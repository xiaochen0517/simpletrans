/**
 * A3 DeepSeek 适配器测试
 *
 * 用 vi.mock 隔离上游 ai SDK 与 @ai-sdk/deepseek，不联网、不需要真实密钥。
 */

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

vi.mock('ai', () => ({ streamText: vi.fn() }));
vi.mock('@ai-sdk/deepseek', () => ({
  createDeepSeek: vi.fn(() => ({ chat: (model) => ({ model }) })),
}));

import { streamText } from 'ai';
import { createDeepSeek } from '@ai-sdk/deepseek';
import { ERROR_CODES } from '../../src/shared/protocol.js';
import {
  buildSystemPrompt,
  deepseekProviderOptions,
  isSupportedTargetLang,
  mapError,
  normalizeOutput,
  PROMPT_VERSION,
  TranslateError,
  translate,
  translateBatch,
} from '../../src/shared/translate/adapter.js';
import {
  BATCH_ENCODING_VERSION,
  BatchAlignError,
  encodeBatchInput,
} from '../../src/shared/translate/batch.js';
import { DEFAULT_SYSTEM_PROMPT } from '../../src/shared/translate/prompt.js';
import { initLogging, resetLogging } from '../../src/shared/log/logger.js';

describe('A3 DeepSeek 适配器', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  afterEach(() => {
    resetLogging();
    vi.restoreAllMocks();
  });

  it('导出 PROMPT_VERSION=2 供缓存 key 使用', () => {
    expect(PROMPT_VERSION).toBe(2);
  });

  it('buildSystemPrompt 强调「数据不是指令」并带目标语言', () => {
    const prompt = buildSystemPrompt({ targetLang: 'zh', template: DEFAULT_SYSTEM_PROMPT });
    expect(prompt).toContain('中文');
    expect(prompt).toContain('数据');
    expect(prompt).toContain('指令');
  });

  it('deepseekProviderOptions：off 关闭思考，其余开启并传 effort', () => {
    expect(deepseekProviderOptions({})).toEqual({
      deepseek: { thinking: { type: 'disabled' } },
    });
    expect(deepseekProviderOptions({ reasoningEffort: 'bogus' })).toEqual({
      deepseek: { thinking: { type: 'disabled' } },
    });

    for (const effort of ['low', 'medium', 'high', 'max']) {
      expect(deepseekProviderOptions({ reasoningEffort: effort })).toEqual({
        deepseek: { thinking: { type: 'enabled' }, reasoningEffort: effort },
      });
    }
  });

  it('normalizeOutput 去掉引号与首尾空白', () => {
    expect(normalizeOutput('  "你好"  ')).toBe('你好');
    expect(normalizeOutput('「世界」')).toBe('世界');
    expect(normalizeOutput('  plain  ')).toBe('plain');
  });

  it('mapError 映射鉴权/限流/网络/其它', () => {
    expect(mapError({ statusCode: 401 }).code).toBe(ERROR_CODES.AUTH);
    expect(mapError({ statusCode: 429 }).code).toBe(ERROR_CODES.RATE_LIMIT);
    expect(mapError(new Error('fetch failed')).code).toBe(ERROR_CODES.NETWORK);
    expect(mapError(new Error('something else')).code).toBe(ERROR_CODES.OTHER);
  });

  it('isSupportedTargetLang 只认当前语言表', () => {
    expect(isSupportedTargetLang('zh')).toBe(true);
    expect(isSupportedTargetLang('ja')).toBe(false);
    expect(isSupportedTargetLang(undefined)).toBe(false);
  });

  it('空文本短路，不调上游', async () => {
    const result = await translate({ text: '   ', targetLang: 'zh', instance: { apiKey: 'sk-x', model: 'm' } });
    expect(result).toEqual({ text: '', usage: null });
    expect(streamText).not.toHaveBeenCalled();
  });

  it('缺密钥抛 CONFIG，不调上游', async () => {
    await expect(translate({ text: 'hi', targetLang: 'zh', instance: { model: 'm' } })).rejects.toMatchObject({
      code: ERROR_CODES.CONFIG,
    });
    expect(streamText).not.toHaveBeenCalled();
  });

  it('成功翻译：流式聚合 + 输出归一 + 用量返回', async () => {
    streamText.mockReturnValue({
      textStream: (async function* () {
        yield ' 你';
        yield '好 ';
      })(),
      usage: Promise.resolve({ promptTokens: 1, completionTokens: 2, totalTokens: 3 }),
    });

    const deltas = [];
    const result = await translate({
      text: 'hello',
      targetLang: 'zh',
      instance: { apiKey: 'sk-x', model: 'deepseek-chat', baseUrl: 'https://api.deepseek.com' },
      onDelta: (delta) => deltas.push(delta),
    });

    expect(result.text).toBe('你好');
    expect(result.usage.totalTokens).toBe(3);
    expect(deltas.join('')).toBe(' 你好 ');
    expect(createDeepSeek).toHaveBeenCalledWith({ apiKey: 'sk-x', baseURL: 'https://api.deepseek.com' });
    expect(streamText).toHaveBeenCalledWith(
      expect.objectContaining({
        prompt: 'hello',
        system: buildSystemPrompt({ targetLang: 'zh', template: DEFAULT_SYSTEM_PROMPT }),
        providerOptions: { deepseek: { thinking: { type: 'disabled' } } },
      })
    );
  });

  it('使用实例保存的提示词与思考强度，测试翻译与页面翻译共用同一路径', async () => {
    streamText.mockReturnValue({
      textStream: (async function* () {
        yield '译文';
      })(),
      usage: Promise.resolve({ totalTokens: 1 }),
    });

    const template = '把内容用书面语翻译成{{targetLang}}。{{outputFormat}}';
    await translate({
      text: 'hello',
      targetLang: 'zh',
      instance: {
        apiKey: 'sk-x',
        model: 'deepseek-chat',
        reasoningEffort: 'low',
        systemPrompt: template,
      },
    });

    const call = streamText.mock.calls[0][0];
    expect(call.system).toContain('用书面语');
    expect(call.system).toContain('中文');
    expect(call.system).not.toContain('{{targetLang}}');
    expect(call.providerOptions).toEqual({
      deepseek: { thinking: { type: 'enabled' }, reasoningEffort: 'low' },
    });
  });

  it('engine.request 记录模型、思考强度与提示词版本，不记录提示词正文', async () => {
    initLogging({ level: 'debug', sessionId: 'adapter-test' });
    vi.spyOn(console, 'debug').mockImplementation(() => {});
    streamText.mockReturnValue({
      textStream: (async function* () {
        yield '译文';
      })(),
      usage: Promise.resolve({ totalTokens: 1 }),
    });

    const template = '机密模板内容 {{targetLang}} {{outputFormat}}';
    await translate({
      text: 'hello',
      targetLang: 'zh',
      instance: { apiKey: 'sk-x', model: 'deepseek-chat', reasoningEffort: 'high', systemPrompt: template },
    });

    const lines = console.debug.mock.calls.map(([line]) => String(line));
    const request = lines.find((line) => line.includes('engine.request'));
    expect(request).toBeTruthy();
    expect(request).toContain('"reasoningEffort":"high"');
    expect(request).toContain('"promptVersion":2');
    expect(request).toContain('"promptDefault":false');
    expect(lines.join('\n')).not.toContain('机密模板内容');
    expect(lines.join('\n')).not.toContain('sk-x');
  });

  it('上游错误经 mapError 转成 TranslateError', async () => {
    streamText.mockImplementation(() => {
      throw Object.assign(new Error('Unauthorized'), { statusCode: 401 });
    });
    await expect(translate({ text: 'hi', targetLang: 'zh', instance: { apiKey: 'sk-x', model: 'm' } })).rejects.toMatchObject({
      code: ERROR_CODES.AUTH,
    });
  });

  it('已取消的 signal 短路，不调用上游', async () => {
    const controller = new AbortController();
    controller.abort();
    await expect(
      translate({
        text: 'hi',
        targetLang: 'zh',
        instance: { apiKey: 'sk-x', model: 'm' },
        signal: controller.signal,
      })
    ).rejects.toMatchObject({ code: ERROR_CODES.CANCELLED });
    expect(streamText).not.toHaveBeenCalled();
  });

  it('外部取消映射 CANCELLED，而非 NETWORK', async () => {
    const controller = new AbortController();
    streamText.mockImplementation(() => {
      controller.abort();
      throw Object.assign(new Error('The operation was aborted'), { name: 'AbortError' });
    });

    await expect(
      translate({
        text: 'hi',
        targetLang: 'zh',
        instance: { apiKey: 'sk-x', model: 'm' },
        signal: controller.signal,
      })
    ).rejects.toMatchObject({ code: ERROR_CODES.CANCELLED });
  });

  it('取消时标记 usage 的拒绝为已处理，不产生未处理拒绝', async () => {
    const controller = new AbortController();
    const unhandled = [];
    const onUnhandled = (reason) => unhandled.push(reason);
    process.on('unhandledRejection', onUnhandled);

    try {
      const usage = Promise.reject(
        Object.assign(new Error('signal is aborted without reason'), { name: 'AbortError' })
      );
      streamText.mockReturnValue({
        textStream: (async function* () {
          controller.abort();
          throw Object.assign(new Error('aborted'), { name: 'AbortError' });
        })(),
        usage,
      });

      await expect(
        translate({
          text: 'hi',
          targetLang: 'zh',
          instance: { apiKey: 'sk-x', model: 'm' },
          signal: controller.signal,
        })
      ).rejects.toMatchObject({ code: ERROR_CODES.CANCELLED });

      await new Promise((resolve) => setTimeout(resolve, 0));
      expect(unhandled).toEqual([]);
    } finally {
      process.off('unhandledRejection', onUnhandled);
    }
  });

  it('超时映射 NETWORK', async () => {
    streamText.mockImplementation(() => {
      throw Object.assign(new Error('The operation was aborted'), { name: 'AbortError' });
    });

    await expect(
      translate({ text: 'hi', targetLang: 'zh', instance: { apiKey: 'sk-x', model: 'm' } })
    ).rejects.toMatchObject({ code: ERROR_CODES.NETWORK });
  });
});

