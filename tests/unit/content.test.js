/**
 * 页面注入入口测试
 *
 * 入口在导入时建立 st-gateway 连接；Node 环境没有 window，入口必须可安全导入。
 */

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { installChrome } from '../helpers/load.js';
import { MESSAGE_TYPES, PORT_NAME } from '../../src/shared/protocol.js';

beforeEach(() => {
  installChrome();
  vi.spyOn(console, 'debug').mockImplementation(() => {});
  vi.spyOn(console, 'info').mockImplementation(() => {});
  vi.spyOn(console, 'warn').mockImplementation(() => {});
  vi.spyOn(console, 'error').mockImplementation(() => {});
});

afterEach(() => {
  vi.restoreAllMocks();
});

describe('页面注入入口', () => {
  it('导入即建立 st-gateway 连接，可在 Node 下导入', async () => {
    const connectSpy = vi.spyOn(chrome.runtime, 'connect');
    vi.resetModules();

    const mod = await import('../../src/content/index.js');

    expect(connectSpy).toHaveBeenCalledWith({ name: PORT_NAME });
    expect(mod.getBridge().getState()).toBe('connecting');

    mod.getBridge().close();
    expect(mod.getBridge().getState()).toBe('closed');
  });

  it('收到 ST_LOG_CONFIG 后更新日志级别', async () => {
    let serverPort = null;
    chrome.runtime.onConnect.addListener((port) => {
      if (port.name === PORT_NAME) serverPort = port;
    });
    vi.resetModules();

    const mod = await import('../../src/content/index.js');
    const { getLogLevel } = await import('../../src/shared/log/logger.js');

    expect(serverPort).not.toBeNull();
    expect(getLogLevel()).toBe('info');

    serverPort.postMessage({
      type: MESSAGE_TYPES.LOG_CONFIG,
      payload: { level: 'debug' },
    });

    expect(getLogLevel()).toBe('debug');
    mod.getBridge().close();
  });
});
