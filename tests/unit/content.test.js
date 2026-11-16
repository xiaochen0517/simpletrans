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

/**
 * 通过 runtime.onMessage 向页面注入发一条后台命令。
 * @param {object} message
 * @returns {Promise<object>}
 */
function sendToContent(message) {
  return new Promise((resolve) => {
    chrome.runtime.onMessage.emit(message, { id: chrome.runtime.id }, resolve);
  });
}

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

  it('Node 环境没有 DOM 时，ST_TOGGLE 返回明确失败而不抛错', async () => {
    vi.resetModules();
    const mod = await import('../../src/content/index.js');

    const response = await sendToContent({
      type: MESSAGE_TYPES.TOGGLE,
      payload: { traceId: 't-1' },
    });

    expect(response.ok).toBe(false);
    expect(response.error.message).toContain('当前页面不可用');
    mod.getBridge().close();
  });

  it('Node 环境没有 DOM 时，ST_CLEAR 返回明确失败而不抛错', async () => {
    vi.resetModules();
    const mod = await import('../../src/content/index.js');

    const response = await sendToContent({ type: MESSAGE_TYPES.CLEAR, payload: {} });

    expect(response.ok).toBe(false);
    expect(response.error.message).toContain('当前页面不可用');
    mod.getBridge().close();
  });
});
