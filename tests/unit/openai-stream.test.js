/**
 * A3 OpenAI SSE 分帧与非流式响应测试
 *
 * 覆盖 chunk 任意边界、CRLF/LF、多行 data、注释/ping、[DONE]、末帧无空行、usage、流内 error、
 * 非法 JSON、空响应、取消，以及非流式标准响应与错误体；用内存 ReadableStream，不联网。
 */

import { describe, expect, it } from 'vitest';
import { ERROR_CODES } from '../../src/shared/protocol.js';
import { readChatStream } from '../../src/shared/translate/openai-stream.js';
import {
  mapUsage,
  normalizeOutput,
  parseJsonCompletion,
  readErrorBody,
} from '../../src/shared/translate/openai-response.js';
import {
  bytes,
  completionBody,
  deltaEvent,
  jsonResponse,
  sseEvent,
  sseResponse,
  usageEvent,
} from '../helpers/openai.js';

/** 把文本按单个字节切块，模拟最坏的 chunk 边界。 */
function byteChunks(text) {
  return [...bytes(text)].map((byte) => new Uint8Array([byte]));
}

/**
 * 断言同步异常带指定错误码。
 * @param {() => unknown} fn
 * @param {string} code
 */
function expectThrowsWithCode(fn, code) {
  let error = null;
  try {
    fn();
  } catch (caught) {
    error = caught;
  }
  expect(error?.code).toBe(code);
}

describe('A3 OpenAI SSE 分帧', () => {
  it('chunk 任意切断、多字节 UTF-8 边界、usage 末帧与 [DONE]', async () => {
    const text =
      deltaEvent('你') +
      deltaEvent('好') +
      usageEvent({ prompt_tokens: 5, completion_tokens: 2, total_tokens: 7 }) +
      sseEvent('[DONE]');

    const deltas = [];
    const result = await readChatStream(sseResponse(byteChunks(text)), {
      onDelta: (delta) => deltas.push(delta),
    });

    expect(deltas.join('')).toBe('你好');
    expect(result.text).toBe('你好');
    expect(result.usage).toEqual({ promptTokens: 5, completionTokens: 2, totalTokens: 7 });
    expect(result.sawDone).toBe(true);
  });

  it('CRLF、注释/ping 与多行 data 都能处理', async () => {
    const text =
      ': ping\r\n\r\n' +
      'data: {"choices": [{"delta":\r\n' +
      'data: {"content":"多行"}}]}\r\n\r\n' +
      'data: [DONE]\r\n\r\n';

    const deltas = [];
    const result = await readChatStream(sseResponse(text), { onDelta: (delta) => deltas.push(delta) });
    expect(deltas).toEqual(['多行']);
    expect(result.text).toBe('多行');
  });

  it('末帧没有结尾空行时仍能派发', async () => {
    const text = 'data: {"choices":[{"delta":{"content":"尾"}}]}';
    const result = await readChatStream(sseResponse(text), {});
    expect(result.text).toBe('尾');
    expect(result.sawDone).toBe(false);
  });

  it('[DONE] 之后的事件不再处理', async () => {
    const text = deltaEvent('前') + sseEvent('[DONE]') + deltaEvent('后');
    const deltas = [];
    const result = await readChatStream(sseResponse(text), { onDelta: (delta) => deltas.push(delta) });
    expect(deltas).toEqual(['前']);
    expect(result.text).toBe('前');
  });

  it('usage 缺失时为 null；空增量为空串但不回调', async () => {
    const text = sseEvent({ choices: [{ delta: { content: '' } }] }) + sseEvent('[DONE]');
    const deltas = [];
    const result = await readChatStream(sseResponse(text), { onDelta: (delta) => deltas.push(delta) });
    expect(deltas).toEqual([]);
    expect(result.text).toBe('');
    expect(result.usage).toBeNull();
  });

  it('流内 error 事件映射为统一错误', async () => {
    await expect(
      readChatStream(sseResponse(sseEvent({ error: { message: 'Rate limit exceeded', type: 'rate_limit_exceeded' } })))
    ).rejects.toMatchObject({ code: ERROR_CODES.RATE_LIMIT });

    await expect(
      readChatStream(sseResponse(sseEvent({ error: { status: 401, message: 'Unauthorized' } })))
    ).rejects.toMatchObject({ code: ERROR_CODES.AUTH });

    await expect(
      readChatStream(
        sseResponse(sseEvent({ error: { type: 'invalid_request_error', message: 'unsupported parameter' } }))
      )
    ).rejects.toMatchObject({ code: ERROR_CODES.CONFIG });
  });

  it('非法 JSON 与缺少 choices/usage 的事件按格式不支持失败', async () => {
    await expect(readChatStream(sseResponse('data: {oops\n\n'))).rejects.toMatchObject({
      code: ERROR_CODES.OTHER,
      message: '当前接口返回格式暂不支持，请使用标准 OpenAI Chat Completions',
    });

    await expect(readChatStream(sseResponse(sseEvent({ id: 'x' })))).rejects.toMatchObject({
      code: ERROR_CODES.OTHER,
    });
  });

  it('空响应返回空文本与 null usage', async () => {
    const result = await readChatStream(sseResponse(''), {});
    expect(result).toEqual({ text: '', usage: null, sawDone: false });
  });

  it('已取消的 signal 直接抛 CANCELLED', async () => {
    const controller = new AbortController();
    controller.abort();
    await expect(readChatStream(sseResponse(deltaEvent('x')), { signal: controller.signal })).rejects.toMatchObject({
      code: ERROR_CODES.CANCELLED,
    });
  });

  it('流式过程中取消后不再回调', async () => {
    const controller = new AbortController();
    const body = new ReadableStream({
      start(stream) {
        stream.enqueue(bytes(deltaEvent('一')));
        // 故意不关闭：取消后不应继续等下一帧。
      },
    });
    const response = new Response(body, { status: 200, headers: { 'content-type': 'text/event-stream' } });
    const deltas = [];

    await expect(
      readChatStream(response, {
        signal: controller.signal,
        onDelta: (delta) => {
          deltas.push(delta);
          controller.abort();
        },
      })
    ).rejects.toMatchObject({ code: ERROR_CODES.CANCELLED });
    expect(deltas).toEqual(['一']);
  });
});

