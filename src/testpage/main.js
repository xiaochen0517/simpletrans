/**
 * C6 翻译测试页入口
 *
 * 模块：插件独立页面（C）/ C6 翻译测试页
 * 职责：加载 D 入口以启动页面注入运行时；把页内「翻译整页 / 显示原文」按钮接到同一份 D5 页面任务；
 *       用两个模拟开关设置结果回显的假数据模式；显示提交/清除结果与错误；不生成正文、不读写配置、不调用引擎。
 * 依赖：D 入口 `getTask()`、测试页 HTML 中的操作条元素。
 * 实现阶段：P6.5（本轮增加「模拟失败 / 模拟慢速」开关）。
 *
 * 约束：普通网页不受影响；本页只在扩展页面内使用，不经过清单注入。
 */

import { getTask } from '../content/index.js';

const startButton = document.getElementById('test-start');
const clearButton = document.getElementById('test-clear');
const slowToggle = document.getElementById('test-mode-slow');
const failToggle = document.getElementById('test-mode-fail');
const status = document.getElementById('test-status');
const form = document.querySelector('.demo-form');
const task = getTask();

/**
 * 当前模拟模式：失败优先于慢速。
 * @returns {'normal' | 'slow' | 'fail'}
 */
function currentMode() {
  if (failToggle?.checked) return 'fail';
  if (slowToggle?.checked) return 'slow';
  return 'normal';
}

/**
 * 把操作条上的开关同步给页面任务；只影响之后的提交。
 */
function applyMode() {
  const current = getTask();
  const mode = currentMode();
  current?.setResultMode?.(mode);
  setStatus(
    mode === 'fail' ? '模拟失败：之后的提交会显示翻译失败' : mode === 'slow' ? '模拟慢速：之后的提交流式更慢' : '就绪'
  );
}

/**
 * 更新状态文字；tone 只用于样式区分。
 * @param {string} message
 * @param {'info' | 'error'} [tone]
 */
function setStatus(message, tone = 'info') {
  if (!status) return;
  status.textContent = message;
  status.dataset.tone = tone;
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

slowToggle?.addEventListener('change', applyMode);
failToggle?.addEventListener('change', applyMode);

// 测试页没有提交动作；阻止表单默认导航，避免按 Enter 离开夹具。
form?.addEventListener('submit', (event) => {
  event.preventDefault();
});
