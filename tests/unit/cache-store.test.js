/**
 * A4 译文缓存存取测试
 *
 * 覆盖需求文档 2.2.3 / 3.4 / 3.9：IndexedDB 结构、读写与 getMany、覆盖统计、domain 元数据、
 * 命中回写节流、容量与 LRU 淘汰、清空与 generation、统计恢复、写入异常、并发与全表扫描禁令。
 * 使用 fake-indexeddb；每个用例使用独立数据库名，互不影响。
 */

import { IDBDatabase, IDBKeyRange, IDBObjectStore, indexedDB as fakeIndexedDB } from 'fake-indexeddb';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { installChrome } from '../helpers/load.js';
import {
  CACHE_DB_NAME,
  CACHE_DB_VERSION,
  CACHE_ENTRY_OVERHEAD_BYTES,
  CACHE_EVICT_BATCH,
  CACHE_EVICT_TARGET_RATIO,
  CACHE_MAX_BYTES,
  CACHE_MAX_ENTRIES,
  CACHE_SCHEMA_VERSION,
  CACHE_TOUCH_INTERVAL_MS,
  CACHE_TOUCH_SET_LIMIT,
  createCacheStore,
} from '../../src/shared/cache/store.js';

const encoder = new TextEncoder();

/** 按 store.js 口径计算一条译文的占用字节。 */
function measureBytes(text) {
  return encoder.encode(text).byteLength + CACHE_ENTRY_OVERHEAD_BYTES;
}

/** 把 IDBRequest 包成 Promise。 */
function requestResult(request) {
  return new Promise((resolve, reject) => {
    request.onsuccess = () => resolve(request.result);
    request.onerror = () => reject(request.error ?? new Error('IndexedDB 请求失败'));
  });
}

/** 等待事务结束。 */
function transactionDone(tx) {
  return new Promise((resolve, reject) => {
    tx.oncomplete = () => resolve();
    tx.onerror = () => reject(tx.error ?? new Error('IndexedDB 事务失败'));
    tx.onabort = () => reject(tx.error ?? new Error('IndexedDB 事务中止'));
  });
}

let factorySeq = 0;

/**
 * 每个用例独立数据库名的 IndexedDB 工厂包装。
 * 记录 open 参数与事务创建，并可注入事务创建失败，用于隔离用例与模拟读写异常。
 */
function createScopedIndexedDB({ failTransaction = () => false } = {}) {
  factorySeq += 1;
  const suffix = factorySeq;
  const names = new Map();
  const openedNames = [];
  const transactions = [];
  const rawDbs = [];

  function actualName(requested) {
    if (!names.has(requested)) names.set(requested, `${requested}::test-${suffix}`);
    return names.get(requested);
  }

  function wrapDatabase(db) {
    return {
      get name() {
        return db.name;
      },
      get version() {
        return db.version;
      },
      get objectStoreNames() {
        return db.objectStoreNames;
      },
      onversionchange: null,
      onclose: null,
      transaction(storeNames, mode = 'readonly') {
        const list = Array.isArray(storeNames) ? [...storeNames] : [storeNames];
        const record = { mode, names: list, failed: false };
        transactions.push(record);
        if (failTransaction(record)) {
          record.failed = true;
          throw new Error('模拟 IndexedDB 事务失败');
        }
        return db.transaction(storeNames, mode);
      },
      close() {
        db.close();
      },
    };
  }

  return {
    openedNames,
    transactions,
    actualName,
    open(name, version) {
      openedNames.push({ name, version });
      const realRequest = fakeIndexedDB.open(actualName(name), version);
      let completed = false;
      let wrapped = null;
      const shim = {
        onupgradeneeded: null,
        onsuccess: null,
        onerror: null,
        get error() {
          return realRequest.error;
        },
        get transaction() {
          return realRequest.transaction;
        },
        get result() {
          if (!completed) return realRequest.result;
          if (!wrapped) wrapped = wrapDatabase(realRequest.result);
          return wrapped;
        },
      };
      realRequest.onupgradeneeded = (event) => shim.onupgradeneeded?.(event);
      realRequest.onsuccess = () => {
        completed = true;
        shim.onsuccess?.();
      };
      realRequest.onerror = () => shim.onerror?.();
      return shim;
    },
    async openRaw(requested = CACHE_DB_NAME) {
      const db = await new Promise((resolve, reject) => {
        const request = fakeIndexedDB.open(actualName(requested));
        request.onsuccess = () => resolve(request.result);
        request.onerror = () => reject(request.error ?? new Error('打开测试数据库失败'));
      });
      rawDbs.push(db);
      return db;
    },
    closeRaw() {
      for (const db of rawDbs.splice(0)) {
        try {
          db.close();
        } catch {
          // 已关闭，忽略。
        }
      }
    },
  };
}

let factory;
let stores;
let clock;

beforeEach(() => {
  factory = createScopedIndexedDB();
  stores = [];
  clock = 1000;
});

