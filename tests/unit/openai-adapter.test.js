/**
 * A3 OpenAI 适配器测试
 *
 * 用注入的 fetch 与内存 ReadableStream 验证请求、流式/非流式、认证、参数、错误映射、
 * 批量、取消与日志脱敏；不联网、不依赖真实 Chrome。
 */

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { ERROR_CODES } from '../../src/shared/protocol.js';
import { createOpenAIConfig } from '../../src/shared/config/openai.js';
import { translate, translateBatch } from '../../src/shared/translate/adapters/openai.js';
import { BatchAlignError, encodeBatchInput } from '../../src/shared/translate/batch.js';
import { initLogging, resetLogging } from '../../src/shared/log/logger.js';
import {
  completionBody,
  deltaEvent,
  jsonResponse,
  sseEvent,
  sseResponse,
  usageEvent,
} from '../helpers/openai.js';

/** 构造一份带密钥的 DeepSeek 实例。 */
function deepseekInstance(overrides = {}) {
  return { ...createOpenAIConfig('deepseek'), apiKey: 'sk-test', ...overrides };
}

/** 构造一份无认证的自定义实例。 */
function localInstance(overrides = {}) {
  const config = createOpenAIConfig('custom');
  config.endpoint.baseUrl = 'http://localhost:8080';
  config.model = 'local-model';
  config.auth = { type: 'none' };
  return { ...config, ...overrides };
}

/**
 * 构造 fetch 注入：每次调用新建响应，避免复用已读 body。
 * @param {() => Response} factory
 */
function fetchOf(factory) {
  return vi.fn(async () => factory());
}