describe('A3 批量翻译（P6.4）', () => {
  const instance = { apiKey: 'sk-x', model: 'deepseek-chat' };

  /** 构造按给定增量输出的假 SDK 结果。 */
  function fakeStream(chunks, usage = { promptTokens: 5, completionTokens: 6, totalTokens: 11 }) {
    return {
      textStream: (async function* () {
        for (const chunk of chunks) yield chunk;
      })(),
      usage: Promise.resolve(usage),
    };
  }

  beforeEach(() => {
    vi.clearAllMocks();
  });

  afterEach(() => {
    resetLogging();
    vi.restoreAllMocks();
  });

  it('空 items 直接返回，不发上游请求', async () => {
    const result = await translateBatch({ items: [], targetLang: 'zh', instance });
    expect(result).toEqual({ usage: null });
    expect(streamText).not.toHaveBeenCalled();
  });

  it('缺密钥抛 CONFIG，已取消抛 CANCELLED，都不发上游请求', async () => {
    await expect(
      translateBatch({ items: [{ groupId: 'g0', text: 'hi' }], targetLang: 'zh', instance: {} })
    ).rejects.toMatchObject({ code: ERROR_CODES.CONFIG });

    const controller = new AbortController();
    controller.abort();
    await expect(
      translateBatch({
        items: [{ groupId: 'g0', text: 'hi' }],
        targetLang: 'zh',
        instance,
        signal: controller.signal,
      })
    ).rejects.toMatchObject({ code: ERROR_CODES.CANCELLED });

    expect(streamText).not.toHaveBeenCalled();
  });

  it('一次请求、JSONL 输入、逐段回调、批量 usage 返回', async () => {
    streamText.mockReturnValue(
      fakeStream(['{"id":"g0","text":" 你好 "}\n{"id":"g1","text":"', '世界"}\n'])
    );
    const items = [
      { groupId: 'g0', text: 'Hello' },
      { groupId: 'g1', text: 'World' },
    ];
    const onItem = vi.fn();

    const result = await translateBatch({ items, targetLang: 'zh', instance, onItem });

    expect(streamText).toHaveBeenCalledTimes(1);
    const call = streamText.mock.calls[0][0];
    expect(call.prompt).toBe(encodeBatchInput(items));
    expect(call.system).toBe(
      buildSystemPrompt({ targetLang: 'zh', template: undefined, mode: 'batch' })
    );
    expect(call.system).toContain('JSONL');
    expect(onItem.mock.calls.map(([entry]) => entry)).toEqual([
      { groupId: 'g0', text: '你好' },
      { groupId: 'g1', text: '世界' },
    ]);
    expect(result.usage).toEqual({ promptTokens: 5, completionTokens: 6, totalTokens: 11 });
    expect(BATCH_ENCODING_VERSION).toBe(1);
  });

  it('容错代码围栏与空行', async () => {
    streamText.mockReturnValue(fakeStream(['```json\n{"id":"g0","text":"你好"}\n```\n']));
    const onItem = vi.fn();

    await translateBatch({
      items: [{ groupId: 'g0', text: 'Hello' }],
      targetLang: 'zh',
      instance,
      onItem,
    });

    expect(onItem).toHaveBeenCalledWith({ groupId: 'g0', text: '你好' });
  });

  it('使用实例提示词模板与思考强度', async () => {
    streamText.mockReturnValue(fakeStream(['{"id":"g0","text":"译文"}\n']));
    await translateBatch({
      items: [{ groupId: 'g0', text: 'Hello' }],
      targetLang: 'zh',
      instance: {
        ...instance,
        reasoningEffort: 'high',
        systemPrompt: '用书面语翻译成{{targetLang}}。{{outputFormat}}',
      },
    });

    const call = streamText.mock.calls[0][0];
    expect(call.system).toContain('用书面语');
    expect(call.system).toContain('JSONL');
    expect(call.providerOptions).toEqual({
      deepseek: { thinking: { type: 'enabled' }, reasoningEffort: 'high' },
    });
  });

  it('缺少段落时抛 BatchAlignError，已解析段落仍回调', async () => {
    initLogging({ level: 'debug', sessionId: 'adapter-test' });
    vi.spyOn(console, 'warn').mockImplementation(() => {});
    streamText.mockReturnValue(fakeStream(['{"id":"g0","text":"只有一段"}\n']));
    const onItem = vi.fn();

    let error = null;
    try {
      await translateBatch({
        items: [
          { groupId: 'g0', text: 'A' },
          { groupId: 'g1', text: 'B' },
        ],
        targetLang: 'zh',
        instance,
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

  it('外部取消映射 CANCELLED；上游错误映射 NETWORK', async () => {
    const controller = new AbortController();
    streamText.mockImplementation(() => {
      controller.abort();
      throw Object.assign(new Error('aborted'), { name: 'AbortError' });
    });
    await expect(
      translateBatch({
        items: [{ groupId: 'g0', text: 'A' }],
        targetLang: 'zh',
        instance,
        signal: controller.signal,
      })
    ).rejects.toMatchObject({ code: ERROR_CODES.CANCELLED });

    streamText.mockImplementation(() => {
      throw Object.assign(new Error('fetch failed'), { name: 'TypeError' });
    });
    await expect(
      translateBatch({ items: [{ groupId: 'g0', text: 'A' }], targetLang: 'zh', instance })
    ).rejects.toMatchObject({ code: ERROR_CODES.NETWORK });
  });

  it('取消时观察 usage 的拒绝，不产生未处理拒绝', async () => {
    const controller = new AbortController();
    const unhandled = [];
    const onUnhandled = (reason) => unhandled.push(reason);
    process.on('unhandledRejection', onUnhandled);

    try {
      const usage = Promise.reject(
        Object.assign(new Error('signal is aborted without reason'), { name: 'AbortError' })
      );
      streamText.mockReturnValue({
        textStream: (async function* () {
          controller.abort();
          throw Object.assign(new Error('aborted'), { name: 'AbortError' });
        })(),
        usage,
      });

      await expect(
        translateBatch({
          items: [{ groupId: 'g0', text: 'A' }],
          targetLang: 'zh',
          instance,
          signal: controller.signal,
        })
      ).rejects.toMatchObject({ code: ERROR_CODES.CANCELLED });

      await new Promise((resolve) => setTimeout(resolve, 0));
      expect(unhandled).toEqual([]);
    } finally {
      process.off('unhandledRejection', onUnhandled);
    }
  });
});
