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
  vi.spyOn(console, 'info').mockImplementation(() => {});
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

  it('st-gateway 端口上的 ST_PING 立即回 ST_PONG', async () => {
    await importFresh('../../src/background/index.js');
    const frames = [];
    const client = chrome.runtime.connect({ name: PORT_NAME });
    client.onMessage.addListener((message) => frames.push(message));

    client.postMessage({ type: MESSAGE_TYPES.PING, payload: { sentAt: 7 } });

    expect(frames).toHaveLength(1);
    expect(frames[0]).toMatchObject({
      type: MESSAGE_TYPES.PONG,
      payload: { sentAt: 7 },
    });
    client.disconnect();
  });

  it('未知一次性消息返回统一错误', async () => {
    await importFresh('../../src/background/index.js');
    const response = await chrome.runtime.sendMessage({ type: 'ST_NOPE' });
    expect(response.ok).toBe(false);
    expect(response.error.message).toContain('无法识别');
  });
});
