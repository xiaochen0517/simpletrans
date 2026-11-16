/**
 * 页面注入入口
 *
 * 模块：页面注入（D）
 * 职责：初始化 E4 日志、建立并持有 D4 桥单例、装配 D2/D3/D5、处理后台命令与日志级别帧；
 *       提供 Ctrl 单键手势作为主快捷键（Chrome commands 不支持裸修饰键）。
 * 依赖：D1–D5、E1 消息协议、E4 日志、content.css（P2 起）。
 * 实现阶段：P4（段落提取、悬停锚定与译文渲染）；P6.1 增加 `ST_START` 整页任务入口与统一提交；
 *           P6.5 增加 `getTask()` 只读钩子，供扩展内翻译测试页驱动同一份页面任务；
 *           P6.3 把后台 `ST_ITEM_*` 结果帧转发给 D5，页面不再生成假数据。
 *
 * 约束：不得引用 shared/config、shared/translate、shared/cache；
 *       不得直接读写同步存储与本地存储。
 */

import './content.css';
import {
  ERROR_CODES,
  MESSAGE_TYPES,
  makeError,
  normalizeTraceId,
} from '../shared/protocol.js';
import {
  createLogger,
  getLogLevel,
  getLogMeta,
  initLogging,
  newTraceId,
  setLogLevel,
} from '../shared/log/logger.js';
import { createBridge } from './bridge.js';
import { createRenderer } from './dom/renderer.js';
import { createHoverTracker } from './hover.js';
import { createTask } from './task.js';

/** 重复注入保护：同一页面只初始化一次桥、监听与 DOM 层。 */
const LOAD_FLAG = '__simpletransContentLoaded';

/** 单键 Ctrl 触发的最长按住时间；超过视为普通按住，不触发。 */
const CTRL_TAP_MAX_MS = 600;

/** 交给 D5 的逐段结果帧。 */
const RESULT_FRAME_TYPES = new Set([
  MESSAGE_TYPES.ITEM_START,
  MESSAGE_TYPES.ITEM_DELTA,
  MESSAGE_TYPES.ITEM_DONE,
  MESSAGE_TYPES.ITEM_ERROR,
]);

/** @type {ReturnType<typeof createBridge> | null} */
let bridge = null;
/** @type {ReturnType<typeof createTask> | null} */
let task = null;
/** @type {ReturnType<typeof createHoverTracker> | null} */
let hover = null;
/** @type {ReturnType<typeof createLogger> | null} */
let log = null;
let readyLogged = false;

/**
 * 焦点是否在可编辑控件内；在输入框里按 Ctrl 不应触发翻译。
 * @returns {boolean}
 */
function isEditableFocus() {
  if (typeof document === 'undefined') return false;
  const active = document.activeElement;
  if (!active || active === document.body) return false;
  if (active.isContentEditable) return true;
  if (active.tagName === 'INPUT' || active.tagName === 'TEXTAREA' || active.tagName === 'SELECT') {
    return true;
  }
  const editable = active.getAttribute?.('contenteditable');
  return editable != null && editable !== 'false';
}

/**
 * 安装「单键 Ctrl」触发。
 *
 * Chrome 的 commands API 只支持「修饰键 + 普通键」，不支持裸 Ctrl；且 Ctrl+Shift+S
 * 是 Chrome 的「另存为」保留快捷键，扩展命令会被静默忽略。因此页面侧补一个 Ctrl
 * 单键手势：按下并松开 Ctrl（中间没有其它键、没有点击/滚轮、未超过 600ms）才触发。
 * 不调用 preventDefault，不影响页面与浏览器原有快捷键。
 *
 * @param {() => void} onTrigger
 * @returns {() => void} 清理函数
 */
function installCtrlTap(onTrigger) {
  if (typeof window === 'undefined') return () => {};

  let down = false;
  let otherKey = false;
  let pointerUsed = false;
  let pressedKey = null;
  let startedAt = 0;

  // 只在 macOS 额外接受 Command（Meta）；Windows 的 Win 键会被系统优先处理，不纳入判断。
  const isMac = /Mac/i.test(
    (typeof navigator !== 'undefined' && (navigator.platform || navigator.userAgent)) || ''
  );
  const isTriggerKey = (event) =>
    event.key === 'Control' || (isMac && event.key === 'Meta');

  const reset = () => {
    down = false;
    otherKey = false;
    pointerUsed = false;
    pressedKey = null;
  };

  const onKeyDown = (event) => {
    if (isTriggerKey(event)) {
      if (down || event.repeat) return;
      down = true;
      otherKey = false;
      pointerUsed = false;
      pressedKey = event.key;
      startedAt = Date.now();
      return;
    }
    if (down) otherKey = true;
  };

  const onKeyUp = (event) => {
    if (!down || event.key !== pressedKey) return;
    const elapsed = Date.now() - startedAt;
    const shouldTrigger = !otherKey && !pointerUsed && elapsed <= CTRL_TAP_MAX_MS && !isEditableFocus();
    reset();
    if (shouldTrigger) onTrigger();
  };

  const onPointerDown = () => {
    if (down) pointerUsed = true;
  };

  const onWheel = () => {
    if (down) pointerUsed = true;
  };

  const onBlur = () => reset();

  window.addEventListener('keydown', onKeyDown, true);
  window.addEventListener('keyup', onKeyUp, true);
  window.addEventListener('pointerdown', onPointerDown, true);
  window.addEventListener('wheel', onWheel, { capture: true, passive: true });
  window.addEventListener('blur', onBlur);

  return () => {
    window.removeEventListener('keydown', onKeyDown, true);
    window.removeEventListener('keyup', onKeyUp, true);
    window.removeEventListener('pointerdown', onPointerDown, true);
    window.removeEventListener('wheel', onWheel, true);
    window.removeEventListener('blur', onBlur);
    reset();
  };
}

