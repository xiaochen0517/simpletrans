/**
 * A1 快捷键命令测试
 *
 * 路由用 vi.mock 隔离，只验证命令名过滤、整页切换委托与结果透传。
 */

import { beforeEach, describe, expect, it, vi } from 'vitest';

vi.mock('../../src/background/router.js', () => ({
  cancelHoverGesture: vi.fn(),
  togglePageTranslation: vi.fn(),
}));

import { installChrome } from '../helpers/load.js';
import { ERROR_CODES, FAILURE_REASONS } from '../../src/shared/protocol.js';
import { COMMAND_TRANSLATE_PAGE, handleCommand } from '../../src/background/commands.js';
import { cancelHoverGesture, togglePageTranslation } from '../../src/background/router.js';

beforeEach(() => {
  installChrome();
  cancelHoverGesture.mockReset();
  cancelHoverGesture.mockResolvedValue({ ok: true, data: { forwarded: true } });
  togglePageTranslation.mockReset();
  togglePageTranslation.mockResolvedValue({
    ok: true,
    data: { action: 'started', phase: 'submitted', total: 3 },
  });
});

describe('A1 快捷键命令', () => {
  it('未知命令直接拒绝，不触发取消与整页切换', async () => {
    const result = await handleCommand('unknown-command');

    expect(result.ok).toBe(false);
    expect(result.error.reason).toBe(FAILURE_REASONS.INVALID_MESSAGE);
    expect(cancelHoverGesture).not.toHaveBeenCalled();
    expect(togglePageTranslation).not.toHaveBeenCalled();
  });

  it('translate-page 先取消悬停手势，再委托整页切换函数并透传结果', async () => {
    const result = await handleCommand(COMMAND_TRANSLATE_PAGE);

    expect(result).toEqual({
      ok: true,
      data: { action: 'started', phase: 'submitted', total: 3 },
    });
    expect(cancelHoverGesture).toHaveBeenCalledTimes(1);
    expect(togglePageTranslation).toHaveBeenCalledTimes(1);
    expect(cancelHoverGesture.mock.calls[0][0]).toBe(togglePageTranslation.mock.calls[0][0]);
    expect(cancelHoverGesture.mock.invocationCallOrder[0]).toBeLessThan(
      togglePageTranslation.mock.invocationCallOrder[0]
    );
  });

  it('取消悬停手势失败或抛错时仍继续整页切换', async () => {
    cancelHoverGesture.mockRejectedValue(new Error('cancel failed'));

    const result = await handleCommand(COMMAND_TRANSLATE_PAGE);

    expect(result.ok).toBe(true);
    expect(togglePageTranslation).toHaveBeenCalledTimes(1);

    cancelHoverGesture.mockReset();
    cancelHoverGesture.mockResolvedValue({
      ok: false,
      error: { code: ERROR_CODES.OTHER, message: '页面尚未准备好' },
    });

    const fallback = await handleCommand(COMMAND_TRANSLATE_PAGE);
    expect(fallback).toEqual({
      ok: true,
      data: { action: 'started', phase: 'submitted', total: 3 },
    });
    expect(togglePageTranslation).toHaveBeenCalledTimes(2);
  });

  it('整页切换失败时原样返回错误', async () => {
    togglePageTranslation.mockResolvedValue({
      ok: false,
      error: {
        code: ERROR_CODES.OTHER,
        message: '当前页面无法翻译',
        reason: FAILURE_REASONS.INJECTION_FAILED,
      },
    });

    const result = await handleCommand(COMMAND_TRANSLATE_PAGE);
    expect(result.ok).toBe(false);
    expect(result.error.reason).toBe(FAILURE_REASONS.INJECTION_FAILED);
  });

  it('整页切换函数抛错时归一为 OTHER', async () => {
    togglePageTranslation.mockRejectedValue(new Error('boom'));

    const result = await handleCommand(COMMAND_TRANSLATE_PAGE);
    expect(result.ok).toBe(false);
    expect(result.error.code).toBe(ERROR_CODES.OTHER);
  });
});
