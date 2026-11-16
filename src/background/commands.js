/**
 * A1 快捷键入口
 *
 * 模块：后台服务（A）/ A1
 * 职责：把 commands 事件转成「翻译当前段落」的控制命令：取活动标签页，必要时补注入，再转发 ST_TOGGLE。
 * 依赖：A1 消息路由、E1 消息协议、E2 设置、E4 日志（P4 起）。
 * 实现阶段：P4（段落提取、悬停锚定与译文渲染）
 *
 * P4 不提供页面外提示：无活动标签页、不可注入页面、扩展停用只记录后台日志；
 * 用户可见的入口提示由 P7 的弹窗承担。
 */

import {
  ERROR_CODES,
  FAILURE_REASONS,
  MESSAGE_TYPES,
  makeError,
} from '../shared/protocol.js';
import { getSettings } from '../shared/settings.js';
import { createLogger, newTraceId } from '../shared/log/logger.js';
import { sendToTab } from './router.js';

/** 清单 commands 中声明的命令名。 */
export const COMMAND_TRANSLATE_PARAGRAPH = 'translate-paragraph';

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
  if (command !== COMMAND_TRANSLATE_PARAGRAPH) {
    log.warn('command.rejected', '未知快捷键命令', { command });
    return failure(ERROR_CODES.OTHER, '未知命令', FAILURE_REASONS.INVALID_MESSAGE);
  }

  const traceId = newTraceId();
  const traceLog = log.withTrace(traceId);
  const startedAt = Date.now();

  traceLog.info('command.received', '收到翻译当前段落命令');

  try {
    const settings = await getSettings();
    if (settings.enabled === false) {
      traceLog.warn('command.rejected', '扩展已停用');
      return failure(ERROR_CODES.CONFIG, '扩展已停用');
    }
  } catch {
    // 读取设置失败不阻断命令，后台按默认值继续。
    traceLog.warn('command.rejected', '读取设置失败，按默认设置继续');
  }

  let tabs = [];
  try {
    tabs = await chrome.tabs.query({ active: true, lastFocusedWindow: true });
  } catch {
    tabs = [];
  }
  const tab = Array.isArray(tabs) ? tabs.find((entry) => entry?.active) ?? tabs[0] : null;
  if (!tab?.id) {
    traceLog.warn('command.rejected', '没有活动标签页', {
      reason: FAILURE_REASONS.NO_ACTIVE_TAB,
    });
    return failure(ERROR_CODES.OTHER, '没有可用的标签页', FAILURE_REASONS.NO_ACTIVE_TAB);
  }

  const result = await sendToTab(tab.id, {
    type: MESSAGE_TYPES.TOGGLE,
    payload: { traceId },
  });

  if (result?.ok) {
    traceLog.info('command.done', '命令已转发', {
      action: result.data?.action ?? null,
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
