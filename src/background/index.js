/**
 * 后台服务入口
 *
 * 模块：后台服务（A）
 * 职责：在 Service Worker 顶层同步注册 A1 消息路由与 A2 请求网关的监听器；初始化 E4 日志。
 * 依赖：A1 消息路由（router）、A2 请求网关（gateway）、E1 消息协议、E2 设置、E4 日志（P3 起）。
 * 实现阶段：P3（后台日志初始化与级别监听）
 *
 * 监听器必须在顶层同步注册，保证 Service Worker 被唤醒时能接住事件；
 * 日志级别读取是异步的，读取完成前使用默认 info，读取后按设置更新。
 */

import { ERROR_CODES, PORT_NAME } from '../shared/protocol.js';
import { getSettings } from '../shared/settings.js';
import { createLogger, getLogLevel, getLogMeta, initLogging, setLogLevel } from '../shared/log/logger.js';
import { handleMessage } from './router.js';
import { handleConnect } from './gateway.js';

/**
 * 安全读取扩展版本；清单不可用时返回 undefined。
 * @returns {string | undefined}
 */
function extensionVersion() {
  try {
    return chrome.runtime.getManifest?.().version;
  } catch {
    return undefined;
  }
}

const log = createLogger('A');
initLogging({
  context: 'background',
  version: extensionVersion(),
  captureErrors: true,
});

getSettings()
  .then((settings) => setLogLevel(settings.logLevel))
  .catch(() => {
    // 读取失败时保持默认 info，不阻断后台。
  })
  .finally(() => {
    log.info('logger.ready', '日志已启动', getLogMeta());
  });

chrome.storage.onChanged.addListener((changes, areaName) => {
  if (areaName !== 'sync' || !changes.settings) return;
  const next = changes.settings.newValue?.logLevel;
  if (!next) return;
  setLogLevel(next);
  log.info('background.settings', '日志级别已更新', { level: getLogLevel() });
});

chrome.runtime.onMessage.addListener((message, sender, sendResponse) => {
  handleMessage(message, sender)
    .then(sendResponse)
    .catch((error) => {
      log.error('message.error', '后台处理失败', {}, error);
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
