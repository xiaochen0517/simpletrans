/**
 * SimpleTrans 消息协议（唯一协议源）
 *
 * 所有跨上下文（Content / Background / Popup）消息的类型、载荷形状与上限
 * 都集中在这里，避免三端各写一份字符串字面量。
 *
 * @see docs/demand/20261111-02-插件架构设计与选型.md §5.4
 */

export const PROTOCOL_VERSION = 1;

/** 消息类型。`ST_` 前缀；控制面用一次性消息，数据面用 Port。 */
export const ST = Object.freeze({
  // ---- 控制面（一次性消息）----
  PING: 'ST_PING',
  PONG: 'ST_PONG',
  ROUTE: 'ST_ROUTE',
  START: 'ST_START',
  STOP: 'ST_STOP',
  RETRY: 'ST_RETRY',
  CLEAR: 'ST_CLEAR',
  TOGGLE: 'ST_TOGGLE',
  GET_STATUS: 'ST_GET_STATUS',

  // ---- 数据面（Port: st-gateway）----
  TRANSLATE_SEGMENT: 'ST_TRANSLATE_SEGMENT',
  SEG_DELTA: 'ST_SEG_DELTA',
  SEG_DONE: 'ST_SEG_DONE',
  SEG_ERROR: 'ST_SEG_ERROR',
  CANCEL_SEGMENT: 'ST_CANCEL_SEGMENT',
  CLOSE: 'ST_CLOSE',

  // ---- 状态面（storage.session）----
  STATE: 'ST_STATE',
});

/** 翻译作用域。 */
export const SCOPE = Object.freeze({
  PAGE: 'page',
  PARAGRAPH: 'paragraph',
});

/** 触发来源，用于日志与后续统计。 */
export const SOURCE = Object.freeze({
  POPUP: 'popup',
  COMMAND: 'command',
  WIDGET: 'widget',
  CONTEXT_MENU: 'contextMenu',
});

/** 任务级状态机。 */
export const PHASE = Object.freeze({
  IDLE: 'idle',
  PREPARING: 'preparing',
  TRANSLATING: 'translating',
  DONE: 'done',
  PARTIAL: 'partial',
  ERROR: 'error',
  CANCELLED: 'cancelled',
});

/** 段落级状态。 */
export const SEGMENT_STATE = Object.freeze({
  PENDING: 'pending',
  INFLIGHT: 'inflight',
  STREAMING: 'streaming',
  DONE: 'done',
  FAILED: 'failed',
});

/** 错误码。`retryable` 由 {@link RETRYABLE_CODES} 推导，不要在调用处硬编码。 */
export const ERROR_CODE = Object.freeze({
  NO_KEY: 'NO_KEY',
  AUTH: 'AUTH',
  RATE_LIMIT: 'RATE_LIMIT',
  QUOTA: 'QUOTA',
  NETWORK: 'NETWORK',
  TIMEOUT: 'TIMEOUT',
  STREAM_BROKEN: 'STREAM_BROKEN',
  BAD_RESPONSE: 'BAD_RESPONSE',
  ABORTED: 'ABORTED',
  INJECT_FAIL: 'INJECT_FAIL',
  UNSUPPORTED_PAGE: 'UNSUPPORTED_PAGE',
});

/** 可重试的错误码集合。 */
export const RETRYABLE_CODES = Object.freeze(
  new Set([
    ERROR_CODE.RATE_LIMIT,
    ERROR_CODE.NETWORK,
    ERROR_CODE.TIMEOUT,
    ERROR_CODE.STREAM_BROKEN,
  ]),
);

/** 载荷上限。Background 侧必须校验，防止被页面构造的 content 消息撑爆。 */
export const LIMITS = Object.freeze({
  MAX_SEGMENT_CHARS: 4000,
  MAX_CONTEXT_CHARS: 400,
  MAX_INFLIGHT_PER_PORT: 4,
});

/** 状态镜像的存储键前缀（chrome.storage.session）。 */
export const STATUS_KEY_PREFIX = 'task:';

/** @param {number} tabId */
export function statusKey(tabId) {
  return `${STATUS_KEY_PREFIX}${tabId}`;
}

/**
 * 构造标准化错误对象。
 * @param {string} code
 * @param {string} message
 * @returns {{ code: string, message: string, retryable: boolean }}
 */
export function makeError(code, message) {
  return { code, message: String(message ?? ''), retryable: RETRYABLE_CODES.has(code) };
}

/** 是否为 `ST_` 命名空间的消息。 */
export function isStMessage(value) {
  return Boolean(value) && typeof value === 'object' && typeof value.type === 'string' && value.type.startsWith('ST_');
}

/**
 * 校验段请求（仅 Background 网关使用）。
 * @param {unknown} message
 * @returns {{ ok: true } | { ok: false, error: ReturnType<typeof makeError> }}
 */
export function validateSegmentRequest(message) {
  if (!isStMessage(message) || message.type !== ST.TRANSLATE_SEGMENT) {
    return { ok: false, error: makeError(ERROR_CODE.BAD_RESPONSE, '不是段翻译请求') };
  }
  if (typeof message.requestId !== 'string' || !message.requestId) {
    return { ok: false, error: makeError(ERROR_CODE.BAD_RESPONSE, '缺少 requestId') };
  }
  if (typeof message.text !== 'string' || !message.text.trim()) {
    return { ok: false, error: makeError(ERROR_CODE.BAD_RESPONSE, '段文本为空') };
  }
  if (message.text.length > LIMITS.MAX_SEGMENT_CHARS) {
    return { ok: false, error: makeError(ERROR_CODE.BAD_RESPONSE, `段文本超过 ${LIMITS.MAX_SEGMENT_CHARS} 字符`) };
  }
  const ctx = message.ctx;
  if (ctx != null) {
    if (typeof ctx !== 'object') {
      return { ok: false, error: makeError(ERROR_CODE.BAD_RESPONSE, 'ctx 必须是对象') };
    }
    const ctxLength = String(ctx.title ?? '').length + String(ctx.prev ?? '').length;
    if (ctxLength > LIMITS.MAX_CONTEXT_CHARS) {
      return { ok: false, error: makeError(ERROR_CODE.BAD_RESPONSE, `上下文超过 ${LIMITS.MAX_CONTEXT_CHARS} 字符`) };
    }
  }
  return { ok: true };
}
