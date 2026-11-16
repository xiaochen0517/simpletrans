/**
 * 后台入口测试
 *
 * 顶层注册监听器，必须在 stub 安装后动态导入（架构 7.6）。
 */

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

vi.mock('../../src/shared/translate/adapter.js', () => {
  class TranslateError extends Error {
    constructor(code, message) {
      super(message);
      this.name = 'TranslateError';
      this.code = code;
    }
  }
  return {
    translate: vi.fn(),
    TranslateError,
    isSupportedTargetLang: (lang) => lang === 'zh',
    SUPPORTED_TARGET_LANGS: ['zh'],
  };
});

import { importFresh } from '../helpers/load.js';
import { MESSAGE_TYPES, PORT_NAME } from '../../src/shared/protocol.js';

beforeEach(() => {
  vi.resetModules();
  vi.spyOn(console, 'debug').mockImplementation(() => {});
  vi.spyOn(console, 'info').mockImplementation(() => {});
  vi.spyOn(console, 'warn').mockImplementation(() => {});
  vi.spyOn(console, 'error').mockImplementation(() => {});
});

afterEach(() => {
  vi.restoreAllMocks();
});

describe('后台入口', () => {
  it('顶层注册 onMessage 与 onConnect', async () => {
    await importFresh('../../src/background/index.js');
    expect(chrome.runtime.onMessage.listeners).toHaveLength(1);
    expect(chrome.runtime.onConnect.listeners).toHaveLength(1);
  });

  it('一次性消息可异步回包', async () => {
    await importFresh('../../src/background/index.js');
    const response = await chrome.runtime.sendMessage({ type: MESSAGE_TYPES.LIST_ENGINES });

    expect(response.ok).toBe(true);
    expect(response.data.instances).toHaveLength(1);
  });

  it('st-gateway 端口上的 ST_PING 立即回 ST_PONG，并异步下发 ST_LOG_CONFIG', async () => {
    await importFresh('../../src/background/index.js');
    const frames = [];
    const client = chrome.runtime.connect({ name: PORT_NAME });
    client.onMessage.addListener((message) => frames.push(message));

    client.postMessage({ type: MESSAGE_TYPES.PING, payload: { sentAt: 7 } });

    expect(frames[0]).toMatchObject({
      type: MESSAGE_TYPES.PONG,
      payload: { sentAt: 7 },
    });
    await vi.waitFor(() => {
      expect(frames.some((frame) => frame.type === MESSAGE_TYPES.LOG_CONFIG)).toBe(true);
    });
    const config = frames.find((frame) => frame.type === MESSAGE_TYPES.LOG_CONFIG);
    expect(config.payload.level).toBe('info');
    client.disconnect();
  });

  it('storage.onChanged 更新后台日志级别', async () => {
    await importFresh('../../src/background/index.js');
    const { getLogLevel } = await import('../../src/shared/log/logger.js');
    await vi.waitFor(() => expect(getLogLevel()).toBe('info'));

    await chrome.storage.sync.set({ settings: { logLevel: 'debug' } });
    await vi.waitFor(() => expect(getLogLevel()).toBe('debug'));
  });

  it('未知一次性消息返回统一错误', async () => {
    await importFresh('../../src/background/index.js');
    const response = await chrome.runtime.sendMessage({ type: 'ST_NOPE' });
    expect(response.ok).toBe(false);
    expect(response.error.message).toContain('无法识别');
  });

  it('顶层注册快捷键监听，触发命令后向活动标签页发 ST_TOGGLE', async () => {
    await importFresh('../../src/background/index.js');
    expect(chrome.commands.onCommand.listeners).toHaveLength(1);

    chrome.tabs.__response = { ok: true, data: { action: 'translating' } };
    chrome.commands.onCommand.emit('translate-paragraph');

    await vi.waitFor(() => expect(chrome.tabs.__sent).toHaveLength(1));
    const [sent] = chrome.tabs.__sent;
    expect(sent.tabId).toBe(1);
    expect(sent.message.type).toBe(MESSAGE_TYPES.TOGGLE);
    expect(sent.message.payload.traceId).toEqual(expect.any(String));
  });
});
