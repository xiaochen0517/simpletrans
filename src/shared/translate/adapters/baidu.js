/**
 * A3 百度翻译适配器
 *
 * 模块：后台服务（A）/ A3
 * 职责：执行百度通用文本翻译：签名、语言码、POST 表单请求、原生批量、错误映射、超时与取消。
 * 依赖：E1 消息协议（错误码）、公共数值（百度超时与字节上限）、语言目录（语言码）、
 *       A3 错误类型（TranslateError 等）、A3 批量对齐错误、E4 日志（P8-2 起）。
 * 实现阶段：P8-2（设置数据规范化、多实例与百度翻译）
 *
 * 不流式：单段一次请求，多段一次原生批量（`q` 用换行分隔）。
 * 不把上游原始报文透传给页面；日志只记错误码、实例 ID、字符数与耗时，不记原文/译文与密钥。
 */

import md5 from 'js-md5';
import {
  BAIDU_BATCH_MAX_BYTES,
  BAIDU_SEGMENT_MAX_BYTES,
  BAIDU_TIMEOUT_MS,
} from '../../constants.js';
import { ERROR_CODES } from '../../protocol.js';
import { toBaiduLang } from '../../languages.js';
import { createLogger } from '../../log/logger.js';
import { BatchAlignError } from '../batch.js';
import {
  TranslateError,
  cancelledError,
  emptyTextError,
  mapUnknownError,
} from '../openai-errors.js';

/** A3 日志入口。 */
const log = createLogger('A3');

/** 百度通用文本翻译接口地址。 */
export const BAIDU_ENDPOINT = 'https://fanyi-api.baidu.com/api/trans/vip/translate';

/** 百度成功错误码。 */
export const BAIDU_SUCCESS_CODE = '52000';

const encoder = new TextEncoder();

/**
 * 计算 UTF-8 字节数。
 * @param {unknown} text
 * @returns {number}
 */
export function utf8Bytes(text) {
  return encoder.encode(String(text ?? '')).length;
}

/**
 * 文本归一：统一换行并把连续换行替换为空格，避免源换行被当作批量分段。
 * 缓存 key 仍使用原文，本函数只作用于请求。
 * @param {unknown} text
 * @returns {string}
 */
export function normalizeBaiduText(text) {
  return String(text ?? '')
    .replace(/\r\n?/g, '\n')
    .replace(/\n+/g, ' ');
}

/**
 * 计算百度签名：`MD5(appid + q + salt + secretKey)`，32 位小写。
 * q 使用 UTF-8 原文，签名前不做 URL 编码。
 * @param {{ appId: string, q: string, salt: string, secretKey: string }} params
 * @returns {string}
 */
export function signBaidu({ appId, q, salt, secretKey }) {
  return md5(`${appId}${q}${salt}${secretKey}`).toLowerCase();
}

/**
 * 生成随机 salt；测试可注入固定值。
 * @returns {string}
 */
function createSalt() {
  const random = Math.floor(Math.random() * 1_000_000_000);
  return String(random + 1);
}

/**
 * 把百度错误码映射为统一错误；未知码归入 OTHER。
 * @param {unknown} errorCode
 * @returns {TranslateError}
 */
export function mapBaiduError(errorCode) {
  const code = String(errorCode ?? '');
  if (code === '52001' || code === '52002') {
    return new TranslateError(ERROR_CODES.NETWORK, '网络错误或服务暂不可用');
  }
  if (code === '52003' || code === '54001' || code === '90107') {
    return new TranslateError(ERROR_CODES.AUTH, 'APPID 或密钥无效');
  }
  if (code === '54000') {
    return new TranslateError(ERROR_CODES.CONFIG, 'APPID 或密钥未配置完整');
  }
  if (code === '54003' || code === '54005') {
    return new TranslateError(ERROR_CODES.RATE_LIMIT, '请求过于频繁，请稍后重试');
  }
  if (code === '54004') {
    return new TranslateError(ERROR_CODES.AUTH, '账户余额不足');
  }
  if (code === '20003') {
    return new TranslateError(ERROR_CODES.OTHER, '文本存在安全风险');
  }
  if (code === '58000') {
    return new TranslateError(ERROR_CODES.CONFIG, '当前网络无法使用百度翻译');
  }
  if (code === '58001' || code === '58002' || code === '58003') {
    return new TranslateError(ERROR_CODES.OTHER, '语言或翻译服务暂不可用');
  }
  return new TranslateError(ERROR_CODES.OTHER, '翻译失败，请稍后重试');
}

