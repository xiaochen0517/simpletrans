/**
 * A2 网关 + A4 真实缓存 store 集成测试（P5）
 *
 * 用 fake-indexeddb 提供真实事务、索引与主键语义，A3 用 vi.mock 隔离；
 * 每个用例重置模块、关闭连接并重建数据库，避免缓存状态跨用例泄漏。
 */

import 'fake-indexeddb/auto';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

vi.mock('../../src/shared/translate/adapter.js', () => {
  class TranslateError extends Error {
    constructor(code, message) {
      super(message);
      this.name = 'TranslateError';
      this.code = code;
    }
  }
  return {
    translate: vi.fn(),
    TranslateError,
    isSupportedTargetLang: (lang) => lang === 'zh',
    SUPPORTED_TARGET_LANGS: ['zh'],
  };
});

import { installChrome } from '../helpers/load.js';
import { MESSAGE_TYPES, PORT_NAME } from '../../src/shared/protocol.js';

const CACHE_DB_NAME = 'simpletrans-cache';

let gateway;
let storeModule;
let keyModule;
let adapter;
let prompt;
let batch;
let instances;
let settings;
let instance;
let promptHash = '';
let clients = [];
let currentConn = null;

function textItem(text, itemId = 'i0') {
  return { itemId, text };
}

function connectGateway() {
  const client = chrome.runtime.connect({ name: PORT_NAME });
  clients.push(client);
  const frames = [];
  client.onMessage.addListener((message) => frames.push(message));
  return { client, frames };
}

async function waitForBatchDoneFor(frames, requestId) {
  await vi.waitFor(
    () => {
      expect(
        frames.some(
          (frame) =>
            frame.type === MESSAGE_TYPES.BATCH_DONE && frame.payload.requestId === requestId
        )
      ).toBe(true);
    },
    { timeout: 2000 }
  );
  return frames.find(
    (frame) => frame.type === MESSAGE_TYPES.BATCH_DONE && frame.payload.requestId === requestId
  );
}

function deleteCacheDatabase() {
  return new Promise((resolve, reject) => {
    const request = indexedDB.deleteDatabase(CACHE_DB_NAME);
    request.onsuccess = () => resolve();
    request.onerror = () => reject(request.error);
    request.onblocked = () => resolve();
  });
}

/**
 * 直接读缓存库的某个存储区，用于核对 entries / meta 的落库结构。
 * @param {'entries' | 'meta' | 'stats'} storeName
 * @returns {Promise<object[]>}
 */
function readStore(storeName) {
  return new Promise((resolve, reject) => {
    const request = indexedDB.open(CACHE_DB_NAME);
    request.onerror = () => reject(request.error);
    request.onsuccess = () => {
      const db = request.result;
      const tx = db.transaction(storeName, 'readonly');
      const all = tx.objectStore(storeName).getAll();
      all.onsuccess = () => {
        db.close();
        resolve(all.result);
      };
      all.onerror = () => {
        db.close();
        reject(all.error);
      };
    };
  });
}

function expectedKeyFor(text, overrides = {}) {
  return keyModule.buildCacheKey({
    engineType: instance.type,
    model: instance.model,
    sourceLang: 'auto',
    targetLang: overrides.targetLang ?? 'zh',
    promptVersion: prompt.PROMPT_VERSION,
    batchEncodingVersion: batch.BATCH_ENCODING_VERSION,
    reasoningEffort: instance.reasoningEffort,
    promptHash,
    context: overrides.context ?? '',
    text,
  });
}

beforeEach(async () => {
  installChrome();
  vi.spyOn(console, 'info').mockImplementation(() => {});
  vi.spyOn(console, 'warn').mockImplementation(() => {});
  clients = [];
  currentConn = null;

  // getCacheStore() 是模块级单例：重置模块后重新导入，避免跨用例共享连接与 generation。
  vi.resetModules();
  adapter = await import('../../src/shared/translate/adapter.js');
  prompt = await import('../../src/shared/translate/prompt.js');
  batch = await import('../../src/shared/translate/batch.js');
  gateway = await import('../../src/background/gateway.js');
  storeModule = await import('../../src/shared/cache/store.js');
  keyModule = await import('../../src/shared/cache/key.js');
  instances = await import('../../src/shared/config/instances.js');
  settings = await import('../../src/shared/settings.js');

  await deleteCacheDatabase();

  chrome.runtime.onConnect.addListener((port) => {
    if (port.name === PORT_NAME) currentConn = gateway.handleConnect(port);
  });

  adapter.translate.mockReset();
  adapter.translate.mockImplementation(async ({ text, onDelta }) => {
    onDelta?.(`[${text}]`);
    return { text: `译:${text}`, usage: { totalTokens: 2 } };
  });

  instance = await instances.getOrCreateDefaultInstance();
  promptHash = await prompt.hashPrompt(instance.systemPrompt);
  await instances.writeKey(instance.id, 'sk-test');
});

afterEach(async () => {
  for (const client of clients) {
    try {
      client.disconnect();
    } catch {
      // 已断开。
    }
  }
  clients = [];
  await new Promise((resolve) => setTimeout(resolve, 0));
  if (storeModule) {
    try {
      await storeModule.getCacheStore().close();
    } catch {
      // 关闭失败不阻断清理。
    }
  }
  await deleteCacheDatabase();
  vi.restoreAllMocks();
});

