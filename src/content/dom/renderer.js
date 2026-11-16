/**
 * D3 译文渲染
 *
 * 模块：页面注入（D）/ D3
 * 职责：把译文内嵌到被翻译节点末尾、更新、隐藏与清除；加载、流式、完成与失败共用一套 DOM 契约。
 * 依赖：D1 的 DOM 标记常量与块级判定（P4 起）。
 * 实现阶段：P4（段落提取、悬停锚定与译文渲染）
 *
 * 约束：译文只写 textContent，不使用 innerHTML；不改动原文文字与行内元素；不读 storage。
 * DOM 结构与样式见 docs/modules/D3-译文渲染.md。
 */

import { HOST_ATTR, TRANSLATION_ATTR, isBlockHost } from './scanner.js';

/** 译文容器固定为行内 font；样式由 content.css 设置。 */
const CONTAINER_TAG = 'font';

/** 承载译文文本的内层 font，更新时只改它的 textContent。 */
const TEXT_TAG = 'font';

/** 加载占位文本。 */
const LOADING_TEXT = '正在翻译…';

/** 行内模式的固定分隔：两个不换行空格（U+00A0）。 */
const INLINE_SEPARATOR = '\u00A0\u00A0';

/**
 * 创建渲染器。
 * @param {{ document?: Document }} [options]
 * @returns {{
 *   showLoading: (host: Element) => boolean,
 *   update: (host: Element, text: string) => boolean,
 *   showDone: (host: Element, text: string) => boolean,
 *   showError: (host: Element, message: string) => boolean,
 *   remove: (host: Element) => boolean,
 *   clearAll: () => number,
 *   getState: (host: Element) => string | null,
 *   getText: (host: Element) => string,
 *   has: (host: Element) => boolean,
 * }}
 */
export function createRenderer({ document: doc = globalThis.document } = {}) {
  /** @type {Map<Element, { container: Element, textElement: Element, mode: string, state: string }>} */
  const entries = new Map();

  /**
   * 创建「外层容器 + 固定格式节点 + 内层文本 font」。
   * @param {Element} host
   * @returns {{ container: Element, textElement: Element, mode: string } | null}
   */
  function createContainer(host) {
    if (!doc) return null;
    const mode = isBlockHost(host) ? 'block' : 'inline';
    const container = doc.createElement(CONTAINER_TAG);
    container.setAttribute(TRANSLATION_ATTR, '');
    container.setAttribute('data-st-for', host.getAttribute?.(HOST_ATTR) ?? '');
    container.setAttribute('data-st-state', 'loading');
    container.setAttribute('data-st-mode', mode);
    container.setAttribute('dir', 'auto');

    const textElement = doc.createElement(TEXT_TAG);
    if (mode === 'block') {
      container.appendChild(doc.createElement('br'));
      container.appendChild(textElement);
    } else {
      container.appendChild(doc.createTextNode(INLINE_SEPARATOR));
      container.appendChild(textElement);
    }

    return { container, textElement, mode };
  }

  /**
   * 确保宿主有容器；容器被页面删除时重建。宿主在文档外时清理并返回 null。
   * @param {Element} host
   * @returns {{ container: Element, textElement: Element, mode: string, state: string } | null}
   */
  function ensureEntry(host) {
    if (!host || host.nodeType !== 1) return null;
    if (host.isConnected === false) {
      const stale = entries.get(host);
      if (stale) {
        stale.container.remove?.();
        entries.delete(host);
      }
      return null;
    }

    let entry = entries.get(host);
    if (entry && entry.container.isConnected === false) {
      entry.container.remove?.();
      entries.delete(host);
      entry = null;
    }
    if (entry) return entry;

    const created = createContainer(host);
    if (!created) return null;
    host.appendChild(created.container);
    entry = { ...created, state: 'loading' };
    entries.set(host, entry);
    return entry;
  }

  /**
   * @param {Element} host
   * @param {string} state
   * @param {string} text
   * @returns {boolean}
   */
  function write(host, state, text) {
    const entry = ensureEntry(host);
    if (!entry) return false;
    entry.state = state;
    entry.container.setAttribute('data-st-state', state);
    entry.textElement.textContent = String(text ?? '');
    return true;
  }

  return {
    showLoading(host) {
      return write(host, 'loading', LOADING_TEXT);
    },

    update(host, text) {
      return write(host, 'streaming', String(text ?? ''));
    },

    showDone(host, text) {
      return write(host, 'done', String(text ?? ''));
    },

    showError(host, message) {
      const detail = String(message ?? '').trim() || '翻译失败，请重试';
      return write(host, 'error', `翻译失败：${detail}`);
    },

    remove(host) {
      const entry = entries.get(host);
      if (!entry) return false;
      entry.container.remove?.();
      entries.delete(host);
      return true;
    },

    clearAll() {
      if (!doc) return 0;
      const containers = doc.querySelectorAll(`[${TRANSLATION_ATTR}]`);
      for (const container of containers) container.remove?.();
      entries.clear();
      return containers.length;
    },

    getState(host) {
      return entries.get(host)?.state ?? null;
    },

    getText(host) {
      return entries.get(host)?.textElement.textContent ?? '';
    },

    has(host) {
      return entries.has(host);
    },
  };
}