afterEach(async () => {
  await Promise.all(stores.map((store) => store.close().catch(() => {})));
  factory.closeRaw();
  stores = [];
  vi.restoreAllMocks();
  delete globalThis.chrome;
});

function track(store) {
  stores.push(store);
  return store;
}

function createStore(options = {}) {
  return track(createCacheStore({ indexedDB: factory, ...options }));
}

/** 覆盖固定占位键；按队列顺序等待此前排队的 touch 任务完成。 */
async function flush(store) {
  await store.set('flush:key', 'flush', { generation: store.generation() });
}

/** 打开被测 store 正在使用的同一个底层数据库（只读检查用）。 */
async function openRaw() {
  return factory.openRaw();
}

async function readAll(db, storeName) {
  const tx = db.transaction([storeName], 'readonly');
  return requestResult(tx.objectStore(storeName).getAll());
}

async function rawPut(db, storeName, value) {
  const tx = db.transaction([storeName], 'readwrite');
  const done = transactionDone(tx);
  tx.objectStore(storeName).put(value);
  await done;
}

async function rawDelete(db, storeName, key) {
  const tx = db.transaction([storeName], 'readwrite');
  const done = transactionDone(tx);
  tx.objectStore(storeName).delete(key);
  await done;
}

describe('A4 常量', () => {
  it('数据库名、版本、容量、淘汰与回写常量与文档一致', () => {
    expect(CACHE_DB_NAME).toBe('simpletrans-cache');
    expect(CACHE_DB_VERSION).toBe(2);
    expect(CACHE_SCHEMA_VERSION).toBe(1);
    expect(CACHE_MAX_BYTES).toBe(1024 * 1024 * 1024);
    expect(CACHE_MAX_ENTRIES).toBe(1_000_000);
    expect(CACHE_EVICT_TARGET_RATIO).toBe(0.9);
    expect(CACHE_EVICT_BATCH).toBe(500);
    expect(CACHE_TOUCH_INTERVAL_MS).toBe(60 * 60 * 1000);
    expect(CACHE_TOUCH_SET_LIMIT).toBe(2048);
    expect(CACHE_ENTRY_OVERHEAD_BYTES).toBe(256);
  });
});

describe('A4 建库与结构', () => {
  it('首次打开按 simpletrans-cache 建库，创建 entries / meta / stats 与 by_lastUsedAt、by_domain 索引', async () => {
    const store = createStore();
    await store.stats();

    expect(factory.openedNames).toHaveLength(1);
    expect(factory.openedNames[0]).toEqual({ name: CACHE_DB_NAME, version: CACHE_DB_VERSION });

    const db = await openRaw();
    expect(db.name).toBe(factory.actualName(CACHE_DB_NAME));
    expect(Array.from(db.objectStoreNames).sort()).toEqual(['entries', 'meta', 'stats']);

    const entries = db.transaction(['entries'], 'readonly').objectStore('entries');
    expect(entries.keyPath).toBe('key');

    const meta = db.transaction(['meta'], 'readonly').objectStore('meta');
    expect(meta.keyPath).toBe('key');
    expect(Array.from(meta.indexNames).sort()).toEqual(['by_domain', 'by_lastUsedAt']);
    expect(meta.index('by_lastUsedAt').keyPath).toBe('lastUsedAt');
    expect(meta.index('by_domain').keyPath).toBe('domain');

    const statsStore = db.transaction(['stats'], 'readonly').objectStore('stats');
    expect(statsStore.keyPath).toBe('id');
    expect(await requestResult(statsStore.get('stats'))).toEqual({
      id: 'stats',
      entries: 0,
      bytes: 0,
      schemaVersion: CACHE_SCHEMA_VERSION,
    });
  });

  it('从版本 1 升级到版本 2 时清空旧缓存并重建统计', async () => {
    // 手工建一个版本 1 的旧库，写入一条  缓存。
    const legacy = await new Promise((resolve, reject) => {
      const request = fakeIndexedDB.open(factory.actualName(CACHE_DB_NAME), 1);
      request.onupgradeneeded = () => {
        const db = request.result;
        db.createObjectStore('entries', { keyPath: 'key' });
        const meta = db.createObjectStore('meta', { keyPath: 'key' });
        meta.createIndex('by_lastUsedAt', 'lastUsedAt');
        meta.createIndex('by_domain', 'domain');
        db.createObjectStore('stats', { keyPath: 'id' });
        const tx = request.transaction;
        tx.objectStore('entries').put({
          key: `cache:v1:${'f'.repeat(64)}`,
          text: '旧译文',
          bytes: 300,
          createdAt: 1,
        });
        tx.objectStore('stats').put({
          id: 'stats',
          entries: 1,
          bytes: 300,
          schemaVersion: 1,
        });
      };
      request.onsuccess = () => resolve(request.result);
      request.onerror = () => reject(request.error ?? new Error('创建旧库失败'));
    });
    expect(legacy.version).toBe(1);
    legacy.close();

    const store = createStore();
    const stats = await store.stats();
    expect(stats.entries).toBe(0);
    expect(stats.bytes).toBe(0);

    const db = await openRaw();
    expect(db.version).toBe(CACHE_DB_VERSION);
    expect(await readAll(db, 'entries')).toEqual([]);
    expect(await readAll(db, 'meta')).toEqual([]);
    expect(await requestResult(db.transaction(['stats'], 'readonly').objectStore('stats').get('stats'))).toEqual({
      id: 'stats',
      entries: 0,
      bytes: 0,
      schemaVersion: CACHE_SCHEMA_VERSION,
    });
  });

  it('stats() 返回 entries / bytes / maxBytes / maxEntries，并反映注入上限', async () => {
    const store = createStore({ limits: { maxBytes: 2048, maxEntries: 5 } });
    const stats = await store.stats();

    expect(Object.keys(stats).sort()).toEqual(['bytes', 'entries', 'maxBytes', 'maxEntries']);
    expect(stats).toEqual({ entries: 0, bytes: 0, maxBytes: 2048, maxEntries: 5 });
  });

  it('未注入 limits 时 stats() 使用文档默认上限', async () => {
    const store = createStore();
    expect(await store.stats()).toEqual({
      entries: 0,
      bytes: 0,
      maxBytes: CACHE_MAX_BYTES,
      maxEntries: CACHE_MAX_ENTRIES,
    });
  });
});

