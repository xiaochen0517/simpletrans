/**
 * DeepSeek 翻译实现
 *
 * 只允许 Background 引用：这里会接触 API Key，content 产物中不得出现本模块。
 * 提供两种调用形态：
 * - translateText：一次性翻译（设置页“测试翻译”沿用）；
 * - translateSegmentStream：逐段流式翻译（数据面使用，P3 接入网关）。
 */

import { createDeepSeek } from '@ai-sdk/deepseek';
import { generateText, streamText } from 'ai';
import { buildSystemPrompt, normalizeOutput } from './provider.js';

export const PROVIDER = 'deepseek';
export const MODEL = 'deepseek-chat';

/**
 * @param {string} apiKey
 */
function createModel(apiKey) {
  if (!apiKey) {
    const error = new Error('缺少 DeepSeek API Key，请先在设置中填写');
    // @ts-expect-error 自定义错误码，供网关归一化为 ERROR_CODE.NO_KEY
    error.code = 'NO_KEY';
    throw error;
  }
  return createDeepSeek({ apiKey })(MODEL);
}

/**
 * 一次性翻译（保持既有行为）。
 * @param {{ text: string, targetLang: string, apiKey: string, ctx?: { title?: string, prev?: string } }} options
 */
export async function translateText({ text, targetLang, apiKey, ctx }) {
  if (!text?.trim()) return '';
  const { text: result } = await generateText({
    model: createModel(apiKey),
    system: buildSystemPrompt(targetLang, ctx),
    prompt: text,
  });
  return normalizeOutput(result);
}

/**
 * 逐段流式翻译。返回 AI SDK 的 streamText 结果：
 * - `result.textStream` 异步迭代增量文本；
 * - `await result.text` 得到最终全文。
 *
 * @param {{ text: string, targetLang: string, apiKey: string, ctx?: { title?: string, prev?: string }, signal?: AbortSignal }} options
 */
export function translateSegmentStream({ text, targetLang, apiKey, ctx, signal }) {
  return streamText({
    model: createModel(apiKey),
    system: buildSystemPrompt(targetLang, ctx),
    prompt: String(text ?? ''),
    abortSignal: signal,
  });
}
