/**
 * 页面注入入口
 *
 * 模块：页面注入（D）
 * 职责：初始化 E4 日志、建立并持有 D4 桥单例、装配 D2/D3/D5/D6、处理后台命令与配置帧；
 *       提供可配置的修饰键手势作为悬停翻译快捷键（Chrome commands 不支持裸修饰键）；
 *       按下时展示待翻译范围，按住期间用滚轮扩大到祖先宿主；
 *       除滚轮与指针移动外的操作取消手势，松开未取消时才提交最终范围；
 *       指针在其它 frame 时通过范围广播让持有指针的 frame 显示和调整；
 *       注入单段刷新与提交取消，桥恢复后通知 D5 续传未完成段；
 *       装配 D6 译文自愈，页面重渲染后按镜像恢复原文未变的译文。
 * 依赖：D1–D6、E1 消息协议、E4 日志、E6 快捷键、公共数值、content.css。
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
import { createHealer } from './heal.js';
import { createRenderer } from './dom/renderer.js';
import { createHoverTracker } from './hover.js';
import { createHoverRange } from './range.js';
import { createTask } from './task.js';
import {
  DEFAULT_HOVER_SHORTCUT,
  normalizeHoverShortcut,
  resolveHoverShortcut,
} from '../shared/shortcut.js';
import { HOVER_RANGE_WHEEL_STEP } from '../shared/constants.js';

/** 重复注入保护：同一页面只初始化一次桥、监听与 DOM 层。 */
const LOAD_FLAG = '__simpletransContentLoaded';

/** 滚轮 deltaMode 为「行」时每行按多少像素估算。 */
const WHEEL_LINE_PX = 16;

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
/** @type {ReturnType<typeof createHoverRange> | null} */
let rangePreview = null;
/** @type {ReturnType<typeof createHealer> | null} */
let healer = null;
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

/** 当前手势；keys 为空表示没有按住快捷键。 */
let gesture = null;
/** 本次手势或远程范围是否已被取消；用于忽略迟到的悬停触发广播。 */
let hoverAborted = false;
/** 当前范围会话归属：本 frame 的 `local` 或其它 frame 的 `remote`。 */
let rangeRole = null;
/** 本地会话结束时暂存的最终宿主；`hasPendingRange` 区分「没有」与「无目标」。 */
let hasPendingRange = false;
/** @type {Element | null} */
let pendingRangeHost = null;
/** 范围消息发送链；保证 begin / cancel 的先后顺序。 */
let rangeForwardChain = Promise.resolve();
/** 范围滚轮监听是否已安装。 */
let wheelBound = false;
/** 滚轮累计量，跨过阈值后升降一级。 */
let wheelAccum = 0;

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
 * 页面是否已失焦或隐藏；释放悬停快捷键时按取消处理。
 * @returns {boolean}
 */
function pageFocusLost() {
  if (typeof document === 'undefined') return false;
  if (document.hasFocus?.() === false) return true;
  return document.visibilityState === 'hidden';
}

/**
 * 发送一条范围消息；begin / cancel 串行发送，避免往返延迟打乱顺序。
 * 扩展页面不经过后台广播，直接跳过。
 * @param {'begin'|'cancel'} phase
 * @returns {Promise<void>}
 */
function forwardRange(phase) {
  if (IS_EXTENSION_PAGE) return Promise.resolve();
  const message = { type: MESSAGE_TYPES.HOVER_RANGE, payload: { phase } };
  rangeForwardChain = rangeForwardChain
    .catch(() => {})
    .then(() => chrome.runtime.sendMessage(message))
    .catch(() => {});
  return rangeForwardChain;
}

/**
 * 按当前状态安装或移除滚轮监听。
 * 只在「本地手势进行中」或「存在范围会话」时安装，避免长期占用非 passive 监听。
 */
function syncWheelListener() {
  if (typeof window === 'undefined') return;
  const needed = Boolean(gesture && !gesture.canceled) || rangeRole != null;
  if (needed === wheelBound) return;
  if (needed) {
    window.addEventListener('wheel', onHoverWheel, { capture: true, passive: false });
    wheelBound = true;
    return;
  }
  window.removeEventListener('wheel', onHoverWheel, true);
  wheelBound = false;
  wheelAccum = 0;
}

/**
 * 把滚轮增量归一为像素。
 * @param {WheelEvent} event
 * @returns {number}
 */
function wheelDeltaPixels(event) {
  const delta = Number(event?.deltaY ?? 0);
  if (!Number.isFinite(delta)) return 0;
  if (event.deltaMode === 1) return delta * WHEEL_LINE_PX;
  if (event.deltaMode === 2) return delta * (Number(window?.innerHeight) || 800);
  return delta;
}

