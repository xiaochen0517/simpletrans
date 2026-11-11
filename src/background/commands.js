/**
 * 快捷键入口
 *
 * commands 的默认键在 manifest 中声明（最多 4 个）；用户可在
 * chrome://extensions/shortcuts 自定义。
 *
 * 注意：`onCommand` 不携带页面内坐标或选区，因此这里只负责把「作用域」
 * 交给页面，由 Content 的 anchor 模块解析具体段落。
 */

import { SCOPE, SOURCE } from '../shared/protocol.js';
import { startOnTab } from './router.js';

const COMMAND_SCOPE = Object.freeze({
  'translate-page': SCOPE.PAGE,
  'translate-paragraph': SCOPE.PARAGRAPH,
});

/**
 * @param {string} command
 * @param {chrome.tabs.Tab | undefined} tab
 */
async function handleCommand(command, tab) {
  const scope = COMMAND_SCOPE[command];
  if (!scope) return;

  const tabId = tab?.id ?? (await chrome.tabs.query({ active: true, currentWindow: true }))[0]?.id;
  if (!tabId) return;

  await startOnTab(tabId, { scope, source: SOURCE.COMMAND });
}

/** 注册快捷键监听。必须在 Service Worker 顶层同步调用。 */
export function registerCommands() {
  chrome.commands.onCommand.addListener((command, tab) => {
    void handleCommand(command, tab);
  });
}
