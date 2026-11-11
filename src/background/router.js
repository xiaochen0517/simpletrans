/**
 * 控制面路由
 *
 * 所有触发入口（快捷键 / 弹窗 / 右键菜单 / 浮窗转发）都经过这里：
 * 1. 解析目标标签页；
 * 2. 确保 content script 已注入（页面在扩展安装前打开时需要补注入）；
 * 3. 把控制命令转发给页面内的 TaskManager。
 *
 * 本模块不发任何翻译请求，也不持有任务状态。
 */

import { ERROR_CODE, ST, makeError } from '../shared/protocol.js';

/** 注入后等待监听器就绪的轮询次数与间隔。 */
const PING_RETRY = Object.freeze({ attempts: 3, delayMs: 50 });

/**
 * @param {number} tabId
 * @returns {Promise<boolean>}
 */
async function pingContent(tabId) {
  try {
    const response = await chrome.tabs.sendMessage(tabId, { type: ST.PING });
    return Boolean(response?.ok);
  } catch {
    return false;
  }
}

/**
 * 保证目标标签页有可用的 content script。
 * @param {number} tabId
 * @returns {Promise<boolean>}
 */
export async function ensureContent(tabId) {
  if (await pingContent(tabId)) return true;

  try {
    // 先注入 CSS：即使后续 JS 注入失败，也不会出现“有译文没样式”的闪烁。
    await chrome.scripting.insertCSS({ target: { tabId }, files: ['content.css'] });
    await chrome.scripting.executeScript({ target: { tabId }, files: ['content.js'] });
  } catch (error) {
    console.warn('[SimpleTrans] 无法注入 content script：', tabId, error);
    return false;
  }

  for (let i = 0; i < PING_RETRY.attempts; i += 1) {
    if (await pingContent(tabId)) return true;
    await new Promise((resolve) => setTimeout(resolve, PING_RETRY.delayMs));
  }
  return false;
}

/**
 * 向指定标签页发送控制命令。
 * @param {number} tabId
 * @param {Record<string, unknown>} message
 */
export async function sendToTab(tabId, message) {
  if (!(await ensureContent(tabId))) {
    return {
      ok: false,
      error: makeError(ERROR_CODE.UNSUPPORTED_PAGE, '当前页面不允许注入脚本（chrome:// 或商店页面）'),
    };
  }
  try {
    return await chrome.tabs.sendMessage(tabId, message);
  } catch (error) {
    return {
      ok: false,
      error: makeError(ERROR_CODE.INJECT_FAIL, error instanceof Error ? error.message : String(error)),
    };
  }
}

/**
 * 启动翻译任务（幂等由 Content 侧的 TaskManager 保证）。
 * @param {number} tabId
 * @param {{ scope: string, lang?: string, force?: boolean, source: string }} options
 */
export function startOnTab(tabId, options) {
  return sendToTab(tabId, {
    v: 1,
    type: ST.START,
    scope: options.scope,
    lang: options.lang,
    force: Boolean(options.force),
    source: options.source,
  });
}

/**
 * 路由到当前活动标签页（弹窗、快捷键兜底使用）。
 * @param {{ scope: string, source: string, lang?: string }} options
 */
export async function routeToActiveTab(options) {
  const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
  if (!tab?.id) {
    return { ok: false, error: makeError(ERROR_CODE.UNSUPPORTED_PAGE, '没有可用的活动标签页') };
  }
  return startOnTab(tab.id, options);
}

/**
 * 把一条控制命令原样转发给当前活动标签页（停止 / 重试 / 清除 / 查询状态）。
 * @param {Record<string, unknown>} message
 */
export async function sendToActiveTab(message) {
  const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
  if (!tab?.id) {
    return { ok: false, error: makeError(ERROR_CODE.UNSUPPORTED_PAGE, '没有可用的活动标签页') };
  }
  return sendToTab(tab.id, message);
}