describe('A4 读写与元数据', () => {
  it('未命中返回 null；空字符串与非字符串 key 也返回 null', async () => {
    const store = createStore();

    expect(await store.get(`cache:v1:${'a'.repeat(64)}`)).toBeNull();
    expect(await store.get('')).toBeNull();
    expect(await store.get(null)).toBeNull();
    expect(await store.get(123)).toBeNull();
  });

  it('写入后可读到译文、字节数与写入时间，并计入统计', async () => {
    clock = 1234;
    const store = createStore({ now: () => clock });
    const text = '你好，世界！Hello world.';

    const result = await store.set('cache:v1:k1', text, { domain: 'example.com' });
    expect(result).toEqual({ written: true, bytes: measureBytes(text) });

    const entry = await store.get('cache:v1:k1');
    expect(entry).toEqual({ text, bytes: measureBytes(text), createdAt: 1234 });
    expect(await store.stats()).toEqual({
      entries: 1,
      bytes: measureBytes(text),
      maxBytes: CACHE_MAX_BYTES,
      maxEntries: CACHE_MAX_ENTRIES,
    });

    await flush(store);
  });

  it('entries 与 meta 分离：entries 只放译文相关字段，meta 放容量、访问时间与域名', async () => {
    const store = createStore();
    await store.set('k1', '译文', { domain: 'example.com' });

    const db = await openRaw();
    const entriesRows = await readAll(db, 'entries');
    expect(entriesRows).toHaveLength(1);
    expect(Object.keys(entriesRows[0]).sort()).toEqual(['bytes', 'createdAt', 'key', 'text']);
    expect(entriesRows[0].text).toBe('译文');

    const metaRows = await readAll(db, 'meta');
    expect(metaRows).toHaveLength(1);
    expect(Object.keys(metaRows[0]).sort()).toEqual([
      'bytes',
      'createdAt',
      'domain',
      'key',
      'lastUsedAt',
    ]);
    expect(metaRows[0].domain).toBe('example.com');
    expect(metaRows[0].bytes).toBe(measureBytes('译文'));

    const statsRows = await readAll(db, 'stats');
    expect(Object.keys(statsRows[0]).sort()).toEqual(['bytes', 'entries', 'id', 'schemaVersion']);
  });

  it('非法或空白译文不写入', async () => {
    const store = createStore();

    expect(await store.set('k1', '')).toEqual({ written: false, bytes: 0 });
    expect(await store.set('k1', '   ')).toEqual({ written: false, bytes: 0 });
    expect(await store.set('', '译文')).toEqual({ written: false, bytes: 0 });
    expect(await store.set(null, '译文')).toEqual({ written: false, bytes: 0 });
    expect(await store.stats()).toMatchObject({ entries: 0, bytes: 0 });
  });

  it('条目结构非法（空译文或字节数非正）时按未命中处理', async () => {
    const store = createStore();
    await store.stats();
    const db = await openRaw();
    await rawPut(db, 'entries', { key: 'bad:empty', text: '', bytes: 300, createdAt: 1 });
    await rawPut(db, 'entries', { key: 'bad:bytes', text: '译文', bytes: 0, createdAt: 1 });

    expect(await store.get('bad:empty')).toBeNull();
    expect(await store.get('bad:bytes')).toBeNull();
    expect((await store.getMany(['bad:empty', 'bad:bytes'])).size).toBe(0);
  });

  it('覆盖更新只增加统计差额，保留首次 createdAt 与首次 domain', async () => {
    clock = 1000;
    const store = createStore({ now: () => clock });
    const first = 'A'.repeat(10);
    const second = 'B'.repeat(100);

    await store.set('k1', first, { domain: 'first.example' });
    clock = 2000;
    const result = await store.set('k1', second, { domain: 'second.example' });

    expect(result).toEqual({ written: true, bytes: measureBytes(second) });
    expect(await store.get('k1')).toEqual({
      text: second,
      bytes: measureBytes(second),
      createdAt: 1000,
    });
    expect(await store.stats()).toMatchObject({ entries: 1, bytes: measureBytes(second) });

    const db = await openRaw();
    const metaRows = await readAll(db, 'meta');
    expect(metaRows).toHaveLength(1);
    expect(metaRows[0].createdAt).toBe(1000);
    expect(metaRows[0].lastUsedAt).toBe(2000);
    expect(metaRows[0].domain).toBe('first.example');

    await flush(store);
  });

  it('已有条目 domain 为空时用本次 domain 补齐', async () => {
    const store = createStore();
    await store.set('k1', '译文', { domain: '' });
    await store.set('k1', '新译文', { domain: 'later.example' });

    const metaRows = await readAll(await openRaw(), 'meta');
    expect(metaRows[0].domain).toBe('later.example');
  });

  it('domain 归一为去首尾空白的字符串，非字符串按空串保存', async () => {
    const store = createStore();
    await store.set('k1', '一', { domain: '  Example.COM  ' });
    await store.set('k2', '二', { domain: 42 });

    const metaRows = await readAll(await openRaw(), 'meta');
    const byKey = new Map(metaRows.map((meta) => [meta.key, meta]));
    expect(byKey.get('k1').domain).toBe('Example.COM');
    expect(byKey.get('k2').domain).toBe('');
  });

  it('by_domain 索引能按域名查到对应条目', async () => {
    const store = createStore();
    await store.set('k1', '一', { domain: 'a.example' });
    await store.set('k2', '二', { domain: 'b.example' });
    await store.set('k3', '三', { domain: 'a.example' });

    const db = await openRaw();
    const index = db.transaction(['meta'], 'readonly').objectStore('meta').index('by_domain');
    const rowsA = await requestResult(index.getAll(IDBKeyRange.only('a.example')));
    const rowsB = await requestResult(index.getAll(IDBKeyRange.only('b.example')));

    expect(rowsA.map((row) => row.key).sort()).toEqual(['k1', 'k3']);
    expect(rowsB.map((row) => row.key)).toEqual(['k2']);
  });

  it('getMany 在一个只读事务中读取多个键并返回 Map，过滤空 key', async () => {
    const store = createStore();
    await store.set('k1', '一');
    await store.set('k2', '二');

    const txSpy = vi.spyOn(IDBDatabase.prototype, 'transaction');
    const originalGet = IDBObjectStore.prototype.get;
    const getCalls = [];
    vi.spyOn(IDBObjectStore.prototype, 'get').mockImplementation(function (key) {
      getCalls.push({ store: this.name, key });
      return originalGet.call(this, key);
    });

    const found = await store.getMany(['k1', 'missing', 'k2', '']);

    expect(found).toBeInstanceOf(Map);
    expect([...found.keys()].sort()).toEqual(['k1', 'k2']);
    expect(found.get('k1')).toMatchObject({ text: '一', bytes: measureBytes('一') });
    expect(found.has('missing')).toBe(false);

    const readonlyEntries = txSpy.mock.calls.filter(
      ([names, mode]) =>
        mode === 'readonly' && Array.isArray(names) && names.length === 1 && names[0] === 'entries'
    );
    expect(readonlyEntries).toHaveLength(1);
    expect(getCalls.filter((call) => call.store === 'entries')).toHaveLength(3);

    await flush(store);
  });

  it('getMany 空数组直接返回空 Map，不打开数据库', async () => {
    const store = createStore();

    expect(await store.getMany([])).toEqual(new Map());
    expect(await store.getMany(['', null, 1])).toEqual(new Map());
    expect(factory.openedNames).toHaveLength(0);
  });
});