/**
 * 校验并读取 APPID 与密钥。
 * @param {Record<string, unknown>} instance
 * @returns {{ appId: string, secretKey: string }}
 */
function readCredentials(instance) {
  const appId = String(instance?.appId ?? '').trim();
  const secretKey = String(instance?.secretKey ?? '').trim();
  if (appId === '' || secretKey === '') {
    throw new TranslateError(ERROR_CODES.CONFIG, 'APPID 或密钥未配置完整');
  }
  return { appId, secretKey };
}

/**
 * 解析目标语言码；不支持或 `auto` 时抛 CONFIG。
 * @param {unknown} targetLang
 * @returns {string}
 */
function resolveTargetCode(targetLang) {
  const code = toBaiduLang(targetLang);
  if (!code || code === 'auto') {
    throw new TranslateError(ERROR_CODES.OTHER, '不支持的目标语言');
  }
  return code;
}

/**
 * 解析源语言码：只允许 `auto` / `en`，非法值回退 `auto`。
 * @param {unknown} sourceLang
 * @returns {string}
 */
function resolveSourceCode(sourceLang) {
  const code = toBaiduLang(sourceLang);
  return code === 'en' ? 'en' : 'auto';
}

/**
 * 把 HTTP 状态映射为统一错误。
 * @param {number} status
 * @returns {TranslateError}
 */
function mapHttpStatus(status) {
  if (status === 401 || status === 403) {
    return new TranslateError(ERROR_CODES.AUTH, 'APPID 或密钥无效');
  }
  if (status === 429) {
    return new TranslateError(ERROR_CODES.RATE_LIMIT, '请求过于频繁，请稍后重试');
  }
  return new TranslateError(ERROR_CODES.NETWORK, '网络错误或服务暂不可用');
}

/**
 * 发起一次百度翻译请求并返回 `trans_result`。
 * @param {{
 *   q: string,
 *   from: string,
 *   to: string,
 *   appId: string,
 *   secretKey: string,
 *   signal?: AbortSignal,
 *   fetchImpl?: Function,
 *   timeoutMs: number,
 *   salt?: string,
 * }} params
 * @returns {Promise<Array<{ src?: string, dst?: string }>>}
 */
