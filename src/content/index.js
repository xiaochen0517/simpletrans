/**
 * 页面注入入口
 *
 * 模块：页面注入（D）
 * 职责：初始化 E4 日志、建立并持有 D4 桥单例、装配 D2/D3/D5、处理后台命令与配置帧；
 *       提供可配置的修饰键手势作为悬停翻译快捷键（Chrome commands 不支持裸修饰键）；
 *       P9 起注入单段刷新与提交取消，桥恢复后通知 D5 续传未完成段；
 *       P12 起从 `ST_CONTENT_CONFIG` 读取悬停快捷键并支持整页会话状态查询。
 * 依赖：D1–D5、E1 消息协议、E4 日志、E6 快捷键、content.css（P2 起）。
 * 实现阶段：P4（段落提取、悬停锚定与译文渲染）；P6.1 增加 `ST_START` 整页任务入口与统一提交；
 *           P6.5 增加 `getTask()` 只读钩子，供扩展内翻译测试页驱动同一份页面任务；
 *           P6.3 把后台 `ST_ITEM_*` 结果帧转发给 D5，页面不再生成假数据；
 *           P9 注入 `onRetry` / `cancelBatch`，转发 `ST_BATCH_DONE` 并在重连后触发续传；
 *           P12 悬停手势改为按设置识别修饰键，新增 `ST_GET_STATUS` 查询与配置帧处理；
 *           P13 悬停手势改为经后台广播到同一标签页所有 frame，由持有指针的 frame 处理。
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
import {
  DEFAULT_HOVER_SHORTCUT,
  normalizeHoverShortcut,
  resolveHoverShortcut,
} from '../shared/shortcut.js';

/** 重复注入保护：同一页面只初始化一次桥、监听与 DOM 层。 */
const LOAD_FLAG = '__simpletransContentLoaded';

/** 单键手势的最长按住时间；超过视为普通按住，不触发。 */
const TAP_MAX_MS = 600;

/**
 * 当前文档是否是扩展页面（C6 测试页与其内嵌 frame）。
 * 扩展页面不经过清单注入，`tabs.sendMessage` 也不会把广播送到这里，
 * 因此悬停手势在扩展页面内直接本地处理。
 */
const IS_EXTENSION_PAGE =
  typeof location !== 'undefined' && String(location.protocol ?? '') === 'chrome-extension:';

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
/** 当前悬停手势的清理函数。 */
let tapCleanup = null;
/** 当前生效的悬停快捷键（归一后的存储值）。 */
let activeHoverShortcut = null;
/** 本页是否已经应用过第一帧内容配置；后续重连帧不再更新。 */
let hoverConfigApplied = false;
/** 桥断开过就置真；恢复连接后通知 D5 续传一次（首次连接不续传）。 */
let bridgeDisconnected = false;

/**
 * 焦点是否在可编辑控件内；在输入框里按悬停快捷键不应触发翻译。
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
 * 安装修饰键单键手势。
 *
 * Chrome 的 commands API 只支持「修饰键 + 普通键」，不支持裸修饰键，因此页面侧用
 * keydown/keyup 识别：按下并松开所选修饰键（同一次手势只按一个可用键，中间没有其它键、
 * 没有点击/滚轮、未超过 600ms）才触发。不调用 preventDefault，不影响页面与浏览器原有快捷键。
 *
 * @param {string[]} keys 可接受的 `KeyboardEvent.key`，例如 `['Control']`
 * @param {() => void} onTrigger
 * @returns {() => void} 清理函数
 */
