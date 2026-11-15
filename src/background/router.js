/**
 * A1 消息路由（控制面）
 *
 * 模块：后台服务（A）/ A1
 * 职责：处理设置页的一次性消息：引擎列表与测试翻译；把结果回给调用方。
 * 依赖：E1（protocol）、E2（settings）、E3（instances/registry）、A3（adapter）、A2（gateway 的并发名额）。
 * 实现阶段：P2（后台网关与页面通道）
 *
 * P2 只落控制面；标签页转发（ST_ROUTE/ST_START/ST_TOGGLE/ST_CLEAR）随 P3/P6 落地。
 */

import {
  ERROR_CODES,
  FAILURE_REASONS,
  MESSAGE_TYPES,
  findForbiddenField,
  isKnownMessageType,
  makeError,
} from '../shared/protocol.js';
import { MAX_SEGMENT_CHARS } from '../shared/constants.js';
import { getSettings } from '../shared/settings.js';
import { getKey, getOrCreateDefaultInstance, getPublicSettings } from '../shared/config/instances.js';
import { validateInstance } from '../shared/config/registry.js';
import { isSupportedTargetLang, translate, TranslateError } from '../shared/translate/adapter.js';
import { normalizeConcurrency, withUpstreamSlot } from './gateway.js';

/**
 * 处理一条一次性消息。
 * @param {{ type?: string, payload?: object }} message
 * @param {{ id?: string }} sender
 * @returns {Promise<{ ok: true, data?: unknown } | { ok: false, error: object }>}
 */
export async function handleMessage(message, sender) {
  if (!sender || sender.id !== chrome.runtime.id) {
    return failure(ERROR_CODES.OTHER, '拒绝来自扩展外部的消息');
  }
  if (!message || typeof message !== 'object' || typeof message.type !== 'string') {
    return failure(ERROR_CODES.OTHER, '无法识别的消息', FAILURE_REASONS.INVALID_MESSAGE);
  }

  try {
    if (message.type === MESSAGE_TYPES.LIST_ENGINES) {
      return await listEngines();
    }
    if (message.type === MESSAGE_TYPES.TEST_ENGINE) {
      return await testEngine(message.payload);
    }
    const text = isKnownMessageType(message.type) ? '该消息暂未实现' : '无法识别的消息';
    return failure(ERROR_CODES.OTHER, text, FAILURE_REASONS.INVALID_MESSAGE);
  } catch (error) {
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

    return {
      ok: true,
      data: {
        text: result.text,
        elapsedMs,
        usage: result.usage ?? null,
      },
    };
  } catch (error) {
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