/**
 * Ctrl 单键触发：提交/隐藏鼠标所在段落。
 */
function triggerCtrlTap() {
  if (!task || !hover) return;
  const traceId = newTraceId();
  Promise.resolve(task.toggle(hover.getCurrentHost(), traceId))
    .then((result) => {
      log?.debug('hotkey.trigger', 'Ctrl 单键触发提交', {
        action: result?.data?.action ?? null,
        traceId,
      });
    })
    .catch((error) => {
      log?.warn('hotkey.trigger', 'Ctrl 单键处理失败', {
        reason: error?.message ?? null,
        traceId,
      });
    });
}

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

/**
 * 输出一次启动横幅；收到日志级别帧后再调用，避免 `off` 仍打出启动日志。
 */
function logReadyOnce() {
  if (readyLogged || !log) return;
  readyLogged = true;
  log.info('logger.ready', '日志已启动', getLogMeta());
}

/**
 * 当前页面不可用（没有 DOM，通常只出现在单元测试环境）。
 * @returns {{ ok: false, error: object }}
 */
function pageUnavailable() {
  return {
    ok: false,
    error: makeError(ERROR_CODES.OTHER, '当前页面不可用，请刷新后重试'),
  };
}

/**
 * 把视口段落一次性提交给后台；后台收到并回执即算成功（P6.1）。
 * @param {object} payload
 * @returns {Promise<{ ok: true, data?: object } | { ok: false, error: object }>}
 */
async function submitPage(payload) {
  try {
    const response = await chrome.runtime.sendMessage({
      type: MESSAGE_TYPES.PAGE_SUBMIT,
      payload,
    });
    return response ?? { ok: false, error: makeError(ERROR_CODES.OTHER, '后台没有返回结果') };
  } catch {
    return { ok: false, error: makeError(ERROR_CODES.NETWORK, '无法连接后台，请稍后重试') };
  }
}

/**
 * 处理后端帧：日志级别帧更新自身；逐段结果帧交给 D5 按 `requestId + itemId` 路由；
 * 批次结束只记日志，段落状态完全由 item 帧驱动。
 * @param {object} frame
 */
function handleFrame(frame) {
  const type = frame?.type;
  if (type === MESSAGE_TYPES.LOG_CONFIG) {
    setLogLevel(frame.payload?.level);
    log?.debug('log.config', '收到日志级别', { level: getLogLevel() });
    logReadyOnce();
    return;
  }

  if (RESULT_FRAME_TYPES.has(type)) {
    task?.applyResultFrame(frame);
    return;
  }

  if (type === MESSAGE_TYPES.BATCH_DONE) {
    log?.debug('page.batch.done', '批次结束', { requestId: frame.payload?.requestId ?? null });
  }
}

/**
 * 处理后台一次性命令。
 * @param {{ type?: string, payload?: object }} message
 * @param {{ id?: string }} sender
 * @param {(response: object) => void} sendResponse
 * @returns {boolean}
 */
