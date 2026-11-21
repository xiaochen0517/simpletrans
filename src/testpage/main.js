/**
 * C6 翻译测试页入口
 *
 * 模块：插件独立页面（C）/ C6 翻译测试页
 * 职责：加载 D 入口以启动页面注入运行时；把页内「翻译整页 / 显示原文」按钮接到同一份 D5 页面任务；
 *       显示提交/清除结果与错误；维护 `#rerender` 重渲染夹具（按模式自动或手动重建目标段落）；
 *       不生成正文、不读写配置、不调用引擎。
 * 依赖：D 入口 `getTask()`、测试页 HTML 中的操作条与重渲染控件元素。
 * 实现阶段：P6.5（结果来源改为后台真实帧，移除模拟开关）；重渲染夹具（docs/demand/20261121-01）。
 *
 * 约束：普通网页不受影响；本页只在扩展页面内使用，不经过清单注入。
 */

import './testpage.css';
import { getTask } from '../content/index.js';

/** 测试页没有设置入口：按系统偏好写 data-theme，并跟随系统变化。 */
const darkQuery = globalThis.matchMedia?.('(prefers-color-scheme: dark)');

function applySystemTheme() {
  const theme = darkQuery?.matches ? 'dark' : 'light';
  document.documentElement.dataset.theme = theme;
  document.documentElement.style.colorScheme = theme;
}

applySystemTheme();
darkQuery?.addEventListener?.('change', applySystemTheme);

const startButton = document.getElementById('test-start');
const clearButton = document.getElementById('test-clear');
const status = document.getElementById('test-status');
const form = document.querySelector('.demo-form');
const task = getTask();

/**
 * 更新状态文字；tone 只用于样式区分。
 * @param {string} message
 * @param {'info' | 'error'} [tone]
 */
function setStatus(message, tone = 'info') {
  if (!status) return;
  status.textContent = message;
  status.className =
    tone === 'error'
      ? 'inline-flex items-center rounded-full bg-red-100 px-2 py-0.5 text-xs font-medium text-red-800 dark:bg-red-900/40 dark:text-red-200'
      : 'inline-flex items-center rounded-full bg-gray-100 px-2 py-0.5 text-xs font-medium text-gray-700 dark:bg-gray-800 dark:text-gray-300';
}

/**
 * 同步按钮禁用状态。
 * @param {boolean} busy
 */
function setBusy(busy) {
  const disabled = busy || !task;
  if (startButton) startButton.disabled = disabled;
  if (clearButton) clearButton.disabled = disabled;
  startButton?.setAttribute('aria-busy', String(busy));
}

if (!task) {
  setStatus('页面注入未就绪，请刷新页面', 'error');
  setBusy(false);
} else {
  setStatus('就绪');
  setBusy(false);
}

startButton?.addEventListener('click', async () => {
  const current = getTask();
  if (!current) {
    setStatus('页面注入未就绪，请刷新页面', 'error');
    return;
  }

  setBusy(true);
  setStatus('正在扫描页面…');
  try {
    const result = await current.start({});
    if (!result?.ok) {
      setStatus(result?.error?.message ?? '启动翻译失败', 'error');
      return;
    }
    const data = result.data ?? {};
    if (data.phase === 'scanning') {
      setStatus('正在扫描页面…');
      return;
    }
    if (data.phase === 'submitting') {
      setStatus('正在提交页面段落…');
      return;
    }
    if (data.phase === 'error') {
      setStatus('提交失败，请查看页面与控制台', 'error');
      return;
    }
    const total = Number(data.total) || 0;
    setStatus(total > 0 ? `已提交 ${total} 段，滚动后自动提交新段落` : '视口附近没有可翻译的段落');
  } catch (error) {
    setStatus(`启动翻译失败：${error?.message ?? error}`, 'error');
  } finally {
    setBusy(false);
  }
});

clearButton?.addEventListener('click', () => {
  const current = getTask();
  if (!current) {
    setStatus('页面注入未就绪，请刷新页面', 'error');
    return;
  }

  try {
    const result = current.clearAll();
    const removed = Number(result?.data?.removed) || 0;
    setStatus(`已清除 ${removed} 处标记`);
  } catch (error) {
    setStatus(`清除失败：${error?.message ?? error}`, 'error');
  }
});

