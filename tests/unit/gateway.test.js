/**
 * A2 请求网关测试
 *
 * 用 vi.mock 隔离 A3 上游；只测网关的校验、帧、并发、取消、断线与超时。
 */

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
    translateBatch: vi.fn(),
    TranslateError,
    SUPPORTED_TARGET_LANGS: ['zh'],
    isSupportedTargetLang: (lang) => lang === 'zh',
  };
});

/**
 * 用内存 store 替换 A4，便于控制命中/失败并观察写入参数；
 * 真实 IndexedDB 的网关集成用例在 cache-gateway.test.js。
 */
vi.mock('../../src/shared/cache/store.js', () => {
  const entries = new Map();
  const state = { generation: 0, calls: [] };

  async function readMany(keys) {
    state.calls.push({ method: 'getMany', keys: [...keys] });
    const found = new Map();
    for (const key of keys) {
      const entry = entries.get(key);
      if (entry) found.set(key, entry);
    }
    return found;
  }

  async function writeOne(key, text, options = {}) {
    state.calls.push({ method: 'set', key, text, options });
    if (Number.isFinite(options.generation) && options.generation !== state.generation) {
      return { written: false, bytes: 0 };
    }
    const previous = entries.get(key);
    const bytes = text.length + 256;
    entries.set(key, {
      text,
      bytes,
      createdAt: previous?.createdAt ?? Date.now(),
      domain: previous?.domain || options.domain || '',
    });
    return { written: true, bytes };
  }

  const getMany = vi.fn(readMany);
  const set = vi.fn(writeOne);

  const store = {
    getMany,
    set,
    async get(key) {
      return entries.get(key) ?? null;
    },
    async stats() {
      return { entries: entries.size, bytes: 0, maxBytes: 1024, maxEntries: 10 };
    },
    async clear() {
      const cleared = entries.size;
      entries.clear();
      return { cleared, freedBytes: 0 };
    },
    generation() {
      return state.generation;
    },
    async close() {},
  };

  return {
    getCacheStore: () => store,
    createCacheStore: () => store,
    CACHE_DB_NAME: 'simpletrans-cache',
    __cache: {
      entries,
      state,
      getMany,
      set,
      /** 每个用例前恢复默认实现与空缓存。 */
      reset() {
        entries.clear();
        state.generation = 0;
        state.calls.length = 0;
        getMany.mockReset();
        set.mockReset();
        getMany.mockImplementation(readMany);
        set.mockImplementation(writeOne);
      },
    },
  };
});

import { installChrome } from '../helpers/load.js';
import {
  ERROR_CODES,
  FAILURE_REASONS,
  MESSAGE_TYPES,
  PORT_NAME,
} from '../../src/shared/protocol.js';
import { DEFAULT_MAX_CONCURRENCY } from '../../src/shared/config/registry.js';
import { AI_TIMEOUT_MS, BAIDU_TIMEOUT_MS, MAX_SEGMENT_CHARS, QPS_WINDOW_MS } from '../../src/shared/constants.js';
import {
  createInstance,
  getOrCreateDefaultInstance,
  removeInstance,
  removeKey,
  setActiveInstance,
  setInstanceEnabled,
  updateInstance,
  writeCredentials,
  writeKey,
} from '../../src/shared/config/instances.js';
import { saveSettings } from '../../src/shared/settings.js';
import { initLogging, resetLogging } from '../../src/shared/log/logger.js';
import { buildCacheKey } from '../../src/shared/cache/key.js';
import { buildLLMProfile } from '../../src/shared/translate/openai-profile.js';
import {
  acceptPageSubmit,
  cleanupTab,
  findConnection,
  handleConnect,
  listFrames,
  normalizeConcurrency,
  splitBatches,
} from '../../src/background/gateway.js';
import { translate, translateBatch, TranslateError } from '../../src/shared/translate/adapter.js';
import { BATCH_ENCODING_VERSION, BatchAlignError } from '../../src/shared/translate/batch.js';
import { hashPrompt, PROMPT_VERSION } from '../../src/shared/translate/prompt.js';
import { __cache } from '../../src/shared/cache/store.js';

let clients = [];
let instance;
let promptHash = '';
let currentConn;

function connectGateway() {
  const client = chrome.runtime.connect({ name: PORT_NAME });
  clients.push(client);
  const frames = [];
  client.onMessage.addListener((message) => frames.push(message));
  return { client, frames };
}

function makeDeferred() {
  let resolve;
  let reject;
  const promise = new Promise((res, rej) => {
    resolve = res;
    reject = rej;
  });
  return { promise, resolve, reject };
}

async function waitForBatchDone(frames) {
  await vi.waitFor(
    () => {
      expect(frames.some((frame) => frame.type === MESSAGE_TYPES.BATCH_DONE)).toBe(true);
    },
    { timeout: 1000 }
  );
  return frames.find((frame) => frame.type === MESSAGE_TYPES.BATCH_DONE);
}

/**
 * 等待指定 requestId 的 ST_BATCH_DONE。
 * @param {object[]} frames
 * @param {string} requestId
 */
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
    { timeout: 1000 }
  );
  return frames.find(
    (frame) => frame.type === MESSAGE_TYPES.BATCH_DONE && frame.payload.requestId === requestId
  );
}

/**
 * 按网关参与 key 的字段计算期望 key（与实现同源，但字段值由用例显式给出）。
 * @param {string} text
 * @param {{ context?: string, targetLang?: string }} [overrides]
 */
async function cacheKeyFor(text, overrides = {}) {
  const promptHash = await hashPrompt(instance.systemPrompt);
  const { endpointFingerprint, generationHash } = await buildLLMProfile(instance);
  return buildCacheKey({
    engineType: instance.type,
    endpointFingerprint,
    model: instance.model,
    sourceLang: 'auto',
    targetLang: overrides.targetLang ?? 'zh',
    promptVersion: PROMPT_VERSION,
    promptHash,
    generationHash,
    batchEncodingVersion: BATCH_ENCODING_VERSION,
    text,
  });
}

/**
 * 取某批次的 batch.done 日志数据；日志未初始化或未输出时返回 null。
 * @param {string} requestId
 */
function batchDoneLog(requestId) {
  const lines = console.info.mock.calls.map(([line]) => String(line));
  const line = lines.find((entry) => entry.includes('batch.done') && entry.includes(requestId));
  if (!line) return null;
  return JSON.parse(line.slice(line.indexOf('{'))).data;
}

function textItem(text, itemId = 'i0') {
  return { itemId, text };
}

/** 可被 AbortSignal 取消的待定上游；已取消时立即 reject。 */
function abortableTranslate({ signal }) {
  return new Promise((resolve, reject) => {
    const fail = () => reject(Object.assign(new Error('aborted'), { code: ERROR_CODES.CANCELLED }));
    if (signal?.aborted) {
      fail();
      return;
    }
    signal?.addEventListener('abort', fail, { once: true });
  });
}

beforeEach(async () => {
  installChrome();
  vi.spyOn(console, 'debug').mockImplementation(() => {});
  vi.spyOn(console, 'info').mockImplementation(() => {});
  vi.spyOn(console, 'warn').mockImplementation(() => {});
  initLogging({ level: 'info', sessionId: 'gateway-test' });
  __cache.reset();
  clients = [];
  chrome.runtime.onConnect.addListener((port) => {
    if (port.name === PORT_NAME) currentConn = handleConnect(port);
  });

  translate.mockReset();
  translate.mockImplementation(async ({ text, onDelta }) => {
    onDelta?.(`[${text}]`);
    return { text: `译:${text}`, usage: { totalTokens: 1 } };
  });

  translateBatch.mockReset();
  translateBatch.mockImplementation(async ({ items, onItem }) => {
    for (const item of items) {
      onItem?.({ groupId: item.groupId, text: `译:${item.text}` });
    }
    return { usage: { totalTokens: 2 } };
  });

  instance = await getOrCreateDefaultInstance();
  promptHash = await hashPrompt(instance.systemPrompt);
  await writeKey(instance.id, 'sk-test');
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
  // 让 cleanup 触发的 abort / 微任务跑完，避免把在途名额带到下一个用例。
  await new Promise((resolve) => setTimeout(resolve, 0));
  vi.unstubAllGlobals();
  resetLogging();
  vi.restoreAllMocks();
});

describe('A2 请求网关：连接与心跳', () => {
  it('非 st-gateway 端口或发送方不符时直接断开', () => {
    const wrongNameDisconnect = vi.fn();
    const wrongName = {
      name: 'other',
      sender: { id: chrome.runtime.id },
      disconnect: wrongNameDisconnect,
      onMessage: { addListener: vi.fn() },
      onDisconnect: { addListener: vi.fn() },
    };
    expect(handleConnect(wrongName)).toBeNull();
    expect(wrongNameDisconnect).toHaveBeenCalled();

    const wrongSenderDisconnect = vi.fn();
    const wrongSender = {
      name: PORT_NAME,
      sender: { id: 'other-extension' },
      disconnect: wrongSenderDisconnect,
      onMessage: { addListener: vi.fn() },
      onDisconnect: { addListener: vi.fn() },
    };
    expect(handleConnect(wrongSender)).toBeNull();
    expect(wrongSenderDisconnect).toHaveBeenCalled();
  });

  it('ST_PING 立即回 ST_PONG，随后下发一次日志与内容配置', async () => {
    const { client, frames } = connectGateway();
    client.postMessage({ type: MESSAGE_TYPES.PING, payload: { sentAt: 42 } });

    expect(frames[0].type).toBe(MESSAGE_TYPES.PONG);
    expect(frames[0].payload.sentAt).toBe(42);
    expect(typeof frames[0].payload.receivedAt).toBe('number');

    await vi.waitFor(() => {
      expect(frames.some((frame) => frame.type === MESSAGE_TYPES.LOG_CONFIG)).toBe(true);
      expect(frames.some((frame) => frame.type === MESSAGE_TYPES.CONTENT_CONFIG)).toBe(true);
    });
    const config = frames.find((frame) => frame.type === MESSAGE_TYPES.LOG_CONFIG);
    expect(config.payload.level).toBe('info');
    const contentConfig = frames.find((frame) => frame.type === MESSAGE_TYPES.CONTENT_CONFIG);
    expect(contentConfig.payload.hoverShortcut).toBe('ctrl');
  });

  it('同一连接只下发一次日志与内容配置', async () => {
    const { client, frames } = connectGateway();
    client.postMessage({ type: MESSAGE_TYPES.PING, payload: { sentAt: 1 } });
    client.postMessage({ type: MESSAGE_TYPES.PING, payload: { sentAt: 2 } });

    await vi.waitFor(() => {
      expect(frames.filter((frame) => frame.type === MESSAGE_TYPES.LOG_CONFIG)).toHaveLength(1);
      expect(frames.filter((frame) => frame.type === MESSAGE_TYPES.CONTENT_CONFIG)).toHaveLength(1);
    });
    await new Promise((resolve) => setTimeout(resolve, 0));
    expect(frames.filter((frame) => frame.type === MESSAGE_TYPES.LOG_CONFIG)).toHaveLength(1);
    expect(frames.filter((frame) => frame.type === MESSAGE_TYPES.CONTENT_CONFIG)).toHaveLength(1);
  });

  it('日志级别与悬停快捷键非法时归一为 info / ctrl', async () => {
    await chrome.storage.sync.set({
      settings: { logLevel: 'nope', hoverShortcut: 'Command' },
    });
    const { client, frames } = connectGateway();
    client.postMessage({ type: MESSAGE_TYPES.PING, payload: { sentAt: 3 } });

    await vi.waitFor(() => {
      expect(frames.some((frame) => frame.type === MESSAGE_TYPES.LOG_CONFIG)).toBe(true);
      expect(frames.some((frame) => frame.type === MESSAGE_TYPES.CONTENT_CONFIG)).toBe(true);
    });
    const config = frames.find((frame) => frame.type === MESSAGE_TYPES.LOG_CONFIG);
    expect(config.payload.level).toBe('info');
    const contentConfig = frames.find((frame) => frame.type === MESSAGE_TYPES.CONTENT_CONFIG);
    expect(contentConfig.payload.hoverShortcut).toBe('ctrl');
  });

  it('悬停快捷键配置随连接下发', async () => {
    await chrome.storage.sync.set({ settings: { hoverShortcut: 'alt' } });
    const { client, frames } = connectGateway();
    client.postMessage({ type: MESSAGE_TYPES.PING, payload: { sentAt: 4 } });

    await vi.waitFor(() => {
      expect(frames.some((frame) => frame.type === MESSAGE_TYPES.CONTENT_CONFIG)).toBe(true);
    });
    const contentConfig = frames.find((frame) => frame.type === MESSAGE_TYPES.CONTENT_CONFIG);
    expect(contentConfig.payload.hoverShortcut).toBe('alt');
  });
});

