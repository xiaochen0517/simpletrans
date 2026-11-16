// @vitest-environment jsdom
/**
 * 页面注入接线测试
 *
 * 在 jsdom 中模拟后台一次性消息，验证：
 * - P6.1：Ctrl 单段与整页都经 ST_PAGE_SUBMIT 提交（scope=single/page）；
 * - ST_START 异步扫描视口附近段落 → 一条提交 → 每段「已提交」→ 假数据逐段回显；
 * - 滚动 200ms 后只补交新段落；
 * - ST_CLEAR 清除标记并返回 removed；
 * - 提交失败、模拟失败、无页面与 Ctrl 手势边界。
 * 不加载真实扩展、不联网、不读写真实存储。
 */

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { installChrome } from '../helpers/load.js';
import { MESSAGE_TYPES, PORT_NAME, ERROR_CODES } from '../../src/shared/protocol.js';
import {
  HOST_ATTR,
  TRANSLATION_ATTR,
  extractText,
  normalizeText,
} from '../../src/content/dom/scanner.js';

/** @type {object | null} 页面注入持有的模块。 */
let contentMod = null;
/** @type {object | null} 模拟后台的 st-gateway 端口。 */
let serverPort = null;
/** @type {object[]} 收到的 ST_PAGE_SUBMIT 载荷。 */
let submissions = [];
/** @type {object[]} 长连接上收到的数据面消息；P6.1 不应出现 ST_TRANSLATE_BATCH。 */
let gatewayMessages = [];
/** @type {Function} ST_PAGE_SUBMIT 的回执。 */
let submitReply = null;
/** @type {Function | null} 页面注入注册的 onMessage 监听器。 */
let contentListener = null;
/** @type {Array<[EventTarget, string, Function, object | undefined]>} 本次用例注册的 DOM 监听器。 */
let domListeners = [];
/** @type {Function | null} 全局 window.addEventListener 的原始实现。 */
let nativeWindowAdd = null;

/**
 * 视口内矩形；jsdom 默认零尺寸，必须模拟真实布局才能收集段落。
 * @returns {object}
 */
function visibleRect() {
  return {
    x: 10,
    y: 10,
    top: 10,
    left: 10,
    width: 100,
    height: 20,
    right: 110,
    bottom: 30,
    toJSON() {},
  };
}

/**
 * 在视口附近之外的矩形（top 超出 1.5 屏）。
 * @returns {object}
 */
function offscreenRect() {
  return {
    x: 10,
    y: 2000,
    top: 2000,
    left: 10,
    width: 100,
    height: 20,
    right: 110,
    bottom: 2020,
    toJSON() {},
  };
}

/**
 * 向页面注入发一条一次性命令。
 * @param {object} message
 * @returns {Promise<object>}
 */
function sendToContent(message) {
  return new Promise((resolve) => {
    chrome.runtime.onMessage.emit(message, { id: chrome.runtime.id }, resolve);
  });
}

/**
 * @param {string} html
 * @returns {Element}
 */
function mount(html) {
  document.body.innerHTML = html;
  return document.body.firstElementChild;
}

/**
 * @param {Element} element
 */
function hover(element) {
  element.dispatchEvent(
    new MouseEvent('pointermove', { bubbles: true, clientX: 10, clientY: 10 })
  );
}

/**
 * 模拟按下并松开一个修饰键。
 * @param {'Control'|'Meta'} key
 */
function tapModifier(key = 'Control') {
  window.dispatchEvent(new KeyboardEvent('keydown', { key, bubbles: true }));
  window.dispatchEvent(new KeyboardEvent('keyup', { key, bubbles: true }));
}

/**
 * @param {Element} host
 * @returns {Element | null}
 */
function translationOf(host) {
  return host.querySelector(`[${TRANSLATION_ATTR}]`);
}

/**
 * 读取宿主内状态文本。
 * @param {Element} host
 * @returns {string}
 */
function rendererTextOf(host) {
  return translationOf(host)?.querySelector('font')?.textContent ?? '';
}

/**
 * 推进若干微任务，用于等待 Ctrl 手势里的异步提交。
 */