// 测试页没有提交动作；阻止表单默认导航，避免按 Enter 离开夹具。
form?.addEventListener('submit', (event) => {
  event.preventDefault();
});

/**
 * 重渲染夹具：按模式重建 `#rerender-target`，用于确认页面重渲染后译文消失的现状，
 * 并在译文自动恢复实现后手动验证。夹具只操作 DOM，不调用 D5、不参与翻译。
 */
const RERENDER_SOURCE =
  'The translated sentence should come back after the page rebuilds it, because the source text did not change.';
const RERENDER_INTERVAL_MS = 3000;
const RERENDER_MODE_LABELS = {
  children: 'replace children',
  host: 'replace host',
  text: 'changed text',
};

const rerenderModeSelect = document.getElementById('rerender-mode');
const rerenderToggle = document.getElementById('rerender-toggle');
const rerenderNow = document.getElementById('rerender-now');
const rerenderStatus = document.getElementById('rerender-status');

let rerenderTimer = null;
let rerenderCount = 0;

/**
 * @returns {HTMLElement | null}
 */
function getRerenderTarget() {
  return document.getElementById('rerender-target');
}

/**
 * @returns {'children' | 'host' | 'text'}
 */
function getRerenderMode() {
  const value = rerenderModeSelect?.value;
  return value === 'host' || value === 'text' ? value : 'children';
}

/**
 * 刷新状态徽标：次数 · 自动/手动 · 当前模式。
 */
function updateRerenderStatus() {
  if (!rerenderStatus) return;
  const state = rerenderTimer == null ? 'idle' : 'auto';
  const label = RERENDER_MODE_LABELS[getRerenderMode()];
  rerenderStatus.textContent = `Refreshes: ${rerenderCount} · ${state} · ${label}`;
}

/**
 * 目标段落的重建文本：文本模式每次追加 Revision 序号，同文本模式恒为原文。
 * @returns {string}
 */
function nextRerenderText() {
  return getRerenderMode() === 'text'
    ? `${RERENDER_SOURCE} Revision ${rerenderCount + 1}.`
    : RERENDER_SOURCE;
}

/**
 * 重建一次目标段落：同文本模式删除译文容器但不改原文；文本模式同时改变原文。
 * 宿主替换模式把目标段落换成同文本的新元素，段落 id 由页面注入重新分配。
 */
function rerenderOnce() {
  const target = getRerenderTarget();
  if (!target) return;

  const text = nextRerenderText();
  rerenderCount += 1;

  if (getRerenderMode() === 'host') {
    const next = document.createElement('p');
    next.id = 'rerender-target';
    next.className = target.className;
    next.textContent = text;
    target.replaceWith(next);
  } else {
    target.replaceChildren(document.createTextNode(text));
  }

  updateRerenderStatus();
}

function startRerenderAuto() {
  if (rerenderTimer != null) return;
  rerenderTimer = setInterval(rerenderOnce, RERENDER_INTERVAL_MS);
  rerenderToggle?.setAttribute('aria-pressed', 'true');
  if (rerenderToggle) rerenderToggle.textContent = 'Stop auto refresh';
  updateRerenderStatus();
}

function stopRerenderAuto() {
  if (rerenderTimer == null) return;
  clearInterval(rerenderTimer);
  rerenderTimer = null;
  rerenderToggle?.setAttribute('aria-pressed', 'false');
  if (rerenderToggle) rerenderToggle.textContent = 'Start auto refresh';
  updateRerenderStatus();
}

rerenderToggle?.addEventListener('click', () => {
  if (rerenderTimer == null) startRerenderAuto();
  else stopRerenderAuto();
});

rerenderNow?.addEventListener('click', rerenderOnce);
rerenderModeSelect?.addEventListener('change', updateRerenderStatus);

// 页面进入 bfcache 或被关闭时停掉计时器，避免在后台继续改 DOM。
window.addEventListener('pagehide', stopRerenderAuto);

updateRerenderStatus();