describe('A4 命中回写', () => {
  it('命中只按节流更新 meta.lastUsedAt，不重写 entries.text', async () => {
    clock = 1000;
    const store = createStore({ now: () => clock });
    const text = '原文译文';
    await store.set('k1', text, { domain: 'example.com' });

    const db = await openRaw();
    const beforeEntry = (await readAll(db, 'entries')).find((entry) => entry.key === 'k1');

    const originalPut = IDBObjectStore.prototype.put;
    const entryPuts = [];
    vi.spyOn(IDBObjectStore.prototype, 'put').mockImplementation(function (value, ...rest) {
      if (this.name === 'entries') entryPuts.push(value);
      return originalPut.call(this, value, ...rest);
    });

    clock = 1000 + CACHE_TOUCH_INTERVAL_MS + 1;
    expect((await store.get('k1')).text).toBe(text);
    await flush(store);

    const meta = (await readAll(db, 'meta')).find((row) => row.key === 'k1');
    expect(meta.lastUsedAt).toBe(clock);
    const afterEntry = (await readAll(db, 'entries')).find((entry) => entry.key === 'k1');
    expect(afterEntry).toEqual(beforeEntry);
    expect(entryPuts.filter((entry) => entry.key === 'k1')).toHaveLength(0);
    // 命中路径没有重写 entries；唯一一次 entries.put 来自 flush 的占位键。
    expect(entryPuts).toHaveLength(1);
    expect(entryPuts[0].key).toBe('flush:key');
  });

  it('命中回写遵守最小间隔，且同一生命周期内同一 key 最多回写一次', async () => {
    clock = 1000;
    const store = createStore({ now: () => clock });
    await store.set('within', '一');
    await store.set('across', '二');
    const db = await openRaw();
    const lastUsedAtOf = async (key) =>
      (await readAll(db, 'meta')).find((row) => row.key === key).lastUsedAt;

    // 距写入不足最小间隔：只是标记已访问，不回写。
    clock = 1500;
    await store.get('within');
    await flush(store);
    expect(await lastUsedAtOf('within')).toBe(1000);

    // 超过最小间隔：回写为本次命中时间。
    clock = 1000 + CACHE_TOUCH_INTERVAL_MS + 1;
    await store.get('across');
    await flush(store);
    const touchedAt = clock;
    expect(await lastUsedAtOf('across')).toBe(touchedAt);

    // 同一生命周期内再次命中同一个 key：touched 集合命中，不再回写。
    clock += CACHE_TOUCH_INTERVAL_MS + 1;
    await store.get('across');
    await flush(store);
    expect(await lastUsedAtOf('across')).toBe(touchedAt);
  });

  it('命中回写集合达到上限后清空，允许旧 key 再次回写', async () => {
    clock = 1000;
    const store = createStore({
      now: () => clock,
      limits: { touchIntervalMs: 0, touchSetLimit: 2 },
    });
    await store.set('k1', '一');
    await store.set('k2', '二');
    await store.set('k3', '三');
    const db = await openRaw();
    const lastUsedAtOf = async (key) =>
      (await readAll(db, 'meta')).find((row) => row.key === key).lastUsedAt;

    clock = 2000;
    await store.get('k1');
    await flush(store);
    expect(await lastUsedAtOf('k1')).toBe(2000);

    clock = 3000;
    await store.get('k2');
    await flush(store);
    expect(await lastUsedAtOf('k2')).toBe(3000);

    // 集合已满，第三次加入前会清空集合（k1、k2 被移出）。
    clock = 4000;
    await store.get('k3');
    await flush(store);
    expect(await lastUsedAtOf('k3')).toBe(4000);

    clock = 5000;
    await store.get('k1');
    await flush(store);
    expect(await lastUsedAtOf('k1')).toBe(5000);

    // 同一个 key 连续命中也只回写一次。
    clock = 6000;
    await store.get('k1');
    await flush(store);
    expect(await lastUsedAtOf('k1')).toBe(5000);
  });

  it('命中只按 key 读取，不比较也不修改 meta.domain', async () => {
    clock = 1000;
    const store = createStore({ now: () => clock });
    await store.set('k1', '译文', { domain: 'first.example' });

    clock = 1000 + CACHE_TOUCH_INTERVAL_MS + 1;
    expect((await store.get('k1')).text).toBe('译文');
    await flush(store);

    const db = await openRaw();
    const meta = (await readAll(db, 'meta')).find((row) => row.key === 'k1');
    expect(meta.domain).toBe('first.example');
  });
});