describe('A2 请求网关：批次执行', () => {
  it('单段成功：START → DELTA → DONE → BATCH_DONE', async () => {
    const { client, frames } = connectGateway();
    client.postMessage({
      type: MESSAGE_TYPES.TRANSLATE_BATCH,
      payload: { requestId: 'ok-1', items: [textItem('hello')] },
    });

    const done = await waitForBatchDone(frames);
    expect(frames.map((frame) => frame.type)).toEqual([
      MESSAGE_TYPES.ITEM_START,
      MESSAGE_TYPES.ITEM_DELTA,
      MESSAGE_TYPES.ITEM_DONE,
      MESSAGE_TYPES.BATCH_DONE,
    ]);
    expect(frames[1].payload.delta).toBe('[hello]');
    expect(frames[2].payload.text).toBe('译:hello');
    expect(done.payload).toMatchObject({ ok: true, done: 1, failed: 0, cancelled: 0 });
  });

  it('多段按顺序逐段执行，帧按 requestId/itemId 归属', async () => {
    translate.mockImplementation(async ({ text }) => ({ text: `t:${text}`, usage: null }));
    const { client, frames } = connectGateway();
    client.postMessage({
      type: MESSAGE_TYPES.TRANSLATE_BATCH,
      payload: {
        requestId: 'multi',
        items: [textItem('a', 'i0'), textItem('b', 'i1')],
      },
    });

    const done = await waitForBatchDone(frames);
    expect(done.payload).toMatchObject({ ok: true, done: 2 });
    expect(translate.mock.calls.map(([params]) => params.text)).toEqual(['a', 'b']);
    expect(
      frames.filter((frame) => frame.type === MESSAGE_TYPES.ITEM_START).map((frame) => frame.payload.itemId)
    ).toEqual(['i0', 'i1']);
  });

  it('校验失败整批拒绝且不调用上游', async () => {
    async function reject(payload, reason, code = ERROR_CODES.OTHER) {
      const { client, frames } = connectGateway();
      client.postMessage({ type: MESSAGE_TYPES.TRANSLATE_BATCH, payload });
      const done = await waitForBatchDone(frames);
      expect(done.payload.ok).toBe(false);
      expect(done.payload.error.reason).toBe(reason);
      expect(done.payload.error.code).toBe(code);
    }

    await reject({}, FAILURE_REASONS.INVALID_REQUEST_ID);
    await reject({ requestId: 'r', items: [] }, FAILURE_REASONS.INVALID_ITEMS);
    await reject(
      { requestId: 'r', items: Array.from({ length: 13 }, (_, i) => textItem('x', `i${i}`)) },
      FAILURE_REASONS.INVALID_ITEMS
    );
    await reject(
      { requestId: 'r', items: [textItem('a', 'same'), textItem('b', 'same')] },
      FAILURE_REASONS.DUPLICATE_ITEM_ID
    );
    await reject({ requestId: 'r', items: [textItem('   ')] }, FAILURE_REASONS.EMPTY_TEXT);
    await reject({ requestId: 'r', items: [textItem('x'.repeat(4001))] }, FAILURE_REASONS.TEXT_TOO_LONG);
    await reject(
      {
        requestId: 'r',
        items: [
          textItem('x'.repeat(4000), 'i0'),
          textItem('x'.repeat(4000), 'i1'),
          textItem('x'.repeat(4000), 'i2'),
          textItem('x', 'i3'),
        ],
      },
      FAILURE_REASONS.BATCH_TOO_LARGE
    );
    await reject(
      { requestId: 'r', items: [{ itemId: 'i0', text: 'hi', context: 'x'.repeat(401) }] },
      FAILURE_REASONS.CONTEXT_TOO_LONG
    );
    await reject(
      {
        requestId: 'r',
        context: 'x',
        items: [
          { itemId: 'i0', text: 'a', context: 'x'.repeat(400) },
          { itemId: 'i1', text: 'b', context: 'x'.repeat(400) },
          { itemId: 'i2', text: 'c', context: 'x'.repeat(400) },
        ],
      },
      FAILURE_REASONS.CONTEXT_TOO_LONG
    );
    await reject(
      { requestId: 'r', items: [textItem('hi')], apiKey: 'sk-x' },
      FAILURE_REASONS.FORBIDDEN_FIELD
    );
    await reject(
      { requestId: 'r', items: [textItem('hi')], targetLang: 'fr' },
      FAILURE_REASONS.UNSUPPORTED_LANG
    );

    expect(translate).not.toHaveBeenCalled();
  });

  it('缺密钥整批以 CONFIG 拒绝，不调用上游', async () => {
    await removeKey(instance.id);
    const { client, frames } = connectGateway();
    client.postMessage({
      type: MESSAGE_TYPES.TRANSLATE_BATCH,
      payload: { requestId: 'no-key', items: [textItem('hi')] },
    });

    const done = await waitForBatchDone(frames);
    expect(done.payload.ok).toBe(false);
    expect(done.payload.error.code).toBe(ERROR_CODES.CONFIG);
    expect(translate).not.toHaveBeenCalled();
  });

  it('没有实例时整批 CONFIG，且网关不创建实例、不写 storage', async () => {
    await chrome.storage.sync.remove('engineInstances');
    const syncSet = vi.spyOn(chrome.storage.sync, 'set');

    const { client, frames } = connectGateway();
    client.postMessage({
      type: MESSAGE_TYPES.TRANSLATE_BATCH,
      payload: { requestId: 'no-instance', items: [textItem('hi')] },
    });

    const done = await waitForBatchDone(frames);
    expect(done.payload.ok).toBe(false);
    expect(done.payload.error.code).toBe(ERROR_CODES.CONFIG);
    expect(syncSet).not.toHaveBeenCalled();
    expect(translate).not.toHaveBeenCalled();
  });

  it('同端口在途批次重名被拒绝', async () => {
    const deferred = makeDeferred();
    translate.mockImplementation(() => deferred.promise);
    const { client, frames } = connectGateway();
    const payload = { requestId: 'dup', items: [textItem('hi')] };

    client.postMessage({ type: MESSAGE_TYPES.TRANSLATE_BATCH, payload });
    await vi.waitFor(() => expect(translate).toHaveBeenCalledTimes(1));
    client.postMessage({ type: MESSAGE_TYPES.TRANSLATE_BATCH, payload });

    await vi.waitFor(() => {
      expect(
        frames.some(
          (frame) =>
            frame.type === MESSAGE_TYPES.BATCH_DONE &&
            frame.payload.error?.reason === FAILURE_REASONS.DUPLICATE_REQUEST
        )
      ).toBe(true);
    });

    deferred.resolve({ text: 'ok', usage: null });
    await vi.waitFor(() => {
      expect(frames.filter((frame) => frame.type === MESSAGE_TYPES.BATCH_DONE)).toHaveLength(2);
    });
  });

  it('每端口在途批次超过 4 时立即拒绝', async () => {
    translate.mockImplementation(abortableTranslate);

    const { client, frames } = connectGateway();
    const conn = currentConn;
    for (let i = 0; i < 4; i += 1) {
      client.postMessage({
        type: MESSAGE_TYPES.TRANSLATE_BATCH,
        payload: { requestId: `batch-${i}`, items: [textItem('hi', `i${i}`)] },
      });
    }
    await vi.waitFor(() => expect(conn.batches.size).toBe(4));
    await vi.waitFor(() => expect(translate).toHaveBeenCalled());

    client.postMessage({
      type: MESSAGE_TYPES.TRANSLATE_BATCH,
      payload: { requestId: 'batch-4', items: [textItem('hi', 'i4')] },
    });
    await vi.waitFor(() => {
      expect(
        frames.some(
          (frame) =>
            frame.type === MESSAGE_TYPES.BATCH_DONE &&
            frame.payload.error?.reason === FAILURE_REASONS.TOO_MANY_INFLIGHT
        )
      ).toBe(true);
    });
  });

  it('全局并发不超过实例最大并发数', async () => {
    await updateInstance(instance.id, { maxConcurrency: 3 });
    translate.mockImplementation(abortableTranslate);

    const ports = Array.from({ length: 4 }, () => connectGateway());
    for (let i = 0; i < 4; i += 1) {
      ports[i].client.postMessage({
        type: MESSAGE_TYPES.TRANSLATE_BATCH,
        payload: { requestId: `limit-${i}`, items: [textItem('hi', `i${i}`)] },
      });
    }

    await vi.waitFor(() => expect(translate).toHaveBeenCalledTimes(3));
    await new Promise((resolve) => setTimeout(resolve, 20));
    expect(translate).toHaveBeenCalledTimes(3);
  });
});