async function requestBaidu({
  q,
  from,
  to,
  appId,
  secretKey,
  signal,
  fetchImpl,
  timeoutMs,
  salt,
}) {
  const doFetch = typeof fetchImpl === 'function' ? fetchImpl : globalThis.fetch;
  if (typeof doFetch !== 'function') {
    throw new TranslateError(ERROR_CODES.NETWORK, '网络错误或服务暂不可用');
  }

  const saltValue = salt == null ? createSalt() : String(salt);
  const sign = signBaidu({ appId, q, salt: saltValue, secretKey });
  const body = new URLSearchParams({ q, from, to, appid: appId, salt: saltValue, sign });

  const timeoutSignal = AbortSignal.timeout(timeoutMs);
  const merged = signal ? AbortSignal.any([signal, timeoutSignal]) : timeoutSignal;

  let response;
  try {
    response = await doFetch(BAIDU_ENDPOINT, {
      method: 'POST',
      headers: {
        'content-type': 'application/x-www-form-urlencoded;charset=UTF-8',
        accept: 'application/json',
      },
      body: body.toString(),
      signal: merged,
      redirect: 'error',
      credentials: 'omit',
      cache: 'no-store',
    });
  } catch (error) {
    if (signal?.aborted) throw cancelledError();
    throw mapUnknownError(error, { signal, timedOut: timeoutSignal.aborted });
  }

  try {
    if (!response || typeof response !== 'object') {
      throw new TranslateError(ERROR_CODES.OTHER, '翻译失败，请稍后重试');
    }
    if (!response.ok) throw mapHttpStatus(Number(response.status));

    const raw = typeof response.text === 'function' ? await response.text() : '';
    let payload;
    try {
      payload = JSON.parse(raw);
    } catch {
      throw new TranslateError(ERROR_CODES.OTHER, '翻译失败，请稍后重试');
    }
    if (!payload || typeof payload !== 'object') {
      throw new TranslateError(ERROR_CODES.OTHER, '翻译失败，请稍后重试');
    }
    if (payload.error_code != null && String(payload.error_code) !== BAIDU_SUCCESS_CODE) {
      throw mapBaiduError(payload.error_code);
    }
    if (!Array.isArray(payload.trans_result)) {
      throw new TranslateError(ERROR_CODES.OTHER, '翻译失败，请稍后重试');
    }
    return payload.trans_result;
  } catch (error) {
    if (error instanceof TranslateError) {
      if (signal?.aborted) throw cancelledError();
      throw error;
    }
    if (signal?.aborted) throw cancelledError();
    throw mapUnknownError(error, { signal, timedOut: timeoutSignal.aborted });
  }
}

/**
 * 单段翻译：成功返回 `{ text, usage: null }`；失败抛 `TranslateError`。
 * @param {{
 *   text?: unknown,
 *   targetLang?: string,
 *   sourceLang?: string,
 *   instance?: Record<string, unknown>,
 *   signal?: AbortSignal,
 *   fetchImpl?: Function,
 *   timeoutMs?: number,
 *   salt?: string,
 * }} [params]
 * @returns {Promise<{ text: string, usage: null }>}
 */
export async function translate({
  text,
  targetLang,
  sourceLang,
  instance,
  signal,
  fetchImpl,
  timeoutMs,
  salt,
} = {}) {
  const raw = String(text ?? '');
  if (raw.trim() === '') return { text: '', usage: null };

  const startedAt = Date.now();
  const { appId, secretKey } = readCredentials(instance);
  const to = resolveTargetCode(targetLang);
  const from = resolveSourceCode(sourceLang);
  const q = normalizeBaiduText(raw);

  const bytes = utf8Bytes(q);
  if (bytes > BAIDU_SEGMENT_MAX_BYTES) {
    throw new TranslateError(ERROR_CODES.OTHER, '文本过长，请分段后重试');
  }

  log.debug('engine.baidu.request', '调用百度翻译接口', {
    instanceId: instance?.id ?? null,
    mode: 'single',
    chars: raw.length,
    bytes,
    from,
    to,
  });

  try {
    if (signal?.aborted) throw cancelledError();
    const transResult = await requestBaidu({
      q,
      from,
      to,
      appId,
      secretKey,
      signal,
      fetchImpl,
      timeoutMs: timeoutMs ?? BAIDU_TIMEOUT_MS.single,
      salt,
    });
    const dst = transResult[0]?.dst;
    if (typeof dst !== 'string' || dst.trim() === '') throw emptyTextError();

    log.debug('engine.baidu.done', '百度翻译接口返回', {
      instanceId: instance?.id ?? null,
      mode: 'single',
      elapsedMs: Date.now() - startedAt,
      chars: raw.length,
    });
    return { text: dst, usage: null };
  } catch (error) {
    throw finishError(error, { instance, mode: 'single', startedAt, signal });
  }
}

/**
 * 多段批量翻译：一次原生批量请求（`q` 用换行分隔），按输入顺序逐段回调。
 * 数量/顺序不符抛 `BatchAlignError`；空译文按段回调空串，由 A2 判定失败。
 * @param {{
 *   items?: Array<{ groupId: string, text: string }>,
 *   targetLang?: string,
 *   sourceLang?: string,
 *   instance?: Record<string, unknown>,
 *   onItem?: (entry: { groupId: string, text: string }) => void,
 *   signal?: AbortSignal,
 *   fetchImpl?: Function,
 *   timeoutMs?: number,
 *   salt?: string,
 * }} [params]
 * @returns {Promise<{ usage: null }>}
 */
