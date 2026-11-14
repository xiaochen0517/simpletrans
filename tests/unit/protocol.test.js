/**
 * E1 消息协议（错误码）测试
 */

import { describe, expect, it } from 'vitest';
import { ERROR_CODES, ERROR_FLAGS, errorInfo, isKnownCode } from '../../src/shared/protocol.js';

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
