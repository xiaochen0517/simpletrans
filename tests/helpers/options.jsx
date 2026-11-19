// @vitest-environment jsdom
/**
 * 组件测试助手（设置页）
 *
 * 模块：测试基建（tests/helpers）
 * 职责：安装 chrome stub、把 `ST_LIST_ENGINES` 绑定到真实的 E3 公开设置（读 stub 存储），
 *       提供渲染、等待、点击、输入与查找工具，供 tests/component/options*.test.jsx 复用。
 * 实现阶段：P8-3（设置页内容分类与 UI 规范化）
 *
 * 不联网、不加载真实扩展：消息由 helper 内的监听器应答，实例数据仍走 E3 的存储路径。
 */

import { act } from 'react';
import { createRoot } from 'react-dom/client';
import Options from '../../src/options/Options.jsx';
import { getPublicSettings } from '../../src/shared/config/instances.js';
import { MESSAGE_TYPES } from '../../src/shared/protocol.js';
import { STORAGE_KEYS } from '../../src/shared/storage.js';
import { installChrome } from './chrome.js';

globalThis.IS_REACT_ACT_ENVIRONMENT = true;

/** 默认缓存统计响应。 */
export const DEFAULT_CACHE_STATS = Object.freeze({
  entries: 12,
  bytes: 2048,
  maxBytes: 1024 * 1024 * 1024,
  maxEntries: 1_000_000,
});

/**
 * 等待挂起的 Promise、消息与 React 更新落地。
 * @param {number} [times]
 */
export async function flush(times = 3) {
  for (let index = 0; index < times; index += 1) {
    await act(async () => {
      await new Promise((resolve) => setTimeout(resolve, 0));
    });
  }
}

/**
 * 安装 chrome stub 并接管设置页用到的一次性消息。
 * @param {{ testEngine?: (payload: object) => object, cacheStats?: object, clearCache?: object }} [options]
 */
export function createHarness(options = {}) {
  const chrome = installChrome();
  const replies = {
    testEngine:
      options.testEngine ??
      (() => ({
        ok: true,
        data: {
          text: '你好，世界',
          elapsedMs: 42,
          usage: { promptTokens: 10, completionTokens: 8, totalTokens: 18 },
          chars: 11,
          engine: {
            name: 'DeepSeek',
            type: 'openai',
            typeLabel: 'OpenAI 兼容',
            preset: 'deepseek',
            model: 'deepseek-chat',
          },
        },
      })),
    cacheStats: { ok: true, data: { ...DEFAULT_CACHE_STATS, ...(options.cacheStats ?? {}) } },
    clearCache: { ok: true, data: { cleared: 12, ...(options.clearCache ?? {}) } },
  };
  /** 记录设置页发出的消息类型，按调用顺序。 */
  const calls = [];

  chrome.runtime.onMessage.addListener((message, _sender, sendResponse) => {
    calls.push(message.type);
    if (message.type === MESSAGE_TYPES.LIST_ENGINES) {
      getPublicSettings()
        .then(({ instances }) => sendResponse({ ok: true, data: { instances } }))
        .catch((error) =>
          sendResponse({
            ok: false,
            error: { code: 'OTHER', message: String(error?.message ?? '读取失败') },
          })
        );
      return true;
    }
    if (message.type === MESSAGE_TYPES.TEST_ENGINE) {
      sendResponse(replies.testEngine(message.payload));
      return false;
    }
    if (message.type === MESSAGE_TYPES.CACHE_STATS) {
      sendResponse(replies.cacheStats);
      return false;
    }
    if (message.type === MESSAGE_TYPES.CLEAR_CACHE) {
      sendResponse(replies.clearCache);
      return false;
    }
    return false;
  });

  const container = document.createElement('div');
  document.body.appendChild(container);
  const root = createRoot(container);

  return { chrome, replies, calls, container, root };
}

/**
 * 挂载设置页并等待首次加载完成。
 * @param {ReturnType<typeof createHarness>} harness
 * @param {string} [hash]
 */
export async function mountOptions(harness, hash = '#/overview') {
  if (window.location.hash !== hash) window.history.replaceState(null, '', hash);
  await act(async () => {
    harness.root.render(<Options />);
  });
  await flush();
  return harness.container;
}

/**
 * 卸载设置页。
 * @param {ReturnType<typeof createHarness>} harness
 */
