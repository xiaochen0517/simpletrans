/**
 * D2 悬停范围预览
 *
 * 模块：页面注入（D）/ D2
 * 职责：保存一次悬停手势的候选宿主链与当前位置，在候选宿主上打虚线边框标记；
 *       支持按滚轮方向扩大到祖先宿主或缩小回基宿主。
 * 依赖：D1 候选提取。
 *
 * 约束：只操作 `data-st-range` 标记，不改文本、样式表、段落 id 或 storage；
 *       同一时刻最多一个宿主带标记。
 */

import { collectHoverRange } from './dom/scanner.js';

/** 范围预览标记：存在即表示该宿主是释放时的翻译目标。 */
export const RANGE_ATTR = 'data-st-range';

/**
 * 创建范围预览控制器。
 * @param {{
 *   collect?: (baseHost: Element) => Array<{ host: Element, text: string }>,
 * }} [options]
 * @returns {{
 *   begin: (baseHost: Element) => number,
 *   expand: () => boolean,
 *   shrink: () => boolean,
 *   getHost: () => Element | null,
 *   getIndex: () => number,
 *   getLevels: () => number,
 *   end: () => Element | null,
 *   cancel: () => void,
 * }}
 */
export function createHoverRange({ collect = collectHoverRange } = {}) {
  /** @type {Array<{ host: Element, text: string }>} */
  let candidates = [];
  let index = 0;
  /** @type {Element | null} */
  let marked = null;

  /**
   * 把标记移到指定宿主；同一个宿主不重复写属性。
   * @param {Element | null} host
   */
  function mark(host) {
    if (marked === host) return;
    marked?.removeAttribute?.(RANGE_ATTR);
    marked = null;
    if (!host || host.nodeType !== 1 || host.isConnected === false) return;
    host.setAttribute?.(RANGE_ATTR, '');
    marked = host;
  }

  /**
   * 当前候选宿主；没有候选时返回 null。
   * @returns {Element | null}
   */
  function currentHost() {
    return candidates[index]?.host ?? null;
  }

  return {
    /**
     * 以基宿主开始一次预览，立即标记候选 0。
     * @param {Element} baseHost
     * @returns {number} 候选总数
     */
    begin(baseHost) {
      candidates = baseHost ? collect(baseHost) : [];
      index = 0;
      mark(currentHost());
      return candidates.length;
    },

    /**
     * 扩大到上一级候选。
     * @returns {boolean} 是否发生变化
     */
    expand() {
      if (index >= candidates.length - 1) return false;
      index += 1;
      mark(currentHost());
      return true;
    },

    /**
     * 缩小回下一级候选。
     * @returns {boolean} 是否发生变化
     */
    shrink() {
      if (index <= 0) return false;
      index -= 1;
      mark(currentHost());
      return true;
    },

    getHost() {
      return currentHost();
    },

    getIndex() {
      return index;
    },

    getLevels() {
      return candidates.length;
    },

    /**
     * 结束预览：移除标记并返回最终候选宿主。
     * @returns {Element | null}
     */
    end() {
      const host = currentHost();
      mark(null);
      candidates = [];
      index = 0;
      return host;
    },

    /**
     * 取消预览：移除标记并清空候选。
     */
    cancel() {
      mark(null);
      candidates = [];
      index = 0;
    },
  };
}
