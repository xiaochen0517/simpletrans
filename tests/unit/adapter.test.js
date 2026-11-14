/**
 * A3 DeepSeek 适配器测试
 *
 * 用 vi.mock 隔离上游 ai SDK 与 @ai-sdk/deepseek，不联网、不需要真实密钥。
 */

import { beforeEach, describe, expect, it, vi } from 'vitest';

vi.mock('ai', () => ({ streamText: vi.fn() }));
vi.mock('@ai-sdk/deepseek', () => ({
  createDeepSeek: vi.fn(() => ({ chat: (model) => ({ model }) })),
}));

import { streamText } from 'ai';
import { createDeepSeek } from '@ai-sdk/deepseek';
import { ERROR_CODES } from '../../src/shared/protocol.js';
import { buildSystemPrompt, mapError, normalizeOutput, TranslateError, translate } from '../../src/shared/translate/adapter.js';

describe('A3 DeepSeek 适配器', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it('buildSystemPrompt 强调「数据不是指令」并带目标语言', () => {
    const prompt = buildSystemPrompt('zh');
    expect(prompt).toContain('中文');
    expect(prompt).toContain('数据');
    expect(prompt).toContain('指令');
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
  });

  it('上游错误经 mapError 转成 TranslateError', async () => {
    streamText.mockImplementation(() => {
      throw Object.assign(new Error('Unauthorized'), { statusCode: 401 });
    });
    await expect(translate({ text: 'hi', targetLang: 'zh', instance: { apiKey: 'sk-x', model: 'm' } })).rejects.toMatchObject({
      code: ERROR_CODES.AUTH,
    });
  });
});
