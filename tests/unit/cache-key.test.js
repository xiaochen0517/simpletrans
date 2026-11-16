/**
 * A4 缓存 key 测试
 *
 * 覆盖需求文档 2.2.1 / 3.3 / 3.9：字段稳定与逐项区分、规范串与 SHA-256、版本前缀、
 * 空上下文与缺省归一、域名等非 key 字段不参与、必填校验与失败路径。
 */

import { createHash } from 'node:crypto';
import { afterEach, describe, expect, it, vi } from 'vitest';
import {
  CACHE_KEY_PREFIX,
  CACHE_KEY_VERSION,
  buildCacheKey,
} from '../../src/shared/cache/key.js';

const BASE = Object.freeze({
  engineType: 'deepseek',
  model: 'deepseek-chat',
  sourceLang: 'auto',
  targetLang: 'zh',
  promptVersion: 1,
  context: '',
  text: 'Hello world',
});

/** 计算规范串的 SHA-256 小写十六进制。 */
function sha256(payload) {
  return createHash('sha256').update(payload).digest('hex');
}

afterEach(() => {
  vi.unstubAllGlobals();
});

describe('A4 缓存 key', () => {
  it('同一组字段重复计算得到同一个 key，形态为 cache:v1:<64 位小写十六进制>', async () => {
    const first = await buildCacheKey(BASE);
    const second = await buildCacheKey({ ...BASE });

    expect(second).toBe(first);
    expect(CACHE_KEY_VERSION).toBe(1);
    expect(CACHE_KEY_PREFIX).toBe('cache:v1:');
    expect(first.startsWith(CACHE_KEY_PREFIX)).toBe(true);
    expect(first).toMatch(/^cache:v1:[0-9a-f]{64}$/);
    expect(first).toHaveLength(CACHE_KEY_PREFIX.length + 64);
  });

  it('按文档固定字段顺序生成规范串并做 SHA-256，key 版本进入规范串', async () => {
    const key = await buildCacheKey(BASE);
    const canonical = JSON.stringify([
      String(CACHE_KEY_VERSION),
      'deepseek',
      'deepseek-chat',
      'auto',
      'zh',
      '1',
      '',
      'Hello world',
    ]);

    expect(key).toBe(`cache:v${CACHE_KEY_VERSION}:${sha256(canonical)}`);
  });

  it.each([
    ['引擎类型', { engineType: 'openai' }],
    ['模型', { model: 'deepseek-reasoner' }],
    ['源语言', { sourceLang: 'en' }],
    ['目标语言', { targetLang: 'ja' }],
    ['提示词版本', { promptVersion: 2 }],
    ['每段上下文', { context: '上一段文字' }],
    ['原文', { text: 'Hello world!' }],
  ])('%s 变化后 key 发生变化', async (_label, patch) => {
    const base = await buildCacheKey(BASE);
    const changed = await buildCacheKey({ ...BASE, ...patch });

    expect(changed).not.toBe(base);
    expect(changed).toMatch(/^cache:v1:[0-9a-f]{64}$/);
  });

  it('context 缺省、undefined、null 与空串得到同一个 key，且与有上下文不同', async () => {
    const { context: _context, ...withoutContext } = BASE;
    const keys = await Promise.all([
      buildCacheKey(BASE),
      buildCacheKey(withoutContext),
      buildCacheKey({ ...BASE, context: undefined }),
      buildCacheKey({ ...BASE, context: null }),
      buildCacheKey({ ...BASE, context: '' }),
    ]);

    expect(new Set(keys).size).toBe(1);
    expect(await buildCacheKey({ ...BASE, context: '上下文' })).not.toBe(keys[0]);
  });

  it('sourceLang 缺省、空串与显式 auto 得到同一个 key，且与其它语言不同', async () => {
    const { sourceLang: _sourceLang, ...withoutSourceLang } = BASE;
    const keys = await Promise.all([
      buildCacheKey(BASE),
      buildCacheKey(withoutSourceLang),
      buildCacheKey({ ...BASE, sourceLang: undefined }),
      buildCacheKey({ ...BASE, sourceLang: null }),
      buildCacheKey({ ...BASE, sourceLang: '' }),
    ]);

    expect(new Set(keys).size).toBe(1);
    expect(await buildCacheKey({ ...BASE, sourceLang: 'en' })).not.toBe(keys[0]);
  });

  it('domain、traceId、requestId 与批次上下文等非 key 字段不影响结果', async () => {
    const base = await buildCacheKey(BASE);

    expect(await buildCacheKey({ ...BASE, domain: 'example.com' })).toBe(base);
    expect(await buildCacheKey({ ...BASE, domain: 'another.example' })).toBe(base);
    expect(
      await buildCacheKey({
        ...BASE,
        domain: 'example.com',
        traceId: 't-1',
        requestId: 'b-1',
        batchContext: '页面标题',
      })
    ).toBe(base);
  });

  it('key 中不出现原文、上下文、域名等明文，只保留哈希与版本前缀', async () => {
    const text = 'Hello world 你好 😀';
    const context = '上一段 ctx-123';
    const key = await buildCacheKey({ ...BASE, text, context, domain: 'example.com' });

    expect(key).not.toContain('Hello');
    expect(key).not.toContain('world');
    expect(key).not.toContain('你好');
    expect(key).not.toContain('😀');
    expect(key).not.toContain('ctx-123');
    expect(key).not.toContain('example.com');
    expect(key).toMatch(/^cache:v1:[0-9a-f]{64}$/);
  });

  it('中文与 emoji 原文可以计算，且与 ASCII 原文互相区分', async () => {
    const ascii = await buildCacheKey(BASE);
    const chinese = await buildCacheKey({ ...BASE, text: '你好，世界' });
    const emoji = await buildCacheKey({ ...BASE, text: '👋🌍😀' });

    for (const key of [chinese, emoji]) expect(key).toMatch(/^cache:v1:[0-9a-f]{64}$/);
    expect(new Set([ascii, chinese, emoji]).size).toBe(3);
  });

  it('原文大小写、标点、首尾空白与内部空白的差异都会改变 key（key 不对原文再归一）', async () => {
    const base = await buildCacheKey({ ...BASE, text: 'hello world' });

    for (const text of ['Hello world', 'hello world!', ' hello world ', 'hello  world']) {
      expect(await buildCacheKey({ ...BASE, text })).not.toBe(base);
    }
  });

  it('promptVersion 数值与等值字符串得到同一个 key，不同版本得到不同 key', async () => {
    const fromNumber = await buildCacheKey({ ...BASE, promptVersion: 1 });
    const fromString = await buildCacheKey({ ...BASE, promptVersion: '1' });
    const nextVersion = await buildCacheKey({ ...BASE, promptVersion: 2 });

    expect(fromString).toBe(fromNumber);
    expect(nextVersion).not.toBe(fromNumber);
  });

  it.each(['engineType', 'model', 'targetLang', 'promptVersion', 'text'])(
    '必填字段 %s 缺失时抛 TypeError',
    async (field) => {
      const input = { ...BASE };
      delete input[field];

      await expect(buildCacheKey(input)).rejects.toThrow(TypeError);
    }
  );

  it.each(['engineType', 'model', 'targetLang', 'promptVersion', 'text'])(
    '必填字段 %s 为空白字符串时抛 TypeError',
    async (field) => {
      await expect(buildCacheKey({ ...BASE, [field]: '   ' })).rejects.toThrow(TypeError);
      await expect(buildCacheKey({ ...BASE, [field]: '' })).rejects.toThrow(TypeError);
    }
  );

  it('必填字段为 null 或 undefined 时抛 TypeError', async () => {
    for (const field of ['engineType', 'model', 'targetLang', 'promptVersion', 'text']) {
      await expect(buildCacheKey({ ...BASE, [field]: null })).rejects.toThrow(TypeError);
      await expect(buildCacheKey({ ...BASE, [field]: undefined })).rejects.toThrow(TypeError);
    }
  });

  it('无参数调用时抛 TypeError', async () => {
    await expect(buildCacheKey()).rejects.toThrow(TypeError);
  });

  it('运行环境缺少 crypto.subtle 时抛 TypeError', async () => {
    vi.stubGlobal('crypto', {});
    await expect(buildCacheKey(BASE)).rejects.toThrow(TypeError);
  });
});