export async function unmountOptions(harness) {
  await act(async () => {
    harness.root.unmount();
  });
  harness.container.remove();
  delete globalThis.chrome;
  window.history.replaceState(null, '', '#/overview');
}

/**
 * 按可见文字找按钮。
 * @param {string} text
 * @param {ParentNode} [root]
 * @returns {HTMLButtonElement | undefined}
 */
export function findButton(text, root = document) {
  return [...root.querySelectorAll('button')].find((button) => button.textContent.includes(text));
}

/**
 * 取全部按钮文字。
 * @param {ParentNode} [root]
 * @returns {string[]}
 */
export function buttonTexts(root = document) {
  return [...root.querySelectorAll('button')].map((button) => button.textContent.trim());
}

/**
 * 点击元素并等待更新。
 * @param {Element | null | undefined} element
 */
export async function click(element) {
  if (!element) throw new Error('要点击的元素不存在');
  await act(async () => {
    element.dispatchEvent(new MouseEvent('click', { bubbles: true }));
  });
  await flush();
}

/**
 * 用原生 setter 写入值，再派发 input/change，确保 React 受控组件收到变更。
 * @param {HTMLInputElement | HTMLTextAreaElement | HTMLSelectElement} element
 * @param {string} value
 */
export async function setValue(element, value) {
  const prototype =
    element instanceof HTMLTextAreaElement
      ? HTMLTextAreaElement.prototype
      : element instanceof HTMLSelectElement
        ? HTMLSelectElement.prototype
        : HTMLInputElement.prototype;
  const setter = Object.getOwnPropertyDescriptor(prototype, 'value')?.set;
  await act(async () => {
    if (setter) setter.call(element, value);
    element.dispatchEvent(new Event('input', { bubbles: true }));
    element.dispatchEvent(new Event('change', { bubbles: true }));
  });
  await flush();
}

/**
 * 读取存储里的设置。
 * @param {ReturnType<typeof createHarness>} harness
 * @returns {Promise<Record<string, any>>}
 */
export async function readSettings(harness) {
  const data = await harness.chrome.storage.sync.get(STORAGE_KEYS.settings);
  return data[STORAGE_KEYS.settings] ?? {};
}

/**
 * 按 aria-label 找共享下拉（E5 Select）。
 * @param {string} label
 * @param {ParentNode} [root]
 * @returns {HTMLDetailsElement | undefined}
 */
export function findSelect(label, root = document) {
  return [...root.querySelectorAll('details.dropdown')].find(
    (details) => details.querySelector('summary')?.getAttribute('aria-label') === label
  );
}

/**
 * 打开共享下拉并选择一个选项。
 * @param {string} label 下拉的 aria-label
 * @param {string} optionText 选项可见文字（支持部分匹配）
 * @param {ParentNode} [root]
 */
export async function chooseOption(label, optionText, root = document) {
  const details = findSelect(label, root);
  if (!details) throw new Error(`找不到下拉：${label}`);
  await act(async () => {
    details.open = true;
    details.dispatchEvent(new Event('toggle'));
  });
  await flush(1);
  const option = [...details.querySelectorAll('button[role="radio"]')].find((button) =>
    button.textContent.includes(optionText)
  );
  if (!option) throw new Error(`下拉 ${label} 中找不到选项：${optionText}`);
  await click(option);
}

/**
 * 读取存储里的原始实例列表。
 * @param {ReturnType<typeof createHarness>} harness
 * @returns {Promise<Array<Record<string, any>>>}
 */
export async function readInstances(harness) {
  const data = await harness.chrome.storage.sync.get(STORAGE_KEYS.instances);
  return Array.isArray(data[STORAGE_KEYS.instances]) ? data[STORAGE_KEYS.instances] : [];
}

/**
 * 直接写入一个不支持类型的实例（模拟更高版本创建的实例）。
 * @param {ReturnType<typeof createHarness>} harness
 * @param {Record<string, any>} instance
 */
export async function seedUnsupportedInstance(harness, instance) {
  const list = await readInstances(harness);
  await harness.chrome.storage.sync.set({
    [STORAGE_KEYS.instances]: [
      ...list,
      {
        id: instance.id ?? 'inst-future',
        type: instance.type ?? 'future-engine',
        name: instance.name ?? '未来实例',
        enabled: true,
        createdAt: 1,
        updatedAt: 1,
      },
    ],
  });
}
