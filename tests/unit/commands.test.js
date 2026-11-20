/**
 * A1 快捷键命令测试
 *
 * 路由用 vi.mock 隔离，只验证命令名过滤、整页启动委托与结果透传。
 */

import { beforeEach, describe, expect, it, vi } from 'vitest';

vi.mock('../../src/background/router.js', () => ({
  startPageTranslation: vi.fn(),
}));

import { installChrome } from '../helpers/load.js';
import { ERROR_CODES, FAILURE_REASONS } from '../../src/shared/protocol.js';
import { COMMAND_TRANSLATE_PAGE, handleCommand } from '../../src/background/commands.js';
import { startPageTranslation } from '../../src/background/router.js';

beforeEach(() => {
  installChrome();
  startPageTranslation.mockReset();
  startPageTranslation.mockResolvedValue({
    ok: true,
    data: { phase: 'submitted', total: 3 },
  });
});

describe('A1 快捷键命令', () => {
  it('未知命令直接拒绝，不启动整页翻译', async () => {
    const result = await handleCommand('unknown-command');

    expect(result.ok).toBe(false);
    expect(result.error.reason).toBe(FAILURE_REASONS.INVALID_MESSAGE);
    expect(startPageTranslation).not.toHaveBeenCalled();
  });

  it('translate-page 委托整页启动函数并透传结果', async () => {
    const result = await handleCommand(COMMAND_TRANSLATE_PAGE);

    expect(result).toEqual({ ok: true, data: { phase: 'submitted', total: 3 } });
    expect(startPageTranslation).toHaveBeenCalledTimes(1);
    expect(startPageTranslation.mock.calls[0][0]).toMatch(/^t-/);
  });

  it('整页启动失败时原样返回错误', async () => {
    startPageTranslation.mockResolvedValue({
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

  it('整页启动函数抛错时归一为 OTHER', async () => {
    startPageTranslation.mockRejectedValue(new Error('boom'));

    const result = await handleCommand(COMMAND_TRANSLATE_PAGE);
    expect(result.ok).toBe(false);
    expect(result.error.code).toBe(ERROR_CODES.OTHER);
  });
});
