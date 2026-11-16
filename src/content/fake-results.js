/**
 * D5 结果回显的临时假数据源
 *
 * 模块：页面注入（D）/ D5
 * 职责：按数据面 `ST_ITEM_*` 帧的形状在页面内投递模拟结果，驱动 D5 的逐段回显；
 *       内容固定为「【模拟 <段落id>】<原文>」，支持 normal / slow / fail 三种模式。
 * 依赖：E1 消息名（P1 起）。不引用 shared/config、shared/translate、shared/cache。
 * 实现阶段：P6.1 结果回显（临时；P6.2 接入后台缓存回显后删除）。
 *
 * 约束：不发消息、不写 storage、不操作 DOM、不调用引擎；只调用注入的 onFrame。
 *
 * 节奏：提交后先保留一个间隔再发 `ST_ITEM_START`，让「已提交，等待翻译」可见；
 * 之后每个间隔推进一片增量，最后发 `ST_ITEM_DONE`。模式在提交时确定，
 * 已开始的流式沿用提交时的切片长度与节奏。
 *
 * 模式与常量的约定见 docs/demand/20261116-04-P6-1前端整页取段与提交.md 2.2.4。
 */

import { MESSAGE_TYPES } from '../shared/protocol.js';

/** 假数据模式：默认、慢速、失败。 */
export const RESULT_MODES = Object.freeze({
  normal: 'normal',
  slow: 'slow',
  fail: 'fail',
});

/** 默认模式下每次增量的字符数。 */
const FAKE_CHUNK_CHARS = 20;

/** 默认模式下的增量间隔（毫秒）。 */
const FAKE_INTERVAL_MS = 80;

/** 慢速模式下的增量字符数。 */
const FAKE_SLOW_CHUNK_CHARS = 4;

/** 慢速模式下的增量间隔（毫秒）。 */
const FAKE_SLOW_INTERVAL_MS = 400;

/** 同时流式的段数上限，避免长页面一次创建大量定时器。 */
const FAKE_MAX_STREAMING = 8;

/**
 * 模拟译文：固定前缀带段落 id，便于核对结果是否落到对应段落。
 * @param {string} itemId
 * @param {string} text
 * @returns {string}
 */
function fakeText(itemId, text) {
  return `【模拟 ${itemId}】${text}`;
}

/**
 * 创建假数据源。
 *
 * @param {{
 *   onFrame: (frame: { type: string, payload: object }) => void,
 *   schedule?: (fn: () => void, ms: number) => unknown,
 *   cancel?: (handle: unknown) => void,
 *   mode?: string,
 * }} options
 * @returns {{
 *   start: (submission: object) => void,
 *   setMode: (mode: string) => void,
 *   getMode: () => string,
 *   cancelAll: () => void,
 * }}
 */
