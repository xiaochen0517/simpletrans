/**
 * Content Script 入口（运行在页面上下文）
 *
 * 角色：页面内的任务宿主。P0 只做握手，保留既有的 `GET_SELECTION` 行为；
 * 分段 / 渲染 / 队列 / 浮窗按需求文档 §6 的 P2–P6 逐步接入。
 *
 * 本文件不得引用任何会接触 API Key 的模块。
 */

import { ERROR_CODE, PHASE, ST, makeError } from '../shared/protocol.js';
import './content.css';

/** 任务模块接入前的占位状态（形状与真实状态镜像一致）。 */
const IDLE_STATUS = Object.freeze({
  phase: PHASE.IDLE,
  total: 0,
  done: 0,
  failed: 0,
});

chrome.runtime.onMessage.addListener((message, _sender, sendResponse) => {
  if (!message || typeof message !== 'object' || typeof message.type !== 'string') {
    return undefined;
  }

  switch (message.type) {
    case ST.PING:
      sendResponse({ ok: true, from: 'content' });
      return undefined;

    // 兼容现有 Popup：展示当前页面选中文本。
    case 'GET_SELECTION':
      sendResponse({ text: window.getSelection()?.toString().trim() ?? '' });
      return undefined;

    case ST.GET_STATUS:
      sendResponse({ ok: true, status: IDLE_STATUS });
      return undefined;

    case ST.START:
      // TODO(P3): 交给 task/manager.js 的 TaskManager.start(message)
      sendResponse({ ok: false, error: makeError(ERROR_CODE.BAD_RESPONSE, '任务模块尚未接入（P3）') });
      return undefined;

    default:
      return undefined;
  }
});