describe('A2 请求网关：译文缓存', () => {
  it('未命中时调用上游，并在定稿后写入缓存', async () => {
    const defaultSet = __cache.set.getMockImplementation();
    const { client, frames } = connectGateway();
    let framesAtWrite = null;
    __cache.set.mockImplementation(async (...args) => {
      framesAtWrite = frames.map((frame) => frame.type);
      return defaultSet(...args);
    });

    client.postMessage({
      type: MESSAGE_TYPES.TRANSLATE_BATCH,
      payload: {
        requestId: 'cache-miss',
        domain: '  Example.COM.  ',
        items: [textItem('Hello cache')],
      },
    });

    const done = await waitForBatchDoneFor(frames, 'cache-miss');

    expect(done.payload).toMatchObject({ ok: true, done: 1, failed: 0, cancelled: 0 });
    expect(translate).toHaveBeenCalledTimes(1);
    expect(frames.map((frame) => frame.type)).toEqual([
      MESSAGE_TYPES.ITEM_START,
      MESSAGE_TYPES.ITEM_DELTA,
      MESSAGE_TYPES.ITEM_DONE,
      MESSAGE_TYPES.BATCH_DONE,
    ]);

    // 写入在 ST_ITEM_DONE 之后发起，不阻塞定稿帧。
    expect(framesAtWrite).toContain(MESSAGE_TYPES.ITEM_DONE);
    expect(framesAtWrite.indexOf(MESSAGE_TYPES.ITEM_START)).toBeLessThan(
      framesAtWrite.indexOf(MESSAGE_TYPES.ITEM_DONE)
    );

    expect(__cache.set).toHaveBeenCalledTimes(1);
    const [key, text, options] = __cache.set.mock.calls[0];
    expect(text).toBe('译:Hello cache');
    expect(key).toMatch(/^cache:v3:[0-9a-f]{64}$/);
    expect(key).toBe(await cacheKeyFor('Hello cache'));
    expect(options.generation).toBe(0);
    expect(options.domain).toBe('example.com');
    expect(__cache.entries.get(key)).toMatchObject({
      text: '译:Hello cache',
      domain: 'example.com',
    });

    const log = batchDoneLog('cache-miss');
    expect(log).toMatchObject({ cacheHits: 0, cacheMisses: 1, cacheWrites: 1 });
  });

  it('修改提示词或生成参数后同一文本不再命中缓存', async () => {
    const text = 'styled paragraph';
    const { client, frames } = connectGateway();

    client.postMessage({
      type: MESSAGE_TYPES.TRANSLATE_BATCH,
      payload: { requestId: 'style-1', items: [textItem(text)] },
    });
    await waitForBatchDoneFor(frames, 'style-1');
    expect(translate).toHaveBeenCalledTimes(1);

    await updateInstance(instance.id, {
      systemPrompt: '自定义 {{targetLang}} {{outputFormat}}',
    });

    frames.length = 0;
    client.postMessage({
      type: MESSAGE_TYPES.TRANSLATE_BATCH,
      payload: { requestId: 'style-2', items: [textItem(text)] },
    });
    await waitForBatchDoneFor(frames, 'style-2');
    expect(translate).toHaveBeenCalledTimes(2);
    expect(batchDoneLog('style-2')).toMatchObject({ cacheHits: 0, cacheMisses: 1 });

    await updateInstance(instance.id, {
      params: {
        ...instance.params,
        temperature: { enabled: true, value: 0.3 },
      },
    });

    frames.length = 0;
    client.postMessage({
      type: MESSAGE_TYPES.TRANSLATE_BATCH,
      payload: { requestId: 'style-3', items: [textItem(text)] },
    });
    await waitForBatchDoneFor(frames, 'style-3');
    expect(translate).toHaveBeenCalledTimes(3);
    expect(batchDoneLog('style-3')).toMatchObject({ cacheHits: 0, cacheMisses: 1 });
  });

  it('缓存写入失败只记日志，不改变翻译结果', async () => {
    __cache.set.mockRejectedValueOnce(new Error('quota exceeded'));
    const { client, frames } = connectGateway();
    client.postMessage({
      type: MESSAGE_TYPES.TRANSLATE_BATCH,
      payload: { requestId: 'cache-write-fail', items: [textItem('write fails')] },
    });

    const done = await waitForBatchDoneFor(frames, 'cache-write-fail');

    expect(done.payload).toMatchObject({ ok: true, done: 1, failed: 0, cancelled: 0 });
    expect(translate).toHaveBeenCalledTimes(1);
    expect(frames.map((frame) => frame.type)).toEqual([
      MESSAGE_TYPES.ITEM_START,
      MESSAGE_TYPES.ITEM_DELTA,
      MESSAGE_TYPES.ITEM_DONE,
      MESSAGE_TYPES.BATCH_DONE,
    ]);
    expect(frames[2].payload.text).toBe('译:write fails');
    expect(__cache.set).toHaveBeenCalledTimes(1);
    // cacheWrites 是「尝试写入次数」：实际写入失败仍计 1。
    expect(batchDoneLog('cache-write-fail')).toMatchObject({
      cacheMisses: 1,
      cacheWrites: 1,
    });
  });

  it('命中时发 START→DONE，不调用上游、不发增量、usage 为 null', async () => {
    const { client, frames } = connectGateway();
    client.postMessage({
      type: MESSAGE_TYPES.TRANSLATE_BATCH,
      payload: { requestId: 'cache-seed', items: [textItem('cache me')] },
    });
    await waitForBatchDoneFor(frames, 'cache-seed');
    expect(__cache.set).toHaveBeenCalledTimes(1);

    const seedKey = __cache.set.mock.calls[0][0];
    expect(__cache.getMany.mock.calls[0][0]).toEqual([seedKey]);

    frames.length = 0;
    client.postMessage({
      type: MESSAGE_TYPES.TRANSLATE_BATCH,
      payload: { requestId: 'cache-hit', items: [textItem('cache me')] },
    });
    const done = await waitForBatchDoneFor(frames, 'cache-hit');

    expect(done.payload).toMatchObject({ ok: true, done: 1, failed: 0, cancelled: 0 });
    expect(translate).toHaveBeenCalledTimes(1);
    expect(frames.map((frame) => frame.type)).toEqual([
      MESSAGE_TYPES.ITEM_START,
      MESSAGE_TYPES.ITEM_DONE,
      MESSAGE_TYPES.BATCH_DONE,
    ]);
    expect(frames[1].payload).toMatchObject({
      requestId: 'cache-hit',
      itemId: 'i0',
      text: '译:cache me',
      usage: null,
    });
    expect(__cache.getMany).toHaveBeenCalledTimes(2);
    expect(__cache.getMany.mock.calls[1][0]).toEqual([seedKey]);
    expect(__cache.set).toHaveBeenCalledTimes(1);
    expect(batchDoneLog('cache-hit')).toMatchObject({
      cacheHits: 1,
      cacheMisses: 0,
      cacheWrites: 0,
    });
  });

  it('debug 级别记录 cache.miss / cache.write / cache.hit', async () => {
    initLogging({ level: 'debug', sessionId: 'gateway-test' });
    const { client, frames } = connectGateway();
    client.postMessage({
      type: MESSAGE_TYPES.TRANSLATE_BATCH,
      payload: { requestId: 'log-seed', items: [textItem('log me')] },
    });
    await waitForBatchDoneFor(frames, 'log-seed');
    await vi.waitFor(() => {
      const lines = console.debug.mock.calls.map(([line]) => String(line));
      expect(lines.some((line) => line.includes('cache.write') && line.includes('log-seed'))).toBe(
        true
      );
    });

    frames.length = 0;
    client.postMessage({
      type: MESSAGE_TYPES.TRANSLATE_BATCH,
      payload: { requestId: 'log-hit', items: [textItem('log me')] },
    });
    await waitForBatchDoneFor(frames, 'log-hit');

    const lines = console.debug.mock.calls.map(([line]) => String(line));
    expect(lines.some((line) => line.includes('cache.miss') && line.includes('log-seed'))).toBe(
      true
    );
    expect(lines.some((line) => line.includes('cache.write') && line.includes('log-seed'))).toBe(
      true
    );
    expect(lines.some((line) => line.includes('cache.hit') && line.includes('log-hit'))).toBe(
      true
    );
    // 日志不出现原文、域名与 key 哈希。
    expect(lines.join('\n')).not.toContain('log me');
    expect(lines.join('\n')).not.toContain('cache:v3:');
  });

  it('命中不占用上游并发名额', async () => {
    await updateInstance(instance.id, { maxConcurrency: 1 });
    const cachedText = 'cached paragraph';
    const key = await cacheKeyFor(cachedText);
    __cache.entries.set(key, { text: '缓存译文', bytes: 300, createdAt: Date.now() });
    translate.mockImplementation(abortableTranslate);

    const blocker = connectGateway();
    blocker.client.postMessage({
      type: MESSAGE_TYPES.TRANSLATE_BATCH,
      payload: { requestId: 'slot-blocker', items: [textItem('blocking')] },
    });
    await vi.waitFor(() => expect(translate).toHaveBeenCalledTimes(1));

    const cached = connectGateway();
    cached.client.postMessage({
      type: MESSAGE_TYPES.TRANSLATE_BATCH,
      payload: { requestId: 'slot-hit', items: [textItem(cachedText)] },
    });
    const done = await waitForBatchDoneFor(cached.frames, 'slot-hit');

    expect(done.payload).toMatchObject({ ok: true, done: 1 });
    expect(cached.frames.map((frame) => frame.type)).toEqual([
      MESSAGE_TYPES.ITEM_START,
      MESSAGE_TYPES.ITEM_DONE,
      MESSAGE_TYPES.BATCH_DONE,
    ]);
    expect(cached.frames[1].payload.text).toBe('缓存译文');
    // 只阻塞批占用了槽位；命中批没有新增上游调用。
    expect(translate).toHaveBeenCalledTimes(1);
  });

  it('A3 失败不写缓存，batch.done 仍计入未命中', async () => {
    translate.mockRejectedValue(new TranslateError(ERROR_CODES.AUTH, '密钥无效或鉴权失败'));
    const { client, frames } = connectGateway();
    client.postMessage({
      type: MESSAGE_TYPES.TRANSLATE_BATCH,
      payload: { requestId: 'cache-fail', items: [textItem('fail me')] },
    });

    const done = await waitForBatchDoneFor(frames, 'cache-fail');

    expect(done.payload).toMatchObject({ ok: false, done: 0, failed: 1 });
    expect(frames.find((frame) => frame.type === MESSAGE_TYPES.ITEM_ERROR).payload.code).toBe(
      ERROR_CODES.AUTH
    );
    expect(__cache.set).not.toHaveBeenCalled();
    expect(batchDoneLog('cache-fail')).toMatchObject({
      cacheHits: 0,
      cacheMisses: 1,
      cacheWrites: 0,
    });
  });

  it('加载中取消不写缓存', async () => {
    translate.mockImplementation(abortableTranslate);
    const { client, frames } = connectGateway();
    client.postMessage({
      type: MESSAGE_TYPES.TRANSLATE_BATCH,
      payload: { requestId: 'cache-cancel', items: [textItem('cancel me')] },
    });
    await vi.waitFor(() => expect(translate).toHaveBeenCalledTimes(1));

    client.postMessage({
      type: MESSAGE_TYPES.CANCEL_BATCH,
      payload: { requestId: 'cache-cancel' },
    });
    const done = await waitForBatchDoneFor(frames, 'cache-cancel');

    expect(done.payload).toMatchObject({ ok: false, done: 0, cancelled: 1 });
    expect(__cache.set).not.toHaveBeenCalled();
    expect(batchDoneLog('cache-cancel')).toMatchObject({ cacheWrites: 0 });
  });

  it('批超时不写缓存', async () => {
    vi.useFakeTimers();
    try {
      translate.mockImplementation(abortableTranslate);
      const { client, frames } = connectGateway();
      client.postMessage({
        type: MESSAGE_TYPES.TRANSLATE_BATCH,
        payload: { requestId: 'cache-timeout', items: [textItem('slow')] },
      });

      await vi.waitFor(() => expect(translate).toHaveBeenCalledTimes(1));
      await vi.advanceTimersByTimeAsync(180_000);
      await vi.waitFor(() => {
        expect(
          frames.some((frame) => frame.type === MESSAGE_TYPES.BATCH_DONE)
        ).toBe(true);
      });

      const error = frames.find((frame) => frame.type === MESSAGE_TYPES.ITEM_ERROR);
      expect(error.payload.code).toBe(ERROR_CODES.NETWORK);
      expect(error.payload.reason).toBe(FAILURE_REASONS.BATCH_TIMEOUT);
      expect(__cache.set).not.toHaveBeenCalled();
      expect(batchDoneLog('cache-timeout')).toMatchObject({ cacheWrites: 0 });
    } finally {
      vi.useRealTimers();
    }
  });

  it('A3 返回空译文时不写缓存', async () => {
    translate.mockResolvedValue({ text: '   ', usage: null });
    const { client, frames } = connectGateway();
    client.postMessage({
      type: MESSAGE_TYPES.TRANSLATE_BATCH,
      payload: { requestId: 'cache-empty', items: [textItem('empty result')] },
    });

    const done = await waitForBatchDoneFor(frames, 'cache-empty');

    expect(done.payload).toMatchObject({ ok: true, done: 1 });
    expect(__cache.set).not.toHaveBeenCalled();
    expect(batchDoneLog('cache-empty')).toMatchObject({
      cacheMisses: 1,
      cacheWrites: 0,
    });
  });

  it('cacheEnabled=false 时不做 key 计算、不读不写缓存', async () => {
    await saveSettings({ cacheEnabled: false });
    const digest = vi.spyOn(globalThis.crypto.subtle, 'digest');
    const { client, frames } = connectGateway();
    client.postMessage({
      type: MESSAGE_TYPES.TRANSLATE_BATCH,
      payload: { requestId: 'cache-off', items: [textItem('no cache')] },
    });

    const done = await waitForBatchDoneFor(frames, 'cache-off');

    expect(done.payload).toMatchObject({ ok: true, done: 1 });
    expect(translate).toHaveBeenCalledTimes(1);
    expect(digest).not.toHaveBeenCalled();
    expect(__cache.getMany).not.toHaveBeenCalled();
    expect(__cache.set).not.toHaveBeenCalled();
    expect(batchDoneLog('cache-off')).toMatchObject({
      cacheHits: 0,
      cacheMisses: 0,
      cacheWrites: 0,
    });
  });

  it('缓存读取异常按未命中处理，仍调用上游并尝试写入', async () => {
    __cache.getMany.mockRejectedValueOnce(new Error('IndexedDB read failed'));
    const { client, frames } = connectGateway();
    client.postMessage({
      type: MESSAGE_TYPES.TRANSLATE_BATCH,
      payload: { requestId: 'cache-read-error', items: [textItem('read failed')] },
    });

    const done = await waitForBatchDoneFor(frames, 'cache-read-error');

    expect(done.payload).toMatchObject({ ok: true, done: 1 });
    expect(translate).toHaveBeenCalledTimes(1);
    expect(__cache.set).toHaveBeenCalledTimes(1);
    expect(batchDoneLog('cache-read-error')).toMatchObject({
      cacheHits: 0,
      cacheMisses: 1,
      cacheWrites: 1,
    });
  });

  it('缓存 key 计算失败时本批不参与缓存，翻译继续', async () => {
    // 模拟运行环境没有 crypto.subtle：buildCacheKey 抛错，网关应降级为全部未命中且不写。
    vi.stubGlobal('crypto', {});
    const { client, frames } = connectGateway();
    client.postMessage({
      type: MESSAGE_TYPES.TRANSLATE_BATCH,
      payload: { requestId: 'cache-key-error', items: [textItem('no crypto')] },
    });

    const done = await waitForBatchDoneFor(frames, 'cache-key-error');

    expect(done.payload).toMatchObject({ ok: true, done: 1 });
    expect(translate).toHaveBeenCalledTimes(1);
    expect(frames.map((frame) => frame.type)).toEqual([
      MESSAGE_TYPES.ITEM_START,
      MESSAGE_TYPES.ITEM_DELTA,
      MESSAGE_TYPES.ITEM_DONE,
      MESSAGE_TYPES.BATCH_DONE,
    ]);
    expect(__cache.getMany).not.toHaveBeenCalled();
    expect(__cache.set).not.toHaveBeenCalled();
    expect(batchDoneLog('cache-key-error')).toMatchObject({
      cacheHits: 0,
      cacheMisses: 0,
      cacheWrites: 0,
    });
  });

  it('domain 缺失或非法时写空串，合法值归一后写入', async () => {
    const { client, frames } = connectGateway();
    const cases = [
      { requestId: 'domain-missing', text: 'domain missing', expected: '' },
      {
        requestId: 'domain-invalid',
        text: 'domain invalid',
        domain: 'https://example.com/path?q=1',
        expected: '',
      },
      {
        requestId: 'domain-valid',
        text: 'domain valid',
        domain: '  Example.COM.  ',
        expected: 'example.com',
      },
    ];

    for (let index = 0; index < cases.length; index += 1) {
      const entry = cases[index];
      const payload = { requestId: entry.requestId, items: [textItem(entry.text)] };
      if (entry.domain !== undefined) payload.domain = entry.domain;
      client.postMessage({ type: MESSAGE_TYPES.TRANSLATE_BATCH, payload });

      await waitForBatchDoneFor(frames, entry.requestId);
      await vi.waitFor(() => expect(__cache.set).toHaveBeenCalledTimes(index + 1));

      const call = __cache.set.mock.calls.find(
        ([, text]) => text === `译:${entry.text}`
      );
      expect(call[2].domain, entry.requestId).toBe(entry.expected);
    }
  });

  it('同文本不同域名的两次请求命中同一 key，保留首次域名', async () => {
    const { client, frames } = connectGateway();
    client.postMessage({
      type: MESSAGE_TYPES.TRANSLATE_BATCH,
      payload: {
        requestId: 'domain-seed',
        domain: 'first.example.com',
        items: [textItem('shared text')],
      },
    });
    await waitForBatchDoneFor(frames, 'domain-seed');

    const seedKey = __cache.set.mock.calls[0][0];
    expect(__cache.entries.get(seedKey).domain).toBe('first.example.com');

    frames.length = 0;
    client.postMessage({
      type: MESSAGE_TYPES.TRANSLATE_BATCH,
      payload: {
        requestId: 'domain-other',
        domain: 'second.example.com',
        items: [textItem('shared text')],
      },
    });
    const done = await waitForBatchDoneFor(frames, 'domain-other');

    expect(done.payload).toMatchObject({ ok: true, done: 1 });
    expect(translate).toHaveBeenCalledTimes(1);
    expect(__cache.getMany.mock.calls[1][0]).toEqual([seedKey]);
    expect(__cache.set).toHaveBeenCalledTimes(1);
    expect(__cache.entries.size).toBe(1);
    expect(__cache.entries.get(seedKey).domain).toBe('first.example.com');
    expect(batchDoneLog('domain-other')).toMatchObject({
      cacheHits: 1,
      cacheMisses: 0,
      cacheWrites: 0,
    });
  });

  it('batch.done 的 cacheHits/cacheMisses/cacheWrites 与实际一致', async () => {
    const hitKey = await cacheKeyFor('cached item');
    __cache.entries.set(hitKey, { text: '来自缓存', bytes: 300, createdAt: Date.now() });

    const { client, frames } = connectGateway();
    client.postMessage({
      type: MESSAGE_TYPES.TRANSLATE_BATCH,
      payload: {
        requestId: 'cache-counts',
        items: [textItem('cached item', 'i0'), textItem('fresh item', 'i1')],
      },
    });

    const done = await waitForBatchDoneFor(frames, 'cache-counts');

    expect(done.payload).toMatchObject({ ok: true, done: 2, failed: 0, cancelled: 0 });
    expect(translate).toHaveBeenCalledTimes(1);
    expect(translate.mock.calls[0][0].text).toBe('fresh item');
    expect(
      frames
        .filter((frame) => frame.type === MESSAGE_TYPES.ITEM_START)
        .map((frame) => frame.payload.itemId)
    ).toEqual(['i0', 'i1']);
    expect(
      frames
        .filter((frame) => frame.type === MESSAGE_TYPES.ITEM_DELTA)
        .map((frame) => frame.payload.itemId)
    ).toEqual(['i1']);
    expect(batchDoneLog('cache-counts')).toMatchObject({
      cacheHits: 1,
      cacheMisses: 1,
      cacheWrites: 1,
      done: 2,
      failed: 0,
      cancelled: 0,
    });
    expect(__cache.set).toHaveBeenCalledTimes(1);
    expect(__cache.set.mock.calls[0][0]).toBe(await cacheKeyFor('fresh item'));
  });

  it('命中仍要求已配置密钥：缺密钥整批拒绝且不读缓存', async () => {
    const key = await cacheKeyFor('needs key');
    __cache.entries.set(key, { text: '来自缓存', bytes: 300, createdAt: Date.now() });
    await removeKey(instance.id);

    const { client, frames } = connectGateway();
    client.postMessage({
      type: MESSAGE_TYPES.TRANSLATE_BATCH,
      payload: { requestId: 'cache-no-key', items: [textItem('needs key')] },
    });

    const done = await waitForBatchDoneFor(frames, 'cache-no-key');

    expect(done.payload.ok).toBe(false);
    expect(done.payload.error.code).toBe(ERROR_CODES.CONFIG);
    expect(frames).toHaveLength(1);
    expect(translate).not.toHaveBeenCalled();
    expect(__cache.getMany).not.toHaveBeenCalled();
    expect(__cache.set).not.toHaveBeenCalled();
  });
});

