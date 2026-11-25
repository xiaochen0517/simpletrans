// @vitest-environment jsdom
/**
 * 弹窗组件测试
 *
 * 覆盖：基础信息展示与降级、翻译方式下拉（只列已配置实例、切换写入 activeInstanceId）、
 *      图标导航、失败提示与 daisyUI 默认主题契约。
 * 用 jsdom + react-dom/client + React 的 act 渲染，不引入 Testing Library；
 * chrome API 由 tests/helpers/chrome.js 的 stub 提供。
 */

import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { readFile } from 'node:fs/promises';
import { join } from 'node:path';
import { act } from 'react';
import { createRoot } from 'react-dom/client';
import Popup from '../../src/popup/Popup.jsx';
import { MESSAGE_TYPES } from '../../src/shared/protocol.js';
import { STORAGE_KEYS } from '../../src/shared/storage.js';
import { installChrome } from '../helpers/chrome.js';

globalThis.IS_REACT_ACT_ENVIRONMENT = true;

/** @type {{ instances?: Array<object>, ok?: boolean }} */
let engineResponse;

/** @type {{ ok: boolean, data?: object, error?: object }} ROUTE status 的响应。 */
let statusResponse;

/** @type {{ ok: boolean, data?: object, error?: object }} ROUTE toggle 的响应。 */
let toggleResponse;

/** @type {Array<{ command?: string }>} 收到的 ST_ROUTE 命令。 */
let routeCalls;

/** 非空时挂起 toggle 响应，用于观察执行中的按钮状态。 */
let pendingToggle;

/** @type {object} */
let chromeStub;

/** @type {HTMLElement} */
let container;

/** @type {ReturnType<typeof createRoot>} */
let root;

/** 默认实例：已启用、已配置密钥、默认模型。 */
function defaultInstance() {
  return {
    id: 'default',
    name: 'DeepSeek',
    type: 'openai',
    typeLabel: 'OpenAI 兼容',
    preset: 'deepseek',
    model: 'deepseek-chat',
    enabled: true,
    hasKey: true,
    requiresKey: true,
    permission: 'granted',
  };
}

/** 让弹窗完成一次挂载后的异步读取。 */
async function flush() {
  await act(async () => {
    await new Promise((resolve) => setTimeout(resolve, 0));
  });
}

/** 挂载弹窗并等待信息读取完成。 */
async function renderPopup() {
  await act(async () => {
    root.render(<Popup />);
  });
  await flush();
}

/** 按可见文字找按钮。 */
function findButton(text) {
  return [...container.querySelectorAll('button')].find((button) =>
    button.textContent.includes(text)
  );
}

/** 取下拉容器、触发器与面板。 */
function findSelect() {
  return container.querySelector('#engine-select');
}

function findSummary() {
  return findSelect()?.querySelector('summary');
}

function findOptions() {
  return [...(findSelect()?.querySelectorAll('button[role="radio"]') ?? [])];
}

/** 展开下拉；jsdom 不保证 summary 的默认 toggle 行为，直接设置 open 并派发 toggle。 */
async function openSelect() {
  const details = findSelect();
  await act(async () => {
    details.open = true;
    details.dispatchEvent(new Event('toggle'));
  });
  await flush();
}

/** 模拟一次下拉选择。 */
async function selectEngine(value) {
  await openSelect();
  const option = findOptions().find((button) => button.dataset.value === value);
  if (!option) throw new Error(`找不到选项 ${value}`);
  await act(async () => {
    option.dispatchEvent(new MouseEvent('click', { bubbles: true }));
  });
  await flush();
}

/** 模拟一次点击。 */
async function click(button) {
  await act(async () => {
    button.dispatchEvent(new MouseEvent('click', { bubbles: true }));
  });
  await flush();
}

