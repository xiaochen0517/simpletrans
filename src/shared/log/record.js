/**
 * E4 日志记录
 *
 * 模块：公共模块（E）/ E4
 * 职责：构造日志记录、脱敏与截断、生成控制台单行文本、生成会话 ID。
 * 依赖：无（P3 起）。
 * 实现阶段：P3（日志模块与调试输出）
 *
 * 约束：不读写浏览器存储，不含密钥/鉴权/服务商域名字面量；
 *       字符串中的完整 URL 只保留来源，敏感字段统一替换。
 */

/** 单条日志的截断上限。 */
export const LOG_LIMITS = Object.freeze({
  maxString: 200,
  maxStack: 2000,
  maxArray: 20,
  maxKeys: 20,
  maxDepth: 2,
  maxDataChars: 4000,
});

/** 上下文到控制台前缀的缩写。 */
export const LOG_CONTEXTS = Object.freeze({
  background: 'bg',
  popup: 'popup',
  options: 'options',
  content: 'content',
});

/** 敏感字段名：命中即整体替换，不打印值。 */
const SENSITIVE_FIELD = /key|token|secret|auth|pass|credential/i;

/** 字符串中的完整 URL；替换为来源。 */
const URL_PATTERN = /https?:\/\/[^\s"'<>]+/gi;

/** 形似服务商密钥的短串；不写出具体前缀字面量，避免进入 content 产物。 */
const TOKEN_PATTERN = /\bs\w-[A-Za-z0-9_-]{8,}\b/g;

/** 形似鉴权头的短串；同样不写出完整字面量。 */
const AUTH_HEADER_PATTERN = /\bB\w+er\s+[A-Za-z0-9._~+/-]{8,}/g;

/**
 * 截断字符串。
 * @param {string} value
 * @param {number} max
 * @returns {string}
 */
function truncate(value, max) {
  return value.length > max ? `${value.slice(0, Math.max(0, max - 1))}…` : value;
}

/**
 * 脱敏并截断一段文本：完整 URL 只保留来源，密钥/鉴权样式短串替换。
 * @param {unknown} value
 * @param {number} max
 * @returns {string}
 */
export function sanitizeText(value, max = LOG_LIMITS.maxString) {
  let out = String(value ?? '');
  out = out.replace(URL_PATTERN, (raw) => {
    try {
      return new URL(raw).origin;
    } catch {
      return '[url]';
    }
  });
  out = out.replace(TOKEN_PATTERN, '[redacted]');
  out = out.replace(AUTH_HEADER_PATTERN, '[redacted]');
  return truncate(out, max);
}

/**
 * 递归脱敏一个值。
 * @param {unknown} value
 * @param {number} depth
 * @param {WeakSet<object>} seen
 * @returns {unknown}
 */
function sanitizeValue(value, depth, seen) {
  if (value == null) return value;
  if (typeof value === 'string') return sanitizeText(value);
  if (typeof value === 'number' || typeof value === 'boolean') return value;
  if (typeof value === 'bigint') return `${value}n`;
  if (typeof value === 'function' || typeof value === 'symbol') return `[${typeof value}]`;
  if (typeof value !== 'object') return String(value);
  if (value instanceof Date) return value.toISOString();
  if (value instanceof Error) return sanitizeError(value);
  if (depth >= LOG_LIMITS.maxDepth) return '[truncated]';
  if (seen.has(value)) return '[circular]';

  seen.add(value);
  try {
    if (Array.isArray(value)) {
      const out = value
        .slice(0, LOG_LIMITS.maxArray)
        .map((item) => sanitizeValue(item, depth, seen));
      if (value.length > LOG_LIMITS.maxArray) out.push(`…(+${value.length - LOG_LIMITS.maxArray})`);
      return out;
    }

    const entries = Object.entries(value);
    const out = {};
    for (const [key, child] of entries.slice(0, LOG_LIMITS.maxKeys)) {
      out[key] = SENSITIVE_FIELD.test(key) ? '[redacted]' : sanitizeValue(child, depth + 1, seen);
    }
    if (entries.length > LOG_LIMITS.maxKeys) out.truncated = `…(+${entries.length - LOG_LIMITS.maxKeys})`;
    return out;
  } finally {
    seen.delete(value);
  }
}

/**
 * 生成可序列化字符串。
 * @param {unknown} value
 * @returns {string}
 */
function safeStringify(value) {
  try {
    return JSON.stringify(value, (_key, child) => (typeof child === 'bigint' ? `${child}n` : child));
  } catch {
    return '"[unserializable]"';
  }
}

/**
 * 脱敏日志数据；超过大小上限时保留预览。
 * @param {unknown} value
 * @returns {unknown}
 */
export function sanitizeData(value) {
  if (value == null) return undefined;
  const clean = sanitizeValue(value, 0, new WeakSet());
  const json = safeStringify(clean);
  if (json.length <= LOG_LIMITS.maxDataChars) return clean;
  return {
    truncated: true,
    preview: truncate(json, LOG_LIMITS.maxDataChars - 40),
  };
}

/**
 * 脱敏错误对象；只保留安全字段与截断后的栈。
 * @param {unknown} error
 * @returns {{ name?: string, message?: string, code?: string, reason?: string, stack?: string }}
 */
export function sanitizeError(error) {
  if (error == null) return { message: '未知错误' };
  if (typeof error !== 'object') return { message: sanitizeText(error) };

  /** @type {Record<string, unknown>} */
  const source = error;
  const nested = source.error && typeof source.error === 'object' ? source.error : null;
  /** @type {{ name?: string, message?: string, code?: string, reason?: string, stack?: string }} */
  const out = {};

  const name = source.name ?? nested?.name;
  if (typeof name === 'string' && name) out.name = sanitizeText(name);
  const message = source.message ?? nested?.message;
  if (typeof message === 'string' && message) out.message = sanitizeText(message);
  if (typeof source.code === 'string' && source.code) out.code = sanitizeText(source.code);
  if (typeof source.reason === 'string' && source.reason) out.reason = sanitizeText(source.reason);
  const stack = source.stack ?? nested?.stack;
  if (typeof stack === 'string' && stack) out.stack = sanitizeText(stack, LOG_LIMITS.maxStack);

  return Object.keys(out).length > 0 ? out : { message: '未知错误' };
}

/**
 * 生成会话 ID；优先随机 UUID，HTTP 页面等非安全上下文走时间 + 随机数回退。
 * @returns {string}
 */
export function createSessionId() {
  const cryptoObj = globalThis.crypto;
  if (cryptoObj && typeof cryptoObj.randomUUID === 'function') {
    try {
      return cryptoObj.randomUUID();
    } catch {
      // 回退到时间 + 随机数。
    }
  }
  return `s-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 10)}`;
}

/**
 * 构造一条日志记录。
 * @param {{
 *   level: string,
 *   scope: string,
 *   ctx: string,
 *   event: string,
 *   message: string,
 *   data?: unknown,
 *   error?: unknown,
 *   traceId?: string,
 *   sessionId?: string,
 *   now?: number,
 * }} params
 * @returns {object}
 */
export function createRecord({
  level,
  scope,
  ctx,
  event,
  message,
  data,
  error,
  traceId,
  sessionId,
  now,
}) {
  /** @type {Record<string, unknown>} */
  const record = {
    ts: Number.isFinite(now) ? now : Date.now(),
    level,
    ctx,
    scope: String(scope ?? 'E4'),
    event: String(event ?? 'log'),
    message: sanitizeText(message ?? ''),
    sessionId: sessionId ?? null,
  };

  if (data !== undefined) {
    const clean = sanitizeData(data);
    if (clean !== undefined) record.data = clean;
  }
  if (error !== undefined && error !== null) record.err = sanitizeError(error);
  if (traceId) record.traceId = traceId;
  return record;
}

/**
 * 本地时间：YYYY-MM-DD HH:mm:ss.SSS。
 * @param {number} ts
 * @returns {string}
 */
export function formatTime(ts) {
  const date = new Date(ts);
  const pad = (n, width = 2) => String(n).padStart(width, '0');
  return (
    `${date.getFullYear()}-${pad(date.getMonth() + 1)}-${pad(date.getDate())} ` +
    `${pad(date.getHours())}:${pad(date.getMinutes())}:${pad(date.getSeconds())}.${pad(date.getMilliseconds(), 3)}`
  );
}

/**
 * 生成控制台单行文本。
 * @param {object} record
 * @returns {string}
 */
export function formatLine(record) {
  const ctx = LOG_CONTEXTS[record.ctx] ?? record.ctx ?? '?';
  const level = String(record.level ?? 'info').toUpperCase();
  const trace = record.traceId ? `[trace:${record.traceId}]` : '';
  const prefix = `[SimpleTrans][${formatTime(record.ts)}][${ctx}][${record.scope}][${level}]${trace}`;

  /** @type {Record<string, unknown>} */
  const payload = {};
  if (record.data !== undefined) payload.data = record.data;
  if (record.err !== undefined) payload.error = record.err;
  const json = Object.keys(payload).length > 0 ? ` ${safeStringify(payload)}` : '';
  const event = record.event ? `${record.event} ` : '';
  return `${prefix} ${event}${record.message}${json}`;
}
