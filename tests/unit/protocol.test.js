/**
 * E1 消息协议（错误码）测试
 */

import { describe, expect, it } from 'vitest';
import {
  ERROR_CODES,
  ERROR_FLAGS,
  FAILURE_REASONS,
  MAX_DOMAIN_CHARS,
  MESSAGE_TYPES,
  PORT_NAME,
  errorInfo,
  findForbiddenField,
  isKnownCode,
  isKnownMessageType,
  makeError,
  normalizeDomain,
  normalizeTraceId,
} from '../../src/shared/protocol.js';

describe('E1 错误码与分类标志', () => {
  it('错误码到 retryable 的映射与架构 6.8 一致', () => {
    expect(ERROR_FLAGS[ERROR_CODES.CONFIG].retryable).toBe(false);
    expect(ERROR_FLAGS[ERROR_CODES.AUTH].retryable).toBe(false);
    expect(ERROR_FLAGS[ERROR_CODES.RATE_LIMIT].retryable).toBe(true);
    expect(ERROR_FLAGS[ERROR_CODES.NETWORK].retryable).toBe(true);
    expect(ERROR_FLAGS[ERROR_CODES.BATCH_ALIGN].retryable).toBe(false);
    expect(ERROR_FLAGS[ERROR_CODES.CANCELLED].retryable).toBe(false);
    expect(ERROR_FLAGS[ERROR_CODES.OTHER].retryable).toBe(false);
  });

  it('splittable 仅批量对齐为真', () => {
    expect(ERROR_FLAGS[ERROR_CODES.BATCH_ALIGN].splittable).toBe(true);
    expect(ERROR_FLAGS[ERROR_CODES.CONFIG].splittable).toBe(false);
    expect(ERROR_FLAGS[ERROR_CODES.NETWORK].splittable).toBe(false);
    expect(ERROR_FLAGS[ERROR_CODES.AUTH].splittable).toBe(false);
  });

  it('fallbackable：配置/鉴权/限流为真，网络/取消为假', () => {
    expect(ERROR_FLAGS[ERROR_CODES.CONFIG].fallbackable).toBe(true);
    expect(ERROR_FLAGS[ERROR_CODES.AUTH].fallbackable).toBe(true);
    expect(ERROR_FLAGS[ERROR_CODES.RATE_LIMIT].fallbackable).toBe(true);
    expect(ERROR_FLAGS[ERROR_CODES.NETWORK].fallbackable).toBe(false);
    expect(ERROR_FLAGS[ERROR_CODES.CANCELLED].fallbackable).toBe(false);
  });

  it('isKnownCode 与 errorInfo 对未知码回退 OTHER', () => {
    expect(isKnownCode(ERROR_CODES.AUTH)).toBe(true);
    expect(isKnownCode('NOPE')).toBe(false);
    expect(errorInfo('NOPE')).toEqual(ERROR_FLAGS[ERROR_CODES.OTHER]);
  });
});

describe('E1 消息名与载荷校验', () => {
  it('端口名固定为 st-gateway', () => {
    expect(PORT_NAME).toBe('st-gateway');
  });

  it('消息名覆盖 P2 控制面与数据面', () => {
    expect(MESSAGE_TYPES.LIST_ENGINES).toBe('ST_LIST_ENGINES');
    expect(MESSAGE_TYPES.TEST_ENGINE).toBe('ST_TEST_ENGINE');
    expect(MESSAGE_TYPES.TRANSLATE_BATCH).toBe('ST_TRANSLATE_BATCH');
    expect(MESSAGE_TYPES.ITEM_START).toBe('ST_ITEM_START');
    expect(MESSAGE_TYPES.ITEM_DELTA).toBe('ST_ITEM_DELTA');
    expect(MESSAGE_TYPES.ITEM_DONE).toBe('ST_ITEM_DONE');
    expect(MESSAGE_TYPES.ITEM_ERROR).toBe('ST_ITEM_ERROR');
    expect(MESSAGE_TYPES.BATCH_DONE).toBe('ST_BATCH_DONE');
    expect(MESSAGE_TYPES.CANCEL_BATCH).toBe('ST_CANCEL_BATCH');
    expect(MESSAGE_TYPES.CANCEL_ITEM).toBe('ST_CANCEL_ITEM');
    expect(MESSAGE_TYPES.PING).toBe('ST_PING');
    expect(MESSAGE_TYPES.PONG).toBe('ST_PONG');
    expect(MESSAGE_TYPES.CLOSE).toBe('ST_CLOSE');
    expect(MESSAGE_TYPES.LOG_CONFIG).toBe('ST_LOG_CONFIG');
  });

  it('isKnownMessageType 只认架构 4.6 的名字', () => {
    expect(isKnownMessageType('ST_TRANSLATE_BATCH')).toBe(true);
    expect(isKnownMessageType('ST_LOG_CONFIG')).toBe(true);
    expect(isKnownMessageType('ST_STOP')).toBe(false);
    expect(isKnownMessageType('ST_RETRY')).toBe(false);
    expect(isKnownMessageType('ST_GET_STATUS')).toBe(false);
    expect(isKnownMessageType(42)).toBe(false);
  });

  it('失败原因齐全且不重复', () => {
    const values = Object.values(FAILURE_REASONS);
    expect(values).toContain('INVALID_MESSAGE');
    expect(values).toContain('FORBIDDEN_FIELD');
    expect(values).toContain('TOO_MANY_INFLIGHT');
    expect(values).toContain('BATCH_TIMEOUT');
    expect(values).toContain('NOT_CONNECTED');
    expect(new Set(values).size).toBe(values.length);
  });

  it('findForbiddenField 检查顶层与嵌套字段', () => {
    expect(findForbiddenField({ requestId: 'r', items: [] })).toBeNull();
    expect(findForbiddenField({ requestId: 'r', apiKey: 'sk-x' })).toBe('apiKey');
    expect(
      findForbiddenField({ requestId: 'r', items: [{ itemId: 'i0', text: 'hi', baseUrl: 'x' }] })
    ).toBe('baseUrl');
    expect(findForbiddenField(null)).toBeNull();
  });

  it('makeError 按需带 reason', () => {
    expect(makeError(ERROR_CODES.OTHER, '失败')).toEqual({
      code: ERROR_CODES.OTHER,
      message: '失败',
    });
    expect(makeError(ERROR_CODES.OTHER, '失败', 'X')).toEqual({
      code: ERROR_CODES.OTHER,
      message: '失败',
      reason: 'X',
    });
  });

  it('normalizeTraceId 只保留非空且不超过 64 的字符串', () => {
    expect(normalizeTraceId('t-123')).toBe('t-123');
    expect(normalizeTraceId('  t-123  ')).toBe('t-123');
    expect(normalizeTraceId('')).toBeUndefined();
    expect(normalizeTraceId('   ')).toBeUndefined();
    expect(normalizeTraceId('x'.repeat(65))).toBeUndefined();
    expect(normalizeTraceId(42)).toBeUndefined();
    expect(normalizeTraceId(null)).toBeUndefined();
  });
});