export async function translateBatch({
  items,
  targetLang,
  sourceLang,
  instance,
  onItem,
  signal,
  fetchImpl,
  timeoutMs,
  salt,
} = {}) {
  const list = Array.isArray(items) ? items : [];
  if (list.length === 0) return { usage: null };

  const startedAt = Date.now();
  const { appId, secretKey } = readCredentials(instance);
  const to = resolveTargetCode(targetLang);
  const from = resolveSourceCode(sourceLang);

  const normalized = list.map((item) => normalizeBaiduText(item?.text));
  if (normalized.some((text) => text.trim() === '')) {
    throw new TranslateError(ERROR_CODES.OTHER, '存在空文本段落');
  }
  const q = normalized.join('\n');
  const bytes = utf8Bytes(q);
  if (bytes > BAIDU_BATCH_MAX_BYTES) {
    throw new TranslateError(ERROR_CODES.OTHER, '文本过长，请缩小批次后重试');
  }

  log.debug('engine.baidu.request', '调用百度翻译接口', {
    instanceId: instance?.id ?? null,
    mode: 'batch',
    items: list.length,
    chars: normalized.reduce((sum, text) => sum + text.length, 0),
    bytes,
    from,
    to,
  });

  try {
    if (signal?.aborted) throw cancelledError();
    const transResult = await requestBaidu({
      q,
      from,
      to,
      appId,
      secretKey,
      signal,
      fetchImpl,
      timeoutMs: timeoutMs ?? BAIDU_TIMEOUT_MS.batch,
      salt,
    });

    if (transResult.length !== list.length) {
      throw new BatchAlignError(
        transResult.length > list.length
          ? { extra: transResult.length - list.length }
          : { missing: list.length - transResult.length }
      );
    }
    list.forEach((item, index) => {
      const dst = transResult[index]?.dst;
      if (typeof dst !== 'string') throw new BatchAlignError({ invalid: 1 });
      onItem?.({ groupId: String(item?.groupId ?? ''), text: dst });
    });

    log.debug('engine.baidu.done', '百度翻译接口返回', {
      instanceId: instance?.id ?? null,
      mode: 'batch',
      items: list.length,
      elapsedMs: Date.now() - startedAt,
      chars: normalized.reduce((sum, text) => sum + text.length, 0),
    });
    return { usage: null };
  } catch (error) {
    throw finishError(error, { instance, mode: 'batch', startedAt, signal });
  }
}

/**
 * 记录失败日志并返回统一错误；取消单独记 info，不记上游报文。
 * @param {unknown} error
 * @param {{ instance?: Record<string, unknown>, mode: string, startedAt: number, signal?: AbortSignal }} context
 * @returns {Error}
 */
function finishError(error, { instance, mode, startedAt, signal }) {
  const elapsedMs = Date.now() - startedAt;
  if (error instanceof BatchAlignError) {
    log.warn('batch.align', '百度批量结果对齐失败', {
      instanceId: instance?.id ?? null,
      mode,
      counts: error.counts,
      elapsedMs,
    });
    return error;
  }
  const mapped = signal?.aborted
    ? cancelledError()
    : error instanceof TranslateError
      ? error
      : mapUnknownError(error, { signal });

  if (mapped.code === ERROR_CODES.CANCELLED) {
    log.info('engine.baidu.cancel', '百度翻译调用已取消', {
      instanceId: instance?.id ?? null,
      mode,
      elapsedMs,
    });
  } else {
    log.warn('engine.baidu.error', '百度翻译调用失败', {
      instanceId: instance?.id ?? null,
      mode,
      code: mapped.code,
      elapsedMs,
    });
  }
  return mapped;
}