async function flush() {
  for (let index = 0; index < 6; index += 1) {
    await Promise.resolve();
  }
}

beforeEach(() => {
  vi.useFakeTimers();
  installChrome();
  delete globalThis.__simpletransContentLoaded;
  document.head.innerHTML = '';
  document.body.innerHTML = '';
  contentMod = null;
  serverPort = null;
  submissions = [];
  gatewayMessages = [];
  contentListener = null;
  domListeners = [];
  submitReply = (payload) => ({
    ok: true,
    data: {
      accepted: true,
      requestId: payload.requestId,
      scope: payload.scope,
      paragraphs: payload.paragraphs.length,
      chars: payload.paragraphs.reduce((sum, paragraph) => sum + paragraph.text.length, 0),
    },
  });

  // 记录并（在 afterEach）移除页面注入注册的 DOM 监听器。
  const originalAdd = EventTarget.prototype.addEventListener;
  vi.spyOn(EventTarget.prototype, 'addEventListener').mockImplementation(function add(type, listener, options) {
    domListeners.push([this, type, listener, options]);
    return originalAdd.call(this, type, listener, options);
  });
  nativeWindowAdd = window.addEventListener;
  window.addEventListener = function addWindowListener(type, listener, options) {
    domListeners.push([window, type, listener, options]);
    return nativeWindowAdd.call(window, type, listener, options);
  };

  vi.spyOn(console, 'debug').mockImplementation(() => {});
  vi.spyOn(console, 'info').mockImplementation(() => {});
  vi.spyOn(console, 'warn').mockImplementation(() => {});
  vi.spyOn(console, 'error').mockImplementation(() => {});

  // jsdom 不做布局：给所有元素一个视口内矩形，`data-offscreen` 子树除外。
  vi.spyOn(Element.prototype, 'getBoundingClientRect').mockImplementation(function rect() {
    if (this?.hasAttribute?.('data-offscreen') || this?.closest?.('[data-offscreen]')) {
      return offscreenRect();
    }
    return visibleRect();
  });

  // 模拟后台一次性接收 ST_PAGE_SUBMIT。
  chrome.runtime.onMessage.addListener((message, sender, sendResponse) => {
    if (message?.type !== MESSAGE_TYPES.PAGE_SUBMIT) return false;
    submissions.push(message.payload);
    sendResponse?.(submitReply(message.payload));
    return false;
  });

  chrome.runtime.onConnect.addListener((port) => {
    if (port.name !== PORT_NAME) return;
    serverPort = port;
    port.onMessage.addListener((message) => {
      gatewayMessages.push(message);
      if (message?.type === MESSAGE_TYPES.PING) {
        port.postMessage({
          type: MESSAGE_TYPES.PONG,
          payload: { sentAt: message.payload?.sentAt },
        });
      }
    });
  });
});

afterEach(() => {
  for (const [target, type, listener, options] of domListeners) {
    try {
      target.removeEventListener(type, listener, options);
    } catch {
      // 目标已失效，忽略。
    }
  }
  domListeners = [];
  if (nativeWindowAdd) {
    window.addEventListener = nativeWindowAdd;
    nativeWindowAdd = null;
  }
  try {
    contentMod?.getBridge()?.close();
  } catch {
    // 桥已关闭或上下文已失效。
  }
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
  vi.useRealTimers();
  delete globalThis.__simpletransContentLoaded;
});

/**
 * 导入页面注入并等到桥连接建立。
 * @returns {Promise<object>}
 */
async function loadContent() {
  vi.resetModules();
  const mod = await import('../../src/content/index.js');
  expect(mod.getBridge().getState()).toBe('connected');
  contentMod = mod;
  contentListener = chrome.runtime.onMessage.listeners.at(-1) ?? null;
  return mod;
}

// ---------------------------------------------------------------------------
// Ctrl 单段：统一提交
// ---------------------------------------------------------------------------