function installModifierTap(keys, onTrigger) {
  if (typeof window === 'undefined') return () => {};

  const accepted = new Set(Array.isArray(keys) ? keys : []);
  const held = new Set();
  let otherKey = false;
  let pointerUsed = false;
  let startedAt = 0;

  const reset = () => {
    held.clear();
    otherKey = false;
    pointerUsed = false;
    startedAt = 0;
  };

  const onKeyDown = (event) => {
    if (accepted.has(event.key)) {
      if (event.repeat) return;
      if (held.size === 0) {
        startedAt = Date.now();
        otherKey = false;
        pointerUsed = false;
      } else {
        // 同一手势里按下第二个可接受键：不再算作单键手势。
        otherKey = true;
      }
      held.add(event.key);
      return;
    }
    if (held.size > 0) otherKey = true;
  };

  const onKeyUp = (event) => {
    if (!accepted.has(event.key) || held.size === 0) return;
    held.delete(event.key);
    if (held.size > 0) return;

    const elapsed = Date.now() - startedAt;
    const shouldTrigger = !otherKey && !pointerUsed && elapsed <= TAP_MAX_MS && !isEditableFocus();
    reset();
    if (shouldTrigger) onTrigger();
  };

  const onPointerDown = () => {
    if (held.size > 0) pointerUsed = true;
  };

  const onWheel = () => {
    if (held.size > 0) pointerUsed = true;
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
 * 应用悬停快捷键：值未变化时不重装监听，变化时先清理旧手势。
 * @param {unknown} value
 */
function applyHoverShortcut(value) {
  const normalized = normalizeHoverShortcut(value);
  if (normalized === activeHoverShortcut) return;

  tapCleanup?.();
  activeHoverShortcut = normalized;
  const resolved = resolveHoverShortcut(normalized);
  tapCleanup = installModifierTap(resolved.keys, requestHoverTrigger);
  log?.info('hotkey.config', '悬停快捷键已应用', { shortcut: resolved.shortcut });
}

/**
 * 悬停快捷键触发：把「触发」交给后台广播给同一标签页的所有 frame。
 * 键盘事件只会送到当前聚焦的文档；指针在 iframe 内而焦点在顶层时，只有广播才能让
 * 实际持有指针的 frame 处理。发送失败（后台不可用、扩展上下文失效）时回退本 frame 处理。
 */
function requestHoverTrigger() {
  if (!task || !hover) return;
  if (IS_EXTENSION_PAGE) {
    runHoverToggle('fallback');
    return;
  }
  try {
    const sent = chrome.runtime.sendMessage({ type: MESSAGE_TYPES.HOVER_TRIGGER });
    if (sent && typeof sent.catch === 'function') {
      sent.catch(() => runHoverToggle('fallback'));
    }
  } catch {
    runHoverToggle('fallback');
  }
}

/**
 * 对当前宿主动作：提交或隐藏。
 * @param {'broadcast' | 'fallback'} source 触发来源，只用于日志
 */
function runHoverToggle(source) {
  if (!task || !hover) return;
  const traceId = newTraceId();
  Promise.resolve(task.toggle(hover.getCurrentHost(), traceId))
    .then((result) => {
      log?.debug('hotkey.trigger', '悬停快捷键触发提交', {
        action: result?.data?.action ?? null,
        traceId,
        source,
      });
    })
    .catch((error) => {
      log?.warn('hotkey.trigger', '悬停快捷键处理失败', {
        reason: error?.message ?? null,
        traceId,
        source,
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
 * 处理后端帧：日志级别帧更新自身；内容配置帧只在页面第一帧应用悬停快捷键；
 * 逐段结果帧交给 D5 按 `requestId + itemId` 路由；批次结束只记日志，段落状态完全由 item 帧驱动。
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

  if (type === MESSAGE_TYPES.CONTENT_CONFIG) {
    if (!hoverConfigApplied) {
      hoverConfigApplied = true;
      applyHoverShortcut(frame.payload?.hoverShortcut);
    }
    log?.debug('hotkey.config', '收到悬停快捷键配置', {
      shortcut: normalizeHoverShortcut(frame.payload?.hoverShortcut),
    });
    return;
  }

  if (RESULT_FRAME_TYPES.has(type)) {
    task?.applyResultFrame(frame);
    return;
  }

  if (type === MESSAGE_TYPES.BATCH_DONE) {
    task?.applyBatchDone(frame);
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
    if (message.type === MESSAGE_TYPES.GET_STATUS) {
      const phase = task?.getStatus?.().phase ?? 'idle';
      const active = phase === 'scanning' || phase === 'submitting' || phase === 'submitted';
      sendResponse?.({ ok: true, data: { active } });
      return false;
    }

    // 后台广播的悬停触发：只有实际持有指针的 frame 有宿主，其余 frame 的宿主为 null。
    if (message.type === MESSAGE_TYPES.HOVER_TRIGGER) {
      runHoverToggle('broadcast');
      return false;
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
  bridgeDisconnected = true;
  if (pendingRequestIds.length > 0) {
    log?.warn('bridge.state', '连接断开，在途请求中断', {
      pending: pendingRequestIds.length,
    });
  }
}

/**
 * 取消后台的一次已接受提交（P9 清除前调用）。
 * 连接未建立或已断开时抛错，由 D5 忽略并继续清除页面。
 * @param {string} requestId
 */
function cancelSubmission(requestId) {
  if (!bridge) throw new Error('通道未建立');
  bridge.cancelBatch(requestId);
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
    onStateChange: (state) => {
      log?.debug('bridge.state', '通道状态变化', { state });
      // 只有「断开后重新连上」才续传；首次连接不改页面会话。
      if (state === 'connected' && bridgeDisconnected) {
        bridgeDisconnected = false;
        void task?.resumeAfterReconnect();
      }
    },
  });

  if (typeof document !== 'undefined') {
    // 渲染器在创建时注入单段刷新回调；此时 task 尚未创建，闭包在点击时才取。
    const renderer = createRenderer({
      onRetry: (host) => task?.retry(host),
    });
    task = createTask({
      renderer,
      submit: submitPage,
      cancelRequest: cancelSubmission,
    });
    hover = createHoverTracker();
    hover.start();
    applyHoverShortcut(DEFAULT_HOVER_SHORTCUT);
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
