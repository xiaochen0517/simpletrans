/**
 * A5 快速翻译
 *
 * 模块：后台服务（A）/ A5
 * 职责：处理弹窗的一次性快速翻译请求：校验参数与实例、选择提示词、调用 A3、返回纯文本结果。
 * 依赖：E1 消息协议、E2 设置、E3 实例与类型目录、A3 适配器、A2 上游并发名额、公共数值、E4 日志。
 *
 * 快速翻译不读写 A4 缓存、不注册提交、不流式、不写页面状态；实例与目标语言来自弹窗当次选择。
 * 日志只记长度、实例、类型、耗时、用量与错误码，不记原文、译文与提示词正文。
 */

import { AI_TIMEOUT_MS, BAIDU_TIMEOUT_MS, MAX_SEGMENT_CHARS } from '../shared/constants.js';
import {
  ERROR_CODES,
  FAILURE_REASONS,
  findForbiddenField,
  makeError,
  normalizeTraceId,
} from '../shared/protocol.js';
import { getSettings } from '../shared/settings.js';
import { isSupportedTargetLang } from '../shared/languages.js';
import {
  ENGINE_TYPE_IDS,
  DEFAULT_QUICK_PROMPT,
  getEngineKind,
  getEngineType,
  getTypeLabel,
  validateInstance,
  validatePromptTemplate,
} from '../shared/config/registry.js';
import {
  getInstanceCredentials,
  getInstances,
  isInstancePermitted,
  requiresKey,
} from '../shared/config/instances.js';
import { translate, TranslateError } from '../shared/translate/adapter.js';
import { createLogger } from '../shared/log/logger.js';
import { normalizeConcurrency, withUpstreamSlot } from './gateway.js';

/** A5 日志入口。 */
const log = createLogger('A5');

/**
 * 处理 `ST_QUICK_TRANSLATE`。
 * @param {unknown} payload
 * @returns {Promise<{ ok: true, data: object } | { ok: false, error: object }>}
 */
