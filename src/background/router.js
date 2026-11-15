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
