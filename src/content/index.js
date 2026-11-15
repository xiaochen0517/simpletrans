/**
 * 页面注入入口
 *
 * 模块：页面注入（D）
 * 职责：初始化 E4 日志、建立并持有 D4 桥单例、接收日志级别帧；P4 起把消息交给悬停、任务与渲染模块。
 * 依赖：D4 桥（bridge）、E1 消息协议、E4 日志、content.css（P2 起）。
 * 实现阶段：P3（日志初始化与级别帧）
 *
 * 约束：不得引用 shared/config、shared/translate、shared/cache；
 *       不得直接读写同步存储与本地存储。
 */
import './content.css';
import { MESSAGE_TYPES } from '../shared/protocol.js';
import {
  createLogger,
  getLogLevel,
  getLogMeta,
  initLogging,
  setLogLevel,
} from '../shared/log/logger.js';
import { createBridge } from './bridge.js';

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

const rawOrigin = typeof location !== 'undefined' ? location.origin : undefined;
const origin = rawOrigin && rawOrigin !== 'null' ? rawOrigin : undefined;
initLogging({
  context: 'content',
  version: extensionVersion(),
  origin,
  captureErrors: true,
});

const log = createLogger('D');
let readyLogged = false;

/**
 * 输出一次启动横幅；收到日志级别帧后再调用，避免 `off` 仍打出启动日志。
 */
function logReadyOnce() {
  if (readyLogged) return;
  readyLogged = true;
  log.info('logger.ready', '日志已启动', getLogMeta());
}

/**
 * 处理后端帧；P3 只处理日志级别，其余帧留给后续阶段。
 * @param {object} frame
 */
function handleFrame(frame) {
  if (frame?.type !== MESSAGE_TYPES.LOG_CONFIG) return;
  setLogLevel(frame.payload?.level);
  log.debug('log.config', '收到日志级别', { level: getLogLevel() });
  logReadyOnce();
}

const bridge = createBridge({
  onFrame: handleFrame,
  onDisconnect: (pendingRequestIds) => {
    if (pendingRequestIds.length > 0) {
      log.warn('bridge.state', '连接断开，在途请求中断', {
        pending: pendingRequestIds.length,
      });
    }
  },
});

bridge.connect();

// Node 单元测试没有 window；真实页面才接生命周期。
if (typeof window !== 'undefined') {
  window.addEventListener('pagehide', () => bridge.close());
  window.addEventListener('pageshow', (event) => {
    if (event.persisted) bridge.connect();
  });
}

/**
 * 供 P4/P6 复用同一个桥。
 * @returns {ReturnType<typeof createBridge>}
 */
export function getBridge() {
  return bridge;
}
