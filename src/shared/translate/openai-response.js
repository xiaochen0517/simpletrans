/**
 * A3 OpenAI 非流式响应解析
 *
 * 模块：后台服务（A）/ A3
 * 职责：解析标准 OpenAI Chat Completions JSON 响应与错误体，读取有限长度的错误信息，
 *       归一输出文本（去首尾空白、剥一层成对引号）与 usage。
 * 依赖：A3 OpenAI 错误映射（openai-errors.js）。
 *
 * 只接受标准响应：`choices[0].message.content` 必须是字符串；content 数组、旧 completions、
 * 缺少 choices 等非标准格式统一按「格式不支持」失败，不做猜测解析。
 */

import { formatError, mapStreamError } from './openai-errors.js';

/** 错误体读取上限（字符）；只用于判断错误类型。 */
export const MAX_ERROR_BODY_CHARS = 8_192;

/**
 * 输出归一：去掉首尾空白，并剥掉一层成对引号/书名号等多余包装。
 * @param {unknown} text
 * @returns {string}
 */
export function normalizeOutput(text) {
  let out = String(text ?? '').trim();
  const pairs = [
    ['"', '"'],
    ["'", "'"],
    ['「', '」'],
    ['『', '』'],
    ['“', '”'],
    ['‘', '’'],
    ['【', '】'],
  ];
  for (const [left, right] of pairs) {
    if (out.length >= 2 && out.startsWith(left) && out.endsWith(right)) {
      out = out.slice(left.length, out.length - right.length).trim();
    }
  }
  return out.trim();
}

/**
 * 把标准 OpenAI usage 归一为内部结构；缺失或非法值返回 `null`。
 * @param {unknown} usage
 * @returns {{ promptTokens: number, completionTokens: number, totalTokens: number } | null}
 */
export function mapUsage(usage) {
  if (!usage || typeof usage !== 'object') return null;
  const pick = (value) => (typeof value === 'number' && Number.isFinite(value) ? value : null);
  const promptTokens = pick(usage.prompt_tokens);
  const completionTokens = pick(usage.completion_tokens);
  const totalTokens = pick(usage.total_tokens);
  if (promptTokens === null && completionTokens === null && totalTokens === null) return null;
  return { promptTokens, completionTokens, totalTokens };
}

/**
 * 读取有限长度的错误体：只用于错误分类，读完即丢弃。
 * @param {Response} response
 * @param {number} [limit]
 * @returns {Promise<string>}
 */
export async function readErrorBody(response, limit = MAX_ERROR_BODY_CHARS) {
  const body = response?.body;
  if (!body || typeof body.getReader !== 'function') {
    const text = typeof response?.text === 'function' ? await response.text() : '';
    return String(text ?? '').slice(0, limit);
  }

  const reader = body.getReader();
  const decoder = new TextDecoder();
  let out = '';
  try {
    while (out.length < limit) {
      const { done, value } = await reader.read();
      if (done) break;
      out += decoder.decode(value, { stream: true });
    }
    out += decoder.decode();
  } finally {
    try {
      await reader.cancel();
    } catch {
      // 错误体读取失败不影响错误分类。
    }
  }
  return out.slice(0, limit);
}

/**
 * 解析标准 OpenAI Chat Completions 非流式响应文本。
 * @param {unknown} text 响应体文本
 * @returns {{ text: string, usage: { promptTokens: number, completionTokens: number, totalTokens: number } | null }}
 */
export function parseJsonCompletion(text) {
  let payload;
  try {
    payload = JSON.parse(String(text ?? ''));
  } catch {
    throw formatError();
  }
  if (!payload || typeof payload !== 'object' || Array.isArray(payload)) {
    throw formatError();
  }
  if (payload.error) throw mapStreamError(payload);

  const choices = payload.choices;
  if (!Array.isArray(choices) || choices.length === 0) throw formatError();

  const content = choices[0]?.message?.content;
  if (typeof content !== 'string') throw formatError();

  return { text: content, usage: mapUsage(payload.usage) };
}