export function createFakeResults({
  onFrame,
  schedule = (fn, ms) => setTimeout(fn, ms),
  cancel = (handle) => clearTimeout(handle),
  mode = RESULT_MODES.normal,
} = {}) {
  let currentMode = RESULT_MODES[mode] ? mode : RESULT_MODES.normal;
  let startTimer = null;
  let tickTimer = null;
  /** 在途段的节奏：由最近一批激活的段决定。 */
  let streamInterval = FAKE_INTERVAL_MS;
  /** @type {Array<{ requestId: string, mode: string, entries: Array<{ requestId: string, itemId: string, text: string }> }>} */
  const pendingStarts = [];
  /** @type {Array<{ requestId: string, itemId: string, text: string, chunkChars: number }>} */
  const queue = [];
  /** @type {Map<string, { requestId: string, itemId: string, text: string, cursor: number, chunkChars: number }>} */
  const active = new Map();

  /**
   * 当前模式对应的切片长度与间隔。
   * @param {string} [target]
   * @returns {{ chunkChars: number, interval: number }}
   */
  function pacing(target = currentMode) {
    return target === RESULT_MODES.slow
      ? { chunkChars: FAKE_SLOW_CHUNK_CHARS, interval: FAKE_SLOW_INTERVAL_MS }
      : { chunkChars: FAKE_CHUNK_CHARS, interval: FAKE_INTERVAL_MS };
  }

  /**
   * @param {string} type
   * @param {object} payload
   */
  function emit(type, payload) {
    try {
      onFrame?.({ type, payload });
    } catch {
      // 观察者异常不影响其它段落。
    }
  }

  /**
   * @param {string} requestId
   * @param {string} itemId
   * @returns {string}
   */
  function keyOf(requestId, itemId) {
    return `${requestId}\u0000${itemId}`;
  }

  function scheduleTick() {
    if (tickTimer != null || active.size === 0) return;
    tickTimer = schedule(() => {
      tickTimer = null;
      tick();
    }, streamInterval);
  }

  /**
   * 把排队中的段落放进并发窗口，并确保有定时器在跑。
   */
  function pump() {
    while (active.size < FAKE_MAX_STREAMING && queue.length > 0) {
      const next = queue.shift();
      active.set(keyOf(next.requestId, next.itemId), {
        requestId: next.requestId,
        itemId: next.itemId,
        text: next.text,
        cursor: 0,
        chunkChars: next.chunkChars,
      });
      emit(MESSAGE_TYPES.ITEM_START, {
        requestId: next.requestId,
        itemId: next.itemId,
      });
    }
    scheduleTick();
  }

  /**
   * 定时器到点：为每个在途段落推进一步。
   */
  function tick() {
    for (const [key, entry] of [...active.entries()]) {
      const chunk = entry.text.slice(entry.cursor, entry.cursor + entry.chunkChars);
      entry.cursor += chunk.length;
      if (entry.cursor < entry.text.length) {
        emit(MESSAGE_TYPES.ITEM_DELTA, {
          requestId: entry.requestId,
          itemId: entry.itemId,
          delta: chunk,
        });
      } else {
        active.delete(key);
        emit(MESSAGE_TYPES.ITEM_DONE, {
          requestId: entry.requestId,
          itemId: entry.itemId,
          text: entry.text,
          usage: null,
        });
      }
    }
    pump();
  }

  /**
   * 预约一次开始：延迟一个间隔再发 `ST_ITEM_START`，让「已提交」可见。
   */
  function scheduleStart() {
    if (startTimer != null || pendingStarts.length === 0) return;
    const group = pendingStarts[0];
    startTimer = schedule(() => {
      startTimer = null;
      activate();
    }, pacing(group.mode).interval);
  }

  /**
   * 激活所有排队等待开始的提交。
   */
  function activate() {
    const groups = pendingStarts.splice(0, pendingStarts.length);
    for (const group of groups) {
      const { chunkChars, interval } = pacing(group.mode);
      streamInterval = interval;
      for (const entry of group.entries) {
        if (group.mode === RESULT_MODES.fail) {
          emit(MESSAGE_TYPES.ITEM_START, {
            requestId: entry.requestId,
            itemId: entry.itemId,
          });
          emit(MESSAGE_TYPES.ITEM_ERROR, {
            requestId: entry.requestId,
            itemId: entry.itemId,
            code: 'NETWORK',
            message: '模拟失败',
          });
        } else {
          queue.push({ ...entry, chunkChars });
        }
      }
    }
    pump();
  }

  return {
    /**
     * 为一次提交启动模拟结果。
     * @param {{ requestId: string, items: Map<string, { text?: string }> }} submission
     */
    start(submission) {
      const items = submission?.items;
      const requestId = submission?.requestId;
      if (!(items instanceof Map) || typeof requestId !== 'string') return;
      const entries = [];
      for (const [itemId, item] of items) {
        entries.push({
          requestId,
          itemId,
          text: fakeText(itemId, typeof item?.text === 'string' ? item.text : ''),
        });
      }
      if (entries.length === 0) return;
      pendingStarts.push({ requestId, mode: currentMode, entries });
      scheduleStart();
    },

    /**
     * 设置模式；只影响之后的提交。
     * @param {string} next
     */
    setMode(next) {
      if (RESULT_MODES[next]) currentMode = next;
    },

    /** @returns {string} 当前模式 */
    getMode() {
      return currentMode;
    },

    /**
     * 停止全部在途、排队与待开始的模拟结果。
     */
    cancelAll() {
      if (startTimer != null) {
        cancel(startTimer);
        startTimer = null;
      }
      if (tickTimer != null) {
        cancel(tickTimer);
        tickTimer = null;
      }
      pendingStarts.length = 0;
      queue.length = 0;
      active.clear();
    },
  };
}