describe('A4 容量与淘汰', () => {
  it('字节超过上限时按 by_lastUsedAt 顺序淘汰最旧条目并更新统计', async () => {
    clock = 1000;
    const store = createStore({
      now: () => clock,
      limits: { maxBytes: 2000, maxEntries: 100, evictBatch: 1 },
    });
    const text = 'x'.repeat(100);

    for (let index = 1; index <= 5; index += 1) {
      clock += 100;
      await store.set(`k${index}`, text);
    }
    expect(await store.stats()).toMatchObject({
      entries: 5,
      bytes: 5 * measureBytes(text),
    });

    clock += 100;
    await store.set('k6', text);

    const stats = await store.stats();
    expect(stats.entries).toBe(5);
    expect(stats.bytes).toBe(5 * measureBytes(text));
    expect(await store.get('k1')).toBeNull();
    expect((await store.get('k6')).text).toBe(text);

    const db = await openRaw();
    expect((await readAll(db, 'stats'))[0]).toMatchObject({
      entries: 5,
      bytes: 5 * measureBytes(text),
    });

    await flush(store);
  });

  it('条数超过上限时触发淘汰，保留最新条目', async () => {
    clock = 1000;
    const store = createStore({
      now: () => clock,
      limits: { maxEntries: 5, evictBatch: 1 },
    });
    const text = 'y'.repeat(20);

    for (let index = 1; index <= 6; index += 1) {
      clock += 100;
      await store.set(`k${index}`, text);
    }

    // 上限 5、目标 90%（4.5）：每次越界删 1 条，最终保留 k3–k6。
    const stats = await store.stats();
    expect(stats.entries).toBe(4);
    expect(stats.bytes).toBe(4 * measureBytes(text));
    expect(await store.get('k1')).toBeNull();
    expect(await store.get('k2')).toBeNull();
    for (const key of ['k3', 'k4', 'k5', 'k6']) {
      expect((await store.get(key)).text).toBe(text);
    }

    await flush(store);
  });

  it('按 by_lastUsedAt 淘汰最久未使用条目，命中会刷新其顺序', async () => {
    clock = 1000;
    const store = createStore({
      now: () => clock,
      limits: { maxEntries: 5, evictBatch: 1 },
    });

    await store.set('flush:key', 'flush');
    await store.set('k1', '译文一');
    clock += 1000;
    await store.set('k2', '译文二');
    clock += 1000;
    await store.set('k3', '译文三');
    clock += 1000;

    // 命中 k1 刷新 lastUsedAt，使其不再是「最旧」。
    clock = 1000 + CACHE_TOUCH_INTERVAL_MS + 1;
    expect((await store.get('k1')).text).toBe('译文一');
    await flush(store);
    clock += 1000;
    await store.set('k4', '译文四');

    const stats = await store.stats();
    expect(stats.entries).toBe(4);
    expect(await store.get('k2')).toBeNull();
    expect((await store.get('k1')).text).toBe('译文一');
    expect((await store.get('k3')).text).toBe('译文三');
    expect((await store.get('k4')).text).toBe('译文四');

    await flush(store);
  });

  it('超过上限时分批淘汰，每批事务结束后统计与条目保持一致', async () => {
    clock = 1000;
    const text = 'z'.repeat(50);
    const seedStore = createStore({ now: () => clock });
    for (let index = 1; index <= 12; index += 1) {
      clock += 100;
      await seedStore.set(`seed-${index}`, text);
    }
    expect((await seedStore.stats()).entries).toBe(12);

    const tightStore = createStore({
      now: () => clock,
      limits: { maxEntries: 10, evictTargetRatio: 0.5, evictBatch: 2 },
    });
    clock += 100;
    await tightStore.set('seed-13', text);

    // 13 条、目标 50%（5 条）、每批 2 条：需要 4 批才能降到上限以下。
    const stats = await tightStore.stats();
    expect(stats.entries).toBe(5);
    expect(stats.bytes).toBe(5 * measureBytes(text));

    const db = await openRaw();
    const entriesRows = await readAll(db, 'entries');
    const metaRows = await readAll(db, 'meta');
    const statsRows = await readAll(db, 'stats');

    expect(entriesRows).toHaveLength(5);
    expect(metaRows).toHaveLength(5);
    expect(statsRows[0].entries).toBe(entriesRows.length);
    expect(statsRows[0].bytes).toBe(
      entriesRows.reduce((total, entry) => total + entry.bytes, 0)
    );
    expect(entriesRows.map((entry) => entry.key).sort()).toEqual(
      ['seed-9', 'seed-10', 'seed-11', 'seed-12', 'seed-13'].sort()
    );
  });
});