describe('页面注入接线（P6.1）：Ctrl 单段统一提交', () => {
  it('ST_TOGGLE 从当前段落发 scope=single 的 ST_PAGE_SUBMIT 并标记已提交', async () => {
    await loadContent();
    const p = mount('<p id="p">Hello world</p>');
    hover(p);

    const response = await sendToContent({
      type: MESSAGE_TYPES.TOGGLE,
      payload: { traceId: 't-page-1' },
    });

    expect(response).toEqual({ ok: true, data: { action: 'submitted' } });
    expect(submissions).toHaveLength(1);
    expect(submissions[0]).toMatchObject({
      scope: 'single',
      traceId: 't-page-1',
      domain: location.hostname,
      paragraphs: [
        {
          index: 0,
          hostId: p.getAttribute(HOST_ATTR),
          text: 'Hello world',
        },
      ],
    });
    expect(rendererTextOf(p)).toBe('已提交，等待翻译');
    expect(normalizeText(extractText(p))).toBe('Hello world');
    expect(gatewayMessages.some((message) => message.type === MESSAGE_TYPES.TRANSLATE_BATCH)).toBe(
      false
    );
  });

  it('单段提交携带页面 domain，且 domain 不含端口或路径', async () => {
    await loadContent();
    const p = mount('<p id="p">Hello domain</p>');
    hover(p);

    await sendToContent({ type: MESSAGE_TYPES.TOGGLE, payload: {} });

    expect(submissions).toHaveLength(1);
    expect(submissions[0].domain).toBe(location.hostname);
    expect(submissions[0].domain).not.toContain(':');
    expect(submissions[0].domain).not.toContain('/');
    expect(submissions[0].scope).toBe('single');
  });

  it('span 与 button 中的文字可以作为独立段落提交', async () => {
    await loadContent();
    mount('<p id="p"><span id="s">Hello</span></p>');
    const span = document.getElementById('s');
    hover(span);
    await sendToContent({ type: MESSAGE_TYPES.TOGGLE, payload: {} });
    expect(submissions[0].paragraphs[0].text).toBe('Hello');
    expect(translationOf(span)?.parentElement).toBe(span);

    mount('<p id="p"><button id="b">Submit</button></p>');
    const button = document.getElementById('b');
    hover(button);
    await sendToContent({ type: MESSAGE_TYPES.TOGGLE, payload: {} });
    expect(submissions[1].paragraphs[0].text).toBe('Submit');
    expect(translationOf(button)?.parentElement).toBe(button);
  });

  it('已提交标记再次触发只移除标记，不发新提交', async () => {
    await loadContent();
    const p = mount('<p id="p">Hello</p>');
    hover(p);
    await sendToContent({ type: MESSAGE_TYPES.TOGGLE, payload: {} });
    expect(translationOf(p)).not.toBe(null);
    expect(submissions).toHaveLength(1);

    hover(p);
    const response = await sendToContent({ type: MESSAGE_TYPES.TOGGLE, payload: {} });

    expect(response).toEqual({ ok: true, data: { action: 'hidden' } });
    expect(translationOf(p)).toBe(null);
    expect(submissions).toHaveLength(1);
  });

  it('指针不在可译段落上时返回 no-target，不提交', async () => {
    await loadContent();
    mount('<p id="p">12345</p>');
    hover(document.getElementById('p'));

    const response = await sendToContent({ type: MESSAGE_TYPES.TOGGLE, payload: {} });

    expect(response).toEqual({ ok: true, data: { action: 'no-target' } });
    expect(submissions).toHaveLength(0);
  });

  it('Ctrl 单键按下并松开触发单段提交', async () => {
    await loadContent();
    const p = mount('<p id="p">Hello</p>');
    hover(p);

    tapModifier('Control');
    await flush();

    expect(submissions).toHaveLength(1);
    expect(submissions[0].scope).toBe('single');
    expect(submissions[0].paragraphs[0].text).toBe('Hello');
    expect(translationOf(p)).not.toBe(null);
  });

  it('Ctrl+其它键、Ctrl+点击、输入焦点、长按都不触发', async () => {
    await loadContent();
    const p = mount('<p id="p">Hello</p>');
    hover(p);

    window.dispatchEvent(new KeyboardEvent('keydown', { key: 'Control', bubbles: true }));
    window.dispatchEvent(new KeyboardEvent('keydown', { key: 'c', bubbles: true }));
    window.dispatchEvent(new KeyboardEvent('keyup', { key: 'c', bubbles: true }));
    window.dispatchEvent(new KeyboardEvent('keyup', { key: 'Control', bubbles: true }));
    await flush();
    expect(submissions).toHaveLength(0);

    window.dispatchEvent(new KeyboardEvent('keydown', { key: 'Control', bubbles: true }));
    p.dispatchEvent(new MouseEvent('pointerdown', { bubbles: true }));
    window.dispatchEvent(new KeyboardEvent('keyup', { key: 'Control', bubbles: true }));
    await flush();
    expect(submissions).toHaveLength(0);

    window.dispatchEvent(new KeyboardEvent('keydown', { key: 'Control', bubbles: true }));
    vi.advanceTimersByTime(1000);
    window.dispatchEvent(new KeyboardEvent('keyup', { key: 'Control', bubbles: true }));
    await flush();
    expect(submissions).toHaveLength(0);

    const input = document.createElement('input');
    document.body.appendChild(input);
    input.focus();
    hover(p);
    tapModifier('Control');
    await flush();
    expect(submissions).toHaveLength(0);
    input.remove();
  });
});