describe('A2 + A4：网关接入真实缓存 store（P5）', () => {
  it('未命中调用 A3 后写入真实 store，meta.domain 为归一后的 hostname', async () => {
    const { client, frames } = connectGateway();
    client.postMessage({
      type: MESSAGE_TYPES.TRANSLATE_BATCH,
      payload: {
        requestId: 'real-miss',
        domain: '  Example.COM.  ',
        items: [textItem('Hello real cache')],
      },
    });

    const done = await waitForBatchDoneFor(frames, 'real-miss');

    expect(done.payload).toMatchObject({ ok: true, done: 1, failed: 0, cancelled: 0 });
    expect(adapter.translate).toHaveBeenCalledTimes(1);

    const store = storeModule.getCacheStore();
    await vi.waitFor(async () => {
      const stats = await store.stats();
      expect(stats.entries).toBe(1);
    });

    const expectedKey = await expectedKeyFor('Hello real cache');
    expect(expectedKey).toMatch(/^cache:v2:[0-9a-f]{64}$/);
    // 域名不进入 key：同文本 key 与域名无关。
    expect(expectedKey).not.toContain('example.com');

    const entry = await store.get(expectedKey);
    expect(entry).not.toBeNull();
    expect(entry.text).toBe('译:Hello real cache');
    expect(entry.bytes).toBeGreaterThan(256);

    const stats = await store.stats();
    expect(stats.maxBytes).toBe(storeModule.CACHE_MAX_BYTES);
    expect(stats.maxEntries).toBe(storeModule.CACHE_MAX_ENTRIES);
    expect(stats.bytes).toBeGreaterThan(256);

    const metaRecords = await readStore('meta');
    expect(metaRecords).toHaveLength(1);
    expect(metaRecords[0]).toMatchObject({ key: expectedKey, domain: 'example.com' });
    expect(Number.isFinite(metaRecords[0].lastUsedAt)).toBe(true);

    const entriesRecords = await readStore('entries');
    expect(entriesRecords).toHaveLength(1);
    expect(entriesRecords[0].key).toBe(expectedKey);
    expect(entriesRecords[0].text).toBe('译:Hello real cache');
  });

  it('同文本不同域名命中同一 key，meta.domain 保留首次写入值', async () => {
    const { client, frames } = connectGateway();
    client.postMessage({
      type: MESSAGE_TYPES.TRANSLATE_BATCH,
      payload: {
        requestId: 'real-first',
        domain: 'first.example.com',
        items: [textItem('Shared text')],
      },
    });
    await waitForBatchDoneFor(frames, 'real-first');

    const store = storeModule.getCacheStore();
    await vi.waitFor(async () => {
      const stats = await store.stats();
      expect(stats.entries).toBe(1);
    });

    const expectedKey = await expectedKeyFor('Shared text');
    frames.length = 0;
    client.postMessage({
      type: MESSAGE_TYPES.TRANSLATE_BATCH,
      payload: {
        requestId: 'real-second',
        domain: 'second.example.com',
        items: [textItem('Shared text')],
      },
    });

    const done = await waitForBatchDoneFor(frames, 'real-second');

    expect(done.payload).toMatchObject({ ok: true, done: 1, failed: 0, cancelled: 0 });
    expect(adapter.translate).toHaveBeenCalledTimes(1);
    expect(frames.map((frame) => frame.type)).toEqual([
      MESSAGE_TYPES.ITEM_START,
      MESSAGE_TYPES.ITEM_DONE,
      MESSAGE_TYPES.BATCH_DONE,
    ]);
    expect(frames[1].payload).toMatchObject({
      text: '译:Shared text',
      usage: null,
    });

    const stats = await store.stats();
    expect(stats.entries).toBe(1);

    const metaRecords = await readStore('meta');
    expect(metaRecords).toHaveLength(1);
    expect(metaRecords[0]).toMatchObject({ key: expectedKey, domain: 'first.example.com' });

    const entriesRecords = await readStore('entries');
    expect(entriesRecords).toHaveLength(1);
    expect(entriesRecords[0].key).toBe(expectedKey);
  });

  it('批次执行期间清空缓存时，旧 generation 的写入被跳过', async () => {
    let resolveTranslate;
    const pending = new Promise((resolve) => {
      resolveTranslate = resolve;
    });
    adapter.translate.mockImplementation(() => pending);

    const { client, frames } = connectGateway();
    client.postMessage({
      type: MESSAGE_TYPES.TRANSLATE_BATCH,
      payload: {
        requestId: 'real-generation',
        domain: 'example.com',
        items: [textItem('in flight')],
      },
    });
    await vi.waitFor(() => expect(adapter.translate).toHaveBeenCalledTimes(1));

    // 批次已捕获 generation=0；清空后写入应因代不一致被跳过。
    await storeModule.getCacheStore().clear();
    resolveTranslate({ text: '迟到的译文', usage: null });

    const done = await waitForBatchDoneFor(frames, 'real-generation');

    expect(done.payload).toMatchObject({ ok: true, done: 1 });
    await new Promise((resolve) => setTimeout(resolve, 0));

    const stats = await storeModule.getCacheStore().stats();
    expect(stats.entries).toBe(0);
    expect(stats.bytes).toBe(0);
  });

  it('cacheEnabled=false 时不写真实 store', async () => {
    await settings.saveSettings({ cacheEnabled: false });

    const { client, frames } = connectGateway();
    client.postMessage({
      type: MESSAGE_TYPES.TRANSLATE_BATCH,
      payload: {
        requestId: 'real-disabled',
        domain: 'example.com',
        items: [textItem('disabled cache')],
      },
    });

    const done = await waitForBatchDoneFor(frames, 'real-disabled');

    expect(done.payload).toMatchObject({ ok: true, done: 1 });
    expect(adapter.translate).toHaveBeenCalledTimes(1);

    const stats = await storeModule.getCacheStore().stats();
    expect(stats.entries).toBe(0);
    expect(stats.bytes).toBe(0);
  });
});
