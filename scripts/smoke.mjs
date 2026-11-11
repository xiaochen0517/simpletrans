#!/usr/bin/env node
/**
 * P0 冒烟测试：在没有 Chrome 的环境里验证构建产物
 *
 * 覆盖：
 * - dist/background.js 能注册全部监听器，并正确路由 ST_PING / ST_ROUTE / ST_STOP /
 *   右键菜单 / 快捷键；
 * - dist/content.js 是自包含 IIFE，能回应 ST_PING / ST_GET_STATUS / GET_SELECTION；
 * - 安装时只写入“位置类”设置，不覆盖已同步的密钥；
 * - content 产物中不包含 apiKey / deepseek 字样（密钥不进页面）。
 *
 * 运行：node scripts/smoke.mjs（需先 npm run build）
 */

import { readFile } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import assert from 'node:assert/strict';

const projectRoot = dirname(dirname(fileURLToPath(import.meta.url)));

/** @returns {{ addListener: Function, listeners: Function[], emit: Function }} */
function createEvent() {
  const listeners = [];
  return {
    listeners,
    addListener: (fn) => listeners.push(fn),
    emit: (...args) => listeners.map((fn) => fn(...args)),
  };
}

function createStorageArea() {
  const data = new Map();
  return {
    data,
    async get(defaults = {}) {
      const result = { ...defaults };
      for (const [key, value] of data) result[key] = value;
      return result;
    },
    async set(patch) {
      for (const [key, value] of Object.entries(patch)) data.set(key, value);
    },
    async remove(keys) {
      for (const key of Array.isArray(keys) ? keys : [keys]) data.delete(key);
    },
    async clear() {
      data.clear();
    },
  };
}

function createChromeStub() {
  const runtime = {
    id: 'smoke-extension',
    onInstalled: createEvent(),
    onStartup: createEvent(),
    onMessage: createEvent(),
    onConnect: createEvent(),
  };
  const sentToTabs = [];
  const injected = [];
  let contentReady = false;

  const tabs = {
    query: async () => [{ id: 7, url: 'https://example.com/' }],
    sendMessage: async (tabId, message) => {
      sentToTabs.push({ tabId, message });
      if (message?.type === 'ST_PING' && !contentReady) throw new Error('Receiving end does not exist');
      return { ok: true, from: 'content', status: { phase: 'idle' } };
    },
    onRemoved: createEvent(),
  };

  const scripting = {
    insertCSS: async (options) => {
      injected.push({ type: 'css', options });
    },
    executeScript: async (options) => {
      injected.push({ type: 'js', options });
      contentReady = true;
    },
  };

  const chrome = {
    runtime,
    tabs,
    scripting,
    commands: { onCommand: createEvent() },
    contextMenus: { removeAll: (cb) => cb?.(), create: () => undefined, onClicked: createEvent() },
    storage: {
      local: createStorageArea(),
      sync: createStorageArea(),
      session: createStorageArea(),
    },
  };

  return { chrome, sentToTabs, injected };
}

function createContentChromeStub() {
  const onMessage = createEvent();
  return {
    chrome: { runtime: { id: 'smoke-extension', onMessage } },
    onMessage,
  };
}

/** @param {Function} listener */
function ask(listener, message) {
  let response;
  const keepAlive = listener(message, { id: 'smoke-extension' }, (value) => {
    response = value;
  });
  return { response: () => response, keepAlive };
}

const failures = [];
/**
 * @param {string} name
 * @param {() => Promise<void> | void} fn
 */
async function test(name, fn) {
  try {
    await fn();
    console.info(`  ✓ ${name}`);
  } catch (error) {
    failures.push({ name, error });
    console.error(`  ✗ ${name}`);
    console.error(`    ${error?.message ?? error}`);
  }
}

const tick = () => new Promise((resolve) => setTimeout(resolve, 0));

// ---------------------------------------------------------------- background
console.info('background.js');
const background = createChromeStub();
globalThis.chrome = background.chrome;
await import(pathToFileURL(join(projectRoot, 'dist/background.js')).href);

const onMessage = background.chrome.runtime.onMessage.listeners.at(-1);
assert.ok(onMessage, 'background 未注册 onMessage');
assert.ok(background.chrome.runtime.onConnect.listeners.length > 0, 'background 未注册 onConnect');
assert.ok(background.chrome.commands.onCommand.listeners.length > 0, 'background 未注册 onCommand');
assert.ok(background.chrome.contextMenus.onClicked.listeners.length > 0, 'background 未注册右键菜单');