describe('A4 清空与 generation', () => {
  it('clear() 返回清空条数与释放字节，只清空缓存数据库', async () => {
    installChrome();
    await chrome.storage.local.set({ 'engineKey:deepseek': 'sk-test' });
    await chrome.storage.sync.set({ settings: { cacheEnabled: false } });
    await chrome.storage.session.set({ tasks: [1] });

    const store = createStore();
    await store.set('k1', '译文一', { domain: 'a.example' });
    await store.set('k2', '译文二', { domain: 'b.example' });
    const before = await store.stats();
    expect(before.entries).toBe(2);

    const result = await store.clear();
    expect(result).toEqual({ cleared: 2, freedBytes: before.bytes });
    expect(await store.stats()).toEqual({
      entries: 0,
      bytes: 0,
      maxBytes: CACHE_MAX_BYTES,
      maxEntries: CACHE_MAX_ENTRIES,
    });
    expect(await store.get('k1')).toBeNull();

    const db = await openRaw();
    expect(await readAll(db, 'entries')).toEqual([]);
    expect(await readAll(db, 'meta')).toEqual([]);
    expect(await readAll(db, 'stats')).toEqual([
      { id: 'stats', entries: 0, bytes: 0, schemaVersion: CACHE_SCHEMA_VERSION },
    ]);

    expect((await chrome.storage.local.get('engineKey:deepseek'))['engineKey:deepseek']).toBe(
      'sk-test'
    );
    expect((await chrome.storage.sync.get('settings')).settings).toEqual({ cacheEnabled: false });
    expect((await chrome.storage.session.get('tasks')).tasks).toEqual([1]);
  });

  it('统计缺失时 clear() 仍清空条目并返回零计数', async () => {
    const store = createStore();
    await store.set('k1', '译文');
    const db = await openRaw();
    await rawDelete(db, 'stats', 'stats');

    expect(await store.clear()).toEqual({ cleared: 0, freedBytes: 0 });
    expect(await readAll(db, 'entries')).toEqual([]);
    expect(await readAll(db, 'meta')).toEqual([]);
    expect((await store.stats()).entries).toBe(0);
  });

  it('每次 clear() 递增 generation', async () => {
    const store = createStore();
    expect(store.generation()).toBe(0);
    await store.clear();
    expect(store.generation()).toBe(1);
    await store.clear();
    expect(store.generation()).toBe(2);
  });

  it('清空后在途的旧 generation 写入被跳过', async () => {
    const store = createStore();
    const staleGeneration = store.generation();

    const pendingWrite = store.set('k1', '旧译文', { generation: staleGeneration });
    const clearing = store.clear();
    const [writeResult] = await Promise.all([pendingWrite, clearing]);

    expect(writeResult).toEqual({ written: false, bytes: 0 });
    expect(await store.get('k1')).toBeNull();
    expect(store.generation()).toBe(staleGeneration + 1);
    expect((await store.stats()).entries).toBe(0);
  });

  it('generation 不一致时 set 直接跳过且不写库', async () => {
    const store = createStore();
    const staleGeneration = store.generation();
    await store.clear();

    expect(await store.set('k1', '新译文', { generation: staleGeneration })).toEqual({
      written: false,
      bytes: 0,
    });
    expect(await store.get('k1')).toBeNull();
    expect((await store.stats()).entries).toBe(0);
  });
});