function handleMessage(message, sender, sendResponse) {
  if (!sender || sender.id !== chrome.runtime.id) return false;
  if (!message || typeof message !== 'object') return false;

  try {
    if (message.type === MESSAGE_TYPES.TOGGLE) {
      if (!task || typeof document === 'undefined' || !hover) {
        sendResponse?.(pageUnavailable());
        return false;
      }
      const traceId = normalizeTraceId(message.payload?.traceId);
      log?.debug('content.toggle', '收到提交当前段落命令', {
        ...(traceId ? { traceId } : {}),
      });

      // 提交是异步的：先返回 true 保持消息通道，完成后回包。
      Promise.resolve(task.toggle(hover.getCurrentHost(), traceId))
        .then((result) => {
          try {
            sendResponse?.(result);
          } catch (error) {
            log?.debug('content.toggle', '当前段落响应失败', {
              reason: error?.message ?? null,
            });
          }
          log?.debug('content.toggle', '当前段落处理完成', {
            action: result?.data?.action ?? null,
            ...(traceId ? { traceId } : {}),
          });
        })
        .catch((error) => {
          log?.error('content.toggle', '当前段落处理异常', {}, error);
          try {
            sendResponse?.({
              ok: false,
              error: makeError(ERROR_CODES.OTHER, `处理命令失败：${error?.message ?? error}`),
            });
          } catch {
            // 回包失败不影响页面。
          }
        });
      return true;
    }

    if (message.type === MESSAGE_TYPES.CLEAR) {
      if (!task || typeof document === 'undefined') {
        sendResponse?.(pageUnavailable());
        return false;
      }
      sendResponse?.(task.clearAll());
      return false;
    }

    if (message.type === MESSAGE_TYPES.START) {
      if (!task || typeof document === 'undefined' || !document.body) {
        sendResponse?.(pageUnavailable());
        return false;
      }
      const traceId = normalizeTraceId(message.payload?.traceId);
      const payload = message.payload ?? {};
      log?.debug('content.start', '收到开始整页提交命令', {
        ...(traceId ? { traceId } : {}),
      });

      // 扫描与提交是异步的：先返回 true 保持消息通道，完成后回包。
      task
        .start({ targetLang: payload.targetLang, traceId })
        .then((result) => {
          try {
            sendResponse?.(result);
          } catch (error) {
            // 弹窗已关闭时回包失败只记日志，任务继续。
            log?.debug('content.start', '整页提交响应失败', {
              reason: error?.message ?? null,
            });
          }
        })
        .catch((error) => {
          log?.error('content.start', '整页提交异常', {}, error);
          try {
            sendResponse?.({
              ok: false,
              error: makeError(ERROR_CODES.OTHER, '扫描页面失败，请稍后重试'),
            });
          } catch {
            // 回包失败不影响页面。
          }
        });
      return true;
    }
  } catch (error) {
    log?.error('content.message', '处理后台命令失败', { type: message.type }, error);
    sendResponse?.({
      ok: false,
      error: makeError(ERROR_CODES.OTHER, `处理命令失败：${error?.message ?? error}`),
    });
    return false;
  }

  return false;
}

/**
 * 桥断开时只记录状态；D5 的提交走一次性消息，不再依赖长连接在途请求。
 * @param {string[]} pendingRequestIds
 */
function handleDisconnect(pendingRequestIds) {
  if (pendingRequestIds.length > 0) {
    log?.warn('bridge.state', '连接断开，在途请求中断', {
      pending: pendingRequestIds.length,
    });
  }
}

/**
 * 初始化日志、桥、DOM 层与监听器。页面只执行一次。
 */
function main() {
  const rawOrigin = typeof location !== 'undefined' ? location.origin : undefined;
  const origin = rawOrigin && rawOrigin !== 'null' ? rawOrigin : undefined;
  initLogging({
    context: 'content',
    version: extensionVersion(),
    origin,
    captureErrors: true,
  });
  log = createLogger('D');

  bridge = createBridge({
    onFrame: handleFrame,
    onDisconnect: handleDisconnect,
    onStateChange: (state) => log?.debug('bridge.state', '通道状态变化', { state }),
  });

  if (typeof document !== 'undefined') {
    const renderer = createRenderer();
    task = createTask({
      renderer,
      submit: submitPage,
    });
    hover = createHoverTracker();
    hover.start();
    installCtrlTap(triggerCtrlTap);
  }

  bridge.connect();

  chrome.runtime.onMessage?.addListener(handleMessage);

  // Node 单元测试没有 window；真实页面才接生命周期。
  if (typeof window !== 'undefined') {
    window.addEventListener('pagehide', () => {
      hover?.stop();
      task?.dispose();
      bridge?.close();
    });
    window.addEventListener('pageshow', (event) => {
      if (event.persisted) {
        bridge?.connect();
        hover?.start();
        task?.resume();
      }
    });
  }
}

// 扩展重载后补注入会再次执行本文件：已有实例时保持静默，避免双桥双监听。
if (!(typeof document !== 'undefined' && globalThis[LOAD_FLAG])) {
  if (typeof document !== 'undefined') globalThis[LOAD_FLAG] = true;
  main();
}

/**
 * 供测试与后续阶段复用同一个桥。
 * @returns {ReturnType<typeof createBridge> | null}
 */
export function getBridge() {
  return bridge;
}

/**
 * 返回当前页面任务，供扩展内的翻译测试页驱动同一份 D5 状态。
 * 普通网页注入不调用；没有 DOM 或尚未装配时返回 null。
 * @returns {ReturnType<typeof createTask> | null}
 */
export function getTask() {
  return task;
}