/**
 * 滚轮调整范围：存在范围会话时扩大 / 缩小并阻止页面滚动与缩放；
 * 没有范围会话时沿用旧语义，把本次手势记为「指针已使用」。
 * @param {WheelEvent} event
 */
function onHoverWheel(event) {
  if (rangeRole == null || !rangePreview) {
    if (gesture) gesture.pointerUsed = true;
    return;
  }
  if (event.cancelable) event.preventDefault();
  event.stopPropagation();

  wheelAccum += wheelDeltaPixels(event);
  if (Math.abs(wheelAccum) < HOVER_RANGE_WHEEL_STEP) return;

  const expanding = wheelAccum < 0;
  const changed = expanding ? rangePreview.expand() : rangePreview.shrink();
  wheelAccum = 0;
  if (changed) {
    log?.debug('hotkey.range.adjust', '悬停范围已调整', {
      index: rangePreview.getIndex(),
      levels: rangePreview.getLevels(),
    });
  }
}

/** 清空本地暂存的范围宿主。 */
function clearPendingRange() {
  hasPendingRange = false;
  pendingRangeHost = null;
}

/**
 * 暂存本地会话的最终宿主；null 表示有会话但没有可用目标。
 * @param {Element | null} host
 */
function setPendingRange(host) {
  hasPendingRange = true;
  pendingRangeHost = host;
}

/**
 * 取出本地暂存的最终宿主；没有时返回 undefined。
 * @returns {Element | null | undefined}
 */
function takePendingRange() {
  if (!hasPendingRange) return undefined;
  const host = pendingRangeHost;
  clearPendingRange();
  return host;
}

/** 清除范围会话与标记。 */
function clearRangeSession() {
  rangePreview?.cancel();
  rangeRole = null;
  clearPendingRange();
  syncWheelListener();
}

/**
 * 以本 frame 的基宿主开始本地范围会话。
 * @param {Element} baseHost
 * @returns {boolean}
 */
function beginLocalRange(baseHost) {
  rangePreview?.cancel();
  rangeRole = null;
  const levels = rangePreview && baseHost ? rangePreview.begin(baseHost) : 0;
  if (!levels) {
    syncWheelListener();
    return false;
  }
  rangeRole = 'local';
  log?.debug('hotkey.range.begin', '悬停范围预览开始', { role: 'local', levels });
  syncWheelListener();
  return true;
}

/**
 * 中止本地手势并移除范围；仍在按住时不触发。
 * @param {string} reason
 */
function cancelActiveGesture(reason) {
  if (!gesture) return;
  const current = gesture;
  const first = !current.canceled;
  current.otherKey = true;
  current.canceled = true;
  gesture = null;
  hoverAborted = true;
  clearRangeSession();
  if (first) void forwardRange('cancel');
  log?.debug('hotkey.range.cancel', '悬停手势已取消', { reason });
}

/**
 * 用户交互取消：本地手势优先，否则清除远程范围会话；只结束悬停状态，不拦截原操作。
 * @param {string} reason
 */
function cancelFromInteraction(reason) {
  if (gesture) {
    cancelActiveGesture(reason);
    return;
  }
  if (rangeRole == null) return;

  const role = rangeRole;
  hoverAborted = true;
  clearRangeSession();
  void forwardRange('cancel');
  log?.debug('hotkey.range.cancel', '悬停范围已取消', { reason, role });
}

/**
 * 开始一次修饰键手势：有本地宿主时本地预览，否则广播开始让持有指针的 frame 预览。
 */
function startGesture() {
  clearRangeSession();
  hoverAborted = false;
  gesture = { keys: new Set(), otherKey: false, pointerUsed: false, canceled: false };
  wheelAccum = 0;
  syncWheelListener();
  if (isEditableFocus()) return;

  const base = hover?.getCurrentHost() ?? null;
  if (base) {
    beginLocalRange(base);
    return;
  }
  void forwardRange('begin');
}

/**
 * 松开最后一个修饰键：结束预览并触发提交；取消过的手势不触发。
 */
function finishGesture() {
  if (!gesture) return;
  const canceled =
    gesture.otherKey ||
    gesture.pointerUsed ||
    gesture.canceled ||
    hoverAborted ||
    isEditableFocus() ||
    pageFocusLost();
  const chain = rangeForwardChain;

  if (canceled) {
    gesture = null;
    clearRangeSession();
    syncWheelListener();
    return;
  }

  if (rangeRole === 'local' && rangePreview) {
    setPendingRange(rangePreview.end());
    rangeRole = null;
  }
  gesture = null;
  syncWheelListener();
  void chain
    .catch(() => {})
    .then(() => requestHoverTrigger());
}

