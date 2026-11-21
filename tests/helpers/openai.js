/**
 * 测试基建（tests/helpers）：OpenAI 响应构造
 *
 * 模块：测试基建（tests/helpers）
 * 职责：用内存 ReadableStream/Response 构造 SSE 与非流式响应，供 OpenAI 协议与适配器测试使用。
 *
 * 不联网、不依赖真实扩展；chunk 边界由调用方决定。
 */

const encoder = new TextEncoder();

/**
 * 把字符串编码为字节。
 * @param {string} text
 * @returns {Uint8Array}
 */
export function bytes(text) {
  return encoder.encode(text);
}

/**
 * 构造 SSE 响应。
 * @param {string | Uint8Array | Array<string | Uint8Array>} chunks 一个或多个 chunk
 * @param {{ status?: number, contentType?: string }} [options]
 * @returns {Response}
 */
export function sseResponse(chunks, { status = 200, contentType = 'text/event-stream' } = {}) {
  const parts = (Array.isArray(chunks) ? chunks : [chunks]).map((chunk) =>
    typeof chunk === 'string' ? bytes(chunk) : chunk
  );
  const body = new ReadableStream({
    start(controller) {
      for (const part of parts) controller.enqueue(part);
      controller.close();
    },
  });
  return new Response(body, { status, headers: { 'content-type': contentType } });
}

/**
 * 构造 JSON 响应。
 * @param {unknown} payload 对象或原始字符串
 * @param {{ status?: number, contentType?: string }} [options]
 * @returns {Response}
 */
export function jsonResponse(payload, { status = 200, contentType = 'application/json' } = {}) {
  const text = typeof payload === 'string' ? payload : JSON.stringify(payload);
  return new Response(text, { status, headers: { 'content-type': contentType } });
}

/**
 * 构造一个 SSE `data:` 事件。
 * @param {unknown} payload 对象或原始字符串
 * @returns {string}
 */
export function sseEvent(payload) {
  return `data: ${typeof payload === 'string' ? payload : JSON.stringify(payload)}\n\n`;
}

/**
 * 构造一个文本增量 SSE 事件。
 * @param {string} content
 * @returns {string}
 */
export function deltaEvent(content) {
  return sseEvent({ choices: [{ delta: { content } }] });
}

/**
 * 构造只有 usage 的末帧事件。
 * @param {{ prompt_tokens?: number, completion_tokens?: number, total_tokens?: number }} usage
 * @returns {string}
 */
export function usageEvent(usage) {
  return sseEvent({ choices: [], usage });
}

/**
 * 构造标准非流式 Chat Completions 响应体。
 * @param {string} content
 * @param {object} [usage]
 * @returns {object}
 */
export function completionBody(content, usage) {
  return {
    id: 'chatcmpl-test',
    object: 'chat.completion',
    choices: [{ index: 0, message: { role: 'assistant', content }, finish_reason: 'stop' }],
    ...(usage ? { usage } : {}),
  };
}
