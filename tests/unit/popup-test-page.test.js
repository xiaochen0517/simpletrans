/**
 * B2 打开测试页助手测试（P6.5）
 *
 * 只测试纯函数 `openTestPage()`：用扩展内路径拼 URL、调用 `chrome.tabs.create`、
 * 把不可用与失败归一为可读提示，不抛出未处理异常。
 * 不渲染 React 组件（避免新增组件测试依赖）；弹窗按钮接线由人工验收覆盖。
 */

import { afterEach, describe, expect, it, vi } from 'vitest';
import { installChrome } from '../helpers/load.js';
import { openTestPage, TEST_PAGE_PATH } from '../../src/popup/open-test-page.js';

const EXPECTED_URL = 'chrome-extension://test-extension-id/testpage/index.html';

afterEach(() => {
  vi.restoreAllMocks();
});

describe('openTestPage（P6.5）', () => {
  it('用扩展内路径拼出 URL，并在新标签页打开', async () => {
    const stub = installChrome();
    const getURL = vi.spyOn(stub.runtime, 'getURL');

    const result = await openTestPage();

    expect(TEST_PAGE_PATH).toBe('testpage/index.html');
    expect(getURL).toHaveBeenCalledWith(TEST_PAGE_PATH);
    expect(stub.tabs.__created).toEqual([{ url: EXPECTED_URL }]);
    expect(result).toEqual({ ok: true, url: EXPECTED_URL });
  });

  it('tabs.create 抛错时返回可读失败结果，不抛异常', async () => {
    const stub = installChrome();
    stub.tabs.create = vi.fn(async () => {
      await Promise.resolve();
      throw new Error('cannot create tab');
    });

    const pending = openTestPage();
    await expect(pending).resolves.toBeDefined();
    const result = await pending;

    expect(result.ok).toBe(false);
    expect(typeof result.message).toBe('string');
    expect(result.message.trim().length).toBeGreaterThan(0);
    expect(result).not.toHaveProperty('url');
    expect(stub.tabs.__created).toHaveLength(0);
    expect(stub.tabs.create).toHaveBeenCalledTimes(1);
  });

  it('chrome.tabs.create 不可用时返回可读错误，且不创建标签页', async () => {
    const stub = installChrome();
    const savedCreate = stub.tabs.create;
    delete stub.tabs.create;

    try {
      const pending = openTestPage();
      await expect(pending).resolves.toBeDefined();
      const result = await pending;

      expect(result.ok).toBe(false);
      expect(typeof result.message).toBe('string');
      expect(result.message.trim().length).toBeGreaterThan(0);
      expect(result).not.toHaveProperty('url');
      expect(stub.tabs.__created).toHaveLength(0);
      // 错误信息是给用户看的中文提示，不是异常堆栈或 undefined。
      expect(result.message).toMatch(/\p{Script=Han}/u);
      expect(result.message).not.toMatch(/error:|undefined/i);
    } finally {
      stub.tabs.create = savedCreate;
    }
  });
});