// ---------------------------------------------------------------------------
// 整页统一提交
// ---------------------------------------------------------------------------

describe('页面注入整页取段与统一提交（P6.1）', () => {
  it('ST_START 扫描视口附近段落并通过 ST_PAGE_SUBMIT 提交，成功后标记已提交', async () => {
    await loadContent();
    document.body.innerHTML = '<p id="a">Hello</p><p id="b">World</p>';

    const response = await sendToContent({
      type: MESSAGE_TYPES.START,
      payload: { targetLang: 'zh', traceId: 't-start' },
    });

    expect(response).toEqual({ ok: true, data: { phase: 'submitted', total: 2 } });
    expect(submissions).toHaveLength(1);
    expect(gatewayMessages.some((message) => message.type === MESSAGE_TYPES.TRANSLATE_BATCH)).toBe(
      false
    );

    const payload = submissions[0];
    expect(payload.requestId).toMatch(/^s-/);
    expect(payload.scope).toBe('page');
    expect(payload.targetLang).toBe('zh');
    expect(payload.traceId).toBe('t-start');
    expect(payload.domain).toBe(location.hostname);
    expect(payload.viewport).toEqual({
      width: window.innerWidth,
      height: window.innerHeight,
    });
    expect(payload.paragraphs).toEqual([
      {
        index: 0,
        hostId: document.getElementById('a').getAttribute(HOST_ATTR),
        text: 'Hello',
      },
      {
        index: 1,
        hostId: document.getElementById('b').getAttribute(HOST_ATTR),
        text: 'World',
      },
    ]);
    expect(payload.paragraphs[1]).not.toHaveProperty('context');

    for (const id of ['a', 'b']) {
      const host = document.getElementById(id);
      expect(host.getAttribute(HOST_ATTR)).toMatch(/^h[a-z0-9]{6}-\d+$/);
      expect(translationOf(host).getAttribute('data-st-state')).toBe('submitted');
      expect(rendererTextOf(host)).toBe('已提交，等待翻译');
    }
  });

  it('只提交视口附近可译段落：远处、跳过规则与表单控件不收集也不标记', async () => {
    await loadContent();
    document.body.innerHTML =
      '<p id="a">Visible</p>' +
      '<p id="b" data-offscreen>Offscreen</p>' +
      '<p translate="no">No translate</p>' +
      '<p id="c">Also visible</p>' +
      '<input value="Input value" />';

    const response = await sendToContent({
      type: MESSAGE_TYPES.START,
      payload: { targetLang: 'zh' },
    });

    expect(response).toEqual({ ok: true, data: { phase: 'submitted', total: 2 } });
    expect(submissions[0].paragraphs.map((paragraph) => paragraph.text)).toEqual([
      'Visible',
      'Also visible',
    ]);
    expect(submissions[0].paragraphs[1]).not.toHaveProperty('context');
    expect(document.getElementById('b').getAttribute(HOST_ATTR)).toBe(null);
    expect(translationOf(document.getElementById('b'))).toBe(null);
  });

  it('重复 ST_START 先移除旧标记再重新扫描并提交新 requestId', async () => {
    await loadContent();
    document.body.innerHTML = '<p id="a">Hello</p><p id="b">World</p>';

    const first = await sendToContent({
      type: MESSAGE_TYPES.START,
      payload: { targetLang: 'zh' },
    });
    expect(first).toEqual({ ok: true, data: { phase: 'submitted', total: 2 } });
    expect(document.querySelectorAll(`[${TRANSLATION_ATTR}]`)).toHaveLength(2);

    const second = await sendToContent({
      type: MESSAGE_TYPES.START,
      payload: { targetLang: 'zh' },
    });

    expect(second).toEqual({ ok: true, data: { phase: 'submitted', total: 2 } });
    expect(submissions).toHaveLength(2);
    expect(submissions[1].requestId).toMatch(/^s-/);
    expect(submissions[1].requestId).not.toBe(submissions[0].requestId);
    expect(submissions[1].scope).toBe('page');
    expect(submissions[1].paragraphs.map((paragraph) => paragraph.text)).toEqual([
      'Hello',
      'World',
    ]);
    expect(document.querySelectorAll(`[${TRANSLATION_ATTR}]`)).toHaveLength(2);
  });

  it('视口附近没有可译段落时返回 idle / total 0 且不提交', async () => {
    await loadContent();
    document.body.innerHTML = '<p>12345</p><p>!!!</p>';

    const response = await sendToContent({
      type: MESSAGE_TYPES.START,
      payload: { targetLang: 'zh' },
    });

    expect(response).toEqual({ ok: true, data: { phase: 'idle', total: 0 } });
    expect(submissions).toHaveLength(0);
    expect(document.querySelector(`[${TRANSLATION_ATTR}]`)).toBe(null);
  });

  it('后台回执 ok:false 时返回错误码，并把所有段落标为失败', async () => {
    await loadContent();
    document.body.innerHTML = '<p id="a">Hello</p><p id="b">World</p>';
    submitReply = () => ({
      ok: false,
      error: { code: ERROR_CODES.NETWORK, message: '网络不可用' },
    });

    const response = await sendToContent({
      type: MESSAGE_TYPES.START,
      payload: { targetLang: 'zh' },
    });

    expect(response).toEqual({
      ok: false,
      error: { code: ERROR_CODES.NETWORK, message: '网络不可用' },
    });
    expect(submissions).toHaveLength(1);
    for (const id of ['a', 'b']) {
      const host = document.getElementById(id);
      expect(translationOf(host).getAttribute('data-st-state')).toBe('error');
      expect(rendererTextOf(host)).toContain('网络不可用');
    }
  });

  it('ST_PAGE_SUBMIT 发送失败（抛错）时返回 NETWORK', async () => {
    await loadContent();
    document.body.innerHTML = '<p id="a">Hello</p>';
    chrome.runtime.sendMessage = async () => {
      throw new Error('offline');
    };

    const response = await sendToContent({
      type: MESSAGE_TYPES.START,
      payload: { targetLang: 'zh' },
    });

    expect(response.ok).toBe(false);
    expect(response.error.code).toBe(ERROR_CODES.NETWORK);
    expect(response.error.message.length).toBeGreaterThan(0);
    expect(translationOf(document.getElementById('a')).getAttribute('data-st-state')).toBe(
      'error'
    );
  });

  it('滚动停止 200ms 后只提交新出现的段落', async () => {
    await loadContent();
    document.body.innerHTML = '<p id="a">Hello</p><p id="b">World</p>';
    await sendToContent({ type: MESSAGE_TYPES.START, payload: { targetLang: 'zh' } });
    expect(submissions).toHaveLength(1);

    document.body.insertAdjacentHTML('beforeend', '<p id="c">New paragraph</p>');
    window.dispatchEvent(new Event('scroll'));
    await vi.advanceTimersByTimeAsync(200);
    await flush();

    expect(submissions).toHaveLength(2);
    expect(submissions[1].scope).toBe('page');
    expect(submissions[1].paragraphs.map((paragraph) => paragraph.text)).toEqual([
      'New paragraph',
    ]);
    const newHost = document.getElementById('c');
    expect(newHost.getAttribute(HOST_ATTR)).toMatch(/^h[a-z0-9]{6}-\d+$/);
    expect(translationOf(newHost).getAttribute('data-st-state')).toBe('submitted');

    // 已提交区域再次滚动不重复提交。
    window.dispatchEvent(new Event('scroll'));
    await vi.advanceTimersByTimeAsync(200);
    await flush();
    expect(submissions).toHaveLength(2);
  });

  it('ST_CLEAR 清除整页标记并返回 removed', async () => {
    await loadContent();
    document.body.innerHTML = '<p id="a">Hello</p><p id="b">World</p>';
    await sendToContent({ type: MESSAGE_TYPES.START, payload: { targetLang: 'zh' } });
    expect(document.querySelectorAll(`[${TRANSLATION_ATTR}]`)).toHaveLength(2);

    const response = await sendToContent({
      type: MESSAGE_TYPES.CLEAR,
      payload: { traceId: 't-clear' },
    });

    expect(response).toEqual({ ok: true, data: { removed: 2 } });
    expect(response.data).not.toHaveProperty('cancelled');
    expect(document.querySelectorAll(`[${TRANSLATION_ATTR}]`)).toHaveLength(0);
    expect(document.getElementById('a').getAttribute(HOST_ATTR)).toMatch(/^h[a-z0-9]{6}-\d+$/);
  });

  it('ST_START 异步处理：handleMessage 返回 true 并异步回包', async () => {
    await loadContent();
    document.body.innerHTML = '<p id="a">Async</p>';
    expect(typeof contentListener).toBe('function');

    const response = await new Promise((resolve) => {
      const returned = contentListener(
        { type: MESSAGE_TYPES.START, payload: { targetLang: 'zh', traceId: 't-async' } },
        { id: chrome.runtime.id },
        resolve
      );
      expect(returned).toBe(true);
    });

    expect(response).toEqual({ ok: true, data: { phase: 'submitted', total: 1 } });
    expect(submissions).toHaveLength(1);
  });

  it('没有 document 或 document.body 时 ST_START 返回「当前页面不可用」', async () => {
    await loadContent();
    vi.stubGlobal('document', undefined);

    const noDocument = await sendToContent({
      type: MESSAGE_TYPES.START,
      payload: { targetLang: 'zh' },
    });

    expect(noDocument).toEqual({
      ok: false,
      error: { code: ERROR_CODES.OTHER, message: '当前页面不可用，请刷新后重试' },
    });

    vi.stubGlobal('document', {});
    const noBody = await sendToContent({
      type: MESSAGE_TYPES.START,
      payload: { targetLang: 'zh' },
    });

    expect(noBody).toEqual({
      ok: false,
      error: { code: ERROR_CODES.OTHER, message: '当前页面不可用，请刷新后重试' },
    });
  });

  it('getTask() 仍导出，返回同一份页面任务', async () => {
    const mod = await loadContent();

    expect(typeof mod.getTask).toBe('function');
    const current = mod.getTask();
    expect(current).not.toBe(null);
    expect(current.getStatus()).toEqual({ phase: 'idle', total: 0 });
  });

  it('Ctrl 落在已提交段落上只移除该段标记，不发起新提交', async () => {
    await loadContent();
    const p = mount('<p id="p">Hello</p>');
    await sendToContent({ type: MESSAGE_TYPES.START, payload: { targetLang: 'zh' } });
    expect(translationOf(p)).not.toBe(null);
    expect(submissions).toHaveLength(1);

    hover(p);
    tapModifier('Control');
    await flush();

    expect(translationOf(p)).toBe(null);
    expect(submissions).toHaveLength(1);
  });
});