/**
 * 处理其它 frame 广播的范围阶段。
 * @param {{ payload?: { phase?: string } }} frame
 */
function applyRemoteRange(frame) {
  const phase = frame?.payload?.phase;
  if (phase === 'begin') {
    if (!hover || !rangePreview) return;
    if (gesture || rangeRole === 'local') return;
    clearRangeSession();
    const base = hover.getCurrentHost();
    if (!base) return;
    const levels = rangePreview.begin(base);
    if (!levels) return;
    rangeRole = 'remote';
    hoverAborted = false;
    log?.debug('hotkey.range.begin', '悬停范围预览开始', { role: 'remote', levels });
    syncWheelListener();
    return;
  }

  if (phase === 'cancel') {
    const hadGesture = Boolean(gesture);
    if (gesture) {
      gesture.otherKey = true;
      gesture.canceled = true;
      gesture = null;
    }
    hoverAborted = true;
    clearRangeSession();
    syncWheelListener();
    if (hadGesture) {
      log?.debug('hotkey.range.cancel', '收到范围取消，手势已中止', { reason: 'remote-cancel' });
    }
  }
}

/**
 * 取本次悬停触发的最终目标：
 * 本地结束的候选 > 远程范围会话的候选 > 当前指针宿主。
 * @returns {Element | null}
 */
function consumeTriggerTarget() {
  const pending = takePendingRange();
  if (pending !== undefined) return pending;
  if (rangeRole != null && rangePreview) {
    const host = rangePreview.end();
    rangeRole = null;
    syncWheelListener();
    return host;
  }
  return hover?.getCurrentHost() ?? null;
}

/**
 * 安装修饰键单键手势。
 *
 * Chrome 的 commands API 只支持「修饰键 + 普通键」，不支持裸修饰键，因此页面侧用
 * keydown/keyup 识别：按下所选修饰键后进入范围预览，按住期间可用滚轮调整；
 * 中间出现其它键、指针、输入、剪贴板、拖拽、失焦或页面隐藏时取消，松开未取消才触发。
 * 取消监听只读事件，不调用 preventDefault；只有范围调整时的滚轮被接管。
 *
 * @param {string[]} keys 可接受的 `KeyboardEvent.key`，例如 `['Control']`
 * @returns {() => void} 清理函数
 */
function installModifierTap(keys) {
  if (typeof window === 'undefined') return () => {};

  const accepted = new Set(Array.isArray(keys) ? keys : []);

  const onKeyDown = (event) => {
    if (accepted.has(event.key)) {
      if (event.repeat) return;
      if (!gesture) startGesture();
      else cancelFromInteraction('second-key');
      gesture?.keys.add(event.key);
      return;
    }
    cancelFromInteraction('other-key');
  };

  const onKeyUp = (event) => {
    if (!accepted.has(event.key)) {
      cancelFromInteraction('other-keyup');
      return;
    }
    if (!gesture) return;
    gesture.keys.delete(event.key);
    if (gesture.keys.size > 0) return;
    finishGesture();
  };

  const onPointerDown = () => cancelFromInteraction('pointerdown');
  const onContextMenu = () => cancelFromInteraction('contextmenu');
  const onTouchStart = () => cancelFromInteraction('touchstart');
  const onTextInput = () => cancelFromInteraction('input');
  const onCompositionStart = () => cancelFromInteraction('composition');
  const onClipboard = () => cancelFromInteraction('clipboard');
  const onDrag = () => cancelFromInteraction('drag');
  const onVisibilityChange = () => {
    if (document.visibilityState === 'hidden') cancelFromInteraction('visibility');
  };

  const onBlur = () => {
    cancelFromInteraction('blur');
    gesture = null;
    syncWheelListener();
  };

  window.addEventListener('keydown', onKeyDown, true);
  window.addEventListener('keyup', onKeyUp, true);
  window.addEventListener('pointerdown', onPointerDown, true);
  window.addEventListener('contextmenu', onContextMenu, true);
  window.addEventListener('touchstart', onTouchStart, { capture: true, passive: true });
  window.addEventListener('beforeinput', onTextInput, true);
  window.addEventListener('input', onTextInput, true);
  window.addEventListener('compositionstart', onCompositionStart, true);
  window.addEventListener('copy', onClipboard, true);
  window.addEventListener('cut', onClipboard, true);
  window.addEventListener('paste', onClipboard, true);
  window.addEventListener('dragstart', onDrag, true);
  window.addEventListener('drop', onDrag, true);
  window.addEventListener('blur', onBlur);
  document.addEventListener('visibilitychange', onVisibilityChange);

  return () => {
    window.removeEventListener('keydown', onKeyDown, true);
    window.removeEventListener('keyup', onKeyUp, true);
    window.removeEventListener('pointerdown', onPointerDown, true);
    window.removeEventListener('contextmenu', onContextMenu, true);
    window.removeEventListener('touchstart', onTouchStart, true);
    window.removeEventListener('beforeinput', onTextInput, true);
    window.removeEventListener('input', onTextInput, true);
    window.removeEventListener('compositionstart', onCompositionStart, true);
    window.removeEventListener('copy', onClipboard, true);
    window.removeEventListener('cut', onClipboard, true);
    window.removeEventListener('paste', onClipboard, true);
    window.removeEventListener('dragstart', onDrag, true);
    window.removeEventListener('drop', onDrag, true);
    window.removeEventListener('blur', onBlur);
    document.removeEventListener('visibilitychange', onVisibilityChange);
    gesture = null;
    hoverAborted = true;
    clearRangeSession();
    syncWheelListener();
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
  tapCleanup = installModifierTap(resolved.keys);
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
    runHoverToggle('fallback', consumeTriggerTarget());
    return;
  }
  try {
    const sent = chrome.runtime.sendMessage({ type: MESSAGE_TYPES.HOVER_TRIGGER });
    if (sent && typeof sent.catch === 'function') {
      sent
        .then((response) => {
          // 后台明确失败（例如页面没有接收方）时回退本 frame，避免预览消失后没有动作。
          if (response && response.ok === false) {
            runHoverToggle('fallback', consumeTriggerTarget());
          }
        })
        .catch(() => runHoverToggle('fallback', consumeTriggerTarget()));
    }
  } catch {
    runHoverToggle('fallback', consumeTriggerTarget());
  }
}