describe('A2 请求网关：取消、断线与超时', () => {
  it('ST_CANCEL_BATCH 中止在途段并结束整批', async () => {
    translate.mockImplementation(abortableTranslate);
    const { client, frames } = connectGateway();
    client.postMessage({
      type: MESSAGE_TYPES.TRANSLATE_BATCH,
      payload: { requestId: 'cancel', items: [textItem('long text')] },
    });
    await vi.waitFor(() => expect(translate).toHaveBeenCalledTimes(1));

    client.postMessage({ type: MESSAGE_TYPES.CANCEL_BATCH, payload: { requestId: 'cancel' } });
    const done = await waitForBatchDone(frames);

    expect(done.payload).toMatchObject({ ok: false, done: 0, failed: 0, cancelled: 1 });
    expect(frames.filter((frame) => frame.type === MESSAGE_TYPES.ITEM_ERROR)).toHaveLength(1);
    expect(frames.find((frame) => frame.type === MESSAGE_TYPES.ITEM_ERROR).payload.code).toBe(
      ERROR_CODES.CANCELLED
    );
  });

  it('取消排队中的段不发帧，剩余段继续执行', async () => {
    const deferred = makeDeferred();
    translate.mockImplementation(({ text }) =>
      text === 'first' ? deferred.promise : Promise.resolve({ text: 'second-done', usage: null })
    );
    const { client, frames } = connectGateway();
    client.postMessage({
      type: MESSAGE_TYPES.TRANSLATE_BATCH,
      payload: {
        requestId: 'cancel-item',
        items: [textItem('first', 'i0'), textItem('second', 'i1')],
      },
    });
    await vi.waitFor(() => expect(translate).toHaveBeenCalledTimes(1));

    client.postMessage({
      type: MESSAGE_TYPES.CANCEL_ITEM,
      payload: { requestId: 'cancel-item', itemId: 'i1' },
    });
    deferred.resolve({ text: 'first-done', usage: null });

    const done = await waitForBatchDone(frames);
    expect(done.payload).toMatchObject({ ok: false, done: 1, cancelled: 1 });
    expect(
      frames.some(
        (frame) => frame.type === MESSAGE_TYPES.ITEM_START && frame.payload.itemId === 'i1'
      )
    ).toBe(false);
  });

  it('端口断开时中止在途请求并清空批次', async () => {
    let capturedSignal;
    translate.mockImplementation((params) => {
      capturedSignal = params.signal;
      return abortableTranslate(params);
    });
    const { client } = connectGateway();
    client.postMessage({
      type: MESSAGE_TYPES.TRANSLATE_BATCH,
      payload: { requestId: 'disconnect', items: [textItem('hi')] },
    });
    await vi.waitFor(() => expect(translate).toHaveBeenCalledTimes(1));

    client.disconnect();
    await vi.waitFor(() => expect(capturedSignal.aborted).toBe(true));
    await new Promise((resolve) => setTimeout(resolve, 0));
  });

  it('批总时长超过 180 秒时剩余段以 NETWORK/BATCH_TIMEOUT 结算', async () => {
    vi.useFakeTimers();
    try {
      translate.mockImplementation(abortableTranslate);
      const { client, frames } = connectGateway();
      client.postMessage({
        type: MESSAGE_TYPES.TRANSLATE_BATCH,
        payload: {
          requestId: 'timeout',
          items: [textItem('a', 'i0'), textItem('b', 'i1')],
        },
      });

      // 先让 beginBatch 的异步校验、缓存查询与首段启动跑完，再推进批超时。
      await vi.waitFor(() => expect(translate).toHaveBeenCalledTimes(1));
      await vi.advanceTimersByTimeAsync(180_000);
      await vi.waitFor(() => {
        expect(
          frames.filter((frame) => frame.type === MESSAGE_TYPES.ITEM_ERROR).length
        ).toBeGreaterThan(0);
      });

      const done = frames.find((frame) => frame.type === MESSAGE_TYPES.BATCH_DONE);
      expect(done.payload.ok).toBe(false);
      expect(done.payload.failed).toBeGreaterThan(0);
      const firstError = frames.find((frame) => frame.type === MESSAGE_TYPES.ITEM_ERROR);
      expect(firstError.payload.code).toBe(ERROR_CODES.NETWORK);
      expect(firstError.payload.reason).toBe(FAILURE_REASONS.BATCH_TIMEOUT);
    } finally {
      vi.useRealTimers();
    }
  });
});

describe('A2 请求网关：边界与并发入口', () => {
  it('网关执行批次期间不写 storage', async () => {
    const syncSet = vi.spyOn(chrome.storage.sync, 'set');
    const localSet = vi.spyOn(chrome.storage.local, 'set');
    const sessionSet = vi.spyOn(chrome.storage.session, 'set');

    const { client, frames } = connectGateway();
    client.postMessage({
      type: MESSAGE_TYPES.TRANSLATE_BATCH,
      payload: { requestId: 'no-write', items: [textItem('hi')] },
    });
    await waitForBatchDone(frames);

    expect(syncSet).not.toHaveBeenCalled();
    expect(localSet).not.toHaveBeenCalled();
    expect(sessionSet).not.toHaveBeenCalled();
  });

  it('normalizeConcurrency 只接受正整数，非法值回退默认 4，不设固定上限', () => {
    expect(normalizeConcurrency(0)).toBe(DEFAULT_MAX_CONCURRENCY);
    expect(normalizeConcurrency('nope')).toBe(DEFAULT_MAX_CONCURRENCY);
    expect(normalizeConcurrency(2)).toBe(2);
    expect(normalizeConcurrency(2.7)).toBe(2);
    expect(normalizeConcurrency(9)).toBe(9);
  });
});

