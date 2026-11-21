/**
 * A1 快捷键入口
 *
 * 模块：后台服务（A）/ A1
 * 职责：把 `commands` 事件转成整页翻译控制命令：生成 traceId，交给 A1 的整页启动函数
 *       （读设置、取活动标签页、必要时补注入并发送 `ST_START`）。
 * 依赖：A1 消息路由、E1 消息协议、E4 日志。
 *
 * 不提供页面外提示：无活动标签页、不可注入页面、扩展停用只记录后台日志；
 * 用户可见的入口由弹窗与页面内状态承担。
 */

import { ERROR_CODES, FAILURE_REASONS, makeError } from '../shared/protocol.js';
import { createLogger, newTraceId } from '../shared/log/logger.js';
import { startPageTranslation } from './router.js';

/** 清单 commands 中声明的整页翻译命令名。 */
export const COMMAND_TRANSLATE_PAGE = 'translate-page';

/** A1 日志入口。 */
const log = createLogger('A1');

/**
 * @param {string} code
 * @param {string} message
 * @param {string} [reason]
 * @returns {{ ok: false, error: object }}
 */
function failure(code, message, reason) {
  return { ok: false, error: makeError(code, message, reason) };
}

/**
 * 处理快捷键命令。
 * @param {string} command
 * @returns {Promise<{ ok: true, data?: object } | { ok: false, error: object }>}
 */
export async function handleCommand(command) {
  if (command !== COMMAND_TRANSLATE_PAGE) {
    log.warn('command.rejected', '未知快捷键命令', { command });
    return failure(ERROR_CODES.OTHER, '未知命令', FAILURE_REASONS.INVALID_MESSAGE);
  }

  const traceId = newTraceId();
  const traceLog = log.withTrace(traceId);
  const startedAt = Date.now();

  traceLog.info('command.received', '收到翻译整页命令');

  let result;
  try {
    result = await startPageTranslation(traceId);
  } catch (error) {
    traceLog.warn('command.rejected', '命令处理异常', {
      reason: error?.name ?? 'Error',
      elapsedMs: Math.max(0, Date.now() - startedAt),
    });
    return failure(ERROR_CODES.OTHER, '命令处理失败，请稍后重试');
  }

  if (result?.ok) {
    traceLog.info('command.done', '命令已转发', {
      phase: result.data?.phase ?? null,
      total: Number(result.data?.total) || 0,
      elapsedMs: Math.max(0, Date.now() - startedAt),
    });
  } else {
    traceLog.warn('command.rejected', '命令转发失败', {
      code: result?.error?.code ?? ERROR_CODES.OTHER,
      reason: result?.error?.reason ?? null,
      elapsedMs: Math.max(0, Date.now() - startedAt),
    });
  }

  return result;
}