describe('E1 缓存消息名（P5）', () => {
  it('两条缓存消息名与架构 4.6 一致', () => {
    expect(MESSAGE_TYPES.CACHE_STATS).toBe('ST_CACHE_STATS');
    expect(MESSAGE_TYPES.CLEAR_CACHE).toBe('ST_CLEAR_CACHE');
  });

  it('两条缓存消息被 isKnownMessageType 识别，未知消息仍不识别', () => {
    expect(isKnownMessageType('ST_CACHE_STATS')).toBe(true);
    expect(isKnownMessageType('ST_CLEAR_CACHE')).toBe(true);
    expect(isKnownMessageType('ST_CACHE_STATS_EXTRA')).toBe(false);
    expect(isKnownMessageType('ST_CLEAR_CACHE_V2')).toBe(false);
  });
});

describe('E1 域名归一（P5）', () => {
  it('MAX_DOMAIN_CHARS 为 253', () => {
    expect(MAX_DOMAIN_CHARS).toBe(253);
  });

  it('去首尾空白、转小写并去掉末尾的点', () => {
    expect(normalizeDomain('  WWW.Example.COM.  ')).toBe('www.example.com');
    expect(normalizeDomain('example.com.')).toBe('example.com');
    expect(normalizeDomain('example.com...')).toBe('example.com');
    expect(normalizeDomain('\tEXAMPLE.com\n')).toBe('example.com');
  });

  it('接受正常 IPv4、多级域名与单标签 hostname', () => {
    expect(normalizeDomain('192.168.0.1')).toBe('192.168.0.1');
    expect(normalizeDomain('127.0.0.1')).toBe('127.0.0.1');
    expect(normalizeDomain('sub.example.co.uk')).toBe('sub.example.co.uk');
    expect(normalizeDomain('localhost')).toBe('localhost');
    expect(normalizeDomain('example.com')).toBe('example.com');
  });

  it('拒绝带协议、端口、路径、查询串与锚点的值', () => {
    const invalid = [
      'https://example.com',
      'http://example.com/path',
      '//example.com',
      'example.com:8080',
      'example.com:443',
      'example.com/path',
      'example.com?x=1',
      'example.com#top',
      'user@example.com',
    ];
    for (const value of invalid) {
      expect(normalizeDomain(value), value).toBe('');
    }
  });

  it('拒绝非法字符、空标签与连字符边界', () => {
    const invalid = [
      'exa mple.com',
      'exa_mple.com',
      'example..com',
      '.example.com',
      '-example.com',
      'example-.com',
      'example.com-',
      '例子.中国',
      'example.com/例子',
      'example.com%20',
    ];
    // 末尾的点合法（归一后去掉），其余非法。
    expect(normalizeDomain('example.com.')).toBe('example.com');
    for (const value of invalid) {
      expect(normalizeDomain(value), value).toBe('');
    }
  });

  it('非字符串、空串与纯空白返回空串', () => {
    for (const value of [undefined, null, 42, true, {}, [], () => 'example.com']) {
      expect(normalizeDomain(value)).toBe('');
    }
    expect(normalizeDomain('')).toBe('');
    expect(normalizeDomain('   ')).toBe('');
    expect(normalizeDomain('.')).toBe('');
  });

  it('253 字符以内接受，超过 MAX_DOMAIN_CHARS 拒绝', () => {
    const label63 = 'a'.repeat(63);
    const maxLength = `${label63}.${'b'.repeat(63)}.${'c'.repeat(63)}.${'d'.repeat(61)}`;
    expect(maxLength).toHaveLength(MAX_DOMAIN_CHARS);
    expect(normalizeDomain(maxLength)).toBe(maxLength);

    const tooLong = `${label63}.${'b'.repeat(63)}.${'c'.repeat(63)}.${'d'.repeat(62)}`;
    expect(tooLong).toHaveLength(MAX_DOMAIN_CHARS + 1);
    expect(normalizeDomain(tooLong)).toBe('');
  });

  it('单段标签最长 63 字符，64 字符拒绝', () => {
    const label63 = `${'a'.repeat(63)}.com`;
    expect(normalizeDomain(label63)).toBe(label63);
    expect(normalizeDomain(`${'a'.repeat(64)}.com`)).toBe('');
  });
});
