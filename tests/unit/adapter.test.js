/**
 * A3 适配器兼容层测试
 *
 * 验证旧 `type: 'deepseek'` 实例经 P8-1 映射后走 OpenAI 兼容适配器：
 * 请求地址/认证/思考参数、提示词、批量、错误与取消；用全局 fetch stub，不联网。
 */

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { ERROR_CODES } from '../../src/shared/protocol.js';
import {
  buildSystemPrompt,
  isSupportedTargetLang,
  normalizeOutput,
  PROMPT_VERSION,
  translate,
  translateBatch,
} from '../../src/shared/translate/adapter.js';
import { encodeBatchInput } from '../../src/shared/translate/batch.js';
import { DEFAULT_SYSTEM_PROMPT } from '../../src/shared/translate/prompt.js';
import { initLogging, resetLogging } from '../../src/shared/log/logger.js';
import { deltaEvent, sseEvent, sseResponse } from '../helpers/openai.js';

/** 构造旧 DeepSeek 实例。 */
function legacyInstance(overrides = {}) {
  return {
    id: 'default',
    type: 'deepseek',
    name: 'DeepSeek',
    model: 'deepseek-chat',
    baseUrl: 'https://api.deepseek.com',
    reasoningEffort: 'off',
    systemPrompt: DEFAULT_SYSTEM_PROMPT,
    apiKey: 'sk-legacy',
    ...overrides,
  };
}

/**
 * 安装全局 fetch stub 并记录调用。
 * @param {() => Response} factory
 */
function stubFetch(factory) {
  const fn = vi.fn(async () => factory());
  vi.stubGlobal('fetch', fn);
  return fn;
}

describe('A3 适配器兼容层：契约与工具', () => {
  afterEach(() => {
    resetLogging();
    vi.unstubAllGlobals();
  });

  it('导出提示词与输出归一接口', () => {
    expect(PROMPT_VERSION).toBe(3);
    expect(isSupportedTargetLang('zh')).toBe(true);
    expect(isSupportedTargetLang('ja')).toBe(true);
    expect(isSupportedTargetLang('fr')).toBe(false);
    expect(normalizeOutput('  "你好"  ')).toBe('你好');

    const prompt = buildSystemPrompt({ targetLang: 'zh', template: DEFAULT_SYSTEM_PROMPT });
    expect(prompt).toContain('中文');
    expect(prompt).toContain('数据');
    expect(prompt).toContain('指令');
  });
});