// ---------------------------------------------------------------------------
// 结果回显（假数据）
// ---------------------------------------------------------------------------

describe('页面注入结果回显（P6.1）', () => {
  it('整页提交后逐段回显：已提交 → 翻译中 → 定稿，内容带段落 id', async () => {
    await loadContent();
    document.body.innerHTML = '<p id="a">Hello</p><p id="b">World</p>';

    await sendToContent({ type: MESSAGE_TYPES.START, payload: { targetLang: 'zh' } });
    const a = document.getElementById('a');
    const b = document.getElementById('b');
    const itemId = a.getAttribute(HOST_ATTR);
    expect(rendererTextOf(a)).toBe('已提交，等待翻译');
    expect(rendererTextOf(b)).toBe('已提交，等待翻译');

    await vi.advanceTimersByTimeAsync(80);
    expect(translationOf(a).getAttribute('data-st-state')).toBe('loading');
    expect(rendererTextOf(a)).toBe('翻译中…');

    await vi.advanceTimersByTimeAsync(80);
    expect(translationOf(a).getAttribute('data-st-state')).toBe('done');
    expect(rendererTextOf(a)).toBe(`【模拟 ${itemId}】Hello`);
    expect(translationOf(b).getAttribute('data-st-state')).toBe('done');
  });

  it('长段落按增量刷新，定稿前能看到流式文本', async () => {
    await loadContent();
    const long = 'A'.repeat(60);
    document.body.innerHTML = `<p id="a">${long}</p>`;

    await sendToContent({ type: MESSAGE_TYPES.START, payload: { targetLang: 'zh' } });
    const host = document.getElementById('a');
    const itemId = host.getAttribute(HOST_ATTR);

    await vi.advanceTimersByTimeAsync(80);
    expect(translationOf(host).getAttribute('data-st-state')).toBe('loading');

    await vi.advanceTimersByTimeAsync(80);
    expect(rendererTextOf(host)).toBe('翻译中…');

    await vi.advanceTimersByTimeAsync(80);
    expect(translationOf(host).getAttribute('data-st-state')).toBe('streaming');
    expect(rendererTextOf(host)).toHaveLength(20);

    await vi.advanceTimersByTimeAsync(160);
    expect(translationOf(host).getAttribute('data-st-state')).toBe('done');
    expect(rendererTextOf(host)).toBe(`【模拟 ${itemId}】${long}`);
  });

  it('模拟失败模式显示「翻译失败」，页面会话保持 submitted', async () => {
    const mod = await loadContent();
    mod.getTask().setResultMode('fail');
    document.body.innerHTML = '<p id="a">Hello</p>';

    await sendToContent({ type: MESSAGE_TYPES.START, payload: { targetLang: 'zh' } });
    await vi.advanceTimersByTimeAsync(80);

    const host = document.getElementById('a');
    expect(translationOf(host).getAttribute('data-st-state')).toBe('error');
    expect(rendererTextOf(host)).toBe('翻译失败：模拟失败');
    expect(mod.getTask().getStatus().phase).toBe('submitted');
  });

  it('Ctrl 单段提交后同样进入回显', async () => {
    await loadContent();
    const p = mount('<p id="p">Hello</p>');
    hover(p);

    await sendToContent({ type: MESSAGE_TYPES.TOGGLE, payload: {} });
    const itemId = p.getAttribute(HOST_ATTR);
    expect(rendererTextOf(p)).toBe('已提交，等待翻译');

    await vi.advanceTimersByTimeAsync(80);
    expect(translationOf(p).getAttribute('data-st-state')).toBe('loading');

    await vi.advanceTimersByTimeAsync(80);
    expect(translationOf(p).getAttribute('data-st-state')).toBe('done');
    expect(rendererTextOf(p)).toBe(`【模拟 ${itemId}】Hello`);
  });

  it('流式进行中「显示原文」后不再出现新字符', async () => {
    await loadContent();
    document.body.innerHTML = `<p id="a">${'A'.repeat(60)}</p>`;
    await sendToContent({ type: MESSAGE_TYPES.START, payload: { targetLang: 'zh' } });
    await vi.advanceTimersByTimeAsync(160);

    const response = await sendToContent({ type: MESSAGE_TYPES.CLEAR, payload: {} });
    expect(response.ok).toBe(true);
    expect(document.querySelector(`[${TRANSLATION_ATTR}]`)).toBe(null);

    await vi.advanceTimersByTimeAsync(1000);
    expect(document.querySelector(`[${TRANSLATION_ATTR}]`)).toBe(null);
  });
});