describe('A2 页面提交：缓存、分组与切批', () => {
  /**
   * 以页面注入的 sender 建立 st-gateway 连接（带 tab.id），用于接收一次性提交的结果帧。
   * @param {number} [tabId]
   */
  function connectPage(tabId = 7) {
    const client = chrome.runtime.connect({
      name: PORT_NAME,
      sender: { id: chrome.runtime.id, tab: { id: tabId } },
    });
    clients.push(client);
    const frames = [];
    client.onMessage.addListener((message) => frames.push(message));
    return { client, frames };
  }

  /**
   * @param {Array<{ hostId?: string, text: string }>} paragraphs
   * @param {{ requestId?: string, tabId?: number, targetLang?: string, domain?: string }} [options]
   */
  function submitPage(paragraphs, options = {}) {
    return acceptPageSubmit({
      requestId: options.requestId ?? 's-1',
      traceId: options.traceId,
      scope: options.scope ?? 'page',
      targetLang: options.targetLang,
      domain: options.domain,
      paragraphs,
      tabId: options.tabId ?? 7,
    });
  }

  it('找不到页面连接时拒绝提交，不查缓存、不调用上游', async () => {
    const result = await submitPage([{ hostId: 'h1', text: 'Hello' }], { tabId: 99 });

    expect(result.accepted).toBe(false);
    expect(result.error.code).toBe(ERROR_CODES.NETWORK);
    expect(result.error.reason).toBe(FAILURE_REASONS.NOT_CONNECTED);
    expect(__cache.getMany).not.toHaveBeenCalled();
    expect(translate).not.toHaveBeenCalled();
  });

  it('命中项立即回显 START→DONE（usage null），未命中项才走上游；一次 getMany', async () => {
    const hitKey = await cacheKeyFor('Hello');
    __cache.entries.set(hitKey, {
      text: '你好',
      bytes: 6,
      createdAt: Date.now(),
      domain: '',
    });
    const { frames } = connectPage();

    const result = await submitPage([
      { hostId: 'h1', text: 'Hello' },
      { hostId: 'h2', text: 'World' },
    ]);

    expect(result.accepted).toBe(true);
    // 命中帧在回执返回前已发出，页面会先收到 START → DONE。
    const hitStart = frames.find(
      (frame) => frame.type === MESSAGE_TYPES.ITEM_START && frame.payload.itemId === 'h1'
    );
    const hitDone = frames.find(
      (frame) => frame.type === MESSAGE_TYPES.ITEM_DONE && frame.payload.itemId === 'h1'
    );
    expect(hitStart).toBeTruthy();
    expect(hitDone.payload).toMatchObject({ text: '你好', usage: null });
    expect(__cache.getMany).toHaveBeenCalledTimes(1);
    expect(__cache.getMany.mock.calls[0][0]).toHaveLength(2);

    await waitForBatchDone(frames);
    const missDone = frames.find(
      (frame) => frame.type === MESSAGE_TYPES.ITEM_DONE && frame.payload.itemId === 'h2'
    );
    expect(missDone.payload.text).toBe('译:World');
    expect(missDone.payload.usage).toEqual({ totalTokens: 1 });
    expect(translate).toHaveBeenCalledTimes(1);
    expect(batchDoneLog('s-1')).toMatchObject({
      done: 2,
      failed: 0,
      cacheHits: 1,
      cacheMisses: 1,
      uniqueGroups: 2,
    });
  });

  it('命中 hit-only 提交不写缓存、不占用上游名额', async () => {
    const key = await cacheKeyFor('Hello');
    __cache.entries.set(key, { text: '你好', bytes: 6, createdAt: Date.now(), domain: '' });
    const { frames } = connectPage();

    await submitPage([{ hostId: 'h1', text: 'Hello' }]);
    await waitForBatchDone(frames);

    expect(translate).not.toHaveBeenCalled();
    expect(__cache.set).not.toHaveBeenCalled();
    expect(batchDoneLog('s-1')).toMatchObject({ done: 1, cacheWrites: 0 });
  });

  it('同提交同 key 只执行一次，全部 item 都收到 DONE 并各占一个计数', async () => {
    const { frames } = connectPage();

    await submitPage([
      { hostId: 'h1', text: 'Same' },
      { hostId: 'h2', text: 'Same' },
    ]);
    await waitForBatchDone(frames);

    expect(translate).toHaveBeenCalledTimes(1);
    expect(frames.filter((frame) => frame.type === MESSAGE_TYPES.ITEM_START)).toHaveLength(2);
    expect(frames.filter((frame) => frame.type === MESSAGE_TYPES.ITEM_DONE)).toHaveLength(2);
    expect(batchDoneLog('s-1')).toMatchObject({
      done: 2,
      uniqueGroups: 1,
      batches: 1,
      dedupeHits: 1,
      cacheWrites: 1,
    });
    // 成功定稿后按 group 只写一次缓存。
    expect(__cache.set).toHaveBeenCalledTimes(1);
  });

  it('缓存关闭时仍按 key 合并与执行，但不读不写缓存', async () => {
    await saveSettings({ cacheEnabled: false });
    const { frames } = connectPage();

    await submitPage([
      { hostId: 'h1', text: 'Same' },
      { hostId: 'h2', text: 'Same' },
    ]);
    await waitForBatchDone(frames);

    expect(translate).toHaveBeenCalledTimes(1);
    expect(__cache.getMany).not.toHaveBeenCalled();
    expect(__cache.set).not.toHaveBeenCalled();
    expect(frames.filter((frame) => frame.type === MESSAGE_TYPES.ITEM_DONE)).toHaveLength(2);
    expect(batchDoneLog('s-1')).toMatchObject({ cacheHits: 0, cacheWrites: 0 });
  });

  it('跨提交同 key 只执行一次上游，结果 fan-out 给两个提交，usage 只归 owner', async () => {
    const deferred = makeDeferred();
    translate.mockImplementation(() => deferred.promise);
    const { frames } = connectPage();

    const first = await submitPage([{ hostId: 'h1', text: 'Shared' }], { requestId: 's-a' });
    const second = await submitPage([{ hostId: 'h2', text: 'Shared' }], { requestId: 's-b' });

    expect(first.accepted).toBe(true);
    expect(second.accepted).toBe(true);
    expect(translate).toHaveBeenCalledTimes(1);
    expect(frames.filter((frame) => frame.type === MESSAGE_TYPES.ITEM_START)).toHaveLength(2);

    deferred.resolve({ text: '共享译文', usage: { totalTokens: 5 } });
    await waitForBatchDoneFor(frames, 's-a');
    await waitForBatchDoneFor(frames, 's-b');

    const doneA = frames.find(
      (frame) => frame.type === MESSAGE_TYPES.ITEM_DONE && frame.payload.requestId === 's-a'
    );
    const doneB = frames.find(
      (frame) => frame.type === MESSAGE_TYPES.ITEM_DONE && frame.payload.requestId === 's-b'
    );
    expect(doneA.payload).toMatchObject({ text: '共享译文', usage: { totalTokens: 5 } });
    expect(doneB.payload).toMatchObject({ text: '共享译文', usage: null });
    expect(batchDoneLog('s-b')).toMatchObject({ dedupeJoined: 1 });
  });

  it('取消一个订阅者不影响其它提交；全部取消后 abort 共享请求', async () => {
    let capturedSignal = null;
    translate.mockImplementation((params) =>
      new Promise((resolve, reject) => {
        capturedSignal = params.signal;
        params.signal?.addEventListener('abort', () => {
          reject(Object.assign(new Error('aborted'), { code: ERROR_CODES.CANCELLED }));
        });
      })
    );
    const { client, frames } = connectPage();

    await submitPage([{ hostId: 'h1', text: 'Shared' }], { requestId: 's-a' });
    await submitPage([{ hostId: 'h2', text: 'Shared' }], { requestId: 's-b' });

    client.postMessage({
      type: MESSAGE_TYPES.CANCEL_ITEM,
      payload: { requestId: 's-a', itemId: 'h1' },
    });
    expect(capturedSignal.aborted).toBe(false);
    await waitForBatchDoneFor(frames, 's-a');
    expect(frames.filter((frame) => frame.type === MESSAGE_TYPES.ITEM_DONE)).toHaveLength(0);
    expect(frames.filter((frame) => frame.type === MESSAGE_TYPES.ITEM_ERROR)).toHaveLength(0);

    client.postMessage({
      type: MESSAGE_TYPES.CANCEL_BATCH,
      payload: { requestId: 's-b' },
    });
    expect(capturedSignal.aborted).toBe(true);
    await waitForBatchDoneFor(frames, 's-b');
    expect(batchDoneLog('s-b')).toMatchObject({ cancelled: 1 });
  });

  it('提交超时：未结算段以 NETWORK / BATCH_TIMEOUT 失败并 abort 共享请求', async () => {
    vi.useFakeTimers();
    try {
      let capturedSignal = null;
      translate.mockImplementation((params) => {
        capturedSignal = params.signal;
        return abortableTranslate(params);
      });
      const { frames } = connectPage();

      await submitPage([{ hostId: 'h1', text: 'Slow' }], { requestId: 's-timeout' });
      await vi.waitFor(() => expect(translate).toHaveBeenCalledTimes(1));

      await vi.advanceTimersByTimeAsync(AI_TIMEOUT_MS.batchTotal);
      await vi.waitFor(() =>
        expect(frames.some((frame) => frame.type === MESSAGE_TYPES.ITEM_ERROR)).toBe(true)
      );

      const error = frames.find((frame) => frame.type === MESSAGE_TYPES.ITEM_ERROR);
      expect(error.payload).toMatchObject({
        code: ERROR_CODES.NETWORK,
        reason: FAILURE_REASONS.BATCH_TIMEOUT,
      });
      expect(capturedSignal.aborted).toBe(true);
      const done = await waitForBatchDone(frames);
      expect(done.payload).toMatchObject({ ok: false, failed: 1, cancelled: 0 });
    } finally {
      vi.useRealTimers();
    }
  });

  it('端口断开时移除订阅并 abort 共享请求，不残留提交', async () => {
    let capturedSignal = null;
    translate.mockImplementation((params) => {
      capturedSignal = params.signal;
      return abortableTranslate(params);
    });
    const { client } = connectPage();

    await submitPage([{ hostId: 'h1', text: 'Hi' }], { requestId: 's-drop' });
    await vi.waitFor(() => expect(translate).toHaveBeenCalledTimes(1));

    client.disconnect();
    await vi.waitFor(() => expect(capturedSignal.aborted).toBe(true));
    await new Promise((resolve) => setTimeout(resolve, 0));
  });

  it('初始化失败时逐段发 ITEM_ERROR 并结束提交', async () => {
    await removeKey(instance.id);
    const { frames } = connectPage();

    const result = await submitPage([
      { hostId: 'h1', text: 'Hello' },
      { hostId: 'h2', text: 'World' },
    ]);

    expect(result.accepted).toBe(true);
    expect(translate).not.toHaveBeenCalled();
    expect(frames.filter((frame) => frame.type === MESSAGE_TYPES.ITEM_ERROR)).toHaveLength(2);
    const done = frames.find((frame) => frame.type === MESSAGE_TYPES.BATCH_DONE);
    expect(done.payload).toMatchObject({ ok: false, failed: 2, done: 0 });
    expect(done.payload.error.code).toBe(ERROR_CODES.CONFIG);
  });

  it('key 计算失败时按文本 fallback 分组，不读写缓存但继续翻译', async () => {
    vi.stubGlobal('crypto', {});
    const { frames } = connectPage();

    await submitPage([
      { hostId: 'h1', text: 'Same' },
      { hostId: 'h2', text: 'Same' },
    ]);
    await waitForBatchDone(frames);

    expect(translate).toHaveBeenCalledTimes(1);
    expect(__cache.getMany).not.toHaveBeenCalled();
    expect(__cache.set).not.toHaveBeenCalled();
    expect(frames.filter((frame) => frame.type === MESSAGE_TYPES.ITEM_DONE)).toHaveLength(2);
  });

  it('单段超过 MAX_SEGMENT_CHARS 时该段失败，其余段落继续翻译', async () => {
    const { frames } = connectPage();

    await submitPage(
      [
        { hostId: 'h1', text: 'ok' },
        { hostId: 'h2', text: 'x'.repeat(MAX_SEGMENT_CHARS + 1) },
      ],
      { requestId: 's-oversize' }
    );
    await waitForBatchDoneFor(frames, 's-oversize');

    expect(translate).toHaveBeenCalledTimes(1);
    expect(translate.mock.calls[0][0].text).toBe('ok');

    const error = frames.find((frame) => frame.type === MESSAGE_TYPES.ITEM_ERROR);
    expect(error.payload).toMatchObject({
      itemId: 'h2',
      reason: FAILURE_REASONS.TEXT_TOO_LONG,
    });
    const done = frames.find((frame) => frame.type === MESSAGE_TYPES.ITEM_DONE);
    expect(done.payload.itemId).toBe('h1');
    expect(frames.find((frame) => frame.type === MESSAGE_TYPES.BATCH_DONE).payload).toMatchObject({
      ok: false,
      done: 1,
      failed: 1,
    });
  });

  /**
   * 读取指定事件的 debug 日志数据。
   * @param {string} event
   * @param {string} requestId
   */
  function debugLogData(event, requestId) {
    const lines = console.debug.mock.calls.map(([line]) => String(line));
    const line = lines.find((entry) => entry.includes(event) && entry.includes(requestId));
    if (!line) return null;
    return JSON.parse(line.slice(line.indexOf('{'))).data;
  }

  it('跨连接（两个标签页）同 key 只执行一次，usage 归首个订阅者', async () => {
    const deferred = makeDeferred();
    translate.mockImplementation(() => deferred.promise);
    const first = connectPage(7);
    const second = connectPage(8);

    await submitPage([{ hostId: 'h1', text: 'Cross' }], { requestId: 'x-a', tabId: 7 });
    await submitPage([{ hostId: 'h2', text: 'Cross' }], { requestId: 'x-b', tabId: 8 });

    expect(translate).toHaveBeenCalledTimes(1);
    expect(first.frames.filter((frame) => frame.type === MESSAGE_TYPES.ITEM_START)).toHaveLength(1);
    expect(second.frames.filter((frame) => frame.type === MESSAGE_TYPES.ITEM_START)).toHaveLength(1);

    deferred.resolve({ text: '跨页译文', usage: { totalTokens: 7 } });
    await waitForBatchDoneFor(first.frames, 'x-a');
    await waitForBatchDoneFor(second.frames, 'x-b');

    const doneA = first.frames.find((frame) => frame.type === MESSAGE_TYPES.ITEM_DONE);
    const doneB = second.frames.find((frame) => frame.type === MESSAGE_TYPES.ITEM_DONE);
    expect(doneA.payload).toMatchObject({ text: '跨页译文', usage: { totalTokens: 7 } });
    expect(doneB.payload).toMatchObject({ text: '跨页译文', usage: null });
    expect(batchDoneLog('x-b')).toMatchObject({ dedupeJoined: 1, done: 1 });
  });

  it('owner 取消后结果仍 fan-out 给剩余订阅者，usage 全为 null', async () => {
    const deferred = makeDeferred();
    translate.mockImplementation(() => deferred.promise);
    const { client, frames } = connectPage();

    await submitPage([{ hostId: 'h1', text: 'Owner' }], { requestId: 'o-a' });
    await submitPage([{ hostId: 'h2', text: 'Owner' }], { requestId: 'o-b' });
    client.postMessage({
      type: MESSAGE_TYPES.CANCEL_ITEM,
      payload: { requestId: 'o-a', itemId: 'h1' },
    });

    deferred.resolve({ text: '剩余译文', usage: { totalTokens: 9 } });
    await waitForBatchDoneFor(frames, 'o-b');

    const doneB = frames.find(
      (frame) => frame.type === MESSAGE_TYPES.ITEM_DONE && frame.payload.requestId === 'o-b'
    );
    expect(doneB.payload).toMatchObject({ text: '剩余译文', usage: null });
    expect(
      frames.some(
        (frame) => frame.type === MESSAGE_TYPES.ITEM_DONE && frame.payload.requestId === 'o-a'
      )
    ).toBe(false);
    expect(batchDoneLog('o-b')).toMatchObject({ done: 1, cancelled: 0 });
  });

  it('端口断开后再次提交同 key 会重新执行，不复用已断开的共享请求', async () => {
    const signals = [];
    translate.mockImplementation((params) => {
      signals.push(params.signal);
      return abortableTranslate(params);
    });
    const first = connectPage(7);
    await submitPage([{ hostId: 'h1', text: 'Again' }], { requestId: 'd-a' });
    await vi.waitFor(() => expect(translate).toHaveBeenCalledTimes(1));

    const framesBefore = first.frames.length;
    first.client.disconnect();
    await vi.waitFor(() => expect(signals[0].aborted).toBe(true));
    expect(first.frames).toHaveLength(framesBefore);

    const second = connectPage(7);
    await submitPage([{ hostId: 'h2', text: 'Again' }], { requestId: 'd-b' });
    await vi.waitFor(() => expect(translate).toHaveBeenCalledTimes(2));
    expect(signals[1]).not.toBe(signals[0]);
    expect(second.frames.filter((frame) => frame.type === MESSAGE_TYPES.ITEM_START)).toHaveLength(
      1
    );
  });

  it('按实例 batchSize / batchMaxChars 切批并记录 batch.plan', async () => {
    initLogging({ level: 'debug', sessionId: 'gateway-test' });
    await updateInstance(instance.id, { batchSize: 2, batchMaxChars: 12 });
    const { frames } = connectPage();

    await submitPage(
      [
        { hostId: 'h1', text: 'aaaaaa' },
        { hostId: 'h2', text: 'bbbbbb' },
        { hostId: 'h3', text: 'cccccc' },
      ],
      { requestId: 's-plan' }
    );
    await waitForBatchDoneFor(frames, 's-plan');

    const plan = debugLogData('batch.plan', 's-plan');
    expect(plan).toMatchObject({
      items: 3,
      groups: 3,
      batches: 2,
      batchSize: 2,
      batchMaxChars: 12,
      batchChars: 18,
      oversizeBatches: 0,
      cacheEnabled: true,
    });
  });
});

describe('A2 批次切分', () => {
  /**
   * @param {number} count
   * @param {number} length
   */
  function groupsOf(count, length) {
    return Array.from({ length: count }, (_, index) => ({
      key: `g${index}`,
      text: 'a'.repeat(length),
    }));
  }

  it('batchSize 与 batchMaxChars 同时生效，先到先切', () => {
    const groups = groupsOf(20, 100);

    const bySize = splitBatches(groups, { batchSize: 8, batchMaxChars: 1000 });
    expect(bySize.map((batch) => batch.groups.length)).toEqual([8, 8, 4]);
    expect(bySize.map((batch) => batch.chars)).toEqual([800, 800, 400]);
    expect(bySize.some((batch) => batch.oversize)).toBe(false);

    const byChars = splitBatches(groups, { batchSize: 8, batchMaxChars: 300 });
    expect(byChars.map((batch) => batch.groups.length)).toEqual([3, 3, 3, 3, 3, 3, 2]);
    expect(byChars.map((batch) => batch.chars)).toEqual([300, 300, 300, 300, 300, 300, 200]);
  });

  it('单段超过字符上限时单独成批并标记 oversize，不拆段', () => {
    const groups = [
      { key: 'a', text: 'a'.repeat(50) },
      { key: 'b', text: 'b'.repeat(3000) },
      { key: 'c', text: 'c'.repeat(50) },
    ];

    const batches = splitBatches(groups, { batchSize: 8, batchMaxChars: 300 });

    expect(batches).toHaveLength(3);
    expect(batches[1].groups.map((group) => group.key)).toEqual(['b']);
    expect(batches[1].oversize).toBe(true);
    const flattened = batches.flatMap((batch) => batch.groups.map((group) => group.key));
    expect(flattened).toEqual(['a', 'b', 'c']);
    expect(new Set(flattened).size).toBe(flattened.length);
  });

  it('空输入不产生批次；缺失或非法参数回退默认值', () => {
    expect(splitBatches([], { batchSize: 8, batchMaxChars: 1000 })).toEqual([]);
    expect(splitBatches(undefined, {})).toEqual([]);

    const groups = groupsOf(3, 10);
    const byDefault = splitBatches(groups, { batchSize: 'x', batchMaxChars: -1 });
    expect(byDefault).toHaveLength(1);
    expect(byDefault[0].groups).toHaveLength(3);
  });
});