describe('A3 适配器兼容层：旧 DeepSeek 实例', () => {
  beforeEach(() => {
    initLogging({ level: 'off', sessionId: 'adapter-test' });
  });

  afterEach(() => {
    resetLogging();
    vi.unstubAllGlobals();
  });

  it('空文本短路，不调用 fetch', async () => {
    const fetchImpl = stubFetch(() => sseResponse(''));
    await expect(translate({ text: '   ', targetLang: 'zh', instance: legacyInstance() })).resolves.toEqual({
      text: '',
      usage: null,
    });
    expect(fetchImpl).not.toHaveBeenCalled();
  });

  it('缺密钥映射 CONFIG，不调用 fetch', async () => {
    const fetchImpl = stubFetch(() => sseResponse(''));
    await expect(
      translate({ text: 'hi', targetLang: 'zh', instance: legacyInstance({ apiKey: '' }) })
    ).rejects.toMatchObject({ code: ERROR_CODES.CONFIG });
    expect(fetchImpl).not.toHaveBeenCalled();
  });

  it('默认思考关闭：请求 DeepSeek chat completions，thinking.type=disabled', async () => {
    const fetchImpl = stubFetch(() =>
      sseResponse(
        deltaEvent(' 你') +
          deltaEvent('好 ') +
          sseEvent({ choices: [], usage: { prompt_tokens: 1, completion_tokens: 2, total_tokens: 3 } }) +
          sseEvent('[DONE]')
      )
    );

    const deltas = [];
    const result = await translate({
      text: 'hello',
      targetLang: 'zh',
      instance: legacyInstance(),
      onDelta: (delta) => deltas.push(delta),
    });

    expect(result).toEqual({
      text: '你好',
      usage: { promptTokens: 1, completionTokens: 2, totalTokens: 3 },
    });
    expect(deltas.join('')).toBe(' 你好 ');

    const [url, init] = fetchImpl.mock.calls[0];
    expect(url).toBe('https://api.deepseek.com/chat/completions');
    expect(init.headers.Authorization).toBe('Bearer sk-legacy');
    const body = JSON.parse(init.body);
    expect(body.model).toBe('deepseek-chat');
    expect(body.thinking).toEqual({ type: 'disabled' });
    expect(body).not.toHaveProperty('reasoning_effort');
    expect(body).not.toHaveProperty('temperature');
  });

  it('旧 reasoningEffort 映射为 reasoning_effort + thinking.type=enabled', async () => {
    const fetchImpl = stubFetch(() => sseResponse(deltaEvent('译文') + sseEvent('[DONE]')));
    await translate({ text: 'hi', targetLang: 'zh', instance: legacyInstance({ reasoningEffort: 'high' }) });

    const body = JSON.parse(fetchImpl.mock.calls[0][1].body);
    expect(body.reasoning_effort).toBe('high');
    expect(body.thinking).toEqual({ type: 'enabled' });
  });

  it('非法旧思考强度回退 off，不发 reasoning_effort', async () => {
    const fetchImpl = stubFetch(() => sseResponse(deltaEvent('译文') + sseEvent('[DONE]')));
    await translate({ text: 'hi', targetLang: 'zh', instance: legacyInstance({ reasoningEffort: 'bogus' }) });
    const body = JSON.parse(fetchImpl.mock.calls[0][1].body);
    expect(body).not.toHaveProperty('reasoning_effort');
    expect(body.thinking).toEqual({ type: 'disabled' });
  });

  it('旧自定义 baseUrl 与模型保留', async () => {
    const fetchImpl = stubFetch(() => sseResponse(deltaEvent('译文') + sseEvent('[DONE]')));
    await translate({
      text: 'hi',
      targetLang: 'zh',
      instance: legacyInstance({ baseUrl: 'https://proxy.example.com/v1', model: 'my-model' }),
    });
    const [url, init] = fetchImpl.mock.calls[0];
    expect(url).toBe('https://proxy.example.com/v1/chat/completions');
    expect(JSON.parse(init.body).model).toBe('my-model');
  });

  it('使用实例保存的提示词模板展开', async () => {
    const fetchImpl = stubFetch(() => sseResponse(deltaEvent('译文') + sseEvent('[DONE]')));
    await translate({
      text: 'hi',
      targetLang: 'zh',
      instance: legacyInstance({ systemPrompt: '把内容用书面语翻译成{{targetLang}}。{{outputFormat}}' }),
    });
    const body = JSON.parse(fetchImpl.mock.calls[0][1].body);
    expect(body.messages[0].content).toContain('用书面语');
    expect(body.messages[0].content).toContain('中文');
    expect(body.messages[0].content).not.toContain('{{targetLang}}');
  });

  it('HTTP 401 与网络异常映射为统一错误', async () => {
    stubFetch(() => new Response('unauthorized', { status: 401 }));
    await expect(translate({ text: 'hi', targetLang: 'zh', instance: legacyInstance() })).rejects.toMatchObject({
      code: ERROR_CODES.AUTH,
    });

    vi.stubGlobal(
      'fetch',
      vi.fn(async () => {
        throw new TypeError('Failed to fetch');
      })
    );
    await expect(translate({ text: 'hi', targetLang: 'zh', instance: legacyInstance() })).rejects.toMatchObject({
      code: ERROR_CODES.NETWORK,
    });
  });

  it('外部取消映射 CANCELLED', async () => {
    const controller = new AbortController();
    vi.stubGlobal(
      'fetch',
      vi.fn(async () => {
        controller.abort();
        throw Object.assign(new Error('aborted'), { name: 'AbortError' });
      })
    );

    await expect(
      translate({
        text: 'hi',
        targetLang: 'zh',
        instance: legacyInstance(),
        signal: controller.signal,
      })
    ).rejects.toMatchObject({ code: ERROR_CODES.CANCELLED });
  });

  it('旧实例批量：一次 JSONL 请求、逐段回调', async () => {
    const jsonl = '{"id":"g0","text":"甲"}\n{"id":"g1","text":"乙"}\n';
    const chunks = [jsonl.slice(0, 20), jsonl.slice(20)].map(deltaEvent).join('') + sseEvent('[DONE]');
    const fetchImpl = stubFetch(() => sseResponse(chunks));
    const items = [
      { groupId: 'g0', text: 'A' },
      { groupId: 'g1', text: 'B' },
    ];
    const onItem = vi.fn();

    const result = await translateBatch({
      items,
      targetLang: 'zh',
      instance: legacyInstance({ reasoningEffort: 'medium' }),
      onItem,
    });

    expect(result.usage).toBeNull();
    expect(onItem.mock.calls.map(([entry]) => entry)).toEqual([
      { groupId: 'g0', text: '甲' },
      { groupId: 'g1', text: '乙' },
    ]);

    const body = JSON.parse(fetchImpl.mock.calls[0][1].body);
    expect(body.messages[1].content).toBe(encodeBatchInput(items));
    expect(body.messages[0].content).toContain('JSONL');
    expect(body.reasoning_effort).toBe('medium');
  });
});
