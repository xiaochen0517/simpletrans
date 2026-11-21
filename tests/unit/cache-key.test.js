/**
 * A4 缓存 key v3 测试
 *
 * 覆盖 v3 字段顺序、endpoint 指纹/生成参数/提示词/批量版本参与 key、
 * OpenAI 与百度隔离、非 key 字段忽略与缺失字段报错。
 */

import { describe, expect, it, vi } from 'vitest';
import {
  CACHE_KEY_PREFIX,
  CACHE_KEY_VERSION,
  buildCacheKey,
} from '../../src/shared/cache/key.js';

/** 一组固定输入。 */
function baseInput(patch = {}) {
  return {
    engineType: 'openai',
    endpointFingerprint: 'https://api.deepseek.com/chat/completions',
    model: 'deepseek-chat',
    sourceLang: 'auto',
    targetLang: 'zh',
    promptVersion: 3,
    promptHash: 'p'.repeat(64),
    generationHash: 'g'.repeat(64),
    batchEncodingVersion: 1,
    text: 'Hello world',
    ...patch,
  };
}

/** 计算期望的 SHA-256 十六进制。 */
async function sha256(text) {
  const digest = await globalThis.crypto.subtle.digest(
    'SHA-256',
    new TextEncoder().encode(text)
  );
  return [...new Uint8Array(digest)].map((byte) => byte.toString(16).padStart(2, '0')).join('');
}

describe('A4 缓存 key v3', () => {
  it('版本常量为 3，key 形态为 cache:v3:<64 位十六进制>', async () => {
    expect(CACHE_KEY_VERSION).toBe(3);
    expect(CACHE_KEY_PREFIX).toBe('cache:v3:');
    const key = await buildCacheKey(baseInput());
    expect(key).toMatch(/^cache:v3:[0-9a-f]{64}$/);
  });

  it('按固定字段顺序做 SHA-256', async () => {
    const input = baseInput();
    const parts = [
      CACHE_KEY_VERSION,
      input.engineType,
      input.endpointFingerprint,
      input.model,
      input.sourceLang,
      input.targetLang,
      input.promptVersion,
      input.promptHash,
      input.generationHash,
      input.batchEncodingVersion,
      input.text,
    ].map(String);
    const expected = CACHE_KEY_PREFIX + (await sha256(JSON.stringify(parts)));
    expect(await buildCacheKey(input)).toBe(expected);
  });

  it('同一组输入稳定，promptVersion 数值与等值字符串等价', async () => {
    expect(await buildCacheKey(baseInput())).toBe(await buildCacheKey(baseInput()));
    expect(await buildCacheKey(baseInput({ promptVersion: '3' }))).toBe(
      await buildCacheKey(baseInput())
    );
  });

  it('endpoint 指纹、生成参数、提示词、模型、语言或批量版本变化都产生新 key', async () => {
    const base = await buildCacheKey(baseInput());
    const changes = {
      endpointFingerprint: 'https://llm.example.com/v1/chat/completions',
      generationHash: 'x'.repeat(64),
      promptHash: 'y'.repeat(64),
      model: 'gpt-4o-mini',
      targetLang: 'ja',
      sourceLang: 'en',
      promptVersion: 4,
      batchEncodingVersion: 2,
      text: 'Hello world!',
    };
    for (const [field, value] of Object.entries(changes)) {
      expect(await buildCacheKey(baseInput({ [field]: value })), field).not.toBe(base);
    }
  });

  it('OpenAI 与百度隔离：引擎类型、指纹、模型与提示词 profile 不同', async () => {
    const openai = await buildCacheKey(baseInput());
    const baidu = await buildCacheKey(
      baseInput({
        engineType: 'baidu',
        endpointFingerprint: 'baidu',
        model: 'general',
        promptVersion: 0,
        promptHash: 'none',
        generationHash: 'baidu:v1',
      })
    );
    expect(baidu).not.toBe(openai);
    expect(baidu).toMatch(/^cache:v3:[0-9a-f]{64}$/);
  });

  it('keyVersion 可显式覆盖，进入规范串并改变 key', async () => {
    expect(await buildCacheKey(baseInput({ keyVersion: 2 }))).not.toBe(
      await buildCacheKey(baseInput())
    );
  });

  it('domain、requestId 等非 key 字段被忽略', async () => {
    const base = await buildCacheKey(baseInput());
    expect(
      await buildCacheKey(baseInput({ domain: 'example.com', requestId: 'r1', traceId: 't1' }))
    ).toBe(base);
  });

  it('key 中不出现原文、提示词哈希等明文', async () => {
    const key = await buildCacheKey(baseInput({ text: '仅供测试的原文' }));
    expect(key).not.toContain('仅供测试');
    expect(key).not.toContain('Hello world');
    expect(key.slice('cache:v3:'.length)).toMatch(/^[0-9a-f]{64}$/);
  });

  it('中文与 emoji 原文可以计算，大小写与空白差异改变 key', async () => {
    const chinese = await buildCacheKey(baseInput({ text: '你好' }));
    const emoji = await buildCacheKey(baseInput({ text: '🙂' }));
    const upper = await buildCacheKey(baseInput({ text: 'HELLO' }));
    const spaced = await buildCacheKey(baseInput({ text: 'Hello  world' }));
    for (const key of [chinese, emoji, upper, spaced]) {
      expect(key).toMatch(/^cache:v3:[0-9a-f]{64}$/);
    }
    expect(new Set([chinese, emoji, upper, spaced]).size).toBe(4);
  });

  it('必填字段缺失或为空时抛 TypeError', async () => {
    for (const field of [
      'engineType',
      'endpointFingerprint',
      'model',
      'targetLang',
      'promptVersion',
      'promptHash',
      'generationHash',
      'batchEncodingVersion',
      'text',
    ]) {
      await expect(buildCacheKey(baseInput({ [field]: undefined }))).rejects.toThrow(TypeError);
    }
    await expect(buildCacheKey()).rejects.toThrow(TypeError);
  });

  it('运行环境缺少 crypto.subtle 时抛 TypeError', async () => {
    vi.stubGlobal('crypto', {});
    await expect(buildCacheKey(baseInput())).rejects.toThrow(TypeError);
    vi.unstubAllGlobals();
  });
});
