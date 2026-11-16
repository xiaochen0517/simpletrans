// @vitest-environment jsdom
/**
 * 页面注入接线测试（P4）
 *
 * 在 jsdom 中模拟 st-gateway 的服务端，验证「快捷键命令 → 悬停解析 → 批次 → 译文渲染」
 * 的完整接线与清除；不加载真实扩展、不联网。
 */

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { installChrome } from '../helpers/load.js';
import { MESSAGE_TYPES, PORT_NAME } from '../../src/shared/protocol.js';
import { TRANSLATION_ATTR, extractText, normalizeText } from '../../src/content/dom/scanner.js';

let serverPort = null;
let batches = [];

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

beforeEach(() => {
  installChrome();
  delete globalThis.__simpletransContentLoaded;
  document.body.innerHTML = '';
  serverPort = null;
  batches = [];
  vi.spyOn(console, 'debug').mockImplementation(() => {});
  vi.spyOn(console, 'info').mockImplementation(() => {});
  vi.spyOn(console, 'warn').mockImplementation(() => {});
  vi.spyOn(console, 'error').mockImplementation(() => {});

  chrome.runtime.onConnect.addListener((port) => {
    if (port.name !== PORT_NAME) return;
    serverPort = port;
    port.onMessage.addListener((message) => {
      if (message?.type === MESSAGE_TYPES.PING) {
        port.postMessage({
          type: MESSAGE_TYPES.PONG,
          payload: { sentAt: message.payload?.sentAt },
        });
      }
      if (message?.type === MESSAGE_TYPES.TRANSLATE_BATCH) {
        batches.push(message.payload);
      }
    });
  });
});

afterEach(() => {
  vi.restoreAllMocks();
  delete globalThis.__simpletransContentLoaded;
});

/**
 * 导入页面注入并等到桥连接建立。
 * @returns {Promise<object>}
 */
async function loadContent() {
  vi.resetModules();
  const mod = await import('../../src/content/index.js');
  await vi.waitFor(() => expect(mod.getBridge().getState()).toBe('connected'));
  return mod;
}

