/**
 * E4 日志记录、脱敏与格式化测试
 */

import { describe, expect, it } from 'vitest';
import {
  LOG_LIMITS,
  createRecord,
  createSessionId,
  formatLine,
  formatTime,
  sanitizeData,
  sanitizeError,
  sanitizeText,
} from '../../src/shared/log/record.js';

describe('E4 记录与格式化', () => {
  it('createRecord 生成固定字段并保留 traceId', () => {
    const record = createRecord({
      level: 'info',
      scope: 'A2',
      ctx: 'background',
      event: 'gateway.connect',
      message: '网关已连接',
      data: { tabId: 12 },
      traceId: 't-1',
      sessionId: 's-1',
      now: 1_700_000_000_000,
    });

    expect(record).toMatchObject({
      level: 'info',
      ctx: 'background',
      scope: 'A2',
      event: 'gateway.connect',
      message: '网关已连接',
      sessionId: 's-1',
      traceId: 't-1',
    });
    expect(record.data).toEqual({ tabId: 12 });
  });

  it('formatLine 输出统一前缀、事件、消息与 JSON', () => {
    const record = createRecord({
      level: 'warn',
      scope: 'D4',
      ctx: 'content',
      event: 'bridge.heartbeat',
      message: '心跳超时',
      data: { count: 3 },
      traceId: 't-9',
      now: 1_700_000_000_000,
    });
    const line = formatLine(record);

    expect(line).toContain('[SimpleTrans][');
    expect(line).toContain('[content][D4][WARN][trace:t-9]');
    expect(line).toContain('bridge.heartbeat 心跳超时');
    expect(line).toContain('{"data":{"count":3}}');
  });

  it('formatTime 为本地时间格式', () => {
    expect(formatTime(1_700_000_000_000)).toMatch(/^\d{4}-\d{2}-\d{2} \d{2}:\d{2}:\d{2}\.\d{3}$/);
  });

  it('createSessionId 返回非空字符串', () => {
    const id = createSessionId();
    expect(typeof id).toBe('string');
    expect(id.length).toBeGreaterThan(0);
    expect(id.length).toBeLessThanOrEqual(64);
  });
});

describe('E4 脱敏与截断', () => {
  it('完整 URL 只保留来源，密钥样式短串替换', () => {
    expect(sanitizeText('see https://example.com/a/b?q=1 for details')).toBe(
      'see https://example.com for details'
    );
    expect(sanitizeText('sk-abcdefghijklmnop')).toBe('[redacted]');
    expect(sanitizeText('Bearer abcdefghijklmnop')).toBe('[redacted]');
  });

  it('敏感字段整体替换，嵌套对象与数组也会处理', () => {
    const clean = sanitizeData({
      apiKey: 'sk-abcdefghijklmnop',
      nested: { token: 'abc', ok: 1 },
      list: [{ secret: 'x' }, 'plain'],
    });
    expect(clean.apiKey).toBe('[redacted]');
    expect(clean.nested.token).toBe('[redacted]');
    expect(clean.nested.ok).toBe(1);
    expect(clean.list[0].secret).toBe('[redacted]');
  });

  it('字符串、数组与深度按上限截断', () => {
    const clean = sanitizeData({
      long: 'x'.repeat(LOG_LIMITS.maxString + 20),
      list: Array.from({ length: LOG_LIMITS.maxArray + 2 }, (_, i) => i),
      deep: { a: { b: { c: 1 } } },
    });
    expect(clean.long.endsWith('…')).toBe(true);
    expect(clean.list).toHaveLength(LOG_LIMITS.maxArray + 1);
    expect(String(clean.list.at(-1))).toContain('(+2)');
    expect(clean.deep.a).toBe('[truncated]');
  });

  it('循环引用不抛错', () => {
    const value = { name: 'x' };
    value.self = value;
    expect(() => sanitizeData(value)).not.toThrow();
    expect(sanitizeData(value).self).toBe('[circular]');
  });

  it('sanitizeError 只保留安全字段并截断栈', () => {
    const error = new Error('boom https://example.com/path?q=1');
    error.stack = `Error: boom\n${'x'.repeat(LOG_LIMITS.maxStack + 50)}`;
    const clean = sanitizeError(error);
    expect(clean.message).toBe('boom https://example.com');
    expect(clean.stack.endsWith('…')).toBe(true);
  });
});