describe('A3 OpenAI 适配器：单段翻译', () => {
  beforeEach(() => {
    initLogging({ level: 'off', sessionId: 'openai-adapter-test' });
  });

  afterEach(() => {
    resetLogging();
    vi.restoreAllMocks();
  });

  it('流式成功：请求、增量、usage 与输出归一', async () => {
    const fetchImpl = fetchOf(() =>
      sseResponse(
        deltaEvent(' 你') +
          deltaEvent('好 ') +
          usageEvent({ prompt_tokens: 5, completion_tokens: 2, total_tokens: 7 }) +
          sseEvent('[DONE]')
      )
    );
    const deltas = [];

    const result = await translate({
      text: 'hello',
      targetLang: 'zh',
      instance: deepseekInstance(),
      fetchImpl,
      onDelta: (delta) => deltas.push(delta),
    });

    expect(result).toEqual({
      text: '你好',
      usage: { promptTokens: 5, completionTokens: 2, totalTokens: 7 },
    });
    expect(deltas.join('')).toBe(' 你好 ');

    const [url, init] = fetchImpl.mock.calls[0];
    expect(url).toBe('https://api.deepseek.com/chat/completions');
    expect(init.method).toBe('POST');
    expect(init.redirect).toBe('error');
    expect(init.credentials).toBe('omit');
    expect(init.headers).toEqual({
      'Content-Type': 'application/json',
      Authorization: 'Bearer sk-test',
    });
    const body = JSON.parse(init.body);
    expect(body.model).toBe('deepseek-chat');
    expect(body.stream).toBe(true);
    expect(body.thinking).toEqual({ type: 'disabled' });
  });

  it('stream=false 时解析标准 JSON，不产生增量', async () => {
    const config = deepseekInstance();
    config.endpoint.stream = false;
    const fetchImpl = fetchOf(() =>
      jsonResponse(completionBody('译文', { prompt_tokens: 1, completion_tokens: 1, total_tokens: 2 }))
    );
    const onDelta = vi.fn();

    const result = await translate({ text: 'hi', targetLang: 'zh', instance: config, fetchImpl, onDelta });

    expect(result).toEqual({
      text: '译文',
      usage: { promptTokens: 1, completionTokens: 1, totalTokens: 2 },
    });
    expect(onDelta).not.toHaveBeenCalled();
    expect(JSON.parse(fetchImpl.mock.calls[0][1].body).stream).toBe(false);
  });

  it('mode=quick 时 system message 使用快速输出格式', async () => {
    const config = deepseekInstance({
      endpoint: { ...createOpenAIConfig('deepseek').endpoint, stream: false },
      systemPrompt: '快速模板 {{targetLang}}。{{outputFormat}}',
    });
    const fetchImpl = fetchOf(() => jsonResponse(completionBody('你好')));

    await translate({
      text: 'hello',
      targetLang: 'zh',
      instance: config,
      mode: 'quick',
      fetchImpl,
    });

    const body = JSON.parse(fetchImpl.mock.calls[0][1].body);
    const system = body.messages[0].content;
    expect(system).toContain('快速模板 中文。');
    expect(system).toContain('音标');
    expect(system).not.toContain('只输出译文本身');
  });

  it('请求流式但服务端返回 JSON 时按非流式解析', async () => {
    const fetchImpl = fetchOf(() => jsonResponse(completionBody('JSON 回退')));
    const onDelta = vi.fn();

    const result = await translate({
      text: 'hi',
      targetLang: 'zh',
      instance: deepseekInstance(),
      fetchImpl,
      onDelta,
    });

    expect(result.text).toBe('JSON 回退');
    expect(onDelta).not.toHaveBeenCalled();
  });

  it('auth.type = none 时无密钥也可翻译', async () => {
    const fetchImpl = fetchOf(() => sseResponse(deltaEvent('本地') + sseEvent('[DONE]')));
    const result = await translate({
      text: 'hi',
      targetLang: 'zh',
      instance: localInstance(),
      fetchImpl,
    });
    expect(result.text).toBe('本地');
    expect(fetchImpl.mock.calls[0][0]).toBe('http://localhost:8080/chat/completions');
  });

  it('空文本短路，不调用 fetch', async () => {
    const fetchImpl = vi.fn();
    await expect(
      translate({ text: '   ', targetLang: 'zh', instance: deepseekInstance(), fetchImpl })
    ).resolves.toEqual({ text: '', usage: null });
    expect(fetchImpl).not.toHaveBeenCalled();
  });

  it('缺密钥与非法配置在发请求前抛 CONFIG', async () => {
    const missingKey = vi.fn();
    await expect(
      translate({ text: 'hi', targetLang: 'zh', instance: deepseekInstance({ apiKey: '' }), fetchImpl: missingKey })
    ).rejects.toMatchObject({ code: ERROR_CODES.CONFIG, message: '缺少密钥，请先在设置页配置' });
    expect(missingKey).not.toHaveBeenCalled();

    const invalid = createOpenAIConfig('custom');
    invalid.model = 'm';
    const invalidFetch = vi.fn();
    await expect(
      translate({ text: 'hi', targetLang: 'zh', instance: invalid, fetchImpl: invalidFetch })
    ).rejects.toMatchObject({ code: ERROR_CODES.CONFIG, message: '接口地址无效，请检查 baseUrl 与 path' });
    expect(invalidFetch).not.toHaveBeenCalled();
  });

  it('主机权限未授权时返回 CONFIG，且不发请求', async () => {
    const fetchImpl = vi.fn();
    await expect(
      translate({
        text: 'hi',
        targetLang: 'zh',
        instance: deepseekInstance(),
        fetchImpl,
        checkPermission: () => false,
      })
    ).rejects.toMatchObject({
      code: ERROR_CODES.CONFIG,
      message: '未授权访问该接口域名，请到设置页重新授权',
    });
    expect(fetchImpl).not.toHaveBeenCalled();
  });

  it('HTTP 状态映射为统一错误码', async () => {
    const cases = [
      [401, 'unauthorized', ERROR_CODES.AUTH],
      [403, 'forbidden', ERROR_CODES.AUTH],
      [429, 'rate limited', ERROR_CODES.RATE_LIMIT],
      [500, 'server error', ERROR_CODES.NETWORK],
      [503, 'unavailable', ERROR_CODES.NETWORK],
      [404, 'not found', ERROR_CODES.CONFIG],
    ];
    for (const [status, text, code] of cases) {
      const fetchImpl = fetchOf(() => jsonResponse(text, { status }));
      await expect(
        translate({ text: 'hi', targetLang: 'zh', instance: deepseekInstance(), fetchImpl })
      ).rejects.toMatchObject({ code });
    }
  });

  it('400 参数不被支持映射为 CONFIG 与明确提示', async () => {
    const fetchImpl = fetchOf(() =>
      jsonResponse({ error: { message: 'unsupported parameter: temperature' } }, { status: 400 })
    );
    await expect(
      translate({ text: 'hi', targetLang: 'zh', instance: deepseekInstance(), fetchImpl })
    ).rejects.toMatchObject({
      code: ERROR_CODES.CONFIG,
      message: '请求参数不被当前模型支持，请关闭不支持的参数',
    });
  });

  it('网络异常映射 NETWORK；超时按 NETWORK；外部取消按 CANCELLED', async () => {
    await expect(
      translate({
        text: 'hi',
        targetLang: 'zh',
        instance: deepseekInstance(),
        fetchImpl: vi.fn(async () => {
          throw new TypeError('Failed to fetch');
        }),
      })
    ).rejects.toMatchObject({ code: ERROR_CODES.NETWORK });

    const timeoutFetch = (url, init) =>
      new Promise((resolve, reject) => {
        init.signal.addEventListener('abort', () => {
          reject(Object.assign(new Error('The operation was aborted'), { name: 'AbortError' }));
        });
      });
    await expect(
      translate({
        text: 'hi',
        targetLang: 'zh',
        instance: deepseekInstance(),
        fetchImpl: timeoutFetch,
        timeoutMs: 10,
      })
    ).rejects.toMatchObject({ code: ERROR_CODES.NETWORK });

    const controller = new AbortController();
    await expect(
      translate({
        text: 'hi',
        targetLang: 'zh',
        instance: deepseekInstance(),
        signal: controller.signal,
        fetchImpl: vi.fn(async () => {
          controller.abort();
          throw Object.assign(new Error('aborted'), { name: 'AbortError' });
        }),
      })
    ).rejects.toMatchObject({ code: ERROR_CODES.CANCELLED });
  });

  it('空译文按 OTHER「引擎返回空译文」失败', async () => {
    const fetchImpl = fetchOf(() => sseResponse(sseEvent('[DONE]')));
    await expect(
      translate({ text: 'hi', targetLang: 'zh', instance: deepseekInstance(), fetchImpl })
    ).rejects.toMatchObject({ code: ERROR_CODES.OTHER, message: '引擎返回空译文' });
  });

  it('日志记录模型与预设，不记录密钥、地址与提示词正文', async () => {
    initLogging({ level: 'debug', sessionId: 'openai-adapter-test' });
    const debug = vi.spyOn(console, 'debug').mockImplementation(() => {});
    const fetchImpl = fetchOf(() => sseResponse(deltaEvent('译文') + sseEvent('[DONE]')));

    await translate({
      text: 'hello',
      targetLang: 'zh',
      instance: deepseekInstance({ systemPrompt: '机密模板 {{targetLang}} {{outputFormat}}' }),
      fetchImpl,
    });

    const lines = debug.mock.calls.map(([line]) => String(line)).join('\n');
    expect(lines).toContain('engine.openai.request');
    expect(lines).toContain('"model":"deepseek-chat"');
    expect(lines).toContain('"preset":"deepseek"');
    expect(lines).not.toContain('sk-test');
    expect(lines).not.toContain('api.deepseek.com');
    expect(lines).not.toContain('机密模板');
  });
});

