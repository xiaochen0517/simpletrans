/**
 * 右键菜单入口：「翻译此段」
 *
 * 与段落快捷键共用 `SCOPE.PARAGRAPH`。注意 `contextMenus.onClicked` 不提供
 * 点击坐标，Content 侧只能使用右键前最后一次 `lastPointer`。
 */

import { SCOPE, SOURCE } from '../shared/protocol.js';
import { startOnTab } from './router.js';

const MENU_ID = 'st-translate-paragraph';

/** 创建（或重建）菜单项。 */
export function setupContextMenu() {
  chrome.contextMenus.removeAll(() => {
    chrome.contextMenus.create({
      id: MENU_ID,
      title: '翻译此段',
      contexts: ['page', 'selection'],
    });
  });
}

/** 注册菜单点击监听。必须在 Service Worker 顶层同步调用。 */
export function registerContextMenu() {
  chrome.contextMenus.onClicked.addListener((info, tab) => {
    if (info.menuItemId !== MENU_ID || !tab?.id) return;
    void startOnTab(tab.id, { scope: SCOPE.PARAGRAPH, source: SOURCE.CONTEXT_MENU });
  });
}
