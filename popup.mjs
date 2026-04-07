const runButton = document.querySelector("#run");
const stopButton = document.querySelector("#stop");
const activeTabMeta = document.querySelector("#activeTabMeta");
const phaseEl = document.querySelector("#phase");
const pagesFetchedEl = document.querySelector("#pagesFetched");
const totalLotsFoundEl = document.querySelector("#totalLotsFound");
const downloadedEl = document.querySelector("#downloaded");
const statusBand = document.querySelector("#statusBand");
const logsEl = document.querySelector("#logs");

const rootDirInput = document.querySelector("#rootDir");
const pageSizeInput = document.querySelector("#pageSize");
const maxPagesInput = document.querySelector("#maxPages");
const requestDelayMsInput = document.querySelector("#requestDelayMs");

let pollTimer = null;

function toIntOrNull(value) {
  if (value == null || value === "") {
    return null;
  }
  const parsed = Number(value);
  return Number.isFinite(parsed) ? parsed : null;
}

async function getActiveTab() {
  const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
  return tab;
}

function renderStatus(status) {
  phaseEl.textContent = status.phase || "空闲";
  pagesFetchedEl.textContent = String(status.pagesFetched || 0);
  totalLotsFoundEl.textContent = String(status.totalLotsFound || 0);
  downloadedEl.textContent = String(status.downloaded || 0);

  const line = [
    `已处理 ${status.processedLots || 0}`,
    `跳过 ${status.skipped || 0}`,
    status.errors ? `失败 ${status.errors}` : null,
    status.currentPage ? `第 ${status.currentPage} 页` : null,
    status.currentLot ? status.currentLot.slice(0, 60) : null,
    status.lastError ? `错误: ${status.lastError.slice(0, 60)}` : null,
  ]
    .filter(Boolean)
    .join(" · ");

  statusBand.textContent = line || "等待开始";
  logsEl.textContent = status.logs?.length ? status.logs.join("\n") : "暂无日志";

  // 自动滚到底部
  logsEl.scrollTop = logsEl.scrollHeight;

  runButton.disabled = Boolean(status.running);
  stopButton.disabled = !status.running;
}

async function refreshStatus() {
  try {
    const status = await chrome.runtime.sendMessage({ type: "GET_EXPORT_STATUS" });
    if (status) {
      renderStatus(status);
    }
  } catch (error) {
    statusBand.textContent = `状态读取失败: ${error.message || String(error)}`;
  }
}

async function refreshActiveTabMeta() {
  const tab = await getActiveTab();
  if (!tab?.url) {
    activeTabMeta.textContent = "无法读取当前标签页";
    runButton.disabled = true;
    return;
  }

  activeTabMeta.textContent = `${tab.title || "Untitled"}\n${tab.url}`;
  if (!tab.url.includes("ha.com/c/search/results.zx")) {
    runButton.disabled = true;
    statusBand.textContent = "请先切到 Heritage 搜索结果页";
  }
}

async function startExport(resume = false) {
  const tab = await getActiveTab();
  if (!tab?.url?.includes("ha.com/c/search/results.zx")) {
    throw new Error("请先切到 Heritage 搜索结果页");
  }

  const payload = {
    startUrl: tab.url,
    rootDir: rootDirInput.value.trim() || "heritage_morgan",
    pageSize: toIntOrNull(pageSizeInput.value) || 50,
    maxPages: toIntOrNull(maxPagesInput.value),
    requestDelayMs: toIntOrNull(requestDelayMsInput.value) ?? 150,
    resume,
  };

  const response = await chrome.runtime.sendMessage({
    type: "START_AUTO_EXPORT",
    payload,
  });

  if (!response?.ok) {
    throw new Error(response?.error || "启动失败");
  }
}

async function stopExport() {
  const response = await chrome.runtime.sendMessage({ type: "STOP_EXPORT" });
  if (!response?.ok) {
    statusBand.textContent = `停止失败: ${response?.error || "未知错误"}`;
  }
}

runButton.addEventListener("click", async () => {
  try {
    // 检查是否有可续传进度
    const progress = await chrome.runtime.sendMessage({ type: "CHECK_RESUME" });
    let resume = false;
    if (progress?.pageIndex > 1) {
      resume = confirm(
        `发现上次进度：第 ${progress.pageIndex} 页，已下载 ${progress.stats?.downloaded || 0} 张\n\n点"确定"续传，点"取消"从头开始`
      );
      if (!resume) {
        await chrome.runtime.sendMessage({ type: "CLEAR_PROGRESS" });
      }
    }
    statusBand.textContent = resume ? "正在续传..." : "正在启动...";
    await startExport(resume);
    await refreshStatus();
  } catch (error) {
    statusBand.textContent = `启动失败: ${error.message || String(error)}`;
  }
});

stopButton.addEventListener("click", async () => {
  try {
    stopButton.disabled = true;
    statusBand.textContent = "正在停止...";
    await stopExport();
  } catch (error) {
    statusBand.textContent = `停止失败: ${error.message || String(error)}`;
  }
});

try {
  await refreshActiveTabMeta();
  await refreshStatus();
} catch {
  // service worker 可能还没就绪，忽略首次错误
}
pollTimer = setInterval(refreshStatus, 1000);

window.addEventListener("unload", () => {
  if (pollTimer) {
    clearInterval(pollTimer);
  }
});
