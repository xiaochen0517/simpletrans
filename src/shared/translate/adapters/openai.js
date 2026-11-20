/**
 * A3 OpenAI 兼容适配器
 *
 * 模块：后台服务（A）/ A3
 * 职责：执行一次 OpenAI-compatible Chat Completions 调用：校验配置与凭据、检查主机权限、
 *       构造请求、发起 fetch、按流式/非流式解析、逐段回调、映射错误与取消、记录脱敏日志。
 * 依赖：E3 OpenAI 兼容配置（openai.js）、A3 请求/流/响应/错误/profile、A3 提示词与批量编码、
 *       E1 消息协议（错误码）、公共数值（超时）、E4 日志（P8-1 起）。
 * 实现阶段：P8-1（大模型 OpenAI 兼容协议与执行）
 *
 * 只读取调用方传入的 `instance.apiKey`，不读写存储；日志不记录密钥、完整 URL、请求头/体、原文/译文与提示词正文。
 */

import { AI_TIMEOUT_MS } from '../../constants.js';
import { ERROR_CODES } from '../../protocol.js';
import {
  OPENAI_ERROR_MESSAGES,
  normalizeOpenAIConfig,
  validateOpenAIConfig,
} from '../../config/openai.js';
import { createLogger } from '../../log/logger.js';
import {
  BATCH_ENCODING_VERSION,
  BatchAlignError,
  createBatchParser,
  encodeBatchInput,
  parseBatchOutput,
} from '../batch.js';
import {
  TranslateError,
  cancelledError,
  emptyTextError,
  mapHttpError,
  mapUnknownError,
} from '../openai-errors.js';
import { normalizeOutput, parseJsonCompletion, readErrorBody } from '../openai-response.js';
import { isEndpointPermitted } from '../openai-profile.js';
import { buildRequest } from '../openai-request.js';
import { readChatStream } from '../openai-stream.js';
import { PROMPT_VERSION, isDefaultPrompt } from '../prompt.js';

/** A3 日志入口。 */
const log = createLogger('A3');

/**
 * 归一并校验配置，检查凭据；失败抛 `TranslateError(CONFIG)`，不发请求。
 * @param {unknown} instance
 * @returns {import('../../config/openai.js').OpenAIConfig & Record<string, unknown>}
 */
function prepareConfig(instance) {
  const config = normalizeOpenAIConfig(instance);
  const validation = validateOpenAIConfig(config);
  if (!validation.ok) {
    throw new TranslateError(ERROR_CODES.CONFIG, validation.errors[0] ?? OPENAI_ERROR_MESSAGES.ENDPOINT);
  }
  const credential = String(instance?.apiKey ?? '').trim();
  if (config.auth.type !== 'none' && credential === '') {
    throw new TranslateError(ERROR_CODES.CONFIG, OPENAI_ERROR_MESSAGES.MISSING_KEY);
  }
  return config;
}

/**
 * 检查 endpoint 主机权限；未授权时抛 `CONFIG`，不构造/发送请求。
 * @param {import('../../config/openai.js').OpenAIConfig} config
 * @param {((request: { origins: string[] }) => Promise<boolean> | boolean) | undefined} checkPermission
 * @returns {Promise<void>}
 */
async function assertPermission(config, checkPermission) {
  const permitted = await isEndpointPermitted(config.endpoint.baseUrl, { contains: checkPermission });
  if (!permitted) {
    throw new TranslateError(ERROR_CODES.CONFIG, '未授权访问该接口域名，请到设置页重新授权');
  }
}

/**
 * 发起请求并解析响应；网络/超时/HTTP/解析错误统一归一为 `TranslateError`。
 * @param {{
 *   request: ReturnType<typeof buildRequest>,
 *   signal?: AbortSignal,
 *   fetchImpl?: Function,
 *   timeoutMs: number,
 *   onDelta?: (delta: string) => void,
 *   collect?: boolean,
 * }} params
 * @returns {Promise<{ text: string, usage: object | null, streamed: boolean }>}
 */
