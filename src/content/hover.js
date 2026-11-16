/**
 * D2 悬停检测
 *
 * 模块：页面注入（D）/ D2
 * 职责：记录鼠标位置并解析当前宿主；指针落在译文上时归到该译文所属宿主。
 * 依赖：D1 宿主提取（P4 起）、公共数值、E4 日志。
 * 实现阶段：P4（段落提取、悬停锚定与译文渲染）
 *
 * 约束：只读指针与 DOM，不发请求、不写 storage；命令到达时按最新坐标重新解析。
 */

import { DISPLAY_UPDATE_THROTTLE_MS } from '../shared/constants.js';
import { createLogger } from '../shared/log/logger.js';
import { resolveAt } from './dom/scanner.js';

/** D2 日志入口。 */
const log = createLogger('D2');

/**
 * 创建悬停跟踪器。
 * @param {{
 *   resolve?: (element: Element) => Element | null,
 *   getElementAt?: (x: number, y: number) => Element | null,
 *   schedule?: (fn: () => void, ms: number) => unknown,
 *   cancel?: (handle: unknown) => void,
 * }} [options]
 * @returns {{ start: () => void, stop: () => void, getCurrentHost: () => Element | null }}
 */
export function createHoverTracker({
  resolve = resolveAt,
  getElementAt,
  schedule = (fn, ms) => setTimeout(fn, ms),
  cancel = (handle) => clearTimeout(handle),
} = {}) {
  let started = false;
  let pointer = null;
  let timer = null;
  let currentHost = null;
  let lastHostId;

  /**
   * 默认用 elementFromPoint 复核；不可用时退回最近一次事件目标。
   * @param {number} x
   * @param {number} y
   * @returns {Element | null}
   */
  function elementAt(x, y) {
    if (typeof getElementAt === 'function') {
      try {
        return getElementAt(x, y) ?? null;
      } catch {
        return null;
      }
    }
    if (typeof document === 'undefined') return null;
    try {
      return document.elementFromPoint?.(x, y) ?? null;
    } catch {
      return null;
    }
  }

  function compute() {
    if (!pointer) {
      currentHost = null;
      return;
    }
    const fromPoint = elementAt(pointer.x, pointer.y);
    const element = fromPoint ?? pointer.target;
    if (!element || element.nodeType !== 1) {
      currentHost = null;
      return;
    }
    currentHost = resolve(element) ?? null;
    const hostId = currentHost?.getAttribute?.('data-st-host');
    if (hostId !== lastHostId) {
      lastHostId = hostId;
      log.debug('hover.target', '当前悬停段落变化', { hostId: hostId ?? null });
    }
  }

  function flush() {
    timer = null;
    compute();
  }

  function onPointerMove(event) {
    pointer = {
      x: Number(event?.clientX ?? 0),
      y: Number(event?.clientY ?? 0),
      target: event?.target ?? null,
    };
    if (timer != null) return;
    timer = schedule(flush, DISPLAY_UPDATE_THROTTLE_MS);
  }

  function onPointerLeave() {
    pointer = null;
    currentHost = null;
    lastHostId = undefined;
    if (timer != null) {
      cancel(timer);
      timer = null;
    }
  }

  /**
   * 指针离开文档时清空；relatedTarget 为空表示离开窗口。
   * @param {PointerEvent} event
   */
  function onPointerOut(event) {
    if (!event?.relatedTarget) onPointerLeave();
  }

  return {
    start() {
      if (started || typeof document === 'undefined') return;
      document.addEventListener('pointermove', onPointerMove, { passive: true });
      document.addEventListener('pointerleave', onPointerLeave);
      document.addEventListener('pointerout', onPointerOut);
      started = true;
    },

    stop() {
      if (!started || typeof document === 'undefined') return;
      document.removeEventListener('pointermove', onPointerMove);
      document.removeEventListener('pointerleave', onPointerLeave);
      document.removeEventListener('pointerout', onPointerOut);
      onPointerLeave();
      started = false;
    },

    getCurrentHost() {
      if (pointer) compute();
      return currentHost;
    },
  };
}
