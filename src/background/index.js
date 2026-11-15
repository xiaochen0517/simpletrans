/**
 * 后台服务入口
 *
 * 模块：后台服务（A）
 * 职责：在 Service Worker 顶层同步注册 A1 消息路由与 A2 请求网关的监听器。
 * 依赖：A1 消息路由（router）、A2 请求网关（gateway）、E1 消息协议（P2 起）。
 * 实现阶段：P2（后台网关与页面通道）
 */

import { ERROR_CODES, PORT_NAME } from '../shared/protocol.js';
import { handleMessage } from './router.js';
import { handleConnect } from './gateway.js';

chrome.runtime.onMessage.addListener((message, sender, sendResponse) => {
  handleMessage(message, sender)
    .then(sendResponse)
    .catch((error) => {
      sendResponse({
        ok: false,
        error: {
          code: ERROR_CODES.OTHER,
          message: `后台处理失败：${error?.message ?? error}`,
        },
      });
    });
  return true;
});

chrome.runtime.onConnect.addListener((port) => {
  if (port?.name !== PORT_NAME) {
    try {
      port?.disconnect?.();
    } catch {
      // 端口已断开，忽略。
    }
    return;
  }
  handleConnect(port);
});
