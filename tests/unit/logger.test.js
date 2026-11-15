/**
 * E4 日志入口测试
 */

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import {
  createLogger,
  getLogLevel,
  getLogMeta,
  initLogging,
  newTraceId,
  resetLogging,
  setLogLevel,
} from '../../src/shared/log/logger.js';

beforeEach(() => {
  resetLogging();
  vi.spyOn(console, 'debug').mockImplementation(() => {});
  vi.spyOn(console, 'info').mockImplementation(() => {});
  vi.spyOn(console, 'warn').mockImplementation(() => {});
  vi.spyOn(console, 'error').mockImplementation(() => {});
});

afterEach(() => {
  resetLogging();
  vi.restoreAllMocks();
});

describe('E4 日志入口', () => {
  it('未初始化时静默', () => {
    const log = createLogger('A2');
    log.info('gateway.connect', '网关已连接', { tabId: 1 });
    expect(console.info).not.toHaveBeenCalled();
  });

  it('按级别过滤并映射控制台方法', () => {
    initLogging({ context: 'background', level: 'info', sessionId: 's-1', version: '0.1.0' });
    const log = createLogger('A2');

    log.debug('batch.start', '开始处理批次', { items: 3 });
    log.info('gateway.connect', '网关已连接', { tabId: 12 });
    log.warn('batch.reject', '批次被拒绝', { reason: 'X' });
    log.error('engine.error', '引擎调用失败', { code: 'AUTH' }, new Error('boom'));

    expect(console.debug).not.toHaveBeenCalled();
    expect(console.info).toHaveBeenCalledTimes(1);
    expect(console.warn).toHaveBeenCalledTimes(1);
    expect(console.error).toHaveBeenCalledTimes(1);

    const line = console.info.mock.calls[0][0];
    expect(line).toContain('[bg][A2][INFO]');
    expect(line).toContain('gateway.connect 网关已连接');
    expect(line).toContain('{"data":{"tabId":12}}');
  });

  it('debug 级别显示详细日志，off 完全静默', () => {
    initLogging({ context: 'content', level: 'debug', sessionId: 's-2' });
    const log = createLogger('D4');

    log.debug('bridge.heartbeat', '心跳正常', { count: 1 });
    expect(console.debug).toHaveBeenCalledTimes(1);

    setLogLevel('off');
    log.error('bridge.invalidated', '扩展已重新加载');
    expect(console.error).not.toHaveBeenCalled();
    expect(getLogLevel()).toBe('off');
  });

  it('traceId 进入前缀，withTrace 不改变原 logger', () => {
    initLogging({ context: 'options', level: 'info', sessionId: 's-3' });
    const log = createLogger('C1');
    log.withTrace('t-1').info('engine.test.start', '开始测试翻译');
    log.info('settings.save', '保存设置');

    const traced = console.info.mock.calls[0][0];
    const plain = console.info.mock.calls[1][0];
    expect(traced).toContain('[trace:t-1]');
    expect(plain).not.toContain('[trace:');
  });

  it('控制台抛错不影响业务', () => {
    initLogging({ context: 'popup', level: 'info', sessionId: 's-4' });
    console.info.mockImplementation(() => {
      throw new Error('console broken');
    });
    const log = createLogger('B1');
    expect(() => log.info('popup.ready', '弹窗日志')).not.toThrow();
  });

  it('getLogMeta 带上下文、级别、版本与会话', () => {
    initLogging({
      context: 'content',
      level: 'warn',
      sessionId: 's-5',
      version: '0.1.0',
      origin: 'https://example.com',
    });
    expect(getLogMeta()).toMatchObject({
      context: 'content',
      level: 'warn',
      sessionId: 's-5',
      version: '0.1.0',
      origin: 'https://example.com',
    });
  });

  it('newTraceId 生成可用短串', () => {
    const id = newTraceId();
    expect(id).toMatch(/^t-[a-z0-9]+-[a-z0-9]+$/);
    expect(id.length).toBeLessThanOrEqual(64);
  });
});