/**
 * 对最终宿主动作：提交或隐藏。
 * @param {'broadcast' | 'fallback'} source 触发来源，只用于日志
 * @param {Element | null} host 本次手势的最终宿主
 */
function runHoverToggle(source, host) {
  if (!task || !hover) return;
  if (hoverAborted) {
    clearPendingRange();
    log?.debug('hotkey.trigger.ignored', '悬停触发已取消，忽略', { reason: 'aborted', source });
    return;
  }
  const traceId = newTraceId();
  Promise.resolve(task.toggle(host, traceId))
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
 * 把视口段落一次性提交给后台；后台收到并回执即算成功。
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

    // 后台广播的范围预览阶段：由持有指针的 frame 建立或取消远程会话。
    if (message.type === MESSAGE_TYPES.HOVER_RANGE) {
      applyRemoteRange(message);
      return false;
    }

    // 后台广播的悬停触发：优先使用本次范围候选，没有范围时按当前指针宿主处理。
    if (message.type === MESSAGE_TYPES.HOVER_TRIGGER) {
      if (hoverAborted) {
        clearPendingRange();
        log?.debug('hotkey.trigger.ignored', '悬停触发已取消，忽略', { reason: 'aborted' });
        return false;
      }
      runHoverToggle('broadcast', consumeTriggerTarget());
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
 * 取消后台的一次已接受提交。
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
    // D6 的恢复与注销回调延迟取 task；D5 通过注入的 heal 写镜像与隐藏集合。
    healer = createHealer({
      document,
      renderer,
      restore: (host, source, translated) => task?.restore(host, source, translated) === true,
      forget: (host) => task?.forget(host),
    });
    task = createTask({
      renderer,
      submit: submitPage,
      cancelRequest: cancelSubmission,
      heal: healer,
    });
    rangePreview = createHoverRange();
    hover = createHoverTracker();
    hover.start();
    applyHoverShortcut(DEFAULT_HOVER_SHORTCUT);
  }

  bridge.connect();

  chrome.runtime.onMessage?.addListener(handleMessage);

  // Node 单元测试没有 window；真实页面才接生命周期。
  if (typeof window !== 'undefined') {
    window.addEventListener('pagehide', () => {
      gesture = null;
      clearRangeSession();
      syncWheelListener();
      hover?.stop();
      healer?.stop();
      task?.dispose();
      bridge?.close();
    });
    window.addEventListener('pageshow', (event) => {
      if (event.persisted) {
        bridge?.connect();
        healer?.start();
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
 * 供测试复用同一个桥。
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