async function execute({ request, signal, fetchImpl, timeoutMs, onDelta, collect = true }) {
  const timeoutSignal = AbortSignal.timeout(timeoutMs);
  const merged = signal ? AbortSignal.any([signal, timeoutSignal]) : timeoutSignal;
  const doFetch = typeof fetchImpl === 'function' ? fetchImpl : globalThis.fetch;
  if (typeof doFetch !== 'function') {
    throw new TranslateError(ERROR_CODES.NETWORK, '网络错误或请求超时');
  }

  let response;
  try {
    response = await doFetch(request.url, {
      method: 'POST',
      headers: request.headers,
      body: JSON.stringify(request.body),
      signal: merged,
      redirect: 'error',
      credentials: 'omit',
      cache: 'no-store',
    });
  } catch (error) {
    throw mapUnknownError(error, { signal, timedOut: timeoutSignal.aborted });
  }

  try {
    if (!response || typeof response !== 'object') {
      throw new TranslateError(ERROR_CODES.OTHER, OPENAI_ERROR_MESSAGES.BAD_RESPONSE);
    }
    if (!response.ok) {
      let body = '';
      try {
        body = await readErrorBody(response);
      } catch {
        body = '';
      }
      throw mapHttpError(response.status, body);
    }

    const contentType = String(response.headers?.get?.('content-type') ?? '').toLowerCase();
    if (!request.stream || contentType.includes('application/json')) {
      const raw = typeof response.text === 'function' ? await response.text() : '';
      return { ...parseJsonCompletion(raw), streamed: false };
    }

    const result = await readChatStream(response, { onDelta, signal, collect });
    return { text: result.text, usage: result.usage, streamed: true };
  } catch (error) {
    // 批量解析器在流式增量里就可能抛对齐错误，保持 BATCH_ALIGN 原样上抛，不归一到 OTHER。
    if (error instanceof BatchAlignError) throw error;
    if (signal?.aborted) throw cancelledError();
    throw mapUnknownError(error, { signal, timedOut: timeoutSignal.aborted });
  }
}

/**
 * 记录请求开始日志；只含预设、模型、开关与版本，不含地址、密钥与提示词正文。
 * @param {import('../../config/openai.js').OpenAIConfig} config
 * @param {string} mode
 * @param {Record<string, unknown>} [extra]
 */
function logRequest(config, mode, extra = {}) {
  log.debug('engine.openai.request', '调用 OpenAI 兼容接口', {
    preset: config.preset,
    model: config.model,
    stream: config.endpoint.stream !== false,
    authType: config.auth.type,
    reasoningMode: config.params.reasoning.mode,
    promptVersion: PROMPT_VERSION,
    promptDefault: isDefaultPrompt(config.systemPrompt),
    mode,
    ...extra,
  });
}

/**
 * 记录失败日志并返回统一错误；不记录上游原始报文。
 * @param {unknown} error
 * @param {{ config: object | null, mode: string, startedAt: number, signal?: AbortSignal }} context
 * @returns {TranslateError}
 */
function finishError(error, { config, mode, startedAt, signal }) {
  const mapped = signal?.aborted ? cancelledError() : mapUnknownError(error, { signal });
  const elapsedMs = Date.now() - startedAt;
  if (mapped.code === ERROR_CODES.CANCELLED) {
    log.info('engine.openai.cancel', 'OpenAI 兼容接口调用已取消', {
      preset: config?.preset ?? null,
      model: config?.model ?? null,
      mode,
      elapsedMs,
    });
  } else {
    log.warn('engine.openai.error', 'OpenAI 兼容接口调用失败', {
      preset: config?.preset ?? null,
      model: config?.model ?? null,
      mode,
      code: mapped.code,
      elapsedMs,
    });
  }
  return mapped;
}

/**
 * 单段翻译：成功返回 `{ text, usage }`；失败抛 `TranslateError`。
 * `mode` 默认 `'single'`；快速翻译传 `'quick'`，使用快速输出格式。
 * @param {{
 *   text?: unknown,
 *   targetLang?: string,
 *   instance?: Record<string, unknown>,
 *   mode?: 'single'|'quick',
 *   onDelta?: (delta: string) => void,
 *   signal?: AbortSignal,
 *   fetchImpl?: Function,
 *   timeoutMs?: number,
 *   checkPermission?: (request: { origins: string[] }) => Promise<boolean> | boolean,
 * }} [params]
 * @returns {Promise<{ text: string, usage: object | null }>}
 */
