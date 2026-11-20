/**
 * A3 适配器契约
 *
 * 模块：后台服务（A）/ A3
 * 职责：按实例类型分发到 OpenAI 兼容或百度翻译适配器；统一导出提示词、输出归一与错误类型。
 * 依赖：A3 OpenAI 适配器（adapters/openai.js）、A3 百度适配器（adapters/baidu.js）、
 *       E3 OpenAI 配置与旧 DeepSeek 映射（config/openai.js）、E3 类型目录（registry.js）、
 *       A3 提示词模板（prompt.js）、A3 批量编码（batch.js）。
 * 实现阶段：P1–P6.4 提供 DeepSeek 契约；P8-1 改为 OpenAI 兼容适配器入口；
 *           P8-2 按 `instance.type` 分发 OpenAI/百度，未知类型返回 `CONFIG`。
 *
 * 页面翻译与设置页测试翻译共用本入口；`mode: 'quick'` 供弹窗快速翻译使用快速输出格式。
 * 凭据由调用方从存储读取后随实例传入，本模块不读写存储。
 */

import { resolveOpenAIConfig } from '../config/openai.js';
import { ENGINE_TYPE_IDS, getEngineType } from '../config/registry.js';
import { ERROR_CODES } from '../protocol.js';
import { translate as translateBaidu, translateBatch as translateBaiduBatch } from './adapters/baidu.js';
import { translate as translateOpenAI, translateBatch as translateBatchOpenAI } from './adapters/openai.js';
import { TranslateError } from './openai-errors.js';
import { normalizeOutput } from './openai-response.js';
import {
  buildSystemPrompt,
  isSupportedTargetLang,
  PROMPT_VERSION,
  SUPPORTED_TARGET_LANGS,
} from './prompt.js';

export {
  buildSystemPrompt,
  isSupportedTargetLang,
  normalizeOutput,
  PROMPT_VERSION,
  SUPPORTED_TARGET_LANGS,
  TranslateError,
};

/**
 * 取实例的可执行类型：旧 `deepseek` 实例按 OpenAI 兼容处理；未知类型返回 null。
 * @param {unknown} instance
 * @returns {string | null}
 */
export function resolveAdapterType(instance) {
  const source = instance && typeof instance === 'object' ? instance : {};
  const type = source.type === 'deepseek' ? ENGINE_TYPE_IDS.OPENAI : source.type;
  return getEngineType(type) ? type : null;
}

/**
 * 把调用方实例解析为 OpenAI 配置，保留 `apiKey`、`systemPrompt` 等调用方字段。
 * @param {unknown} instance
 * @returns {Record<string, unknown>}
 */
function toOpenAIInstance(instance) {
  const source = instance && typeof instance === 'object' ? instance : {};
  return resolveOpenAIConfig(source);
}

/**
 * 单段翻译。成功返回 `{ text, usage }`；失败抛 `TranslateError`。
 * @param {{
 *   text?: string,
 *   targetLang?: string,
 *   sourceLang?: string,
 *   instance?: Record<string, unknown>,
 *   mode?: 'single'|'quick',
 *   onDelta?: (delta: string) => void,
 *   signal?: AbortSignal,
 *   fetchImpl?: Function,
 *   timeoutMs?: number,
 *   checkPermission?: (request: { origins: string[] }) => Promise<boolean> | boolean,
 *   salt?: string,
 * }} [params]
 * @returns {Promise<{ text: string, usage: object | null }>}
 */
export async function translate(params = {}) {
  const type = resolveAdapterType(params.instance);
  if (type === ENGINE_TYPE_IDS.OPENAI) {
    return translateOpenAI({ ...params, instance: toOpenAIInstance(params.instance) });
  }
  if (type === ENGINE_TYPE_IDS.BAIDU) {
    return translateBaidu(params);
  }
  throw new TranslateError(ERROR_CODES.CONFIG, '不支持的实例类型');
}

/**
 * 多段批量翻译：OpenAI 走 JSONL，百度走原生批量；按段回调。
 * @param {{
 *   items?: Array<{ groupId: string, text: string }>,
 *   targetLang?: string,
 *   sourceLang?: string,
 *   instance?: Record<string, unknown>,
 *   onItem?: (entry: { groupId: string, text: string }) => void,
 *   signal?: AbortSignal,
 *   fetchImpl?: Function,
 *   timeoutMs?: number,
 *   checkPermission?: (request: { origins: string[] }) => Promise<boolean> | boolean,
 *   salt?: string,
 * }} [params]
 * @returns {Promise<{ usage: object | null }>}
 */
export async function translateBatch(params = {}) {
  const type = resolveAdapterType(params.instance);
  if (type === ENGINE_TYPE_IDS.OPENAI) {
    return translateBatchOpenAI({ ...params, instance: toOpenAIInstance(params.instance) });
  }
  if (type === ENGINE_TYPE_IDS.BAIDU) {
    return translateBaiduBatch(params);
  }
  throw new TranslateError(ERROR_CODES.CONFIG, '不支持的实例类型');
}
