/**
 * A3 OpenAI SSE 流式解析
 *
 * 模块：后台服务（A）/ A3
 * 职责：用 `eventsource-parser` 做 SSE 分帧，把标准 OpenAI Chat Completions 流映射为
 *       文本增量、末帧 usage 与流内错误；处理 chunk 任意边界、CRLF/LF、多行 data、注释/ping、`[DONE]`
 *       与末帧无空行。
 * 依赖：`eventsource-parser/stream`（仅分帧）、A3 错误映射与 usage 归一（openai-errors.js / openai-response.js）。
 *
 * 分帧交给库，JSON 校验、`[DONE]`、choices、usage、error 与上限由本模块负责；
 * 不按行手写拆分、不自行拼 `data:`，不自动重连。
 */

import { EventSourceParserStream } from 'eventsource-parser/stream';
import { ERROR_CODES } from '../protocol.js';
import { TranslateError, cancelledError, formatError, mapStreamError } from './openai-errors.js';
import { mapUsage } from './openai-response.js';

/** 单个 SSE 事件缓冲上限（字符）：异常大响应直接失败。 */
export const SSE_MAX_BUFFER_CHARS = 1_000_000;

/** 流式输出总字符上限：异常大响应直接失败。 */
export const SSE_MAX_TOTAL_CHARS = 16_000_000;

/** 单个事件上限（字符）：正常 OpenAI 事件远小于该值。 */
export const SSE_MAX_EVENT_CHARS = 512_000;

/** 事件总数上限。 */
export const SSE_MAX_EVENTS = 20_000;

/**
 * 读取标准 OpenAI Chat Completions SSE 流。
 *
 * - 只在完整事件上处理；`data: [DONE]` 结束；
 * - `choices[0].delta.content` 为字符串时累计并回调；其它字段忽略；
 * - `usage` 取最后一个包含 usage 的事件，缺失为 `null`；
 * - 流内 `error` 对象按统一错误码抛出；
 * - 分帧错误、非法 JSON、非标准结构按「格式不支持」抛出；
 * - `signal` 中断时抛出 `CANCELLED`，并取消 reader。
 *
 * @param {Response} response
 * @param {{ onDelta?: (delta: string) => void, signal?: AbortSignal, collect?: boolean }} [options]
 * @returns {Promise<{ text: string, usage: { promptTokens: number, completionTokens: number, totalTokens: number } | null, sawDone: boolean }>}
 */
export async function readChatStream(response, { onDelta, signal, collect = true } = {}) {
  const body = response?.body;
  if (!body || typeof body.pipeThrough !== 'function') throw formatError();

  let totalChars = 0;
  // SSE 规范只在空行派发事件；末尾补两个换行，保证最后一帧（可能没有结尾空行）也能派发。
  const tail = new TransformStream({
    transform(chunk, controller) {
      totalChars += chunk.length;
      if (totalChars > SSE_MAX_TOTAL_CHARS) {
        controller.error(new TranslateError(ERROR_CODES.OTHER, '上游响应过大，已停止读取'));
        return;
      }
      controller.enqueue(chunk);
    },
    flush(controller) {
      controller.enqueue('\n\n');
    },
  });

  const events = body
    .pipeThrough(new TextDecoderStream())
    .pipeThrough(tail)
    .pipeThrough(new EventSourceParserStream({ maxBufferSize: SSE_MAX_BUFFER_CHARS }));

  const reader = events.getReader();
  let text = '';
  let usage = null;
  let sawDone = false;
  let eventCount = 0;

  try {
    for (;;) {
      if (signal?.aborted) throw cancelledError();
      const { done, value: event } = await reader.read();
      if (done) break;
      if (signal?.aborted) throw cancelledError();

      eventCount += 1;
      if (eventCount > SSE_MAX_EVENTS) {
        throw new TranslateError(ERROR_CODES.OTHER, '上游响应事件过多，已停止读取');
      }

      const data = event?.data;
      if (typeof data !== 'string' || data === '') continue;
      if (data.trim() === '[DONE]') {
        sawDone = true;
        break;
      }
      if (data.length > SSE_MAX_EVENT_CHARS) {
        throw new TranslateError(ERROR_CODES.OTHER, '上游响应事件过大，已停止读取');
      }

      let payload;
      try {
        payload = JSON.parse(data);
      } catch {
        throw formatError();
      }
      if (!payload || typeof payload !== 'object' || Array.isArray(payload)) throw formatError();
      if (payload.error) throw mapStreamError(payload);

      const hasChoices = Array.isArray(payload.choices);
      const hasUsage = Boolean(payload.usage) && typeof payload.usage === 'object';
      // 标准事件要么带 choices，要么是只带 usage 的末帧；两者都没有视为非标准格式。
      if (!hasChoices && !hasUsage) throw formatError();

      const choice = hasChoices ? payload.choices[0] : null;
      const delta = choice?.delta?.content;
      if (typeof delta === 'string' && delta !== '') {
        if (collect) text += delta;
        onDelta?.(delta);
      }

      if (hasUsage) {
        const mapped = mapUsage(payload.usage);
        if (mapped) usage = mapped;
      }
    }
  } finally {
    try {
      await reader.cancel();
    } catch {
      // 流已结束或已中止时 cancel 可能失败，忽略。
    }
  }

  return { text, usage, sawDone };
}