export async function translate({
  text,
  targetLang,
  instance,
  mode = 'single',
  onDelta,
  signal,
  fetchImpl,
  timeoutMs,
  checkPermission,
} = {}) {
  const prompt = String(text ?? '');
  if (prompt.trim() === '') return { text: '', usage: null };
  const promptMode = mode === 'quick' ? 'quick' : 'single';

  const startedAt = Date.now();
  let config = null;
  try {
    config = prepareConfig(instance);
    if (signal?.aborted) throw cancelledError();
    await assertPermission(config, checkPermission);

    const request = buildRequest({
      config,
      apiKey: instance?.apiKey,
      systemPrompt: instance?.systemPrompt,
      targetLang,
      text: prompt,
      mode: promptMode,
    });
    logRequest(config, promptMode);

    const result = await execute({
      request,
      signal,
      fetchImpl,
      timeoutMs: timeoutMs ?? AI_TIMEOUT_MS.total,
      onDelta,
    });

    const normalized = normalizeOutput(result.text);
    if (normalized === '') throw emptyTextError();

    log.debug('engine.openai.done', 'OpenAI 兼容接口返回', {
      preset: config.preset,
      model: config.model,
      mode: promptMode,
      elapsedMs: Date.now() - startedAt,
      totalTokens: result.usage?.totalTokens ?? null,
    });
    return { text: normalized, usage: result.usage ?? null };
  } catch (error) {
    throw finishError(error, { config, mode: promptMode, startedAt, signal });
  }
}

/**
 * 多段批量翻译：一次请求，输入 JSONL，输出 JSONL；解析出一段就回调一段。
 *
 * - 空 `items` 直接返回 `{ usage: null }`，不发请求；
 * - 空译文不在这里失败，由 A2 按段处理；
 * - 对齐失败抛 `BatchAlignError`（`code = BATCH_ALIGN`），已解析段落保留。
 *
 * @param {{
 *   items?: Array<{ groupId: string, text: string }>,
 *   targetLang?: string,
 *   instance?: Record<string, unknown>,
 *   onItem?: (entry: { groupId: string, text: string }) => void,
 *   signal?: AbortSignal,
 *   fetchImpl?: Function,
 *   timeoutMs?: number,
 *   checkPermission?: (request: { origins: string[] }) => Promise<boolean> | boolean,
 * }} [params]
 * @returns {Promise<{ usage: object | null }>}
 */
export async function translateBatch({
  items,
  targetLang,
  instance,
  onItem,
  signal,
  fetchImpl,
  timeoutMs,
  checkPermission,
} = {}) {
  const list = Array.isArray(items) ? items : [];
  if (list.length === 0) return { usage: null };

  const startedAt = Date.now();
  let config = null;
  try {
    config = prepareConfig(instance);
    if (signal?.aborted) throw cancelledError();
    await assertPermission(config, checkPermission);

    const ids = list.map((item) => String(item?.groupId ?? ''));
    const emit = (entry) => {
      onItem?.({ groupId: entry.id, text: normalizeOutput(entry.text) });
    };
    let parser = null;

    const request = buildRequest({
      config,
      apiKey: instance?.apiKey,
      systemPrompt: instance?.systemPrompt,
      targetLang,
      text: encodeBatchInput(list),
      mode: 'batch',
    });
    logRequest(config, 'batch', {
      batchItems: list.length,
      encodingVersion: BATCH_ENCODING_VERSION,
    });

    if (request.stream) parser = createBatchParser(ids, { onItem: emit });

    const result = await execute({
      request,
      signal,
      fetchImpl,
      timeoutMs: timeoutMs ?? AI_TIMEOUT_MS.batchTotal,
      onDelta: parser ? (delta) => parser.push(delta) : undefined,
      collect: false,
    });

    if (parser && result.streamed) {
      parser.end();
    } else {
      parseBatchOutput(result.text, ids, { onItem: emit });
    }

    log.debug('engine.openai.done', 'OpenAI 兼容接口返回', {
      preset: config.preset,
      model: config.model,
      mode: 'batch',
      batchItems: list.length,
      elapsedMs: Date.now() - startedAt,
      totalTokens: result.usage?.totalTokens ?? null,
    });
    return { usage: result.usage ?? null };
  } catch (error) {
    if (error instanceof BatchAlignError) {
      log.warn('batch.align', '批量结果对齐失败', {
        preset: config?.preset ?? null,
        model: config?.model ?? null,
        mode: 'batch',
        counts: error.counts,
        elapsedMs: Date.now() - startedAt,
      });
      throw error;
    }
    throw finishError(error, { config, mode: 'batch', startedAt, signal });
  }
}
