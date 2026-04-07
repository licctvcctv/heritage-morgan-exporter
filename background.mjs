import {
  buildDownloadTasks,
  buildSearchPageUrl,
  parseSearchResultsHtml,
} from "./shared.mjs";

const STATUS_KEY = "heritageMorganExportStatus";
const MAX_CONCURRENT_DOWNLOADS = 4; // 最大同时下载数

// MV3 service worker 保活：任务运行期间每 20 秒读一次 storage 防止超时
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

async function resetStatus(options) {
  jobState = {
    running: true,
    stopped: false,
    phase: "启动中",
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

// DataDome 403 自动重试
async function fetchText(url, retries = 3) {
  for (let attempt = 1; attempt <= retries; attempt++) {
    const response = await fetch(url, { credentials: "include" });

    if (response.ok) {
      const text = await response.text();
      if (text.includes("captcha-delivery.com") || text.includes("geo.captcha-delivery")) {
        if (attempt < retries) {
          const delay = 5000 * attempt;
          await pushLog(`⚠ 触发 DataDome 验证，${delay / 1000}s 后重试 (${attempt}/${retries})...`);
          await sleep(delay);
          continue;
        }
        throw new Error("DataDome 拦截，需要手动在浏览器中完成验证后重试");
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
      throw new Error(`HTTP 403 - DataDome 拦截，请在浏览器中刷新搜索页后重试`);
    }

    throw new Error(`HTTP ${response.status} - ${url}`);
  }
}

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

// ── 下载流控：等待单个下载完成 ──
function waitForDownload(downloadId) {
  return new Promise((resolve, reject) => {
    const timeout = setTimeout(() => {
      chrome.downloads.onChanged.removeListener(handler);
      resolve(); // 超时也不阻塞，继续下一个
    }, 60000); // 单张最长等 60 秒

    function handler(delta) {
      if (delta.id !== downloadId) return;
      if (delta.state?.current === "complete") {
        clearTimeout(timeout);
        chrome.downloads.onChanged.removeListener(handler);
        resolve();
      } else if (delta.state?.current === "interrupted") {
        clearTimeout(timeout);
        chrome.downloads.onChanged.removeListener(handler);
        reject(new Error(`下载中断: ${delta.error?.current || "unknown"}`));
      }
    }

    chrome.downloads.onChanged.addListener(handler);
  });
}

// ── 查询当前进行中的下载数 ──
function getActiveDownloadCount() {
  return new Promise((resolve) => {
    chrome.downloads.search({ state: "in_progress" }, (results) => {
      resolve(results?.length || 0);
    });
  });
}

// ── 等待下载槽位空出 ──
async function waitForDownloadSlot() {
  while (true) {
    const active = await getActiveDownloadCount();
    if (active < MAX_CONCURRENT_DOWNLOADS) return;
    await sleep(500); // 每 0.5s 检查一次
  }
}

// ── 带流控的下载：等槽位 → 发起下载 → 等完成 ──
async function downloadWithThrottle(url, filename) {
  await waitForDownloadSlot();
  const downloadId = await chrome.downloads.download({
    url,
    filename,
    conflictAction: "uniquify",
    saveAs: false,
  });
  await waitForDownload(downloadId);
}

async function runExportJob(options) {
  startKeepalive();
  await resetStatus(options);
  await pushLog("✓ 任务已启动");

  const seenLots = new Set();
  let pageIndex = 1;

  try {
    while (true) {
      const currentStatus = await getStatus();
      if (currentStatus.stopped) {
        await pushLog("⏹ 用户手动停止");
        await setStatus({ running: false, phase: "已停止" });
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
          await pushLog(`✗ 重试仍然失败，任务终止`);
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
          await pushLog("⏹ 用户手动停止");
          await setStatus({ running: false, phase: "已停止" });
          return;
        }

        const tasks = buildDownloadTasks(item, options.rootDir);

        if (!item.service || !tasks.length) {
          await setStatus({
            processedLots: jobState.processedLots + 1,
            skipped: jobState.skipped + 1,
          });
          const reason = !item.service ? "无 PCGS/NGC" : "无图片";
          await pushLog(`  跳过: ${reason} - ${item.title?.slice(0, 50) || item.url}`);
          continue;
        }

        try {
          for (const task of tasks) {
            await downloadWithThrottle(task.url, task.filename);
          }

          await setStatus({
            processedLots: jobState.processedLots + 1,
            downloaded: jobState.downloaded + tasks.length,
          });
          await pushLog(
            `  ✓ ${item.service}/${item.grade || "?"} sale${item.saleNo}_lot${item.lotNo} [${tasks.length}张]`,
          );
        } catch (error) {
          await setStatus({
            processedLots: jobState.processedLots + 1,
            errors: jobState.errors + 1,
          });
          await pushLog(`  ✗ 下载失败: ${error.message?.slice(0, 80) || String(error)}`);
        }
      }

      pageIndex += 1;

      if (options.requestDelayMs > 0) {
        await sleep(options.requestDelayMs * 2);
      }
    }

    // 等待所有剩余下载完成
    await pushLog("⏳ 等待剩余下载完成...");
    for (let i = 0; i < 120; i++) {
      const active = await getActiveDownloadCount();
      if (active === 0) break;
      await sleep(1000);
    }

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

  return undefined;
});