describe('A3 OpenAI 适配器：批量翻译', () => {
  beforeEach(() => {
    initLogging({ level: 'off', sessionId: 'openai-adapter-test' });
  });

  afterEach(() => {
    resetLogging();
    vi.restoreAllMocks();
  });

  it('空 items 直接返回，不发请求', async () => {
    const fetchImpl = vi.fn();
    await expect(translateBatch({ items: [], instance: deepseekInstance(), fetchImpl })).resolves.toEqual({
      usage: null,
    });
    expect(fetchImpl).not.toHaveBeenCalled();
  });

  it('流式 JSONL：一次请求、按段回调与归一、批量 usage', async () => {
    const text = '{"id":"g0","text":" 你好 "}\n{"id":"g1","text":"世界"}\n';
    const chunks =
      [text.slice(0, 18), text.slice(18, 40), text.slice(40)].map(deltaEvent).join('') +
      sseEvent('[DONE]');
    const fetchImpl = fetchOf(() => sseResponse(chunks));
    const items = [
      { groupId: 'g0', text: 'Hello' },
      { groupId: 'g1', text: 'World' },
    ];
    const onItem = vi.fn();

    const result = await translateBatch({
      items,
      targetLang: 'zh',
      instance: deepseekInstance(),
      fetchImpl,
      onItem,
    });

    expect(onItem.mock.calls.map(([entry]) => entry)).toEqual([
      { groupId: 'g0', text: '你好' },
      { groupId: 'g1', text: '世界' },
    ]);
    expect(result.usage).toBeNull();

    const body = JSON.parse(fetchImpl.mock.calls[0][1].body);
    expect(body.messages[1].content).toBe(encodeBatchInput(items));
    expect(body.messages[0].content).toContain('JSONL');
  });

  it('非流式 JSONL 从 message.content 解析并逐段回调', async () => {
    const config = deepseekInstance();
    config.endpoint.stream = false;
    const jsonl = '{"id":"g0","text":"甲"}\n{"id":"g1","text":"乙"}\n';
    const fetchImpl = fetchOf(() =>
      jsonResponse(completionBody(jsonl, { prompt_tokens: 2, completion_tokens: 2, total_tokens: 4 }))
    );
    const onItem = vi.fn();

    const result = await translateBatch({
      items: [
        { groupId: 'g0', text: 'A' },
        { groupId: 'g1', text: 'B' },
      ],
      targetLang: 'zh',
      instance: config,
      fetchImpl,
      onItem,
    });

    expect(onItem.mock.calls.map(([entry]) => entry)).toEqual([
      { groupId: 'g0', text: '甲' },
      { groupId: 'g1', text: '乙' },
    ]);
    expect(result.usage).toEqual({ promptTokens: 2, completionTokens: 2, totalTokens: 4 });
  });

  it('对齐失败抛 BatchAlignError，已解析段落保留', async () => {
    const fetchImpl = fetchOf(() => sseResponse(deltaEvent('{"id":"g0","text":"只有一段"}\n') + sseEvent('[DONE]')));
    const onItem = vi.fn();

    let error = null;
    try {
      await translateBatch({
        items: [
          { groupId: 'g0', text: 'A' },
          { groupId: 'g1', text: 'B' },
        ],
        targetLang: 'zh',
        instance: deepseekInstance(),
        fetchImpl,
        onItem,
      });
    } catch (caught) {
      error = caught;
    }

    expect(error).toBeInstanceOf(BatchAlignError);
    expect(error.code).toBe(ERROR_CODES.BATCH_ALIGN);
    expect(error.counts.missing).toBe(1);
    expect(onItem).toHaveBeenCalledTimes(1);
  });

  it('流式解析中遇到未知段落时保持 BATCH_ALIGN，不归一到 OTHER', async () => {
    const fetchImpl = fetchOf(() =>
      sseResponse(deltaEvent('{"id":"gX","text":"?"}\n') + sseEvent('[DONE]'))
    );

    let error = null;
    try {
      await translateBatch({
        items: [{ groupId: 'g0', text: 'A' }],
        targetLang: 'zh',
        instance: deepseekInstance(),
        fetchImpl,
      });
    } catch (caught) {
      error = caught;
    }

    expect(error).toBeInstanceOf(BatchAlignError);
    expect(error.code).toBe(ERROR_CODES.BATCH_ALIGN);
  });

  it('缺密钥与权限未授权时不发批量请求', async () => {
    const fetchImpl = vi.fn();
    await expect(
      translateBatch({
        items: [{ groupId: 'g0', text: 'A' }],
        targetLang: 'zh',
        instance: deepseekInstance({ apiKey: '' }),
        fetchImpl,
      })
    ).rejects.toMatchObject({ code: ERROR_CODES.CONFIG });

    await expect(
      translateBatch({
        items: [{ groupId: 'g0', text: 'A' }],
        targetLang: 'zh',
        instance: deepseekInstance(),
        fetchImpl,
        checkPermission: () => false,
      })
    ).rejects.toMatchObject({ code: ERROR_CODES.CONFIG, message: '未授权访问该接口域名，请到设置页重新授权' });
    expect(fetchImpl).not.toHaveBeenCalled();
  });
});

