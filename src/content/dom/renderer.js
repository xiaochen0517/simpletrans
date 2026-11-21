/**
 * D3 译文渲染
 *
 * 模块：页面注入（D）/ D3
 * 职责：把提交与译文状态内嵌到被翻译节点末尾、更新、隐藏与清除；提交中、已提交、翻译中、流式、
 *       译文与失败共用一套 DOM 契约；错误态在提示文字后提供链接样式的「刷新」按钮。
 * 依赖：D1 的 DOM 标记常量与块级判定。
 *
 * 约束：状态文本只写 textContent，不使用 innerHTML；不改动原文文字与行内元素；不读 storage。
 * DOM 结构与样式见 docs/modules/D-页面注入.md#d3-译文渲染。
 */

import { HOST_ATTR, TRANSLATION_ATTR, isBlockHost } from './scanner.js';

/** 译文容器固定为行内 font；样式由 content.css 设置。 */
const CONTAINER_TAG = 'font';

/** 承载状态文本的内层 font，更新时只改它的 textContent。 */
const TEXT_TAG = 'font';

/** 正在提交的占位文本。 */
const SUBMITTING_TEXT = '正在提交…';

/** 已提交标记文本。 */
const SUBMITTED_TEXT = '已提交，等待翻译';

/** 翻译中占位文本（收到 START、尚未有增量）。 */
const LOADING_TEXT = '翻译中…';

/** 翻译失败提示前缀。 */
const TRANSLATE_ERROR_PREFIX = '翻译失败：';

/** 行内模式的固定分隔：两个不换行空格（U+00A0）。 */
const INLINE_SEPARATOR = '\u00A0\u00A0';

/** 失败段「刷新」按钮的标记属性；CSS 只匹配该属性，不影响页面原有按钮。 */
export const RETRY_ATTR = 'data-st-retry';

/** 「刷新」按钮文字与无障碍标签。 */
const RETRY_TEXT = '刷新';
const RETRY_LABEL = '重新翻译此段';

/**
 * 创建渲染器。`onRetry` 由页面入口注入，指向 D5 的单段刷新；点击只重发当前段。
 * @param {{
 *   document?: Document,
 *   onRetry?: (host: Element) => unknown,
 * }} [options]
 * @returns {{
 *   showSubmitting: (host: Element) => boolean,
 *   showSubmitted: (host: Element, text?: string) => boolean,
 *   showLoading: (host: Element) => boolean,
 *   update: (host: Element, text: string) => boolean,
 *   showDone: (host: Element, text: string) => boolean,
 *   showSubmitError: (host: Element, message: string) => boolean,
 *   showError: (host: Element, message: string) => boolean,
 *   remove: (host: Element) => boolean,
 *   clearAll: () => number,
 *   getState: (host: Element) => string | null,
 *   has: (host: Element) => boolean,
 * }}
 */
