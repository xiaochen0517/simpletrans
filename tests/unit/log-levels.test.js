/**
 * E4 日志等级测试
 */

import { describe, expect, it } from 'vitest';
import {
  DEFAULT_LOG_LEVEL,
  LOG_LEVELS,
  LOG_LEVEL_LABELS,
  LOG_LEVEL_OPTIONS,
  normalizeLevel,
  shouldLog,
} from '../../src/shared/log/levels.js';

describe('E4 日志等级', () => {
  it('五个等级数值递增，off 最大', () => {
    expect(LOG_LEVELS.debug).toBeLessThan(LOG_LEVELS.info);
    expect(LOG_LEVELS.info).toBeLessThan(LOG_LEVELS.warn);
    expect(LOG_LEVELS.warn).toBeLessThan(LOG_LEVELS.error);
    expect(LOG_LEVELS.error).toBeLessThan(LOG_LEVELS.off);
    expect(DEFAULT_LOG_LEVEL).toBe('info');
  });

  it('normalizeLevel 只认五个值，其余回退 info', () => {
    for (const level of ['debug', 'info', 'warn', 'error', 'off']) {
      expect(normalizeLevel(level)).toBe(level);
    }
    expect(normalizeLevel('verbose')).toBe('info');
    expect(normalizeLevel('')).toBe('info');
    expect(normalizeLevel(null)).toBe('info');
    expect(normalizeLevel(42)).toBe('info');
  });

  it('shouldLog 按阈值过滤，off 全部关闭', () => {
    expect(shouldLog('info', 'debug')).toBe(false);
    expect(shouldLog('info', 'info')).toBe(true);
    expect(shouldLog('info', 'warn')).toBe(true);
    expect(shouldLog('warn', 'info')).toBe(false);
    expect(shouldLog('warn', 'warn')).toBe(true);
    expect(shouldLog('error', 'warn')).toBe(false);
    expect(shouldLog('debug', 'debug')).toBe(true);
    expect(shouldLog('off', 'error')).toBe(false);
    expect(shouldLog('info', 'nope')).toBe(false);
  });

  it('设置页选项与短标签齐全', () => {
    expect(LOG_LEVEL_OPTIONS.map((option) => option.value)).toEqual([
      'debug',
      'info',
      'warn',
      'error',
      'off',
    ]);
    expect(LOG_LEVEL_LABELS.debug).toBe('详细');
    expect(LOG_LEVEL_LABELS.off).toBe('关闭');
  });
});
