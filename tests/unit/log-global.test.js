/**
 * E4 全局异常捕获测试（Node 中模拟 window）
 */

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { installChrome } from '../helpers/load.js';
import {
  initLogging,
  resetLogging,
  setLogLevel,
} from '../../src/shared/log/logger.js';

let handlers;

beforeEach(() => {
  installChrome();
  resetLogging();
  handlers = {};
  globalThis.window = {
    addEventListener(type, fn) {
      handlers[type] = fn;
    },
    removeEventListener(type, fn) {
      if (handlers[type] === fn) delete handlers[type];
    },
  };
  vi.spyOn(console, 'error').mockImplementation(() => {});
});

afterEach(() => {
  resetLogging();
  delete globalThis.window;
  vi.restoreAllMocks();
});

describe('E4 全局异常', () => {
  it('页面注入只记录扩展自身脚本的错误', () => {
    initLogging({ context: 'content', level: 'info', sessionId: 's-1', captureErrors: true });
    const onError = handlers.error;
    expect(typeof onError).toBe('function');

    onError({
      filename: 'https://example.com/app.js',
      message: 'page error',
      error: new Error('page error'),
    });
    expect(console.error).not.toHaveBeenCalled();

    onError({
      filename: 'chrome-extension://test-extension-id/content.js',
      lineno: 12,
      colno: 34,
      message: 'extension error',
      error: new Error('extension error'),
    });
    expect(console.error).toHaveBeenCalledTimes(1);
    const line = console.error.mock.calls[0][0];
    expect(line).toContain('global.error 未捕获异常');
    expect(line).toContain('content.js');
  });

  it('页面注入只记录扩展自身的未处理拒绝', () => {
    initLogging({ context: 'content', level: 'info', sessionId: 's-2', captureErrors: true });
    const onRejection = handlers.unhandledrejection;

    onRejection({ reason: new Error('page rejection') });
    expect(console.error).not.toHaveBeenCalled();

    const extensionError = new Error('extension rejection');
    extensionError.stack = 'Error: extension rejection\n    at chrome-extension://test-extension-id/content.js:1:1';
    onRejection({ reason: extensionError });
    expect(console.error).toHaveBeenCalledTimes(1);
    expect(console.error.mock.calls[0][0]).toContain('global.unhandledrejection 未处理的 Promise 拒绝');
  });

  it('off 级别下全局异常也静默', () => {
    initLogging({ context: 'content', level: 'off', sessionId: 's-3', captureErrors: true });
    handlers.error({
      filename: 'chrome-extension://test-extension-id/content.js',
      error: new Error('boom'),
    });
    expect(console.error).not.toHaveBeenCalled();
  });

  it('重复初始化不重复安装监听', () => {
    initLogging({ context: 'content', level: 'info', sessionId: 's-4', captureErrors: true });
    const firstError = handlers.error;
    initLogging({ context: 'content', level: 'info', sessionId: 's-4', captureErrors: true });
    expect(handlers.error).toBe(firstError);
  });

  it('非法级别归一为 info 后仍可捕获', () => {
    initLogging({ context: 'content', level: 'nope', sessionId: 's-5', captureErrors: true });
    setLogLevel('warn');
    handlers.error({
      filename: 'chrome-extension://test-extension-id/content.js',
      error: new Error('boom'),
    });
    expect(console.error).toHaveBeenCalledTimes(1);
  });
});