describe('A4 统计恢复', () => {
  it('统计记录缺失时清空 entries / meta 并重建零值统计', async () => {
    const store = createStore();
    await store.set('k1', '译文一');
    await store.set('k2', '译文二');
    const db = await openRaw();
    await rawDelete(db, 'stats', 'stats');

    const stats = await store.stats();
    expect(stats.entries).toBe(0);
    expect(stats.bytes).toBe(0);
    expect(await store.get('k1')).toBeNull();
    expect(await readAll(db, 'entries')).toEqual([]);
    expect(await readAll(db, 'meta')).toEqual([]);
    expect(await readAll(db, 'stats')).toEqual([
      { id: 'stats', entries: 0, bytes: 0, schemaVersion: CACHE_SCHEMA_VERSION },
    ]);
  });

  it('统计版本不符时清空重建', async () => {
    const store = createStore();
    await store.set('k1', '译文');
    const db = await openRaw();
    await rawPut(db, 'stats', {
      id: 'stats',
      entries: 99,
      bytes: 999,
      schemaVersion: CACHE_SCHEMA_VERSION + 1,
    });

    const stats = await store.stats();
    expect(stats.entries).toBe(0);
    expect(stats.bytes).toBe(0);
    expect(await store.get('k1')).toBeNull();
    expect(await readAll(db, 'entries')).toEqual([]);
  });

  it('统计字段非法时清空重建', async () => {
    const store = createStore();
    await store.set('k1', '译文');
    const db = await openRaw();
    await rawPut(db, 'stats', {
      id: 'stats',
      entries: -1,
      bytes: 100,
      schemaVersion: CACHE_SCHEMA_VERSION,
    });

    const stats = await store.stats();
    expect(stats.entries).toBe(0);
    expect(stats.bytes).toBe(0);
    expect(await store.get('k1')).toBeNull();
  });

  it('写入时发现统计损坏会先清空旧缓存再写入新条目', async () => {
    const store = createStore();
    await store.set('old', '旧译文');
    const db = await openRaw();
    await rawPut(db, 'stats', {
      id: 'stats',
      entries: 5,
      bytes: 5000,
      schemaVersion: 99,
    });

    expect((await store.set('new', '新译文')).written).toBe(true);
    expect(await store.get('old')).toBeNull();
    expect((await store.get('new')).text).toBe('新译文');
    const stats = await store.stats();
    expect(stats.entries).toBe(1);
    expect(stats.bytes).toBe(measureBytes('新译文'));
  });
});

