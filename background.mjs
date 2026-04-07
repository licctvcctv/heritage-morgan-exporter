import {
  buildDownloadTasks,
  buildSearchPageUrl,
  parseSearchResultsHtml,
} from "./shared.mjs";

const STATUS_KEY = "heritageMorganExportStatus";
const PROGRESS_KEY = "heritageMorganProgress"; // 持久化进度（local storage，重启不丢）
const MAX_CONCURRENT_DOWNLOADS = 6;

// MV3 service worker 保活
let keepaliveTimer = null;
function startKeepalive() {
  if (keepaliveTimer) return;
  keepaliveTimer = setInterval(() => {
    chrome.storage.session.get(STATUS_KEY);
  }, 20000);
}
function stopKeepalive() {
  if (keepaliveTimer) {
    clearInterval(keepaliveTimer);
    keepaliveTimer = null;
  }
}

let jobState = {
  running: false,
  stopped: false,
  phase: "idle",
  logs: [],
  pagesFetched: 0,
  totalLotsFound: 0,
  processedLots: 0,
  downloaded: 0,
  skipped: 0,
  errors: 0,
  currentPage: 0,
  currentLot: "",
  lastError: "",
  options: null,
  startedAt: null,
  updatedAt: null,
};

function nowIso() {
  return new Date().toISOString();
}

async function persistStatus() {
  jobState.updatedAt = nowIso();
  await chrome.storage.session.set({ [STATUS_KEY]: jobState });
}

async function setStatus(patch) {
  jobState = { ...jobState, ...patch };
  await persistStatus();
}

async function pushLog(message) {
  const logs = [
    ...(jobState.logs || []),
    `[${new Date().toLocaleTimeString()}] ${message}`,
  ].slice(-200);
  jobState = { ...jobState, logs };
  await persistStatus();
}

async function resetStatus(options, resumePage = 0, resumeStats = null) {
  jobState = {
    running: true,
    stopped: false,
    phase: "启动中",
    logs: [],
    pagesFetched: resumeStats?.pagesFetched || 0,
    totalLotsFound: resumeStats?.totalLotsFound || 0,
    processedLots: resumeStats?.processedLots || 0,
    downloaded: resumeStats?.downloaded || 0,
    skipped: resumeStats?.skipped || 0,
    errors: resumeStats?.errors || 0,
    currentPage: resumePage,
    currentLot: "",
    lastError: "",
    options,
    startedAt: nowIso(),
    updatedAt: nowIso(),
  };
  await persistStatus();
}

async function getStatus() {
  const stored = await chrome.storage.session.get(STATUS_KEY);
  return stored[STATUS_KEY] || jobState;
}

// ── 进度持久化（chrome.storage.local，重启不丢） ──
async function saveProgress(pageIndex, seenLotUrls, stats) {
  await chrome.storage.local.set({
    [PROGRESS_KEY]: {
      pageIndex,
      seenLotUrls: [...seenLotUrls],
      stats: {
        pagesFetched: stats.pagesFetched,
        totalLotsFound: stats.totalLotsFound,
        processedLots: stats.processedLots,
        downloaded: stats.downloaded,
        skipped: stats.skipped,
        errors: stats.errors,
      },
      savedAt: nowIso(),
    },
  });
}

async function loadProgress() {
  const stored = await chrome.storage.local.get(PROGRESS_KEY);
  return stored[PROGRESS_KEY] || null;
}

async function clearProgress() {
  await chrome.storage.local.remove(PROGRESS_KEY);
}

// DataDome 403 自动重试
async function fetchText(url, retries = 3) {
  for (let attempt = 1; attempt <= retries; attempt++) {
    const response = await fetch(url, { credentials: "include" });

    if (response.ok) {
      const text = await response.text();
      if (text.includes("captcha-delivery.com") || text.includes("geo.captcha-delivery")) {
        if (attempt < retries) {
          const delay = 5000 * attempt;
          await pushLog(`⚠ DataDome 验证，${delay / 1000}s 后重试 (${attempt}/${retries})...`);
          await sleep(delay);
          continue;
        }
        throw new Error("DataDome 拦截，请手动完成验证后重试");
      }
      return text;
    }

    if (response.status === 403) {
      if (attempt < retries) {
        const delay = 5000 * attempt;
        await pushLog(`⚠ HTTP 403，${delay / 1000}s 后重试 (${attempt}/${retries})...`);
        await sleep(delay);
        continue;
      }
      throw new Error(`HTTP 403 - DataDome 拦截`);
    }

    throw new Error(`HTTP ${response.status}`);
  }
}

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

