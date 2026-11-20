// @vitest-environment jsdom
/**
 * B3 快速翻译面板组件测试
 *
 * 覆盖标签切换、选区自动填入、临时实例与目标语言不写存储、Ctrl+Enter、结果纯文本、复制与错误。
 * 用 jsdom + react-dom/client + React 的 act 渲染，chrome API 由 tests/helpers/chrome.js 的 stub 提供。
 */

import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { act } from 'react';
import { createRoot } from 'react-dom/client';
import Popup from '../../src/popup/Popup.jsx';
import { MESSAGE_TYPES } from '../../src/shared/protocol.js';
import { STORAGE_KEYS } from '../../src/shared/storage.js';
import { installChrome } from '../helpers/chrome.js';

globalThis.IS_REACT_ACT_ENVIRONMENT = true;

/** @type {object} */
let chromeStub;
/** @type {HTMLElement} */
let container;
/** @type {ReturnType<typeof createRoot>} */
let root;
/** 快速翻译响应。 */
let quickResponse;
/** 选区响应。 */
let selectionResponse;
/** 实例列表响应。 */
let instancesResponse;
/** 收到的快速翻译载荷。 */
let quickPayloads;
/** 选区读取次数。 */
let selectionRequests;

/** 默认实例。 */
function defaultInstance() {
  return {
    id: 'default',
    name: 'DeepSeek',
    type: 'openai',
    typeLabel: 'OpenAI 兼容',
    kind: 'llm',
    preset: 'deepseek',
    model: 'deepseek-chat',
    enabled: true,
    hasKey: true,
    requiresKey: true,
    permission: 'granted',
  };
}

/** 等待异步读取与渲染完成。 */
async function flush() {
  await act(async () => {
    await new Promise((resolve) => setTimeout(resolve, 0));
  });
}

/** 挂载弹窗。 */
async function renderPopup() {
  await act(async () => {
    root.render(<Popup />);
  });
  await flush();
}

/** 点击元素。 */
async function click(element) {
  await act(async () => {
    element.dispatchEvent(new MouseEvent('click', { bubbles: true }));
  });
  await flush();
}

/** 切到快速翻译标签。 */
async function openQuickTab() {
  await click(container.querySelector('#popup-tab-quick'));
}

/** 取输入框。 */
function input() {
  return container.querySelector('#quick-input');
}

/** 取可见按钮（按文字精确匹配，避免命中「快速翻译」标签）。 */
function findButton(text) {
  return [...container.querySelectorAll('button')].find(
    (button) => button.textContent.trim() === text
  );
}

/** 用原生 setter 写入文本域，再派发 input，确保 React 受控组件收到变更。 */
async function setValue(element, value) {
  const setter = Object.getOwnPropertyDescriptor(HTMLTextAreaElement.prototype, 'value')?.set;
  await act(async () => {
    if (setter) setter.call(element, value);
    element.dispatchEvent(new Event('input', { bubbles: true }));
  });
  await flush();
}

beforeEach(async () => {
  chromeStub = installChrome();
  quickResponse = {
    ok: true,
    data: {
      text: '你好',
      elapsedMs: 12,
      usage: null,
      chars: 5,
      targetLang: 'zh',
      engine: { id: 'default', name: 'DeepSeek', type: 'openai', kind: 'llm' },
    },
  };
  selectionResponse = { ok: true, data: { text: 'selected text', truncated: false } };
  instancesResponse = { ok: true, data: { instances: [defaultInstance()] } };
  quickPayloads = [];
  selectionRequests = 0;

  chromeStub.runtime.onMessage.addListener((message, _sender, sendResponse) => {
    if (message.type === MESSAGE_TYPES.LIST_ENGINES) {
      sendResponse(instancesResponse);
      return false;
    }
    if (message.type === MESSAGE_TYPES.GET_SELECTION) {
      selectionRequests += 1;
      sendResponse(selectionResponse);
      return false;
    }
    if (message.type === MESSAGE_TYPES.QUICK_TRANSLATE) {
      quickPayloads.push(message.payload);
      sendResponse(quickResponse);
      return false;
    }
    return false;
  });

  await chromeStub.storage.sync.set({
    [STORAGE_KEYS.settings]: {
      logLevel: 'off',
      targetLang: 'zh',
      activeInstanceId: 'default',
      popupDefaultTab: 'default',
    },
  });

  container = document.createElement('div');
  document.body.appendChild(container);
  root = createRoot(container);
});

afterEach(async () => {
  await act(async () => {
    root.unmount();
  });
  container.remove();
  delete globalThis.chrome;
});