beforeEach(async () => {
  chromeStub = installChrome();
  engineResponse = { ok: true, data: { instances: [defaultInstance()] } };
  statusResponse = { ok: true, data: { active: false } };
  toggleResponse = { ok: true, data: { action: 'started', phase: 'submitted', total: 2 } };
  routeCalls = [];
  pendingToggle = null;

  chromeStub.runtime.onMessage.addListener((message, _sender, sendResponse) => {
    if (message.type === MESSAGE_TYPES.LIST_ENGINES) {
      sendResponse(engineResponse);
      return false;
    }
    if (message.type === MESSAGE_TYPES.ROUTE) {
      const command = message.payload?.command;
      routeCalls.push({ command });
      if (command === 'status') {
        sendResponse(statusResponse);
        return false;
      }
      if (command === 'toggle') {
        if (pendingToggle) {
          pendingToggle.push(sendResponse);
          return true;
        }
        sendResponse(toggleResponse);
        return false;
      }
      sendResponse({ ok: false, error: { code: 'OTHER', message: '未知命令' } });
      return false;
    }
    return false;
  });

  await chromeStub.storage.sync.set({
    [STORAGE_KEYS.settings]: { logLevel: 'info', targetLang: 'zh' },
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
  document.documentElement.removeAttribute('data-theme');
  document.documentElement.style.colorScheme = '';
});

describe('弹窗基础信息', () => {
  it('下拉显示当前翻译方式，并显示目标语言与密钥状态', async () => {
    await renderPopup();

    const summary = findSummary();
    expect(summary).toBeTruthy();
    expect(summary.textContent).toContain('DeepSeek');

    await openSelect();
    const labels = findOptions().map((button) => button.textContent);
    expect(labels[0]).toContain('DeepSeek');
    expect(labels[0]).toContain('deepseek-chat');

    const text = container.textContent;
    expect(text).toContain('翻译方式');
    expect(text).toContain('中文');
    expect(text).toContain('密钥已配置');
    expect(text).not.toContain('读取配置失败');
  });

  it('渲染图标（图标库已接入）', async () => {
    await renderPopup();
    expect(container.querySelectorAll('svg').length).toBeGreaterThanOrEqual(4);
  });

  it('未配置密钥时显示「密钥未配置」，且下拉没有可选项', async () => {
    engineResponse = {
      ok: true,
      data: { instances: [{ ...defaultInstance(), hasKey: false }] },
    };
    await renderPopup();

    expect(container.textContent).toContain('密钥未配置');
    expect(container.textContent).not.toContain('密钥已配置');
    expect(findSummary().getAttribute('aria-disabled')).toBe('true');
    expect(container.textContent).toContain('未配置翻译方式');
    expect(container.textContent).toContain('没有可用的翻译实例');
  });

  it('无认证实例显示「无需密钥」并可正常选用', async () => {
    engineResponse = {
      ok: true,
      data: {
        instances: [
          {
            ...defaultInstance(),
            id: 'local',
            name: 'Local',
            requiresKey: false,
            hasKey: true,
          },
        ],
      },
    };
    await renderPopup();

    expect(findSummary().getAttribute('aria-disabled')).toBeNull();
    expect(container.textContent).toContain('无需密钥');
  });

  it('没有实例时显示「未配置翻译方式」并保留命令按钮', async () => {
    engineResponse = { ok: true, data: { instances: [] } };
    await renderPopup();

    expect(container.textContent).toContain('未配置翻译方式');
    const startButton = findButton('翻译整页');
    expect(startButton).toBeTruthy();
    expect(startButton.disabled).toBe(false);
  });

  it('后台读取失败时显示降级提示，命令按钮仍可用', async () => {
    engineResponse = { ok: false, error: { code: 'OTHER', message: '读取失败' } };
    await renderPopup();

    expect(container.textContent).toContain('读取配置失败，请到设置页检查');
    const startButton = findButton('翻译整页');
    expect(startButton).toBeTruthy();
    expect(startButton.disabled).toBe(false);
  });
});

describe('整页单按钮与快捷键', () => {
  it('未开启整页翻译时只显示一个按钮，展示快捷键与统一图标', async () => {
    await renderPopup();

    const startButton = findButton('翻译整页');
    expect(startButton).toBeTruthy();
    expect(findButton('显示原文')).toBeUndefined();
    expect(startButton.textContent).toContain('Ctrl+Shift+Y');
    expect(startButton.querySelector('.lucide-languages')).toBeTruthy();
  });

  it('页面整页会话开启时显示「显示原文」与快捷键，点击只发 toggle 并切回', async () => {
    statusResponse = { ok: true, data: { active: true } };
    toggleResponse = { ok: true, data: { action: 'cleared', removed: 2 } };
    await renderPopup();

    const clearButton = findButton('显示原文');
    expect(clearButton).toBeTruthy();
    expect(findButton('翻译整页')).toBeUndefined();
    expect(clearButton.textContent).toContain('Ctrl+Shift+Y');
    expect(clearButton.querySelector('.lucide-languages')).toBeTruthy();

    await click(clearButton);

    const commands = routeCalls.map((call) => call.command);
    expect(commands).toContain('toggle');
    expect(commands).not.toContain('start');
    expect(commands).not.toContain('clear');
    expect(findButton('翻译整页')).toBeTruthy();
    expect(findButton('翻译整页').textContent).toContain('Ctrl+Shift+Y');
  });

  it('点击「翻译整页」成功切换为「显示原文」，快捷键保持显示', async () => {
    await renderPopup();
    await click(findButton('翻译整页'));

    const commands = routeCalls.map((call) => call.command);
    expect(commands).toContain('toggle');
    expect(commands).not.toContain('start');
    expect(findButton('显示原文')).toBeTruthy();
    expect(findButton('显示原文').textContent).toContain('Ctrl+Shift+Y');
    expect(container.textContent).toContain('已提交：2 段');
  });

  it('状态查询失败时回退「翻译整页」，按钮仍可点击', async () => {
    statusResponse = { ok: false, error: { code: 'OTHER', message: '页面不可用' } };
    await renderPopup();

    const startButton = findButton('翻译整页');
    expect(startButton).toBeTruthy();
    expect(findButton('显示原文')).toBeUndefined();
    expect(startButton.disabled).toBe(false);
  });

  it('未绑定浏览器快捷键时未翻译状态显示「未设置」', async () => {
    chromeStub.commands.__shortcuts = [
      { name: 'translate-page', shortcut: '', description: '翻译整页' },
    ];
    await renderPopup();

    expect(findButton('翻译整页').textContent).toContain('未设置');
  });

  it('未绑定浏览器快捷键时已翻译状态也显示「未设置」', async () => {
    chromeStub.commands.__shortcuts = [
      { name: 'translate-page', shortcut: '', description: '翻译整页' },
    ];
    statusResponse = { ok: true, data: { active: true } };
    await renderPopup();

    expect(findButton('显示原文').textContent).toContain('未设置');
  });

  it('执行中显示进度文案并禁用，快捷键徽标仍在', async () => {
    pendingToggle = [];
    await renderPopup();

    await click(findButton('翻译整页'));

    const busyButton = findButton('正在提交…');
    expect(busyButton).toBeTruthy();
    expect(busyButton.disabled).toBe(true);
    expect(busyButton.textContent).toContain('Ctrl+Shift+Y');

    await act(async () => {
      pendingToggle[0](toggleResponse);
    });
    await flush();

    expect(findButton('显示原文')).toBeTruthy();
  });

  it('底部悬停提示读取设置中的快捷键', async () => {
    await chromeStub.storage.sync.set({
      [STORAGE_KEYS.settings]: {
        logLevel: 'info',
        targetLang: 'zh',
        hoverShortcut: 'alt',
      },
    });
    await renderPopup();

    const hint = [...container.querySelectorAll('p')].find((node) =>
      node.textContent.includes('悬停翻译快捷键')
    );
    expect(hint).toBeTruthy();
    expect(hint.textContent).toContain('Alt');
  });
});

describe('翻译方式切换', () => {
  it('只列出已配置密钥的实例', async () => {
    engineResponse.data.instances = [
      defaultInstance(),
      { id: 'backup', name: 'Backup', model: 'deepseek-reasoner', hasKey: false },
      { id: 'third', name: 'Third', model: 'm3', hasKey: true },
    ];
    await renderPopup();
    await openSelect();

    const labels = findOptions().map((button) => button.textContent.trim().replace(/\s+/g, ' '));
    expect(labels[0]).toContain('DeepSeek');
    expect(labels[0]).toContain('OpenAI 兼容/deepseek');
    expect(labels[0]).toContain('deepseek-chat');
    expect(labels[1]).toContain('Third');
    expect(labels.some((label) => label.includes('Backup'))).toBe(false);
  });

  it('停用实例不出现在下拉中', async () => {
    engineResponse.data.instances = [
      defaultInstance(),
      { id: 'off', name: 'Off', model: 'm-off', hasKey: true, enabled: false },
    ];
    await renderPopup();
    await openSelect();

    const labels = findOptions().map((button) => button.textContent);
    expect(labels).toHaveLength(1);
    expect(labels[0]).toContain('DeepSeek');
  });

  it('按 activeInstanceId 选中当前翻译方式', async () => {
    engineResponse.data.instances = [
      defaultInstance(),
      { id: 'third', name: 'Third', model: 'm3', hasKey: true },
    ];
    await chromeStub.storage.sync.set({
      [STORAGE_KEYS.settings]: { logLevel: 'info', targetLang: 'zh', activeInstanceId: 'third' },
    });

    await renderPopup();
    expect(findSummary().textContent).toContain('Third');
    await openSelect();
    const current = findOptions().find((button) => button.dataset.value === 'third');
    expect(current.getAttribute('aria-checked')).toBe('true');
  });

  it('切换后把选择写入 settings.activeInstanceId', async () => {
    engineResponse.data.instances = [
      defaultInstance(),
      { id: 'third', name: 'Third', model: 'm3', hasKey: true },
    ];
    await renderPopup();

    await selectEngine('third');

    const stored = await chromeStub.storage.sync.get(STORAGE_KEYS.settings);
    expect(stored[STORAGE_KEYS.settings].activeInstanceId).toBe('third');
    expect(findSummary().textContent).toContain('Third');
  });

  it('写入失败时回退到上一个选择并提示', async () => {
    engineResponse.data.instances = [
      defaultInstance(),
      { id: 'third', name: 'Third', model: 'm3', hasKey: true },
    ];
    await renderPopup();

    chromeStub.storage.sync.set = async () => {
      throw new Error('storage unavailable');
    };
    await selectEngine('third');

    expect(findSummary().textContent).toContain('DeepSeek');
    expect(container.textContent).toContain('切换翻译方式失败，请重试');
  });
});

describe('弹窗标签与初始页', () => {
  it('渲染两个标签，默认选中「默认」页', async () => {
    await renderPopup();

    const defaultTab = container.querySelector('#popup-tab-default');
    const quickTab = container.querySelector('#popup-tab-quick');
    expect(container.querySelector('[role="tablist"]')).toBeTruthy();
    expect(defaultTab.getAttribute('aria-selected')).toBe('true');
    expect(quickTab.getAttribute('aria-selected')).toBe('false');
    expect(defaultTab.textContent).toContain('默认');
    expect(quickTab.textContent).toContain('快速翻译');
    const quickPanel = container.querySelector('#popup-panel-quick');
    expect(quickPanel).toBeTruthy();
    expect(quickPanel.className).toContain('hidden');
  });

  it('popupDefaultTab=quick 时先显示快速翻译页', async () => {
    await chromeStub.storage.sync.set({
      [STORAGE_KEYS.settings]: { logLevel: 'info', targetLang: 'zh', popupDefaultTab: 'quick' },
    });
    await renderPopup();

    expect(container.querySelector('#popup-tab-quick').getAttribute('aria-selected')).toBe('true');
    expect(container.querySelector('#quick-input')).toBeTruthy();
    expect(container.querySelector('#popup-panel-default').className).toContain('hidden');
  });

  it('按 settings.theme 应用深色主题', async () => {
    await chromeStub.storage.sync.set({
      [STORAGE_KEYS.settings]: { logLevel: 'info', targetLang: 'zh', theme: 'dark' },
    });
    await renderPopup();

    expect(document.documentElement.dataset.theme).toBe('dark');
    expect(document.documentElement.style.colorScheme).toBe('dark');
  });

  it('点击与方向键切换标签，切换不写 popupDefaultTab', async () => {
    await renderPopup();

    await click(container.querySelector('#popup-tab-quick'));
    expect(container.querySelector('#quick-input')).toBeTruthy();
    expect(container.querySelector('#popup-panel-quick').className).not.toContain('hidden');
    expect(container.querySelector('#popup-tab-quick').getAttribute('aria-selected')).toBe('true');

    await act(async () => {
      container
        .querySelector('#popup-tab-quick')
        .dispatchEvent(new KeyboardEvent('keydown', { key: 'ArrowLeft', bubbles: true }));
    });
    await flush();
    expect(container.querySelector('#popup-panel-default').className).not.toContain('hidden');
    expect(container.querySelector('#popup-panel-quick').className).toContain('hidden');
    expect(container.querySelector('#popup-tab-default').getAttribute('aria-selected')).toBe('true');

    const stored = await chromeStub.storage.sync.get(STORAGE_KEYS.settings);
    expect(stored[STORAGE_KEYS.settings].popupDefaultTab).toBeUndefined();
  });
});

describe('图标导航入口', () => {
  it('点击「设置」调用 openOptionsPage', async () => {
    await renderPopup();
    await click(findButton('设置'));

    expect(chromeStub.runtime.__openOptionsCount).toBe(1);
    expect(chromeStub.tabs.__created).toHaveLength(0);
  });

  it('openOptionsPage 不可用时回退到新标签页打开设置页', async () => {
    delete chromeStub.runtime.openOptionsPage;
    await renderPopup();
    await click(findButton('设置'));

    expect(chromeStub.tabs.__created).toHaveLength(1);
    expect(chromeStub.tabs.__created[0].url).toBe(
      'chrome-extension://test-extension-id/options/index.html'
    );
  });

  it('点击「测试页」在新标签页打开测试页', async () => {
    await renderPopup();
    await click(findButton('测试页'));

    expect(chromeStub.tabs.__created).toHaveLength(1);
    expect(chromeStub.tabs.__created[0].url).toBe(
      'chrome-extension://test-extension-id/testpage/index.html'
    );
  });

  it('打开设置失败时显示提示，其他按钮仍可用', async () => {
    chromeStub.runtime.__openOptionsError = new Error('cannot open');
    await renderPopup();
    await click(findButton('设置'));

    expect(container.textContent).toContain('无法打开设置页，请重试');
    expect(findButton('翻译整页').disabled).toBe(false);
  });
});

describe('尺寸与样式契约', () => {
  it('弹窗宽度写在视口根节点上，内容区可纵向滚动', async () => {
    const css = await readFile(join(process.cwd(), 'src/popup/popup.css'), 'utf8');
    const source = await readFile(join(process.cwd(), 'src/popup/Popup.jsx'), 'utf8');

    expect(css, '缺少 html/body 固定宽度').toMatch(/html,\s*body\s*\{[^}]*width:\s*360px/s);
    expect(css, '弹窗 CSS 不应再包含自定义皮肤').not.toContain('.st-');
    expect(source).toContain('max-h-[600px]');
    expect(source).toContain('overflow-y-auto');
  });

  it('整页操作只有一个主按钮，不再并排两个命令按钮', async () => {
    const source = await readFile(join(process.cwd(), 'src/popup/Popup.jsx'), 'utf8');
    expect(source).not.toContain('grid grid-cols-2 gap-2');
    expect(source).toContain('runPage');
    expect(source).toContain('max-w-[9rem] truncate');
  });

  it('共享样式使用 HyperUI 调色板与 data-theme dark 变体', async () => {
    const css = await readFile(join(process.cwd(), 'src/shared/global.css'), 'utf8');

    expect(css).toContain('@custom-variant dark');
    expect(css).toContain('bg-gray-50');
    expect(css).toContain('dark:bg-gray-950');
    expect(css).not.toContain('daisyui');
    expect(css).not.toContain('simpletrans-light');
  });
});