describe('A2 页面提交：队列与批量翻译', () => {
  /**
   * 以页面注入的 sender 建立 st-gateway 连接（带 tab.id）。
   * @param {number} [tabId]
   */
  function connectPage(tabId = 7) {
    const client = chrome.runtime.connect({
      name: PORT_NAME,
      sender: { id: chrome.runtime.id, tab: { id: tabId } },
    });
    clients.push(client);
    const frames = [];
    client.onMessage.addListener((message) => frames.push(message));
    return { client, frames };
  }

  /**
   * @param {Array<{ hostId?: string, text: string }>} paragraphs
   * @param {{ requestId?: string, tabId?: number }} [options]
   */
  function submitPage(paragraphs, options = {}) {
    return acceptPageSubmit({
      requestId: options.requestId ?? 'q-1',
      scope: 'page',
      paragraphs,
      tabId: options.tabId ?? 7,
    });
  }

  it('两个新 group 只发一次批量请求，逐段 DONE 且 usage 为 null', async () => {
    const { frames } = connectPage();

    await submitPage(
      [
        { hostId: 'h1', text: 'Hello' },
        { hostId: 'h2', text: 'World' },
      ],
      { requestId: 'q-batch' }
    );
    const done = await waitForBatchDoneFor(frames, 'q-batch');

    expect(translateBatch).toHaveBeenCalledTimes(1);
    expect(translate).not.toHaveBeenCalled();
    expect(translateBatch.mock.calls[0][0].items).toEqual([
      { groupId: 'g0', text: 'Hello' },
      { groupId: 'g1', text: 'World' },
    ]);
    expect(
      frames.filter((frame) => frame.type === MESSAGE_TYPES.ITEM_START).map((frame) => frame.payload.itemId)
    ).toEqual(['h1', 'h2']);
    const dones = frames.filter((frame) => frame.type === MESSAGE_TYPES.ITEM_DONE);
    expect(dones.map((frame) => frame.payload.itemId)).toEqual(['h1', 'h2']);
    expect(dones.map((frame) => frame.payload.text)).toEqual(['译:Hello', '译:World']);
    expect(dones.every((frame) => frame.payload.usage === null)).toBe(true);
    expect(done.payload).toMatchObject({ ok: true, done: 2, failed: 0, cancelled: 0 });
    // 按 group 各写一次缓存。
    expect(__cache.set).toHaveBeenCalledTimes(2);
  });

  it('批量对齐失败：已解析段保留，其余段 BATCH_ALIGN', async () => {
    translateBatch.mockImplementation(async ({ items, onItem }) => {
      onItem?.({ groupId: items[0].groupId, text: '只解析第一段' });
      throw new BatchAlignError({ missing: 1 });
    });
    const { frames } = connectPage();

    await submitPage(
      [
        { hostId: 'h1', text: 'One' },
        { hostId: 'h2', text: 'Two' },
      ],
      { requestId: 'q-align' }
    );
    const done = await waitForBatchDoneFor(frames, 'q-align');

    const itemDone = frames.find((frame) => frame.type === MESSAGE_TYPES.ITEM_DONE);
    expect(itemDone.payload).toMatchObject({ itemId: 'h1', text: '只解析第一段' });
    const itemError = frames.find((frame) => frame.type === MESSAGE_TYPES.ITEM_ERROR);
    expect(itemError.payload).toMatchObject({ itemId: 'h2', code: ERROR_CODES.BATCH_ALIGN });
    expect(done.payload).toMatchObject({ ok: false, done: 1, failed: 1 });
    // 只写已解析段的缓存。
    expect(__cache.set).toHaveBeenCalledTimes(1);
    expect(__cache.set.mock.calls[0][1]).toBe('只解析第一段');
  });

  it('批量中某段空译文：该段按 OTHER 失败，其它段不受影响且不写缓存', async () => {
    translateBatch.mockImplementation(async ({ items, onItem }) => {
      onItem?.({ groupId: items[0].groupId, text: '正常译文' });
      onItem?.({ groupId: items[1].groupId, text: '   ' });
      return { usage: null };
    });
    const { frames } = connectPage();

    await submitPage(
      [
        { hostId: 'h1', text: 'One' },
        { hostId: 'h2', text: 'Two' },
      ],
      { requestId: 'q-empty' }
    );
    const done = await waitForBatchDoneFor(frames, 'q-empty');

    const itemError = frames.find((frame) => frame.type === MESSAGE_TYPES.ITEM_ERROR);
    expect(itemError.payload).toMatchObject({
      itemId: 'h2',
      code: ERROR_CODES.OTHER,
      message: '引擎返回空译文',
    });
    const itemDone = frames.find((frame) => frame.type === MESSAGE_TYPES.ITEM_DONE);
    expect(itemDone.payload).toMatchObject({ itemId: 'h1', text: '正常译文' });
    expect(done.payload).toMatchObject({ ok: false, done: 1, failed: 1 });
    expect(__cache.set).toHaveBeenCalledTimes(1);
  });

  it('缓存命中与批量混合：命中项直接回显，其余两个 group 合成一批', async () => {
    const hitKey = await cacheKeyFor('Cached');
    __cache.entries.set(hitKey, {
      text: '缓存译文',
      bytes: 10,
      createdAt: Date.now(),
      domain: '',
    });
    const { frames } = connectPage();

    await submitPage(
      [
        { hostId: 'h1', text: 'Cached' },
        { hostId: 'h2', text: 'One' },
        { hostId: 'h3', text: 'Two' },
      ],
      { requestId: 'q-mix' }
    );
    const done = await waitForBatchDoneFor(frames, 'q-mix');

    expect(translateBatch).toHaveBeenCalledTimes(1);
    expect(translateBatch.mock.calls[0][0].items.map((item) => item.text)).toEqual([
      'One',
      'Two',
    ]);
    expect(translate).not.toHaveBeenCalled();
    const dones = frames.filter((frame) => frame.type === MESSAGE_TYPES.ITEM_DONE);
    expect(dones.map((frame) => [frame.payload.itemId, frame.payload.text])).toEqual([
      ['h1', '缓存译文'],
      ['h2', '译:One'],
      ['h3', '译:Two'],
    ]);
    expect(done.payload).toMatchObject({ ok: true, done: 3, failed: 0 });
    expect(__cache.set).toHaveBeenCalledTimes(2);
    expect(batchDoneLog('q-mix')).toMatchObject({
      cacheHits: 1,
      cacheMisses: 2,
      cacheWrites: 2,
      done: 3,
    });
  });

  it('单 group 批次走单段 translate，保留流式与上游 usage', async () => {
    const { frames } = connectPage();

    await submitPage([{ hostId: 'h1', text: 'Solo' }], { requestId: 'q-single' });
    await waitForBatchDoneFor(frames, 'q-single');

    expect(translate).toHaveBeenCalledTimes(1);
    expect(translateBatch).not.toHaveBeenCalled();
    expect(frames.map((frame) => frame.type)).toEqual([
      MESSAGE_TYPES.ITEM_START,
      MESSAGE_TYPES.ITEM_DELTA,
      MESSAGE_TYPES.ITEM_DONE,
      MESSAGE_TYPES.BATCH_DONE,
    ]);
    expect(frames[2].payload.usage).toEqual({ totalTokens: 1 });
  });

  it('队列按实例并发上限串行执行批次', async () => {
    await updateInstance(instance.id, { batchSize: 2, maxConcurrency: 1 });
    const pending = [];
    translateBatch.mockImplementation(
      (params) =>
        new Promise((resolve, reject) => {
          pending.push({ params, resolve, reject });
        })
    );
    const { frames } = connectPage();

    await submitPage(
      [
        { hostId: 'h1', text: 'A' },
        { hostId: 'h2', text: 'B' },
        { hostId: 'h3', text: 'C' },
        { hostId: 'h4', text: 'D' },
      ],
      { requestId: 'q-limit' }
    );

    await vi.waitFor(() => expect(translateBatch).toHaveBeenCalledTimes(1));
    await new Promise((resolve) => setTimeout(resolve, 20));
    expect(translateBatch).toHaveBeenCalledTimes(1);
    expect(pending[0].params.items).toHaveLength(2);

    for (const [index, item] of pending[0].params.items.entries()) {
      pending[0].params.onItem({ groupId: item.groupId, text: `批一-${index}` });
    }
    pending[0].resolve({ usage: null });
    await vi.waitFor(() => expect(translateBatch).toHaveBeenCalledTimes(2));
    expect(pending[1].params.items).toHaveLength(2);

    for (const [index, item] of pending[1].params.items.entries()) {
      pending[1].params.onItem({ groupId: item.groupId, text: `批二-${index}` });
    }
    pending[1].resolve({ usage: null });

    const done = await waitForBatchDoneFor(frames, 'q-limit');
    expect(done.payload).toMatchObject({ ok: true, done: 4, failed: 0 });
  });

  it('批次等待期间新提交同 key 只订阅在途 group，不重复入队', async () => {
    let pending = null;
    translateBatch.mockImplementation(
      (params) =>
        new Promise((resolve, reject) => {
          pending = { params, resolve, reject };
        })
    );
    const first = connectPage(7);
    const second = connectPage(8);

    await submitPage(
      [
        { hostId: 'a1', text: 'One' },
        { hostId: 'a2', text: 'Two' },
      ],
      { requestId: 'join-a', tabId: 7 }
    );
    await vi.waitFor(() => expect(translateBatch).toHaveBeenCalledTimes(1));

    await submitPage(
      [
        { hostId: 'b1', text: 'One' },
        { hostId: 'b2', text: 'Two' },
      ],
      { requestId: 'join-b', tabId: 8 }
    );
    expect(translateBatch).toHaveBeenCalledTimes(1);
    expect(
      second.frames.filter((frame) => frame.type === MESSAGE_TYPES.ITEM_START)
    ).toHaveLength(2);

    for (const [index, item] of pending.params.items.entries()) {
      pending.params.onItem({ groupId: item.groupId, text: `共享-${index}` });
    }
    pending.resolve({ usage: { totalTokens: 3 } });

    await waitForBatchDoneFor(first.frames, 'join-a');
    await waitForBatchDoneFor(second.frames, 'join-b');
    expect(
      first.frames.filter((frame) => frame.type === MESSAGE_TYPES.ITEM_DONE)
    ).toHaveLength(2);
    expect(
      second.frames.filter((frame) => frame.type === MESSAGE_TYPES.ITEM_DONE)
    ).toHaveLength(2);
    expect(batchDoneLog('join-b')).toMatchObject({ dedupeJoined: 2, done: 2 });
  });

  it('取消一个 group 不 abort 整批；全部取消后 abort 批次请求', async () => {
    let captured = null;
    translateBatch.mockImplementation(
      (params) =>
        new Promise((resolve, reject) => {
          captured = { params, resolve, reject };
          params.signal?.addEventListener('abort', () => {
            reject(Object.assign(new Error('aborted'), { code: ERROR_CODES.CANCELLED }));
          });
        })
    );
    const single = connectPage();

    await submitPage(
      [
        { hostId: 'h1', text: 'One' },
        { hostId: 'h2', text: 'Two' },
      ],
      { requestId: 'q-cancel-item' }
    );
    await vi.waitFor(() => expect(translateBatch).toHaveBeenCalledTimes(1));

    single.client.postMessage({
      type: MESSAGE_TYPES.CANCEL_ITEM,
      payload: { requestId: 'q-cancel-item', itemId: 'h1' },
    });
    expect(captured.params.signal.aborted).toBe(false);

    // 已取消 group 的结果被队列忽略，剩余 group 正常定稿。
    captured.params.onItem({ groupId: 'g0', text: '不应出现' });
    captured.params.onItem({ groupId: 'g1', text: '剩余译文' });
    captured.resolve({ usage: null });

    const done = await waitForBatchDoneFor(single.frames, 'q-cancel-item');
    expect(done.payload).toMatchObject({ ok: false, done: 1, cancelled: 1 });
    expect(
      single.frames.filter((frame) => frame.type === MESSAGE_TYPES.ITEM_DONE)
    ).toHaveLength(1);
    expect(
      single.frames.filter((frame) => frame.type === MESSAGE_TYPES.ITEM_ERROR)
    ).toHaveLength(0);

    // 全部取消：abort 批次请求，不发单段帧。
    const all = connectPage();
    await submitPage(
      [
        { hostId: 'c1', text: 'Three' },
        { hostId: 'c2', text: 'Four' },
      ],
      { requestId: 'q-cancel-batch' }
    );
    await vi.waitFor(() => expect(translateBatch).toHaveBeenCalledTimes(2));
    const secondCaptured = captured;
    all.client.postMessage({
      type: MESSAGE_TYPES.CANCEL_BATCH,
      payload: { requestId: 'q-cancel-batch' },
    });
    expect(secondCaptured.params.signal.aborted).toBe(true);

    const cancelDone = await waitForBatchDoneFor(all.frames, 'q-cancel-batch');
    expect(cancelDone.payload).toMatchObject({ ok: false, done: 0, cancelled: 2 });
    expect(
      all.frames.filter((frame) => frame.type === MESSAGE_TYPES.ITEM_ERROR)
    ).toHaveLength(0);
  });

  it('提交超时：批量未结算段以 NETWORK / BATCH_TIMEOUT 失败并 abort 批次', async () => {
    vi.useFakeTimers();
    try {
      let captured = null;
      translateBatch.mockImplementation(
        (params) =>
          new Promise((resolve, reject) => {
            captured = { params, resolve, reject };
            params.signal?.addEventListener('abort', () => {
              reject(Object.assign(new Error('aborted'), { code: ERROR_CODES.CANCELLED }));
            });
          })
      );
      const { frames } = connectPage();

      await submitPage(
        [
          { hostId: 'h1', text: 'One' },
          { hostId: 'h2', text: 'Two' },
        ],
        { requestId: 'q-timeout' }
      );
      await vi.waitFor(() => expect(translateBatch).toHaveBeenCalledTimes(1));

      await vi.advanceTimersByTimeAsync(AI_TIMEOUT_MS.batchTotal);
      await vi.waitFor(() =>
        expect(
          frames.filter((frame) => frame.type === MESSAGE_TYPES.ITEM_ERROR)
        ).toHaveLength(2)
      );

      for (const frame of frames.filter((entry) => entry.type === MESSAGE_TYPES.ITEM_ERROR)) {
        expect(frame.payload).toMatchObject({
          code: ERROR_CODES.NETWORK,
          reason: FAILURE_REASONS.BATCH_TIMEOUT,
        });
      }
      expect(captured.params.signal.aborted).toBe(true);
      const done = await waitForBatchDoneFor(frames, 'q-timeout');
      expect(done.payload).toMatchObject({ ok: false, failed: 2, cancelled: 0 });
    } finally {
      vi.useRealTimers();
    }
  });
});