describe('A4 异常降级', () => {
  it('写入异常时先淘汰再重试一次，重试成功后正常写入', async () => {
    let failedOnce = false;
    const failingFactory = createScopedIndexedDB({
      failTransaction: (record) => {
        if (!failedOnce && record.mode === 'readwrite') {
          failedOnce = true;
          return true;
        }
        return false;
      },
    });
    const store = track(createCacheStore({ indexedDB: failingFactory }));

    const result = await store.set('k1', '重试后写入');

    expect(failedOnce).toBe(true);
    expect(result).toEqual({ written: true, bytes: measureBytes('重试后写入') });
    // 第一次写入事务失败，随后有一次淘汰统计事务，然后才是重试写入事务。
    expect(failingFactory.transactions[0]).toMatchObject({ mode: 'readwrite', failed: true });
    expect(failingFactory.transactions.length).toBeGreaterThanOrEqual(4);
    expect(failingFactory.transactions.slice(1).every((record) => !record.failed)).toBe(true);
    expect((await store.get('k1')).text).toBe('重试后写入');
  });

  it('写入始终失败时返回 written:false 且不抛出', async () => {
    const failingFactory = createScopedIndexedDB({
      failTransaction: (record) => record.mode === 'readwrite',
    });
    const store = track(createCacheStore({ indexedDB: failingFactory }));

    await expect(store.set('k1', '无法写入')).resolves.toEqual({ written: false, bytes: 0 });
    expect(await store.get('k1')).toBeNull();
  });

  it('读取异常按未命中处理，不抛出', async () => {
    const failingFactory = createScopedIndexedDB({
      failTransaction: (record) => record.mode === 'readonly',
    });
    const store = track(createCacheStore({ indexedDB: failingFactory }));

    expect(await store.get('k1')).toBeNull();
    expect((await store.getMany(['k1', 'k2'])).size).toBe(0);
  });

  it('数据库打开失败时读取按未命中、写入不抛出', async () => {
    const store = track(
      createCacheStore({
        indexedDB: {
          open() {
            throw new Error('模拟打开失败');
          },
        },
      })
    );

    expect(await store.get('k1')).toBeNull();
    expect((await store.getMany(['k1'])).size).toBe(0);
    await expect(store.set('k1', '译文')).resolves.toEqual({ written: false, bytes: 0 });
  });
});

describe('A4 并发与生命周期', () => {
  it('并发写入串行执行，统计不丢', async () => {
    const store = createStore();
    const keys = Array.from({ length: 20 }, (_, index) => `k${index}`);
    const texts = keys.map((_, index) => `译文${index}`);

    const results = await Promise.all(keys.map((key, index) => store.set(key, texts[index])));

    expect(results.every((result) => result.written)).toBe(true);
    const stats = await store.stats();
    expect(stats.entries).toBe(20);
    expect(stats.bytes).toBe(texts.reduce((total, text) => total + measureBytes(text), 0));

    const found = await store.getMany(keys);
    expect(found.size).toBe(20);

    await flush(store);
  });

  it('同一 key 并发写入按顺序覆盖，只保留一条并统计最后值', async () => {
    const store = createStore();

    await Promise.all(['甲', '乙', '丙'].map((text) => store.set('k1', text)));

    expect(await store.stats()).toMatchObject({ entries: 1, bytes: measureBytes('丙') });
    expect(await store.get('k1')).toMatchObject({ text: '丙', bytes: measureBytes('丙') });

    await flush(store);
  });

  it('close() 后重新打开仍可读写', async () => {
    clock = 1000;
    const store = createStore({ now: () => clock });
    await store.set('k1', '写入前');

    await store.close();
    expect((await store.get('k1')).text).toBe('写入前');

    await store.set('k2', '重开后');
    expect((await store.get('k2')).text).toBe('重开后');
    expect((await store.stats()).entries).toBe(2);

    await flush(store);
  });

  it('读取、写入、淘汰与清空都不使用 getAll / getAllKeys 全表扫描', async () => {
    clock = 1000;
    const store = createStore({
      now: () => clock,
      limits: { maxEntries: 2, evictBatch: 1 },
    });
    const getAllSpy = vi.spyOn(IDBObjectStore.prototype, 'getAll');
    const getAllKeysSpy = vi.spyOn(IDBObjectStore.prototype, 'getAllKeys');

    await store.set('k1', '一');
    await store.set('k2', '二');
    await store.set('k3', '三');
    await store.get('k1');
    await store.getMany(['k1', 'k2', 'k3']);
    await store.stats();
    await flush(store);
    await store.clear();

    expect(getAllSpy).not.toHaveBeenCalled();
    expect(getAllKeysSpy).not.toHaveBeenCalled();
  });
});

describe('A4 单例', () => {
  it('getCacheStore() 返回同一个实例，vi.resetModules() 后重新创建', async () => {
    const firstModule = await import('../../src/shared/cache/store.js');
    const first = firstModule.getCacheStore();
    expect(firstModule.getCacheStore()).toBe(first);

    vi.resetModules();
    const secondModule = await import('../../src/shared/cache/store.js');
    const second = secondModule.getCacheStore();
    expect(second).not.toBe(first);

    await first.close();
    await second.close();
  });
});