// ── 下载流控（简化版，不等单个完成，只控并发数） ──
async function waitForDownloadSlot() {
  for (let i = 0; i < 300; i++) { // 最多等 150 秒
    try {
      const results = await chrome.downloads.search({ state: "in_progress" });
      if ((results?.length || 0) < MAX_CONCURRENT_DOWNLOADS) return;
    } catch {
      return; // API 异常时放行，不阻塞
    }
    await sleep(500);
  }
  // 超时也放行，不卡死
}

async function downloadFile(url, filename) {
  await waitForDownloadSlot();
  try {
    await chrome.downloads.download({
      url,
      filename,
      conflictAction: "uniquify",
      saveAs: false,
    });
  } catch (err) {
    throw new Error(`download API: ${err.message || err}`);
  }
}

async function runExportJob(options) {
  startKeepalive();

  // ── 尝试续传 ──
  let pageIndex = 1;
  const seenLots = new Set();
  let resumeStats = null;

  if (options.resume) {
    const progress = await loadProgress();
    if (progress && progress.pageIndex > 1) {
      pageIndex = progress.pageIndex;
      progress.seenLotUrls?.forEach((u) => seenLots.add(u));
      resumeStats = progress.stats;
      await resetStatus(options, pageIndex, resumeStats);
      await pushLog(`✓ 从第 ${pageIndex} 页续传（已有 ${resumeStats?.downloaded || 0} 张）`);
    } else {
      await resetStatus(options);
      await pushLog("✓ 任务已启动（无可续传进度）");
    }
  } else {
    await clearProgress();
    await resetStatus(options);
    await pushLog("✓ 任务已启动");
  }

  try {
    while (true) {
      const currentStatus = await getStatus();
      if (currentStatus.stopped) {
        // 停止时保存进度
        await saveProgress(pageIndex, seenLots, jobState);
        await pushLog(`⏹ 已停止，进度已保存（第 ${pageIndex} 页），下次可续传`);
        await setStatus({ running: false, phase: "已停止" });
        stopKeepalive();
        return;
      }

      if (options.maxPages && pageIndex > options.maxPages) {
        await pushLog(`达到最大页数 ${options.maxPages}，停止`);
        break;
      }

      const searchUrl = buildSearchPageUrl(options.startUrl, options.pageSize, pageIndex);
      await setStatus({
        phase: "抓取搜索页",
        currentPage: pageIndex,
        currentLot: "",
      });
      await pushLog(`📄 搜索页 ${pageIndex}`);

      let searchHtml;
      try {
        searchHtml = await fetchText(searchUrl);
      } catch (err) {
        await pushLog(`✗ 搜索页失败: ${err.message}`);
        await setStatus({ lastError: err.message });
        await sleep(10000);
        try {
          searchHtml = await fetchText(searchUrl);
        } catch (err2) {
          // 保存进度后终止
          await saveProgress(pageIndex, seenLots, jobState);
          await pushLog(`✗ 重试失败，进度已保存（第 ${pageIndex} 页）`);
          throw err2;
        }
      }

      const page = parseSearchResultsHtml(searchHtml, searchUrl);
      const freshItems = page.items.filter((item) => !seenLots.has(item.url));

      if (!page.items.length) {
        await pushLog(`第 ${pageIndex} 页没有结果，结束`);
        break;
      }

      if (!freshItems.length) {
        await pushLog(`第 ${pageIndex} 页无新数据，结束`);
        break;
      }

      freshItems.forEach((item) => seenLots.add(item.url));
      await setStatus({
        pagesFetched: pageIndex,
        totalLotsFound: seenLots.size,
      });
      await pushLog(`  找到 ${freshItems.length} 个 lot`);

      for (const item of freshItems) {
        const s = await getStatus();
        if (s.stopped) {
          await saveProgress(pageIndex, seenLots, jobState);
          await pushLog(`⏹ 已停止，进度已保存（第 ${pageIndex} 页）`);
          await setStatus({ running: false, phase: "已停止" });
          stopKeepalive();
          return;
        }

        const tasks = buildDownloadTasks(item, options.rootDir);

        if (!item.service || !item.isAllowedGrade || !tasks.length) {
          await setStatus({
            processedLots: jobState.processedLots + 1,
            skipped: jobState.skipped + 1,
          });
          const reason = !item.service
            ? "无 PCGS/NGC"
            : !item.isAllowedGrade
              ? `grade 不在白名单 (${item.grade || "unknown"})`
              : "无图片";
          await pushLog(`  跳过: ${reason} - ${item.title?.slice(0, 50) || item.url}`);
          continue;
        }

        try {
          for (const task of tasks) {
            await downloadFile(task.url, task.filename);
          }

          await setStatus({
            processedLots: jobState.processedLots + 1,
            downloaded: jobState.downloaded + tasks.length,
          });
          await pushLog(
            `  ✓ ${item.service}/${item.gradeBucket || item.grade || "?"} sale${item.saleNo}_lot${item.lotNo} [${tasks.length}张]`,
          );
        } catch (error) {
          await setStatus({
            processedLots: jobState.processedLots + 1,
            errors: jobState.errors + 1,
          });
          await pushLog(`  ✗ 下载失败: ${error.message?.slice(0, 80) || String(error)}`);
        }
      }

      // 每页结束保存一次进度
      pageIndex += 1;
      await saveProgress(pageIndex, seenLots, jobState);

      if (options.requestDelayMs > 0) {
        await sleep(options.requestDelayMs * 2);
      }
    }

    await clearProgress();
    await setStatus({
      running: false,
      phase: "已完成",
      currentLot: "",
    });
    stopKeepalive();
    await pushLog(`✓ 全部完成！共 ${jobState.processedLots} lot，下载 ${jobState.downloaded} 张，跳过 ${jobState.skipped}，失败 ${jobState.errors}`);
  } catch (error) {
    stopKeepalive();
    await setStatus({
      running: false,
      phase: "失败",
      currentLot: "",
      lastError: error.message || String(error),
    });
    await pushLog(`✗ 任务失败: ${error.message || String(error)}`);
  }
}