describe('A3 OpenAI 非流式响应', () => {
  it('解析标准 choices[0].message.content 与 usage', () => {
    const parsed = parseJsonCompletion(
      JSON.stringify(completionBody(' 你好 ', { prompt_tokens: 1, completion_tokens: 2, total_tokens: 3 }))
    );
    expect(parsed.text).toBe(' 你好 ');
    expect(parsed.usage).toEqual({ promptTokens: 1, completionTokens: 2, totalTokens: 3 });
  });

  it('content 数组、缺少 choices、非字符串 content、非法 JSON 都按格式不支持失败', () => {
    const cases = [
      JSON.stringify({ choices: [{ message: { content: [{ type: 'text', text: 'hi' }] } }] }),
      JSON.stringify({ choices: [] }),
      JSON.stringify({ choices: [{ message: { content: 42 } }] }),
      '{bad json',
      JSON.stringify({ foo: 'bar' }),
    ];
    for (const text of cases) {
      expectThrowsWithCode(() => parseJsonCompletion(text), ERROR_CODES.OTHER);
    }
  });

  it('非流式错误体经流内错误映射', () => {
    expectThrowsWithCode(
      () => parseJsonCompletion(JSON.stringify({ error: { status: 401, message: 'Unauthorized' } })),
      ERROR_CODES.AUTH
    );
  });

  it('usage 缺失返回 null；字段缺失保留 null', () => {
    expect(parseJsonCompletion(JSON.stringify(completionBody('hi'))).usage).toBeNull();
    expect(mapUsage({ total_tokens: 3 })).toEqual({
      promptTokens: null,
      completionTokens: null,
      totalTokens: 3,
    });
    expect(mapUsage(null)).toBeNull();
    expect(mapUsage({})).toBeNull();
  });

  it('readErrorBody 只读有限长度并取消 reader', async () => {
    const body = await readErrorBody(jsonResponse('x'.repeat(100)), 20);
    expect(body).toHaveLength(20);
  });

  it('normalizeOutput 去掉引号与首尾空白', () => {
    expect(normalizeOutput('  "你好"  ')).toBe('你好');
    expect(normalizeOutput('「世界」')).toBe('世界');
    expect(normalizeOutput('  plain  ')).toBe('plain');
    expect(normalizeOutput(null)).toBe('');
  });
});
