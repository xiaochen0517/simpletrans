/**
 * A1 消息路由（控制面）
 *
 * 模块：后台服务（A）/ A1
 * 职责：处理设置页的一次性消息：引擎列表与测试翻译；把结果回给调用方。
 * 依赖：E1（protocol）、E2（settings）、E3（instances/registry）、A3（adapter）、A2（gateway 的并发名额）。
 * 实现阶段：P2（后台网关与页面通道）
 *
 * P2 只落控制面；标签页转发（ST_ROUTE/ST_START/ST_TOGGLE/ST_CLEAR）随 P4/P7 落地。
 */

import {
  ERROR_CODES,
  FAILURE_REASONS,
  MESSAGE_TYPES,
  findForbiddenField,
  isKnownMessageType,
  makeError,
  normalizeTraceId,
} from '../shared/protocol.js';
import { MAX_SEGMENT_CHARS } from '../shared/constants.js';
import { getSettings } from '../shared/settings.js';
import { createLogger } from '../shared/log/logger.js';
import { getKey, getOrCreateDefaultInstance, getPublicSettings } from '../shared/config/instances.js';
import { validateInstance } from '../shared/config/registry.js';
import { isSupportedTargetLang, translate, TranslateError } from '../shared/translate/adapter.js';
import { normalizeConcurrency, withUpstreamSlot } from './gateway.js';

/** A1 日志入口。 */
const log = createLogger('A1');

/** 每个标签页同一时刻只允许一次补注入。 */
const injecting = new Map();

/** Chrome 在目标页没有监听器时给出的错误特征。 */
const NO_RECEIVER_PATTERN =
  /Receiving end does not exist|Could not establish connection|message port closed/i;

/**
 * 处理一条一次性消息。
 * @param {{ type?: string, payload?: object }} message
 * @param {{ id?: string }} sender
 * @returns {Promise<{ ok: true, data?: unknown } | { ok: false, error: object }>}
 */
export async function handleMessage(message, sender) {
  if (!sender || sender.id !== chrome.runtime.id) {
    log.warn('message.rejected', '拒绝来自扩展外部的消息');
    return failure(ERROR_CODES.OTHER, '拒绝来自扩展外部的消息');
  }
  if (!message || typeof message !== 'object' || typeof message.type !== 'string') {
    log.warn('message.rejected', '无法识别的消息');
    return failure(ERROR_CODES.OTHER, '无法识别的消息', FAILURE_REASONS.INVALID_MESSAGE);
  }

  const traceId = normalizeTraceId(message.payload?.traceId);
  log.debug('message.received', '收到一次性消息', { type: message.type, traceId });

  try {
    let response;
    if (message.type === MESSAGE_TYPES.LIST_ENGINES) {
      response = await listEngines();
    } else if (message.type === MESSAGE_TYPES.TEST_ENGINE) {
      response = await testEngine(message.payload);
    } else {
      const text = isKnownMessageType(message.type) ? '该消息暂未实现' : '无法识别的消息';
      response = failure(ERROR_CODES.OTHER, text, FAILURE_REASONS.INVALID_MESSAGE);
    }

    if (!response.ok) {
      log.warn('message.rejected', '控制面请求失败', {
        type: message.type,
        code: response.error?.code,
        ...(response.error?.reason ? { reason: response.error.reason } : {}),
        ...(traceId ? { traceId } : {}),
      });
    }
    return response;
  } catch (error) {
    log.error('message.error', '控制面请求异常', { type: message.type }, error);
    return failure(ERROR_CODES.OTHER, `请求处理失败：${error?.message ?? error}`);
  }
}

/**
 * @returns {Promise<{ ok: true, data: { instances: Array<object> } }>}
 */
async function listEngines() {
  try {
    await getOrCreateDefaultInstance();
    const { instances } = await getPublicSettings();
    return {
      ok: true,
      data: {
        instances: instances.map((instance) => ({
          id: instance.id,
          type: instance.type,
          name: instance.name,
          model: instance.model,
          hasKey: Boolean(instance.hasKey),
        })),
      },
    };
  } catch (error) {
    return failure(ERROR_CODES.OTHER, `读取引擎列表失败：${error?.message ?? error}`);
  }
}

/**
 * @param {unknown} payload
 * @returns {Promise<{ ok: true, data: object } | { ok: false, error: object }>}
 */