export function createRenderer({ document: doc = globalThis.document, onRetry } = {}) {
  /** @type {Map<Element, { container: Element, textElement: Element, retryButton: Element | null, mode: string, state: string }>} */
  const entries = new Map();

  /**
   * 触发单段刷新：不触发宿主按钮/链接的点击，也不导航。
   * 只有错误态才响应，避免隐藏按钮被程序化触发。
   * @param {Event} event
   * @param {Element} host
   */
  function triggerRetry(event, host) {
    event.preventDefault?.();
    event.stopPropagation?.();
    if (entries.get(host)?.state !== 'error') return;
    if (typeof onRetry !== 'function') return;
    try {
      onRetry(host);
    } catch {
      // 单段刷新失败不影响页面其它标记。
    }
  }

  /**
   * 键盘触发：Enter / Space 与点击走同一条路径，Space 需阻止页面滚动。
   * @param {KeyboardEvent} event
   * @param {Element} host
   */
  function onRetryKeyDown(event, host) {
    if (event.key !== 'Enter' && event.key !== ' ') return;
    if (event.repeat) return;
    triggerRetry(event, host);
  }

  /**
   * 创建「外层容器 + 固定格式节点 + 内层文本 font + 刷新按钮」。
   * 按钮只创建一次，默认隐藏；宿主本身可能是 button / a，因此用 span + role=button 而不是嵌套原生控件。
   * @param {Element} host
   * @returns {{ container: Element, textElement: Element, retryButton: Element | null, mode: string } | null}
   */
  function createContainer(host) {
    if (!doc) return null;
    const mode = isBlockHost(host) ? 'block' : 'inline';
    const container = doc.createElement(CONTAINER_TAG);
    container.setAttribute(TRANSLATION_ATTR, '');
    container.setAttribute('data-st-for', host.getAttribute?.(HOST_ATTR) ?? '');
    container.setAttribute('data-st-state', 'submitting');
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

    let retryButton = null;
    if (typeof doc.createElement === 'function') {
      retryButton = doc.createElement('span');
      retryButton.setAttribute(RETRY_ATTR, '');
      retryButton.setAttribute('role', 'button');
      retryButton.setAttribute('tabindex', '0');
      retryButton.setAttribute('aria-label', RETRY_LABEL);
      retryButton.textContent = RETRY_TEXT;
      retryButton.hidden = true;
      retryButton.addEventListener?.('click', (event) => triggerRetry(event, host));
      retryButton.addEventListener?.('keydown', (event) => onRetryKeyDown(event, host));
      container.appendChild(retryButton);
    }

    return { container, textElement, retryButton, mode };
  }

  /**
   * 确保宿主有容器；容器被页面删除时重建。宿主在文档外时清理并返回 null。
   * @param {Element} host
   * @returns {{ container: Element, textElement: Element, retryButton: Element | null, mode: string, state: string } | null}
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
    entry = { ...created, state: 'submitting' };
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
    // 「刷新」只在错误态出现；容器与按钮复用，不叠加。
    if (entry.retryButton) entry.retryButton.hidden = state !== 'error';
    return true;
  }

  return {
    /**
     * 标记为「正在提交…」。
     * @param {Element} host
     * @returns {boolean}
     */
    showSubmitting(host) {
      return write(host, 'submitting', SUBMITTING_TEXT);
    },

    /**
     * 标记为「已提交，等待翻译」。
     * @param {Element} host
     * @param {string} [text]
     * @returns {boolean}
     */
    showSubmitted(host, text) {
      return write(host, 'submitted', text ?? SUBMITTED_TEXT);
    },

    /**
     * 收到开始帧：显示「翻译中…」，等待增量或定稿。
     * @param {Element} host
     * @returns {boolean}
     */
    showLoading(host) {
      return write(host, 'loading', LOADING_TEXT);
    },

    /**
     * 写入流式累计文本。
     * @param {Element} host
     * @param {string} text
     * @returns {boolean}
     */
    update(host, text) {
      return write(host, 'streaming', text);
    },

    /**
     * 写入定稿译文。
     * @param {Element} host
     * @param {string} text
     * @returns {boolean}
     */
    showDone(host, text) {
      return write(host, 'done', text);
    },

    /**
     * 整页或单段提交失败的提示。
     * @param {Element} host
     * @param {string} message
     * @returns {boolean}
     */
    showSubmitError(host, message) {
      const detail = String(message ?? '').trim() || '提交失败，请重试';
      return write(host, 'error', `提交失败：${detail}`);
    },

    /**
     * 翻译失败的提示（结果帧 ST_ITEM_ERROR）。
     * @param {Element} host
     * @param {string} message
     * @returns {boolean}
     */
    showError(host, message) {
      const detail = String(message ?? '').trim() || '翻译失败，请重试';
      return write(host, 'error', `${TRANSLATE_ERROR_PREFIX}${detail}`);
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

    has(host) {
      return entries.has(host);
    },
  };
}