describe('A2 多实例与百度', () => {
  /** 以页面 sender 建立连接（带 tab.id）。 */
  function connectPage(tabId = 7) {
    const client = chrome.runtime.connect({
      name: PORT_NAME,
      sender: { id: chrome.runtime.id, tab: { id: tabId } },
    });
    clients.push(client);
    const frames = [];
    client.onMessage.addListener((message) => frames.push(message));
    return { client, frames };
  }

  /** 创建百度实例、写入凭据并设为当前实例。 */
  async function useBaidu() {
    const baidu = await createInstance({ type: 'baidu', name: 'Baidu' });
    await writeCredentials(baidu.id, { appId: 'appid-1', secretKey: 'secret-1' });
    await setActiveInstance(baidu.id);
    return baidu;
  }

  it('百度实例：提交带上 APPID/密钥，单段走 translate', async () => {
    const baidu = await useBaidu();
    const { frames } = connectPage();
    await acceptPageSubmit({
      requestId: 'baidu-single',
      scope: 'single',
      paragraphs: [{ hostId: 'h1', text: 'Hello' }],
      tabId: 7,
    });
    await waitForBatchDoneFor(frames, 'baidu-single');

    expect(translate).toHaveBeenCalledTimes(1);
    expect(translate.mock.calls[0][0].instance).toMatchObject({
      id: baidu.id,
      type: 'baidu',
      appId: 'appid-1',
      secretKey: 'secret-1',
    });
    const done = frames.find((frame) => frame.type === MESSAGE_TYPES.ITEM_DONE);
    expect(done.payload.text).toBe('译:Hello');
  });

  it('百度实例：单段超过 4800 字节直接失败，不调用上游', async () => {
    await useBaidu();
    const { frames } = connectPage();
    await acceptPageSubmit({
      requestId: 'baidu-long',
      paragraphs: [{ hostId: 'h1', text: '汉'.repeat(1601) }],
      tabId: 7,
    });
    const done = await waitForBatchDoneFor(frames, 'baidu-long');
    expect(done.payload).toMatchObject({ ok: false, failed: 1 });
    const error = frames.find((frame) => frame.type === MESSAGE_TYPES.ITEM_ERROR);
    expect(error.payload).toMatchObject({
      code: ERROR_CODES.OTHER,
      reason: FAILURE_REASONS.TEXT_TOO_LONG,
    });
    expect(translate).not.toHaveBeenCalled();
  });

  it('百度实例提交超时为 30 秒（不是 180 秒）', async () => {
    vi.useFakeTimers();
    try {
      await useBaidu();
      translate.mockImplementation(abortableTranslate);
      const { frames } = connectPage();
      await acceptPageSubmit({
        requestId: 'baidu-timeout',
        paragraphs: [{ hostId: 'h1', text: 'slow' }],
        tabId: 7,
      });
      await vi.waitFor(() => expect(translate).toHaveBeenCalledTimes(1));

      await vi.advanceTimersByTimeAsync(BAIDU_TIMEOUT_MS.batch);
      await vi.waitFor(() =>
        expect(frames.some((frame) => frame.type === MESSAGE_TYPES.ITEM_ERROR)).toBe(true)
      );
      expect(
        frames.find((frame) => frame.type === MESSAGE_TYPES.ITEM_ERROR).payload
      ).toMatchObject({
        code: ERROR_CODES.NETWORK,
        reason: FAILURE_REASONS.BATCH_TIMEOUT,
      });
      const done = await waitForBatchDoneFor(frames, 'baidu-timeout');
      expect(done.payload).toMatchObject({ ok: false, failed: 1 });
    } finally {
      vi.useRealTimers();
    }
  });

  it('百度缓存 key 使用固定 profile，与 OpenAI 隔离', async () => {
    await useBaidu();
    const { frames } = connectPage();
    await acceptPageSubmit({
      requestId: 'baidu-cache',
      paragraphs: [{ hostId: 'h1', text: 'Cached text' }],
      tabId: 7,
    });
    await waitForBatchDoneFor(frames, 'baidu-cache');

    await vi.waitFor(() => expect(__cache.set).toHaveBeenCalledTimes(1));
    const [key] = __cache.set.mock.calls[0];
    const expected = await buildCacheKey({
      engineType: 'baidu',
      endpointFingerprint: 'baidu',
      model: 'general',
      sourceLang: 'auto',
      targetLang: 'zh',
      promptVersion: 0,
      promptHash: 'none',
      generationHash: 'baidu:v1',
      batchEncodingVersion: BATCH_ENCODING_VERSION,
      text: 'Cached text',
    });
    expect(key).toBe(expected);
  });

  it('唯一实例的 endpoint 未授权时拒绝提交，不调用上游', async () => {
    const custom = await createInstance({
      type: 'openai',
      preset: 'custom',
      name: 'Local',
      endpoint: { baseUrl: 'https://llm.example.com', path: '/v1/chat/completions' },
      model: 'local',
    });
    await writeCredentials(custom.id, { apiKey: 'sk-local' });
    await removeInstance(instance.id);

    const { frames } = connectPage();
    await acceptPageSubmit({
      requestId: 'permission-denied',
      paragraphs: [{ hostId: 'h1', text: 'hi' }],
      tabId: 7,
    });
    const done = await waitForBatchDoneFor(frames, 'permission-denied');
    expect(done.payload.ok).toBe(false);
    const error = frames.find((frame) => frame.type === MESSAGE_TYPES.ITEM_ERROR);
    expect(error.payload).toMatchObject({ code: ERROR_CODES.CONFIG });
    expect(error.payload.message).toContain('未授权');
    expect(translate).not.toHaveBeenCalled();
  });

  it('当前实例不可用且没有备选时拒绝提交', async () => {
    const custom = await createInstance({
      type: 'openai',
      preset: 'custom',
      name: 'Local',
      endpoint: { baseUrl: 'https://llm.example.com', path: '/v1/chat/completions' },
      model: 'local',
    });
    await writeCredentials(custom.id, { apiKey: 'sk-local' });
    await setInstanceEnabled(instance.id, false);
    await setInstanceEnabled(custom.id, false);

    const { frames } = connectPage();
    await acceptPageSubmit({
      requestId: 'no-usable',
      paragraphs: [{ hostId: 'h1', text: 'hi' }],
      tabId: 7,
    });
    const done = await waitForBatchDoneFor(frames, 'no-usable');
    expect(done.payload.ok).toBe(false);
    const error = frames.find((frame) => frame.type === MESSAGE_TYPES.ITEM_ERROR);
    expect(error.payload.code).toBe(ERROR_CODES.CONFIG);
    expect(translate).not.toHaveBeenCalled();
  });
});

describe('A2 批次切分', () => {
  it('batchMaxBytes 按 UTF-8 字节切批，且不拆段', () => {
    const groups = Array.from({ length: 5 }, (_, index) => ({
      key: `g${index}`,
      text: '汉'.repeat(100),
    }));
    const batches = splitBatches(groups, {
      batchSize: 20,
      batchMaxChars: 10_000,
      batchMaxBytes: 1_000,
    });
    expect(batches.length).toBe(2);
    expect(batches[0].groups.length).toBe(3);
    expect(batches[1].groups.length).toBe(2);
    for (const batch of batches) {
      expect(batch.bytes).toBeLessThanOrEqual(1_000);
      expect(batch.oversize).toBe(false);
    }
  });

  it('单段超过字节上限时单独成批并标记 oversize', () => {
    const batches = splitBatches(
      [{ text: '汉'.repeat(400) }, { text: 'ok' }],
      { batchSize: 20, batchMaxChars: 10_000, batchMaxBytes: 1_000 }
    );
    expect(batches.length).toBe(2);
    expect(batches[0].oversize).toBe(true);
    expect(batches[0].groups).toHaveLength(1);
  });

  it('未提供 batchMaxBytes 时不限制字节', () => {
    const batches = splitBatches([{ text: '汉'.repeat(400) }], {
      batchSize: 20,
      batchMaxChars: 10_000,
    });
    expect(batches).toHaveLength(1);
    expect(batches[0].oversize).toBe(false);
  });
});

