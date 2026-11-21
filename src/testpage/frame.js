/**
 * C6 翻译测试页 / 内嵌 frame 夹具入口
 *
 * 模块：插件独立页面（C）/ C6
 * 职责：在 iframe 文档内加载 D 入口，提供本 frame 的「翻译 / 显示原文」操作与状态显示；
 *       验证 iframe 文档内的取段、提交、渲染与悬停；不读写配置、不调用引擎。
 * 依赖：D 入口 `getTask()`、frame.html 中的操作条元素。
 * 实现阶段：P13（跨 frame 翻译支持）
 *
 * 约束：扩展页面不会被清单注入，页面自行加载运行时；跨 frame 命令与聚合计数由真实页面验收。
 */

import { getTask } from '../content/index.js';

const task = getTask();
const startButton = document.getElementById('frame-start');
const clearButton = document.getElementById('frame-clear');
const status = document.getElementById('frame-status');
const olderToggle = document.getElementById('older-toggle');
const olderBody = document.getElementById('older-body');

olderToggle?.addEventListener('click', () => {
  olderToggle.classList.toggle('open');
  olderBody?.classList.toggle('show');
});

/**
 * @param {string} message
 */
function setStatus(message) {
  if (status) status.textContent = message;
}

/**
 * @param {boolean} busy
 */
function setBusy(busy) {
  const disabled = busy || !task;
  if (startButton) startButton.disabled = disabled;
  if (clearButton) clearButton.disabled = disabled;
  startButton?.setAttribute('aria-busy', String(busy));
}

if (!task) {
  setStatus('Page runtime not ready, reload the test page');
  setBusy(false);
} else {
  setStatus('Ready');
  setBusy(false);
}

startButton?.addEventListener('click', async () => {
  const current = getTask();
  if (!current) return;

  setBusy(true);
  setStatus('Scanning this frame…');
  try {
    const result = await current.start({});
    if (!result?.ok) {
      setStatus(result?.error?.message ?? 'Failed to start translation');
      return;
    }
    const total = Number(result.data?.total) || 0;
    setStatus(total > 0 ? `Submitted ${total} paragraphs` : 'No translatable paragraphs');
  } catch (error) {
    setStatus(`Failed to start: ${error?.message ?? error}`);
  } finally {
    setBusy(false);
  }
});

clearButton?.addEventListener('click', () => {
  const current = getTask();
  if (!current) return;
  try {
    const result = current.clearAll();
    const removed = Number(result?.data?.removed) || 0;
    setStatus(`Removed ${removed} marks`);
  } catch (error) {
    setStatus(`Failed to clear: ${error?.message ?? error}`);
  }
});