describe('页面注入接线（P4）', () => {
  it('ST_TOGGLE 从当前段落发批次，收到定稿后渲染译文', async () => {
    const mod = await loadContent();
    const p = mount('<p id="p">Hello world</p>');
    hover(p);

    const response = await sendToContent({
      type: MESSAGE_TYPES.TOGGLE,
      payload: { traceId: 't-page-1' },
    });

    expect(response).toEqual({ ok: true, data: { action: 'translating' } });
    expect(batches).toHaveLength(1);
    expect(batches[0]).toMatchObject({
      traceId: 't-page-1',
      items: [{ itemId: 'i0', text: 'Hello world' }],
    });

    serverPort.postMessage({
      type: MESSAGE_TYPES.ITEM_DONE,
      payload: { requestId: batches[0].requestId, itemId: 'i0', text: '你好，世界' },
    });

    await vi.waitFor(() => {
      expect(document.querySelector(`[${TRANSLATION_ATTR}]`)?.textContent).toBe('你好，世界');
    });
    expect(p.textContent).toContain('你好，世界');
    expect(normalizeText(extractText(p))).toBe('Hello world');

    mod.getBridge().close();
  });

  it('span 中的文字，译文插入 span 内部', async () => {
    const mod = await loadContent();
    mount('<p id="p"><span id="s">Hello</span></p>');
    const span = document.getElementById('s');
    hover(span);

    await sendToContent({ type: MESSAGE_TYPES.TOGGLE, payload: {} });
    expect(batches[0].items).toEqual([{ itemId: 'i0', text: 'Hello' }]);

    serverPort.postMessage({
      type: MESSAGE_TYPES.ITEM_DONE,
      payload: { requestId: batches[0].requestId, itemId: 'i0', text: '你好' },
    });

    await vi.waitFor(() => {
      expect(document.querySelector(`[${TRANSLATION_ATTR}]`)).not.toBe(null);
    });
    expect(document.querySelector(`[${TRANSLATION_ATTR}]`).parentElement).toBe(span);
    expect(span.textContent).toContain('你好');
    mod.getBridge().close();
  });

  it('button 中的文字可以作为独立段落翻译', async () => {
    const mod = await loadContent();
    mount('<p id="p"><button id="b">Submit</button></p>');
    const button = document.getElementById('b');
    hover(button);

    await sendToContent({ type: MESSAGE_TYPES.TOGGLE, payload: {} });
    expect(batches[0].items).toEqual([{ itemId: 'i0', text: 'Submit' }]);

    serverPort.postMessage({
      type: MESSAGE_TYPES.ITEM_DONE,
      payload: { requestId: batches[0].requestId, itemId: 'i0', text: '提交' },
    });

    await vi.waitFor(() => {
      expect(document.querySelector(`[${TRANSLATION_ATTR}]`)).not.toBe(null);
    });
    expect(document.querySelector(`[${TRANSLATION_ATTR}]`).parentElement).toBe(button);
    mod.getBridge().close();
  });

  it('译文可见时再次触发隐藏，指针在译文上归到该段', async () => {
    const mod = await loadContent();
    const p = mount('<p id="p">Hello</p>');
    hover(p);

    await sendToContent({ type: MESSAGE_TYPES.TOGGLE, payload: {} });
    serverPort.postMessage({
      type: MESSAGE_TYPES.ITEM_DONE,
      payload: { requestId: batches[0].requestId, itemId: 'i0', text: '你好' },
    });
    await vi.waitFor(() => {
      expect(document.querySelector(`[${TRANSLATION_ATTR}]`)).not.toBe(null);
    });

    const translation = document.querySelector(`[${TRANSLATION_ATTR}]`);
    hover(translation);
    const response = await sendToContent({ type: MESSAGE_TYPES.TOGGLE, payload: {} });

    expect(response).toEqual({ ok: true, data: { action: 'hidden' } });
    expect(document.querySelector(`[${TRANSLATION_ATTR}]`)).toBe(null);
    mod.getBridge().close();
  });

  it('ST_CLEAR 移除全部译文并回传计数', async () => {
    const mod = await loadContent();
    const p = mount('<p id="p">Hello</p>');
    hover(p);

    await sendToContent({ type: MESSAGE_TYPES.TOGGLE, payload: {} });
    serverPort.postMessage({
      type: MESSAGE_TYPES.ITEM_DONE,
      payload: { requestId: batches[0].requestId, itemId: 'i0', text: '你好' },
    });
    await vi.waitFor(() => {
      expect(document.querySelector(`[${TRANSLATION_ATTR}]`)).not.toBe(null);
    });

    const response = await sendToContent({ type: MESSAGE_TYPES.CLEAR, payload: {} });

    expect(response.ok).toBe(true);
    expect(response.data.removed).toBe(1);
    expect(document.querySelector(`[${TRANSLATION_ATTR}]`)).toBe(null);
    mod.getBridge().close();
  });

  it('指针不在可译段落上时返回 no-target', async () => {
    const mod = await loadContent();
    mount('<p id="p">12345</p>');
    hover(document.getElementById('p'));

    const response = await sendToContent({ type: MESSAGE_TYPES.TOGGLE, payload: {} });

    expect(response).toEqual({ ok: true, data: { action: 'no-target' } });
    expect(batches).toHaveLength(0);
    mod.getBridge().close();
  });

  it('Ctrl 单键按下并松开触发翻译', async () => {
    const mod = await loadContent();
    const p = mount('<p id="p">Hello</p>');
    hover(p);

    tapModifier('Control');

    expect(batches).toHaveLength(1);
    expect(batches[0].items).toEqual([{ itemId: 'i0', text: 'Hello' }]);
    expect(document.querySelector(`[${TRANSLATION_ATTR}]`)).not.toBe(null);
    mod.getBridge().close();
  });

  it('Ctrl+其它键不触发（Ctrl+C 不被误判）', async () => {
    const mod = await loadContent();
    const p = mount('<p id="p">Hello</p>');
    hover(p);

    window.dispatchEvent(new KeyboardEvent('keydown', { key: 'Control', bubbles: true }));
    window.dispatchEvent(new KeyboardEvent('keydown', { key: 'c', bubbles: true }));
    window.dispatchEvent(new KeyboardEvent('keyup', { key: 'c', bubbles: true }));
    window.dispatchEvent(new KeyboardEvent('keyup', { key: 'Control', bubbles: true }));

    expect(batches).toHaveLength(0);
    mod.getBridge().close();
  });

  it('按住 Ctrl 点击时不触发（避免 Ctrl+click 误判）', async () => {
    const mod = await loadContent();
    const p = mount('<p id="p">Hello</p>');
    hover(p);

    window.dispatchEvent(new KeyboardEvent('keydown', { key: 'Control', bubbles: true }));
    p.dispatchEvent(new MouseEvent('pointerdown', { bubbles: true }));
    window.dispatchEvent(new KeyboardEvent('keyup', { key: 'Control', bubbles: true }));

    expect(batches).toHaveLength(0);
    mod.getBridge().close();
  });

  it('焦点在输入框内时 Ctrl 单键不触发', async () => {
    const mod = await loadContent();
    const p = mount('<p id="p">Hello</p>');
    const input = document.createElement('input');
    document.body.appendChild(input);
    input.focus();
    hover(p);

    tapModifier('Control');

    expect(batches).toHaveLength(0);
    input.remove();
    mod.getBridge().close();
  });

  it('按住 Ctrl 超过 600 毫秒不触发', async () => {
    const mod = await loadContent();
    const p = mount('<p id="p">Hello</p>');
    let now = 1000;
    const spy = vi.spyOn(Date, 'now').mockImplementation(() => now);
    hover(p);

    window.dispatchEvent(new KeyboardEvent('keydown', { key: 'Control', bubbles: true }));
    now += 1000;
    window.dispatchEvent(new KeyboardEvent('keyup', { key: 'Control', bubbles: true }));

    expect(batches).toHaveLength(0);
    spy.mockRestore();
    mod.getBridge().close();
  });
});