export async function quickTranslate(payload) {
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
  if (settings.enabled === false) return failure(ERROR_CODES.CONFIG, '扩展已停用');

  const targetLang = payload.targetLang ?? settings.targetLang;
  if (!isSupportedTargetLang(targetLang)) {
    return failure(ERROR_CODES.OTHER, '不支持的目标语言', FAILURE_REASONS.UNSUPPORTED_LANG);
  }

  if (
    payload.instanceId != null &&
    (typeof payload.instanceId !== 'string' ||
      payload.instanceId === '' ||
      payload.instanceId.length > 64)
  ) {
    return failure(ERROR_CODES.OTHER, '实例标识无效', FAILURE_REASONS.INVALID_MESSAGE);
  }

  let instances;
  try {
    instances = await getInstances();
  } catch {
    return failure(ERROR_CODES.CONFIG, '读取引擎配置失败');
  }
  if (instances.length === 0) return failure(ERROR_CODES.CONFIG, '没有可用的翻译实例');

  const instance = resolveInstance(instances, payload.instanceId, settings.activeInstanceId);
  if (!instance) {
    return failure(ERROR_CODES.CONFIG, '快速翻译实例不存在，请重新选择');
  }

  if (!getEngineType(instance.type)) {
    return failure(ERROR_CODES.CONFIG, '不支持的实例类型');
  }
  const validation = validateInstance(instance);
  if (!validation.ok) {
    return failure(ERROR_CODES.CONFIG, validation.errors[0] ?? '实例配置无效');
  }
  if (instance.enabled === false) {
    return failure(ERROR_CODES.CONFIG, '该实例已停用，请重新选择');
  }

  let credentials;
  try {
    credentials = await getInstanceCredentials(instance);
  } catch {
    return failure(ERROR_CODES.CONFIG, '读取实例凭据失败');
  }
  if (requiresKey(instance)) {
    const complete =
      instance.type === ENGINE_TYPE_IDS.BAIDU
        ? Boolean(credentials.appId && credentials.secretKey)
        : Boolean(credentials.apiKey);
    if (!complete) {
      return failure(
        ERROR_CODES.CONFIG,
        instance.type === ENGINE_TYPE_IDS.BAIDU
          ? 'APPID 或密钥未配置完整'
          : '缺少密钥，请先在设置页保存密钥'
      );
    }
  }

  if (!(await isInstancePermitted(instance))) {
    return failure(ERROR_CODES.CONFIG, '未授权访问该接口域名，请到设置页重新授权');
  }

  const isLlm = instance.type === ENGINE_TYPE_IDS.OPENAI;
  const quickPrompt = isLlm ? resolveQuickPrompt(instance, traceLog) : null;

  traceLog.info('quick.start', '开始快速翻译', {
    textLength: text.length,
    targetLang,
    instanceId: instance.id,
    type: instance.type,
    kind: getEngineKind(instance.type),
  });

  let elapsedMs = 0;
  try {
    const result = await withUpstreamSlot(
      async () => {
        const startedAt = performance.now();
        try {
          return await translate({
            text,
            targetLang,
            sourceLang: settings.sourceLang,
            instance: isLlm
              ? { ...instance, ...credentials, systemPrompt: quickPrompt }
              : { ...instance, ...credentials },
            mode: isLlm ? 'quick' : 'single',
            timeoutMs: isLlm ? AI_TIMEOUT_MS.total : BAIDU_TIMEOUT_MS.single,
          });
        } finally {
          elapsedMs = Math.round(performance.now() - startedAt);
        }
      },
      normalizeConcurrency(instance.maxConcurrency),
      instance
    );

    traceLog.info('quick.done', '快速翻译完成', {
      ok: true,
      elapsedMs,
      instanceId: instance.id,
      type: instance.type,
      totalTokens: result.usage?.totalTokens ?? null,
      chars: text.length,
    });

    return {
      ok: true,
      data: {
        text: result.text,
        elapsedMs,
        usage: result.usage ?? null,
        chars: text.length,
        targetLang,
        engine: {
          id: instance.id,
          name: instance.name,
          type: instance.type,
          typeLabel: getTypeLabel(instance.type),
          preset: isLlm ? instance.preset : null,
          model: instance.model,
          kind: getEngineKind(instance.type),
        },
      },
    };
  } catch (error) {
    const code = error instanceof TranslateError ? error.code : ERROR_CODES.OTHER;
    traceLog.warn('quick.done', '快速翻译失败', {
      ok: false,
      code,
      elapsedMs,
      instanceId: instance.id,
      type: instance.type,
    });
    if (error instanceof TranslateError) return failure(error.code, error.message);
    return failure(ERROR_CODES.OTHER, `翻译失败：${error?.message ?? error}`);
  }
}

/**
 * 解析实例：显式 `instanceId` 优先；未提供时用当前实例，再退回第一个实例。
 * @param {Array<Record<string, unknown>>} instances
 * @param {unknown} instanceId
 * @param {unknown} activeInstanceId
 * @returns {Record<string, unknown> | null}
 */
function resolveInstance(instances, instanceId, activeInstanceId) {
  if (typeof instanceId === 'string') {
    return instances.find((item) => item.id === instanceId) ?? null;
  }
  return (
    instances.find((item) => item.id === activeInstanceId) ??
    instances[0] ??
    null
  );
}

/**
 * 取快速翻译提示词：缺失或校验失败时回退默认模板并记 warn 日志。
 * @param {Record<string, unknown>} instance
 * @param {ReturnType<typeof log.withTrace>} traceLog
 * @returns {string}
 */
function resolveQuickPrompt(instance, traceLog) {
  const candidate = typeof instance.quickPrompt === 'string' ? instance.quickPrompt : '';
  const check = validatePromptTemplate(candidate);
  if (check.ok) return candidate;

  traceLog.warn('quick.prompt.fallback', '快速翻译提示词不可用，已回退默认模板', {
    instanceId: instance.id,
    reason: check.error ?? 'invalid-prompt',
  });
  return DEFAULT_QUICK_PROMPT;
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
