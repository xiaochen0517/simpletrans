/**
 * A1 快捷键命令测试
 *
 * 路由用 vi.mock 隔离，只验证命令名过滤、设置检查、活动标签页与 ST_TOGGLE 转发。
 */

import { beforeEach, describe, expect, it, vi } from 'vitest';

vi.mock('../../src/background/router.js', () => ({
  sendToTab: vi.fn(),
}));

import { installChrome } from '../helpers/load.js';
import {
  ERROR_CODES,
  FAILURE_REASONS,
  MESSAGE_TYPES,
} from '../../src/shared/protocol.js';
import { COMMAND_TRANSLATE_PARAGRAPH, handleCommand } from '../../src/background/commands.js';
import { sendToTab } from '../../src/background/router.js';

beforeEach(() => {
  installChrome();
  sendToTab.mockReset();
  sendToTab.mockResolvedValue({ ok: true, data: { action: 'submitted' } });
});

describe('A1 快捷键命令', () => {
  it('未知命令直接拒绝', async () => {
    const query = vi.spyOn(chrome.tabs, 'query');
    const result = await handleCommand('unknown-command');

    expect(result.ok).toBe(false);
    expect(result.error.reason).toBe(FAILURE_REASONS.INVALID_MESSAGE);
    expect(query).not.toHaveBeenCalled();
    expect(sendToTab).not.toHaveBeenCalled();
  });

  it('把 ST_TOGGLE 与 traceId 转发到活动标签页', async () => {
    const result = await handleCommand(COMMAND_TRANSLATE_PARAGRAPH);

    expect(result).toEqual({ ok: true, data: { action: 'submitted' } });
    expect(sendToTab).toHaveBeenCalledTimes(1);
    const [tabId, message] = sendToTab.mock.calls[0];
    expect(tabId).toBe(1);
    expect(message.type).toBe(MESSAGE_TYPES.TOGGLE);
    expect(message.payload.traceId).toMatch(/^t-/);
  });

  it('没有活动标签页时返回 NO_ACTIVE_TAB', async () => {
    chrome.tabs.__queryResult = [];

    const result = await handleCommand(COMMAND_TRANSLATE_PARAGRAPH);
    expect(result.ok).toBe(false);
    expect(result.error.reason).toBe(FAILURE_REASONS.NO_ACTIVE_TAB);
    expect(sendToTab).not.toHaveBeenCalled();
  });

  it('扩展停用时不发消息', async () => {
    await chrome.storage.sync.set({ settings: { enabled: false } });

    const result = await handleCommand(COMMAND_TRANSLATE_PARAGRAPH);
    expect(result.ok).toBe(false);
    expect(result.error.code).toBe(ERROR_CODES.CONFIG);
    expect(sendToTab).not.toHaveBeenCalled();
  });

  it('转发失败时原样返回错误', async () => {
    sendToTab.mockResolvedValue({
      ok: false,
      error: {
        code: ERROR_CODES.OTHER,
        message: '当前页面无法翻译',
        reason: FAILURE_REASONS.INJECTION_FAILED,
      },
    });

    const result = await handleCommand(COMMAND_TRANSLATE_PARAGRAPH);
    expect(result.ok).toBe(false);
    expect(result.error.reason).toBe(FAILURE_REASONS.INJECTION_FAILED);
  });
});
