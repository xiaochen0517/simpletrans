/**
 * Background Service Worker 入口
 *
 * 角色：控制面路由 + 数据面流式网关。不持有跨段任务状态，不读写页面 DOM。
 *
 * 监听器必须在顶层同步注册：Service Worker 被唤醒时不会重放历史事件。
 */

import { ERROR_CODE, ST, isStMessage, makeError } from '../shared/protocol.js';
import { AREA, writeArea } from '../shared/storage.js';
import { DEFAULT_SETTINGS } from '../shared/settings.js';
import { registerCommands } from './commands.js';
import { registerContextMenu, setupContextMenu } from './context-menu.js';
import { registerGateway } from './gateway.js';
import { routeToActiveTab, sendToActiveTab } from './router.js';

/** 需要转发给页面任务管理器的控制命令。 */
const FORWARDED_CONTROLS = new Set([ST.STOP, ST.RETRY, ST.CLEAR, ST.TOGGLE, ST.GET_STATUS]);

chrome.runtime.onInstalled.addListener(({ reason }) => {
  // 默认值由 getSettings() 在读取时合并，这里只补“位置类”设置，避免覆盖已同步的密钥。
  void (async () => {
    if (reason === 'install') {
      await writeArea(AREA.SYNC, { keyStorage: DEFAULT_SETTINGS.keyStorage });
      console.info('[SimpleTrans] 扩展已安装');
    }
    setupContextMenu();
  })();
});

chrome.runtime.onStartup.addListener(() => {
  // 右键菜单会跨重启保留，这里重建一次以同步标题/上下文的改动。
  setupContextMenu();
});

chrome.runtime.onMessage.addListener((message, _sender, sendResponse) => {
  if (!isStMessage(message)) return undefined;

  switch (message.type) {
    case ST.PING:
      sendResponse({ ok: true, from: 'background' });
      return undefined;

    case ST.ROUTE:
      routeToActiveTab({ scope: message.scope, source: message.source })
        .then(sendResponse)
        .catch((error) => sendResponse(toFailure(error)));
      return true;

    default:
      if (FORWARDED_CONTROLS.has(message.type)) {
        sendToActiveTab(message)
          .then(sendResponse)
          .catch((error) => sendResponse(toFailure(error)));
        return true;
      }
      return undefined;
  }
});

chrome.tabs.onRemoved.addListener((_tabId) => {
  // TODO(P5): 清理 storage.session 中的 task:<tabId> 状态镜像。
});

registerGateway();
registerCommands();
registerContextMenu();

/**
 * @param {unknown} error
 */
function toFailure(error) {
  return {
    ok: false,
    error: makeError(ERROR_CODE.BAD_RESPONSE, error instanceof Error ? error.message : String(error)),
  };
}