describe('B3 快速翻译：选区与输入', () => {
  it('设置卡片不显示说明文字或实例类别提示', async () => {
    await renderPopup();
    await openQuickTab();

    const text = container.textContent;
    expect(text).not.toContain('修改只对本次快速翻译生效');
    expect(text).not.toContain('大模型实例：');
    expect(text).not.toContain('传统翻译实例：');
  });

  it('默认页不读取选区，切到快速页时读取一次', async () => {
    await renderPopup();
    expect(selectionRequests).toBe(0);

    await openQuickTab();
    expect(selectionRequests).toBe(1);
    expect(input().value).toBe('selected text');

    await click(container.querySelector('#popup-tab-default'));
    await openQuickTab();
    expect(selectionRequests).toBe(1);
    expect(input().value).toBe('selected text');
  });

  it('切到快速页时自动填入当前网页选中文字', async () => {
    await renderPopup();
    await openQuickTab();

    expect(input()).toBeTruthy();
    expect(input().value).toBe('selected text');
  });

  it('切换标签不重置快速页输入', async () => {
    await renderPopup();
    await openQuickTab();
    await setValue(input(), '自定义内容');

    await click(container.querySelector('#popup-tab-default'));
    await openQuickTab();

    expect(input().value).toBe('自定义内容');
  });

  it('已输入内容时不被自动选区覆盖；手动「读取选区」可覆盖', async () => {
    await renderPopup();
    await openQuickTab();
    await setValue(input(), '手写内容');
    expect(input().value).toBe('手写内容');

    await click(findButton('读取选区'));
    expect(input().value).toBe('selected text');
  });

  it('没有选中文字时保持空输入，不报错', async () => {
    selectionResponse = { ok: true, data: { text: '', truncated: false } };
    await renderPopup();
    await openQuickTab();

    expect(input().value).toBe('');
    expect(container.textContent).not.toContain('读取失败');
  });

  it('选区超长时显示截断提示', async () => {
    selectionResponse = { ok: true, data: { text: 'x'.repeat(4000), truncated: true } };
    await renderPopup();
    await openQuickTab();

    expect(container.textContent).toContain('已截取前 4000 字符');
  });
});

describe('B3 快速翻译：临时实例与目标语言', () => {
  it('Ctrl+Enter 提交快速翻译并展示纯文本结果', async () => {
    await renderPopup();
    await openQuickTab();

    await act(async () => {
      input().dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', ctrlKey: true, bubbles: true }));
    });
    await flush();

    expect(quickPayloads).toHaveLength(1);
    expect(quickPayloads[0]).toMatchObject({
      text: 'selected text',
      instanceId: 'default',
      targetLang: 'zh',
    });
    expect(container.textContent).toContain('你好');
    expect(container.textContent).toContain('DeepSeek');
    expect(container.querySelector('[aria-label="快速翻译结果"]')).toBeTruthy();
  });

  it('临时切换目标语言只改本次请求，不写设置', async () => {
    await renderPopup();
    await openQuickTab();

    const languageSelect = container.querySelector('#quick-lang-select');
    await act(async () => {
      languageSelect.open = true;
      languageSelect.dispatchEvent(new Event('toggle'));
    });
    const japanese = [...languageSelect.querySelectorAll('button[role="radio"]')].find(
      (button) => button.dataset.value === 'ja'
    );
    await click(japanese);

    await act(async () => {
      input().dispatchEvent(new Event('input', { bubbles: true }));
    });
    await click(findButton('翻译'));
    expect(quickPayloads).toHaveLength(1);
    expect(quickPayloads[0].targetLang).toBe('ja');
    const stored = await chromeStub.storage.sync.get(STORAGE_KEYS.settings);
    expect(stored[STORAGE_KEYS.settings].targetLang).toBe('zh');
    expect(stored[STORAGE_KEYS.settings].activeInstanceId).toBe('default');
  });

  it('没有可用实例时禁用翻译并提示', async () => {
    instancesResponse = { ok: true, data: { instances: [] } };
    await chromeStub.storage.sync.set({
      [STORAGE_KEYS.settings]: {
        logLevel: 'off',
        targetLang: 'zh',
        popupDefaultTab: 'quick',
      },
    });
    await renderPopup();
    await flush();

    expect(container.querySelector('#quick-input')).toBeTruthy();
    expect(container.textContent).toContain('没有可用的翻译实例');
    expect(findButton('翻译').disabled).toBe(true);
  });
});

describe('B3 快速翻译：错误与复制', () => {
  it('失败时显示后台错误并保留输入', async () => {
    quickResponse = { ok: false, error: { code: 'CONFIG', message: '该实例已停用' } };
    await renderPopup();
    await openQuickTab();

    await act(async () => {
      input().dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', ctrlKey: true, bubbles: true }));
    });
    await flush();

    expect(container.textContent).toContain('该实例已停用');
    expect(input().value).toBe('selected text');
  });

  it('复制结果写入剪贴板并提示', async () => {
    const copied = [];
    Object.defineProperty(navigator, 'clipboard', {
      configurable: true,
      value: { writeText: async (text) => copied.push(text) },
    });
    await renderPopup();
    await openQuickTab();

    await act(async () => {
      input().dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', ctrlKey: true, bubbles: true }));
    });
    await flush();
    await click(findButton('复制'));

    expect(copied).toEqual(['你好']);
    expect(container.textContent).toContain('已复制');
  });
});
