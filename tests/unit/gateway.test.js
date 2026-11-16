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
import {
  getOrCreateDefaultInstance,
  removeKey,
  updateInstance,
  writeKey,
} from '../../src/shared/config/instances.js';
import { saveSettings } from '../../src/shared/settings.js';
import { initLogging, resetLogging } from '../../src/shared/log/logger.js';
import { buildCacheKey } from '../../src/shared/cache/key.js';
import { handleConnect, normalizeConcurrency } from '../../src/background/gateway.js';
import { translate, TranslateError } from '../../src/shared/translate/adapter.js';
import { BATCH_ENCODING_VERSION } from '../../src/shared/translate/batch.js';
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
function cacheKeyFor(text, overrides = {}) {
  return buildCacheKey({
    engineType: instance.type,
    model: instance.model,
    sourceLang: 'auto',
    targetLang: overrides.targetLang ?? 'zh',
    promptVersion: PROMPT_VERSION,
    batchEncodingVersion: BATCH_ENCODING_VERSION,
    reasoningEffort: instance.reasoningEffort,
    promptHash,
    context: overrides.context ?? '',
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

  it('ST_PING 立即回 ST_PONG，随后下发一次 ST_LOG_CONFIG', async () => {
    const { client, frames } = connectGateway();
    client.postMessage({ type: MESSAGE_TYPES.PING, payload: { sentAt: 42 } });

    expect(frames[0].type).toBe(MESSAGE_TYPES.PONG);
    expect(frames[0].payload.sentAt).toBe(42);
    expect(typeof frames[0].payload.receivedAt).toBe('number');

    await vi.waitFor(() => {
      expect(frames.some((frame) => frame.type === MESSAGE_TYPES.LOG_CONFIG)).toBe(true);
    });
    const config = frames.find((frame) => frame.type === MESSAGE_TYPES.LOG_CONFIG);
    expect(config.payload.level).toBe('info');
  });

  it('同一连接只下发一次 ST_LOG_CONFIG', async () => {
    const { client, frames } = connectGateway();
    client.postMessage({ type: MESSAGE_TYPES.PING, payload: { sentAt: 1 } });
    client.postMessage({ type: MESSAGE_TYPES.PING, payload: { sentAt: 2 } });

    await vi.waitFor(() => {
      expect(frames.filter((frame) => frame.type === MESSAGE_TYPES.LOG_CONFIG)).toHaveLength(1);
    });
    await new Promise((resolve) => setTimeout(resolve, 0));
    expect(frames.filter((frame) => frame.type === MESSAGE_TYPES.LOG_CONFIG)).toHaveLength(1);
  });

  it('日志级别非法时归一为 info', async () => {
    await chrome.storage.sync.set({ settings: { logLevel: 'nope' } });
    const { client, frames } = connectGateway();
    client.postMessage({ type: MESSAGE_TYPES.PING, payload: { sentAt: 3 } });

    await vi.waitFor(() => {
      expect(frames.some((frame) => frame.type === MESSAGE_TYPES.LOG_CONFIG)).toBe(true);
    });
    const config = frames.find((frame) => frame.type === MESSAGE_TYPES.LOG_CONFIG);
    expect(config.payload.level).toBe('info');
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
      { requestId: 'r', items: [textItem('hi')], targetLang: 'ja' },
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

describe('A2 请求网关：译文缓存（P5）', () => {
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
    expect(key).toMatch(/^cache:v2:[0-9a-f]{64}$/);
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

  it('修改提示词或思考强度后同一文本不再命中缓存', async () => {
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

    await updateInstance(instance.id, { reasoningEffort: 'high' });

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
    expect(lines.join('\n')).not.toContain('cache:v2:');
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
