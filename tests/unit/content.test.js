/**
 * 页面注入入口测试
 *
 * 入口在导入时建立 st-gateway 连接；Node 环境没有 window，入口必须可安全导入。
 */

import { afterEach, describe, expect, it, vi } from 'vitest';
import { installChrome } from '../helpers/load.js';
import { PORT_NAME } from '../../src/shared/protocol.js';

afterEach(() => {
  vi.restoreAllMocks();
});

describe('页面注入入口', () => {
  it('导入即建立 st-gateway 连接，可在 Node 下导入', async () => {
    installChrome();
    vi.spyOn(console, 'info').mockImplementation(() => {});
    const connectSpy = vi.spyOn(chrome.runtime, 'connect');
    vi.resetModules();

    const mod = await import('../../src/content/index.js');

    expect(connectSpy).toHaveBeenCalledWith({ name: PORT_NAME });
    expect(mod.getBridge().getState()).toBe('connecting');

    mod.getBridge().close();
    expect(mod.getBridge().getState()).toBe('closed');
  });
});