async function testEngine(payload) {
  if (!payload || typeof payload !== 'object' || Array.isArray(payload)) {
    return failure(ERROR_CODES.OTHER, '请求参数无效', FAILURE_REASONS.INVALID_MESSAGE);
  }
  const traceId = normalizeTraceId(payload.traceId);
  const traceLog = log.withTrace(traceId);

  if (findForbiddenField(payload)) {
    return failure(ERROR_CODES.OTHER, '请求包含不允许的字段', FAILURE_REASONS.FORBIDDEN_FIELD);
  }

  const text = typeof payload.text === 'string' ? payload.text : '';
  if (text.trim() === '') {
    return failure(ERROR_CODES.OTHER, '请输入待翻译文本', FAILURE_REASONS.EMPTY_TEXT);
  }
  if (text.length > MAX_SEGMENT_CHARS) {
    return failure(
      ERROR_CODES.OTHER,
      `文本超过 ${MAX_SEGMENT_CHARS} 字符上限`,
      FAILURE_REASONS.TEXT_TOO_LONG
    );
  }

  let settings;
  try {
    settings = await getSettings();
  } catch {
    return failure(ERROR_CODES.CONFIG, '读取设置失败');
  }

  const targetLang = payload.targetLang ?? settings.targetLang;
  if (!isSupportedTargetLang(targetLang)) {
    return failure(ERROR_CODES.OTHER, '不支持的目标语言', FAILURE_REASONS.UNSUPPORTED_LANG);
  }

  traceLog.info('engine.test.start', '开始测试翻译', {
    textLength: text.length,
    targetLang,
  });

  let instance;
  let apiKey;
  try {
    instance = await getOrCreateDefaultInstance();
    if (!validateInstance(instance).ok) {
      return failure(ERROR_CODES.CONFIG, '引擎配置无效，请到设置页检查');
    }
    apiKey = await getKey(instance.id);
  } catch {
    return failure(ERROR_CODES.CONFIG, '读取引擎配置失败');
  }

  if (!apiKey) {
    return failure(ERROR_CODES.CONFIG, '缺少密钥，请先在设置页保存密钥');
  }

  let elapsedMs = 0;
  try {
    const result = await withUpstreamSlot(async () => {
      const startedAt = performance.now();
      try {
        return await translate({
          text,
          targetLang,
          instance: { ...instance, apiKey },
        });
      } finally {
        elapsedMs = Math.round(performance.now() - startedAt);
      }
    }, normalizeConcurrency(settings.concurrency));

    traceLog.info('engine.test.done', '测试翻译完成', {
      ok: true,
      elapsedMs,
      totalTokens: result.usage?.totalTokens ?? null,
    });

    return {
      ok: true,
      data: {
        text: result.text,
        elapsedMs,
        usage: result.usage ?? null,
      },
    };
  } catch (error) {
    const code = error instanceof TranslateError ? error.code : ERROR_CODES.OTHER;
    traceLog.warn('engine.test.done', '测试翻译失败', {
      ok: false,
      code,
      elapsedMs,
    });
    if (error instanceof TranslateError) {
      return failure(error.code, error.message);
    }
    return failure(ERROR_CODES.OTHER, `翻译失败：${error?.message ?? error}`);
  }
}

/**
 * @param {string} code
 * @param {string} message
 * @param {string} [reason]
 * @returns {{ ok: false, error: object }}
 */
function failure(code, message, reason) {
  return { ok: false, error: makeError(code, message, reason) };
}

/**
 * 把一次性命令送到标签页；页面注入未运行时先补样式再补脚本，然后重发一次。
 * @param {number} tabId
 * @param {{ type: string, payload?: object }} message
 * @returns {Promise<{ ok: true, data?: object } | { ok: false, error: object }>}
 */
export async function sendToTab(tabId, message) {
  if (typeof tabId !== 'number') {
    return failure(ERROR_CODES.OTHER, '没有可用的标签页', FAILURE_REASONS.NO_ACTIVE_TAB);
  }

  try {
    return await chrome.tabs.sendMessage(tabId, message);
  } catch (error) {
    if (!NO_RECEIVER_PATTERN.test(String(error?.message ?? error))) {
      log.warn('message.rejected', '无法与页面通信', {
        tabId,
        reason: FAILURE_REASONS.NO_RECEIVER,
      });
      return failure(
        ERROR_CODES.OTHER,
        '无法与页面通信，请刷新后重试',
        FAILURE_REASONS.NO_RECEIVER
      );
    }
  }

  try {
    await ensureInjected(tabId);
  } catch {
    return failure(
      ERROR_CODES.OTHER,
      '当前页面无法翻译，请在普通网页上使用',
      FAILURE_REASONS.INJECTION_FAILED
    );
  }

  try {
    return await chrome.tabs.sendMessage(tabId, message);
  } catch {
    return failure(
      ERROR_CODES.OTHER,
      '页面尚未准备好，请刷新后重试',
      FAILURE_REASONS.NO_RECEIVER
    );
  }
}

/**
 * 补注入页面脚本：先样式后脚本，与清单静态注入的顺序保持一致。
 * @param {number} tabId
 * @returns {Promise<void>}
 */
async function ensureInjected(tabId) {
  const running = injecting.get(tabId);
  if (running) return running;

  const job = (async () => {
    log.info('tab.inject', '页面未注入，开始补注入', { tabId });
    try {
      await chrome.scripting.insertCSS({ target: { tabId }, files: ['content.css'] });
      await chrome.scripting.executeScript({ target: { tabId }, files: ['content.js'] });
    } catch (error) {
      log.warn('tab.inject', '页面注入失败', {
        tabId,
        reason: FAILURE_REASONS.INJECTION_FAILED,
      });
      throw error;
    }
  })().finally(() => {
    injecting.delete(tabId);
  });

  injecting.set(tabId, job);
  return job;
}