await test('安装时只写入 keyStorage，不动密钥', async () => {
  background.chrome.storage.sync.data.set('deepseekApiKey', 'sk-legacy');
  background.chrome.runtime.onInstalled.emit({ reason: 'install' });
  await tick();
  assert.equal(background.chrome.storage.sync.data.get('keyStorage'), 'local');
  assert.equal(background.chrome.storage.sync.data.get('deepseekApiKey'), 'sk-legacy');
});

await test('ST_PING → { ok: true }', () => {
  const { response } = ask(onMessage, { type: 'ST_PING' });
  assert.deepEqual(response(), { ok: true, from: 'background' });
});

await test('ST_ROUTE → 注入 content 并转发 ST_START(page)', async () => {
  background.sentToTabs.length = 0;
  background.injected.length = 0;
  const { keepAlive } = ask(onMessage, { type: 'ST_ROUTE', scope: 'page', source: 'popup' });
  assert.equal(keepAlive, true, '异步消息应返回 true');
  await tick();
  await tick();
  const injectedJs = background.injected.find((item) => item.type === 'js');
  assert.ok(injectedJs, '未触发 executeScript 兜底注入');
  assert.deepEqual(injectedJs.options.files, ['content.js']);
  const start = background.sentToTabs.find((item) => item.message.type === 'ST_START');
  assert.ok(start, '未转发 ST_START');
  assert.equal(start.tabId, 7);
  assert.equal(start.message.scope, 'page');
  assert.equal(start.message.source, 'popup');
});

await test('ST_STOP → 转发到活动标签页', async () => {
  background.sentToTabs.length = 0;
  ask(onMessage, { type: 'ST_STOP' });
  await tick();
  await tick();
  assert.ok(background.sentToTabs.some((item) => item.message.type === 'ST_STOP'));
});

await test('右键菜单 → ST_START(paragraph)', async () => {
  background.sentToTabs.length = 0;
  background.chrome.contextMenus.onClicked.emit({ menuItemId: 'st-translate-paragraph' }, { id: 7 });
  await tick();
  await tick();
  const start = background.sentToTabs.find((item) => item.message.type === 'ST_START');
  assert.ok(start, '右键菜单未触发 ST_START');
  assert.equal(start.message.scope, 'paragraph');
  assert.equal(start.message.source, 'contextMenu');
});

await test('快捷键 translate-page → ST_START(page)', async () => {
  background.sentToTabs.length = 0;
  background.chrome.commands.onCommand.emit('translate-page', { id: 7 });
  await tick();
  await tick();
  const start = background.sentToTabs.find((item) => item.message.type === 'ST_START');
  assert.ok(start, '快捷键未触发 ST_START');
  assert.equal(start.message.scope, 'page');
  assert.equal(start.message.source, 'command');
});

// ------------------------------------------------------------------- content
console.info('content.js');
const content = createContentChromeStub();
const contentCode = await readFile(join(projectRoot, 'dist/content.js'), 'utf8');

await test('content.js 是自包含 IIFE，无 import / export', () => {
  assert.ok(contentCode.trimStart().startsWith('(function'), '产物不是 IIFE');
  assert.equal(/^\s*(import|export)\s/m.test(contentCode), false, '产物包含 ESM 语句');
});

await test('content.js 不含密钥相关代码', () => {
  assert.equal(/apiKey|deepseek|generateText|streamText/i.test(contentCode), false);
});

await test('content 响应 ST_PING / ST_GET_STATUS / GET_SELECTION', () => {
  const scope = { chrome: content.chrome, window: { getSelection: () => ({ toString: () => ' hello ' }) } };
  const factory = new Function('chrome', 'window', contentCode);
  factory(scope.chrome, scope.window);
  const listener = content.onMessage.listeners.at(-1);
  assert.ok(listener, 'content 未注册 onMessage');

  assert.deepEqual(ask(listener, { type: 'ST_PING' }).response(), { ok: true, from: 'content' });
  assert.deepEqual(ask(listener, { type: 'ST_GET_STATUS' }).response().status.phase, 'idle');
  assert.equal(ask(listener, { type: 'GET_SELECTION' }).response().text, 'hello');
  assert.equal(ask(listener, { type: 'ST_START', scope: 'page' }).response().ok, false);
});

void content;

// --------------------------------------------------------------------- 汇总
console.info('');
if (failures.length > 0) {
  console.error(`冒烟测试失败：${failures.length} 项`);
  process.exitCode = 1;
} else {
  console.info('冒烟测试通过');
}