chrome.runtime.onMessage.addListener((message, _sender, sendResponse) => {
  if (message?.type === "GET_EXPORT_STATUS") {
    getStatus().then(sendResponse);
    return true;
  }

  if (message?.type === "START_AUTO_EXPORT") {
    getStatus()
      .then(async (status) => {
        if (status.running) {
          sendResponse({ ok: false, error: "已有任务运行中" });
          return;
        }
        runExportJob(message.payload).catch((error) => {
          console.error("runExportJob failed", error);
        });
        sendResponse({ ok: true });
      })
      .catch((error) => {
        sendResponse({ ok: false, error: error.message || String(error) });
      });
    return true;
  }

  if (message?.type === "STOP_EXPORT") {
    getStatus()
      .then(async (status) => {
        if (!status.running) {
          sendResponse({ ok: false, error: "没有运行中的任务" });
          return;
        }
        await setStatus({ stopped: true });
        sendResponse({ ok: true });
      })
      .catch((error) => {
        sendResponse({ ok: false, error: error.message || String(error) });
      });
    return true;
  }

  // 查询是否有可续传的进度
  if (message?.type === "CHECK_RESUME") {
    loadProgress().then(sendResponse);
    return true;
  }

  // 清除续传进度
  if (message?.type === "CLEAR_PROGRESS") {
    clearProgress().then(() => sendResponse({ ok: true }));
    return true;
  }

  return undefined;
});
