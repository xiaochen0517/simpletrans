/**
 * A3 OpenAI 兼容错误映射
 *
 * 模块：后台服务（A）/ A3
 * 职责：把 HTTP 状态、响应体错误对象、流内 error 与网络/取消/超时异常映射为统一错误码与用户提示；
 *       定义 A3 的 `TranslateError`。
 * 依赖：E1 消息协议（错误码）。
 *
 * 不把上游原始报文透传给页面；日志只记错误码，不记响应体、密钥、URL 与请求头/体。
 */

import { ERROR_CODES } from '../protocol.js';
import { OPENAI_ERROR_MESSAGES } from '../config/openai.js';

/**
 * 携带统一错误码的可抛出错误。
 */
export class TranslateError extends Error {
  /**
   * @param {string} code 统一错误码（见 ERROR_CODES）
   * @param {string} message 用户可见提示
   */
  constructor(code, message) {
    super(message);
    this.name = 'TranslateError';
    this.code = code;
  }
}

/**
 * 构造 `CONFIG` 错误。
 * @param {string} [message]
 * @returns {TranslateError}
 */
export function configError(message = OPENAI_ERROR_MESSAGES.ENDPOINT) {
  return new TranslateError(ERROR_CODES.CONFIG, message);
}

/**
 * 构造 `OTHER` 格式不支持错误。
 * @returns {TranslateError}
 */
export function formatError() {
  return new TranslateError(ERROR_CODES.OTHER, OPENAI_ERROR_MESSAGES.BAD_RESPONSE);
}

/**
 * 构造取消错误。
 * @returns {TranslateError}
 */
export function cancelledError() {
  return new TranslateError(ERROR_CODES.CANCELLED, '翻译已取消');
}

/**
 * 构造空译文错误。
 * @returns {TranslateError}
 */
export function emptyTextError() {
  return new TranslateError(ERROR_CODES.OTHER, OPENAI_ERROR_MESSAGES.EMPTY_TEXT);
}

/**
 * 判断错误体是否在说「参数不被支持」。
 * @param {string} text 小写后的响应体
 * @returns {boolean}
 */
function isUnsupportedParam(text) {
  return /unsupported|not supported|invalid parameter|unknown parameter|unrecognized|extra fields|not allowed|invalid value|invalid request/i.test(
    text
  );
}

/**
 * 把 HTTP 状态与有限长度的错误体映射为统一错误。
 * 只按状态码与关键词分类，不返回上游原始报文。
 * @param {number} status
 * @param {unknown} [bodyText]
 * @returns {TranslateError}
 */
export function mapHttpError(status, bodyText = '') {
  const text = String(bodyText ?? '').toLowerCase();
  const code = Number(status);

  if (code === 401 || code === 403) {
    return new TranslateError(ERROR_CODES.AUTH, '密钥无效或鉴权失败');
  }
  if (code === 402) {
    return new TranslateError(ERROR_CODES.AUTH, '额度不足或账户欠费');
  }
  if (code === 429) {
    return new TranslateError(ERROR_CODES.RATE_LIMIT, '请求过于频繁，请稍后重试');
  }
  if (code === 404) {
    return configError();
  }
  if (code === 400 || code === 422) {
    if (/invalid api key|unauthorized|authentication/i.test(text)) {
      return new TranslateError(ERROR_CODES.AUTH, '密钥无效或鉴权失败');
    }
    if (/rate limit|too many requests/i.test(text)) {
      return new TranslateError(ERROR_CODES.RATE_LIMIT, '请求过于频繁，请稍后重试');
    }
    if (isUnsupportedParam(text)) {
      return new TranslateError(ERROR_CODES.CONFIG, OPENAI_ERROR_MESSAGES.PARAMS);
    }
    return new TranslateError(ERROR_CODES.CONFIG, '请求参数无效，请检查接口配置');
  }
  if (code === 408 || code === 504) {
    return new TranslateError(ERROR_CODES.NETWORK, '网络错误或请求超时');
  }
  if (code >= 500 && code <= 599) {
    return new TranslateError(ERROR_CODES.NETWORK, '网络错误或请求超时');
  }
  return new TranslateError(ERROR_CODES.OTHER, '翻译失败，请稍后重试');
}

/**
 * 把流内 error 事件（`{ error: {...} }` 或 `{ type: 'error', ... }`）映射为统一错误。
 * @param {unknown} payload 已解析的事件对象
 * @returns {TranslateError}
 */
export function mapStreamError(payload) {
  const source = payload && typeof payload === 'object' ? payload : {};
  const error =
    source.error && typeof source.error === 'object'
      ? source.error
      : source.type === 'error'
        ? source
        : source;

  const status = Number(error.status ?? error.status_code ?? source.status ?? 0);
  if (status >= 400) return mapHttpError(status, String(error.message ?? ''));

  const code = String(error.code ?? error.type ?? '').toLowerCase();
  const message = String(error.message ?? '').toLowerCase();

  if (/authentication|unauthorized|invalid_api_key|invalid api key/.test(code) ||
      /invalid api key|unauthorized|authentication/.test(message)) {
    return new TranslateError(ERROR_CODES.AUTH, '密钥无效或鉴权失败');
  }
  if (/rate_limit|too many requests/.test(code) || /rate limit|too many requests/.test(message)) {
    return new TranslateError(ERROR_CODES.RATE_LIMIT, '请求过于频繁，请稍后重试');
  }
  if (/invalid_request|parameter|unsupported|not supported/.test(code) ||
      /unsupported|not supported|invalid parameter|unknown parameter/.test(message)) {
    return new TranslateError(ERROR_CODES.CONFIG, OPENAI_ERROR_MESSAGES.PARAMS);
  }
  if (/server_error|overloaded|timeout|unavailable/.test(code) ||
      /overloaded|timeout|unavailable|server error/.test(message)) {
    return new TranslateError(ERROR_CODES.NETWORK, '网络错误或请求超时');
  }
  return new TranslateError(ERROR_CODES.OTHER, OPENAI_ERROR_MESSAGES.BAD_RESPONSE);
}

/**
 * 把任意异常归一为 `TranslateError`。
 *
 * - 外部取消优先于超时：`signal.aborted` 为真时返回 `CANCELLED`；
 * - 本模块超时（`timedOut`）与网络类异常返回 `NETWORK`；
 * - 其它异常返回 `OTHER`，不带上游原始报文。
 *
 * @param {unknown} error
 * @param {{ signal?: AbortSignal, timedOut?: boolean }} [options]
 * @returns {TranslateError}
 */
export function mapUnknownError(error, { signal, timedOut } = {}) {
  if (error instanceof TranslateError) return error;
  if (signal?.aborted) return cancelledError();
  if (timedOut === true) return new TranslateError(ERROR_CODES.NETWORK, '网络错误或请求超时');

  const name = String(error?.name ?? '');
  const message = String(error?.message ?? '');
  const lower = message.toLowerCase();

  if (/AbortError|TimeoutError/i.test(name)) {
    return new TranslateError(ERROR_CODES.NETWORK, '网络错误或请求超时');
  }
  if (
    /TypeError|NetworkError|FetchError/i.test(name) ||
    /network|fetch|econnrefused|econnreset|etimedout|connection|socket|failed to fetch/i.test(lower)
  ) {
    return new TranslateError(ERROR_CODES.NETWORK, '网络错误或请求超时');
  }
  return new TranslateError(ERROR_CODES.OTHER, '翻译失败，请稍后重试');
}
