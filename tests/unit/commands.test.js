/**
 * A1 快捷键命令测试
 *
 * 路由用 vi.mock 隔离，只验证命令名过滤、整页切换委托与结果透传。
 */

import { beforeEach, describe, expect, it, vi } from 'vitest';

vi.mock('../../src/background/router.js', () => ({
  togglePageTranslation: vi.fn(),
}));

import { installChrome } from '../helpers/load.js';
import { ERROR_CODES, FAILURE_REASONS } from '../../src/shared/protocol.js';
import { COMMAND_TRANSLATE_PAGE, handleCommand } from '../../src/background/commands.js';
import { togglePageTranslation } from '../../src/background/router.js';

beforeEach(() => {
  installChrome();
  togglePageTranslation.mockReset();
  togglePageTranslation.mockResolvedValue({
    ok: true,
    data: { action: 'started', phase: 'submitted', total: 3 },
  });
});

describe('A1 快捷键命令', () => {
  it('未知命令直接拒绝，不触发整页切换', async () => {
    const result = await handleCommand('unknown-command');

    expect(result.ok).toBe(false);
    expect(result.error.reason).toBe(FAILURE_REASONS.INVALID_MESSAGE);
    expect(togglePageTranslation).not.toHaveBeenCalled();
  });

  it('translate-page 委托整页切换函数并透传结果', async () => {
    const result = await handleCommand(COMMAND_TRANSLATE_PAGE);

    expect(result).toEqual({
      ok: true,
      data: { action: 'started', phase: 'submitted', total: 3 },
    });
    expect(togglePageTranslation).toHaveBeenCalledTimes(1);
    expect(togglePageTranslation.mock.calls[0][0]).toMatch(/^t-/);
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