describe('A2 网关：QPS、拆批与标签页清理', () => {
  /** 以页面 sender 建立连接（带 tab.id）。 */
  function connectPage(tabId = 7) {
    const client = chrome.runtime.connect({
      name: PORT_NAME,
      sender: { id: chrome.runtime.id, tab: { id: tabId } },
    });
    clients.push(client);
    const frames = [];
    client.onMessage.addListener((message) => frames.push(message));
    return { client, frames };
  }

  /** 创建百度实例（可覆盖批次/并发/QPS）、写入凭据并设为当前实例。 */
  async function useBaidu(patch = {}) {
    const baidu = await createInstance({ type: 'baidu', name: 'Baidu', ...patch });
    await writeCredentials(baidu.id, { appId: 'appid-1', secretKey: 'secret-1' });
    await setActiveInstance(baidu.id);
    return baidu;
  }

  /**
   * 取某个事件的全部日志数据（按输出顺序）。
   * @param {string} event
   * @returns {object[]}
   */
  function logEntries(event) {
    const lines = [
      ...console.debug.mock.calls,
      ...console.info.mock.calls,
      ...console.warn.mock.calls,
    ].map(([line]) => String(line));
    const out = [];
    for (const line of lines) {
      const index = line.indexOf(`] ${event} `);
      if (index < 0) continue;
      const brace = line.indexOf('{', index);
      if (brace < 0) {
        out.push({});
        continue;
      }
      try {
        out.push(JSON.parse(line.slice(brace)).data ?? {});
      } catch {
        out.push({});
      }
    }
    return out;
  }

  it('百度 QPS=1：同一实例的第二次上游请求等窗口，批量内多段只计 1 次', async () => {
    vi.useFakeTimers();
    try {
      await useBaidu({ qps: 1, batchSize: 1, maxConcurrency: 2 });
      const { frames } = connectPage();
      await acceptPageSubmit({
        requestId: 'qps-batches',
        paragraphs: [
          { hostId: 'h1', text: 'One' },
          { hostId: 'h2', text: 'Two' },
        ],
        tabId: 7,
      });

      await vi.waitFor(() => expect(translate).toHaveBeenCalledTimes(1));
      await vi.advanceTimersByTimeAsync(20);
      expect(translate).toHaveBeenCalledTimes(1);

      await vi.advanceTimersByTimeAsync(QPS_WINDOW_MS);
      await vi.waitFor(() => expect(translate).toHaveBeenCalledTimes(2));

      const done = await waitForBatchDoneFor(frames, 'qps-batches');
      expect(done.payload).toMatchObject({ ok: true, done: 2, failed: 0 });
      // 两次单段请求各计 1 次，窗口内不会出现第三次。
      expect(translate).toHaveBeenCalledTimes(2);
    } finally {
      vi.useRealTimers();
    }
  });

  it('一个批量请求只计 1 次 QPS：组数不影响速率', async () => {
    await useBaidu({ qps: 1, batchSize: 8, maxConcurrency: 2 });
    const { frames } = connectPage();
    await acceptPageSubmit({
      requestId: 'qps-one-batch',
      paragraphs: [
        { hostId: 'h1', text: 'One' },
        { hostId: 'h2', text: 'Two' },
        { hostId: 'h3', text: 'Three' },
      ],
      tabId: 7,
    });
    const done = await waitForBatchDoneFor(frames, 'qps-one-batch');
    expect(done.payload).toMatchObject({ ok: true, done: 3 });
    expect(translateBatch).toHaveBeenCalledTimes(1);
    expect(translate).not.toHaveBeenCalled();
  });

  it('OpenAI 兼容实例不做 QPS 门控：多个批次立即发出', async () => {
    await updateInstance(instance.id, { batchSize: 1, maxConcurrency: 2 });
    const { frames } = connectPage();
    await acceptPageSubmit({
      requestId: 'openai-no-qps',
      paragraphs: [
        { hostId: 'h1', text: 'One' },
        { hostId: 'h2', text: 'Two' },
      ],
      tabId: 7,
    });
    // 若被 QPS 门控，第二次请求至少要等 1 秒；这里 500ms 内必须都已发出。
    await vi.waitFor(() => expect(translate).toHaveBeenCalledTimes(2), { timeout: 500 });
    const done = await waitForBatchDoneFor(frames, 'openai-no-qps');
    expect(done.payload).toMatchObject({ ok: true, done: 2 });
  });

  it('QPS 等待期间取消提交：不再发请求，也不发错误帧', async () => {
    vi.useFakeTimers();
    try {
      await useBaidu({ qps: 1, batchSize: 1, maxConcurrency: 2 });
      translate.mockImplementation(abortableTranslate);
      const { client, frames } = connectPage();
      await acceptPageSubmit({
        requestId: 'qps-cancel',
        paragraphs: [
          { hostId: 'h1', text: 'One' },
          { hostId: 'h2', text: 'Two' },
        ],
        tabId: 7,
      });
      await vi.waitFor(() => expect(translate).toHaveBeenCalledTimes(1));

      client.postMessage({
        type: MESSAGE_TYPES.CANCEL_BATCH,
        payload: { requestId: 'qps-cancel' },
      });
      const done = await waitForBatchDoneFor(frames, 'qps-cancel');
      expect(done.payload).toMatchObject({ cancelled: 2, failed: 0 });

      await vi.advanceTimersByTimeAsync(QPS_WINDOW_MS * 2);
      expect(translate).toHaveBeenCalledTimes(1);
      expect(frames.filter((frame) => frame.type === MESSAGE_TYPES.ITEM_ERROR)).toHaveLength(0);
    } finally {
      vi.useRealTimers();
    }
  });

  it('批量对齐失败：未结算段二分拆批，直到单段后全部出译文', async () => {
    translateBatch.mockImplementation(async ({ items }) => {
      if (items.length > 1) throw new BatchAlignError({ missing: 1 });
      return { usage: null };
    });
    const { frames } = connectPage();
    await acceptPageSubmit({
      requestId: 'split-all',
      paragraphs: [
        { hostId: 'h1', text: 'One' },
        { hostId: 'h2', text: 'Two' },
        { hostId: 'h3', text: 'Three' },
        { hostId: 'h4', text: 'Four' },
      ],
      tabId: 7,
    });

    const done = await waitForBatchDoneFor(frames, 'split-all');
    expect(done.payload).toMatchObject({ ok: true, done: 4, failed: 0 });

    // 4 段 → 两次 2 段批 → 4 个单段批走单段 translate。
    expect(translateBatch).toHaveBeenCalledTimes(3);
    expect(translate).toHaveBeenCalledTimes(4);
    expect(
      frames.filter((frame) => frame.type === MESSAGE_TYPES.ITEM_DONE)
    ).toHaveLength(4);
    expect(
      frames.filter((frame) => frame.type === MESSAGE_TYPES.ITEM_ERROR)
    ).toHaveLength(0);

    const splits = logEntries('batch.split');
    expect(splits.length).toBeGreaterThanOrEqual(3);
    expect(splits[0]).toMatchObject({ parentGroups: 4, leftGroups: 2, rightGroups: 2, depth: 1 });
    expect(splits.every((entry) => entry.parentGroups >= 2)).toBe(true);
  });

  it('已解析段保留：只对未结算段拆批，已解析段不重发', async () => {
    let call = 0;
    translateBatch.mockImplementation(async ({ items, onItem }) => {
      call += 1;
      if (call === 1) {
        onItem?.({ groupId: items[0].groupId, text: '已解析一' });
        onItem?.({ groupId: items[1].groupId, text: '已解析二' });
        throw new BatchAlignError({ missing: 2 });
      }
      for (const item of items) onItem?.({ groupId: item.groupId, text: `补:${item.text}` });
      return { usage: null };
    });
    const { frames } = connectPage();
    await acceptPageSubmit({
      requestId: 'split-partial',
      paragraphs: [
        { hostId: 'h1', text: 'One' },
        { hostId: 'h2', text: 'Two' },
        { hostId: 'h3', text: 'Three' },
        { hostId: 'h4', text: 'Four' },
      ],
      tabId: 7,
    });

    const done = await waitForBatchDoneFor(frames, 'split-partial');
    expect(done.payload).toMatchObject({ ok: true, done: 4 });
    const dones = frames
      .filter((frame) => frame.type === MESSAGE_TYPES.ITEM_DONE)
      .map((frame) => [frame.payload.itemId, frame.payload.text]);
    expect(dones).toEqual([
      ['h1', '已解析一'],
      ['h2', '已解析二'],
      ['h3', '译:Three'],
      ['h4', '译:Four'],
    ]);
    expect(translateBatch).toHaveBeenCalledTimes(1);
    expect(translate).toHaveBeenCalledTimes(2);
    expect(logEntries('batch.split')[0]).toMatchObject({ parentGroups: 2, depth: 1 });
  });

  it('单段仍对齐失败时按 BATCH_ALIGN 结束，不无限拆批', async () => {
    const alignError = () => new BatchAlignError({ missing: 1 });
    translateBatch.mockRejectedValue(alignError());
    translate.mockRejectedValue(alignError());

    const { frames } = connectPage();
    await acceptPageSubmit({
      requestId: 'split-single',
      paragraphs: [
        { hostId: 'h1', text: 'One' },
        { hostId: 'h2', text: 'Two' },
      ],
      tabId: 7,
    });

    const done = await waitForBatchDoneFor(frames, 'split-single');
    expect(done.payload).toMatchObject({ ok: false, failed: 2, done: 0 });
    const errors = frames.filter((frame) => frame.type === MESSAGE_TYPES.ITEM_ERROR);
    expect(errors).toHaveLength(2);
    for (const frame of errors) {
      expect(frame.payload.code).toBe(ERROR_CODES.BATCH_ALIGN);
    }
    expect(translateBatch).toHaveBeenCalledTimes(1);
    expect(translate).toHaveBeenCalledTimes(2);
    expect(logEntries('batch.split')).toHaveLength(1);
  });

  it('可重试错误自动重试同一实例：网络抖动后成功只发一次 DONE', async () => {
    vi.useFakeTimers();
    try {
      translate
        .mockRejectedValueOnce(new TranslateError(ERROR_CODES.NETWORK, 'net'))
        .mockImplementationOnce(async ({ text, onDelta }) => {
          onDelta?.(`[${text}]`);
          return { text: `译:${text}`, usage: { totalTokens: 1 } };
        });
      const { frames } = connectPage();
      await acceptPageSubmit({
        requestId: 'retry-single',
        scope: 'single',
        paragraphs: [{ hostId: 'h1', text: 'Hi' }],
        tabId: 7,
      });

      await vi.waitFor(() => expect(translate).toHaveBeenCalledTimes(1));
      await vi.advanceTimersByTimeAsync(1500);
      await vi.waitFor(() => expect(translate).toHaveBeenCalledTimes(2));

      const done = await waitForBatchDoneFor(frames, 'retry-single');
      expect(done.payload).toMatchObject({ ok: true, done: 1, failed: 0 });
      expect(frames.filter((frame) => frame.type === MESSAGE_TYPES.ITEM_DONE)).toHaveLength(1);
      expect(frames.filter((frame) => frame.type === MESSAGE_TYPES.ITEM_ERROR)).toHaveLength(0);
      expect(logEntries('queue.retry')[0]).toMatchObject({
        attempt: 1,
        maxAttempts: 3,
        code: ERROR_CODES.NETWORK,
      });
    } finally {
      vi.useRealTimers();
    }
  });

  it('已产生增量后失败不重试，避免重复译文', async () => {
    translate.mockImplementation(async ({ onDelta }) => {
      onDelta?.('半句');
      throw new TranslateError(ERROR_CODES.NETWORK, 'stream broken');
    });
    const { frames } = connectPage();
    await acceptPageSubmit({
      requestId: 'retry-emitted',
      scope: 'single',
      paragraphs: [{ hostId: 'h1', text: 'Hi' }],
      tabId: 7,
    });

    const done = await waitForBatchDoneFor(frames, 'retry-emitted');
    expect(done.payload).toMatchObject({ ok: false, failed: 1 });
    expect(translate).toHaveBeenCalledTimes(1);
    expect(frames.filter((frame) => frame.type === MESSAGE_TYPES.ITEM_DELTA)).toHaveLength(1);
    expect(
      frames.find((frame) => frame.type === MESSAGE_TYPES.ITEM_ERROR).payload
    ).toMatchObject({ code: ERROR_CODES.NETWORK });
  });

  it('鉴权失败不自动重试', async () => {
    translate.mockRejectedValue(new TranslateError(ERROR_CODES.AUTH, 'bad key'));
    const { frames } = connectPage();
    await acceptPageSubmit({
      requestId: 'no-retry-auth',
      scope: 'single',
      paragraphs: [{ hostId: 'h1', text: 'Hi' }],
      tabId: 7,
    });
    const done = await waitForBatchDoneFor(frames, 'no-retry-auth');
    expect(done.payload).toMatchObject({ ok: false, failed: 1 });
    expect(translate).toHaveBeenCalledTimes(1);
  });

  it('标签页关闭兜底清理：中止在途请求、清空提交，其它标签页不受影响', async () => {
    translate.mockImplementation(abortableTranslate);
    const first = connectPage(7);
    const second = connectPage(8);

    await acceptPageSubmit({
      requestId: 'tab-close',
      paragraphs: [{ hostId: 'h1', text: 'Slow' }],
      tabId: 7,
    });
    await vi.waitFor(() => expect(translate).toHaveBeenCalledTimes(1));
    const signal = translate.mock.calls[0][0].signal;

    expect(cleanupTab(7)).toBe(true);
    expect(signal.aborted).toBe(true);
    expect(first.frames.some((frame) => frame.type === MESSAGE_TYPES.BATCH_DONE)).toBe(false);

    const [entry] = logEntries('tab.cleanup');
    expect(entry).toMatchObject({ tabId: 7, pendingSubmissions: 1, pendingBatches: 0 });

    // 其它标签页仍可正常提交与翻译。
    translate.mockImplementation(async ({ text }) => ({
      text: `译:${text}`,
      usage: { totalTokens: 1 },
    }));
    await acceptPageSubmit({
      requestId: 'other-tab',
      scope: 'single',
      paragraphs: [{ hostId: 'o1', text: 'Other' }],
      tabId: 8,
    });
    const done = await waitForBatchDoneFor(second.frames, 'other-tab');
    expect(done.payload).toMatchObject({ ok: true, done: 1 });

    // 幂等：重复清理与未知标签页都不抛错、不重复计数。
    expect(cleanupTab(7)).toBe(false);
    expect(cleanupTab(999)).toBe(false);
  });

  it('端口断开后标签页关闭事件幂等处理', async () => {
    const { client, frames } = connectPage(7);
    await acceptPageSubmit({
      requestId: 'tab-disconnect',
      paragraphs: [{ hostId: 'h1', text: 'Hi' }],
      tabId: 7,
    });
    await waitForBatchDoneFor(frames, 'tab-disconnect');

    client.disconnect();
    expect(() => cleanupTab(7)).not.toThrow();
    expect(cleanupTab(7)).toBe(false);
  });
});
describe('A2 请求网关：跨 frame 连接', () => {
  /**
   * 以指定 frame 的 sender 建立连接。
   * @param {number} tabId
   * @param {number} frameId
   */
  function connectFrame(tabId, frameId) {
    const client = chrome.runtime.connect({
      name: PORT_NAME,
      sender: { id: chrome.runtime.id, tab: { id: tabId }, frameId },
    });
    clients.push(client);
    const frames = [];
    client.onMessage.addListener((message) => frames.push(message));
    return { client, frames };
  }

  it('同一标签页不同 frame 的连接并存，提交按 frame 路由', async () => {
    const top = connectFrame(7, 0);
    const child = connectFrame(7, 1);

    expect(listFrames(7).map((conn) => conn.frameId)).toEqual([0, 1]);

    await acceptPageSubmit({
      requestId: 'frame-submit',
      scope: 'single',
      paragraphs: [{ hostId: 'h1', text: 'Hello from child frame' }],
      tabId: 7,
      frameId: 1,
    });

    const done = await waitForBatchDoneFor(child.frames, 'frame-submit');
    expect(done.payload).toMatchObject({ ok: true, done: 1 });
    expect(child.frames.some((frame) => frame.type === MESSAGE_TYPES.ITEM_DONE)).toBe(true);
    expect(top.frames.filter((frame) => frame.type === MESSAGE_TYPES.BATCH_DONE)).toHaveLength(0);
  });

  it('同一 frame 重连只替换该 frame 的旧连接，其它 frame 不受影响', () => {
    const firstTop = connectFrame(7, 0);
    const child = connectFrame(7, 1);
    const secondTop = connectFrame(7, 0);

    expect(findConnection(7, 0)?.port.id).toBe(secondTop.client.id);
    expect(findConnection(7, 1)?.port.id).toBe(child.client.id);
    expect(findConnection(7, 0)?.port.id).not.toBe(firstTop.client.id);
    expect(listFrames(7)).toHaveLength(2);
  });

  it('未连接的 frame 提交返回 NOT_CONNECTED', async () => {
    connectFrame(7, 0);

    const result = await acceptPageSubmit({
      requestId: 'missing-frame',
      scope: 'single',
      paragraphs: [{ hostId: 'h1', text: 'Hi' }],
      tabId: 7,
      frameId: 2,
    });

    expect(result.accepted).toBe(false);
    expect(result.error.reason).toBe(FAILURE_REASONS.NOT_CONNECTED);
  });

  it('标签页关闭清理该标签页全部 frame 连接', () => {
    connectFrame(7, 0);
    connectFrame(7, 1);
    connectFrame(8, 0);

    expect(cleanupTab(7)).toBe(true);
    expect(findConnection(7, 0)).toBeNull();
    expect(findConnection(7, 1)).toBeNull();
    expect(listFrames(7)).toEqual([]);
    // 其它标签页连接保留。
    expect(findConnection(8, 0)).not.toBeNull();
  });
});
