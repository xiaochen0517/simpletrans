/**
 * 后台服务入口
 *
 * 模块：后台服务（A）
 * 职责：在 Service Worker 顶层同步注册 A1 消息路由、快捷键入口、标签页关闭清理与 A2 请求网关的监听器；初始化 E4 日志。
 * 依赖：A1 消息路由（router）、A1 快捷键（commands）、A2 请求网关（gateway）、E1 消息协议、E2 设置、E4 日志（P3 起）。
 * 实现阶段：P4（快捷键监听）；P9 增加 `chrome.tabs.onRemoved` 兜底清理。
 *
 * 监听器必须在顶层同步注册，保证 Service Worker 被唤醒时能接住事件；
 * 日志级别读取是异步的，读取完成前使用默认 info，读取后按设置更新。
 */

import { ERROR_CODES, PORT_NAME } from '../shared/protocol.js';
import { getSettings } from '../shared/settings.js';
import { ensureConfigMigrated } from '../shared/config/instances.js';
import { createLogger, getLogLevel, getLogMeta, initLogging, setLogLevel } from '../shared/log/logger.js';
import { handleMessage } from './router.js';
import { cleanupTab, handleConnect } from './gateway.js';
import { handleCommand } from './commands.js';

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

// 配置迁移 v1 → v2：只执行一次，幂等；失败保留旧数据并在下次唤醒时重试。
ensureConfigMigrated().catch((error) => {
  log.warn('config.migrate.error', '配置迁移失败，将在下次启动重试', {
    reason: error?.name ?? 'Error',
  });
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

chrome.commands.onCommand.addListener((command) => {
  // 命令处理是异步的；监听器本身不阻塞 Service Worker。
  void handleCommand(command);
});

// 标签页关闭兜底：端口 onDisconnect 之外的显式清理，与断线清理幂等（P9）。
chrome.tabs.onRemoved.addListener((tabId) => {
  cleanupTab(tabId);
});
