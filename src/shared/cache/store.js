/**
 * A4 缓存存取
 *
 * 模块：后台服务（A）/ A4
 * 职责：在扩展自己的 IndexedDB `simpletrans-cache` 中读写译文缓存，负责容量淘汰、统计与清空；
 *       失败与取消不写入，读写异常只降级为未命中/不写入。
 * 依赖：E4 日志（P5 起）。不依赖 A4 key、E2 存储与设置：key 由调用方算好传入，是否启用缓存由 A2 判断。
 * 实现阶段：P5（译文缓存）；P6.2 数据库版本 2，升级时清空 v1 缓存。
 *
 * 结构：`entries` 只放译文与字节数/写入时间；`meta` 放容量、访问时间与来源域名（含 `by_domain` 索引）；
 * `stats` 只放一行汇总。命中只更新 `meta.lastUsedAt`，绝不重写 `entries.text`。
 */

import { createLogger } from '../log/logger.js';

/** A4 日志入口。 */
const log = createLogger('A4');

/** IndexedDB 数据库名。 */
export const CACHE_DB_NAME = 'simpletrans-cache';

/** 数据库结构版本；结构变化时递增，旧库按不可信缓存清空重建。 */
export const CACHE_DB_VERSION = 2;

/** 统计记录结构版本。 */
export const CACHE_SCHEMA_VERSION = 1;

/** 应用层保守上限 1 GiB（清单的 `unlimitedStorage` 只解除浏览器配额）。 */
export const CACHE_MAX_BYTES = 1024 * 1024 * 1024;

/** 条目数上限，防止大量极小条目把索引撑大。 */
export const CACHE_MAX_ENTRIES = 1_000_000;

/** 淘汰目标比例：一次淘汰到上限的 90% 以下，避免每次写入都触发淘汰。 */
export const CACHE_EVICT_TARGET_RATIO = 0.9;

/** 单个事务最多淘汰的条数。 */
export const CACHE_EVICT_BATCH = 500;

/** 命中后回写访问时间的最小间隔。 */
export const CACHE_TOUCH_INTERVAL_MS = 60 * 60 * 1000;

/** 命中回写节流集合上限。 */
export const CACHE_TOUCH_SET_LIMIT = 2048;

/** 每条 key、索引与记录的开销估算。 */
export const CACHE_ENTRY_OVERHEAD_BYTES = 256;

/** 单次淘汰最多执行的批数，避免一次写入长时间占用 Service Worker。 */
const EVICT_MAX_BATCHES_PER_RUN = 200;

/** 存储区名。 */
const STORE_ENTRIES = 'entries';
const STORE_META = 'meta';
const STORE_STATS = 'stats';

/**
 * 统计记录零值。
 * @returns {{ id: string, entries: number, bytes: number, schemaVersion: number }}
 */
function zeroStats() {
  return { id: 'stats', entries: 0, bytes: 0, schemaVersion: CACHE_SCHEMA_VERSION };
}

/**
 * 判断统计记录是否可信：结构、类型与 schema 版本都对得上。
 * @param {unknown} value
 * @returns {boolean}
 */
function isValidStats(value) {
  return Boolean(
    value &&
      typeof value === 'object' &&
      value.id === 'stats' &&
      Number.isFinite(value.entries) &&
      value.entries >= 0 &&
      Number.isFinite(value.bytes) &&
      value.bytes >= 0 &&
      value.schemaVersion === CACHE_SCHEMA_VERSION
  );
}

/**
 * 判断条目是否有效：译文非空、字节数为正。
 * @param {unknown} value
 * @returns {boolean}
 */
function isValidEntry(value) {
  return Boolean(
    value &&
      typeof value === 'object' &&
      typeof value.text === 'string' &&
      value.text.trim() !== '' &&
      Number.isFinite(value.bytes) &&
      value.bytes > 0
  );
}

/**
 * 归一来源域名：只接受字符串，去掉首尾空白；其余一律空串。
 * @param {unknown} value
 * @returns {string}
 */
function normalizeMetaDomain(value) {
  return typeof value === 'string' ? value.trim() : '';
}

/**
 * 统计一条译文的占用字节数。
 * @param {string} text
 * @returns {number}
 */
function measureBytes(text) {
  return new TextEncoder().encode(text).byteLength + CACHE_ENTRY_OVERHEAD_BYTES;
}

/**
 * 把一个 IndexedDB 请求包成 Promise。
 * @param {IDBRequest} request
 * @returns {Promise<any>}
 */
function requestAsPromise(request) {
  return new Promise((resolve, reject) => {
    request.onsuccess = () => resolve(request.result);
    request.onerror = () => reject(request.error ?? new Error('IndexedDB 请求失败'));
  });
}

/**
 * 等待事务结束；成功才 resolve。
 * @param {IDBTransaction} tx
 * @returns {Promise<void>}
 */
function transactionDone(tx) {
  return new Promise((resolve, reject) => {
    tx.oncomplete = () => resolve();
    tx.onerror = () => reject(tx.error ?? new Error('IndexedDB 事务失败'));
    tx.onabort = () => reject(tx.error ?? new Error('IndexedDB 事务已中止'));
  });
}

/**
 * 创建缓存存取接口。
 *
 * @param {{
 *   indexedDB?: IDBFactory,
 *   now?: () => number,
 *   limits?: {
 *     maxBytes?: number,
 *     maxEntries?: number,
 *     evictTargetRatio?: number,
 *     evictBatch?: number,
 *     touchIntervalMs?: number,
 *     touchSetLimit?: number,
 *   },
 * }} [options]
 */
export function createCacheStore({ indexedDB = globalThis.indexedDB, now = Date.now, limits = {} } = {}) {
  const maxBytes = Number.isFinite(limits.maxBytes) ? limits.maxBytes : CACHE_MAX_BYTES;
  const maxEntries = Number.isFinite(limits.maxEntries) ? limits.maxEntries : CACHE_MAX_ENTRIES;
  const evictTargetRatio = Number.isFinite(limits.evictTargetRatio)
    ? limits.evictTargetRatio
    : CACHE_EVICT_TARGET_RATIO;
  const evictBatch = Number.isFinite(limits.evictBatch) ? limits.evictBatch : CACHE_EVICT_BATCH;
  const touchIntervalMs = Number.isFinite(limits.touchIntervalMs)
    ? limits.touchIntervalMs
    : CACHE_TOUCH_INTERVAL_MS;
  const touchSetLimit = Number.isFinite(limits.touchSetLimit)
    ? limits.touchSetLimit
    : CACHE_TOUCH_SET_LIMIT;

  /** @type {Promise<IDBDatabase> | null} */
  let dbPromise = null;
  /** 清空代：清空后旧批次未完成的写入被跳过。 */
  let generation = 0;
  /** 写入队列：串行化写入、淘汰与清空，避免并发改 stats。 */
  let queue = Promise.resolve();
  /** 本 SW 生命周期内已回写访问时间的 key。 */
  const touched = new Set();

  /**
   * 把任务排进写入队列；前一个任务失败不影响后续任务。
   * @template T
   * @param {() => Promise<T>} task
   * @returns {Promise<T>}
   */
  function enqueue(task) {
    const run = queue.then(task, task);
    queue = run.then(
      () => {},
      () => {}
    );
    return run;
  }

  /**
   * 懒打开数据库；失败后下次操作重试。升级时不迁移旧缓存，直接按当前结构重建。
   * @returns {Promise<IDBDatabase>}
   */
  function openDatabase() {
    if (dbPromise) return dbPromise;

    dbPromise = new Promise((resolve, reject) => {
      let request;
      try {
        request = indexedDB.open(CACHE_DB_NAME, CACHE_DB_VERSION);
      } catch (error) {
        dbPromise = null;
        reject(error);
        return;
      }

      request.onupgradeneeded = () => {
        const db = request.result;
        for (const name of [STORE_ENTRIES, STORE_META, STORE_STATS]) {
          if (db.objectStoreNames.contains(name)) db.deleteObjectStore(name);
        }

        db.createObjectStore(STORE_ENTRIES, { keyPath: 'key' });
        const meta = db.createObjectStore(STORE_META, { keyPath: 'key' });
        meta.createIndex('by_lastUsedAt', 'lastUsedAt');
        meta.createIndex('by_domain', 'domain');
        db.createObjectStore(STORE_STATS, { keyPath: 'id' });

        const tx = request.transaction;
        tx?.objectStore(STORE_STATS).put(zeroStats());
      };

      request.onsuccess = () => {
        const db = request.result;
        db.onversionchange = () => {
          try {
            db.close();
          } catch {
            // 已关闭，忽略。
          }
          dbPromise = null;
        };
        db.onclose = () => {
          dbPromise = null;
        };
        resolve(db);
      };

      request.onerror = () => {
        dbPromise = null;
        reject(request.error ?? new Error('打开缓存数据库失败'));
      };
    });

    return dbPromise;
  }

  /**
   * 在指定存储区上执行一次事务；回调只等待 IDB 请求，不 await 其它 Promise。
   * @template T
   * @param {'readonly'|'readwrite'} mode
   * @param {string[]} stores
   * @param {(tx: IDBTransaction) => Promise<T>} fn
   * @returns {Promise<T>}
   */
  async function runTransaction(mode, stores, fn) {
    const db = await openDatabase();
    const tx = db.transaction(stores, mode);
    const done = transactionDone(tx);

    let result;
    try {
      result = await fn(tx);
    } catch (error) {
      try {
        tx.abort();
      } catch {
        // 事务可能已结束，忽略。
      }
      done.catch(() => {});
      throw error;
    }

    await done;
    return result;
  }

  /**
   * 读取统计；缺失或结构不符时清空缓存并重建零值统计（缓存可丢弃，不做全库扫描）。
   * 必须在 readwrite 事务内调用。
   * @param {IDBTransaction} tx
   * @returns {Promise<{ id: string, entries: number, bytes: number, schemaVersion: number }>}
   */
  async function ensureStats(tx) {
    const stored = await requestAsPromise(tx.objectStore(STORE_STATS).get('stats'));
    if (isValidStats(stored)) return stored;

    await Promise.all([
      requestAsPromise(tx.objectStore(STORE_ENTRIES).clear()),
      requestAsPromise(tx.objectStore(STORE_META).clear()),
      requestAsPromise(tx.objectStore(STORE_STATS).put(zeroStats())),
    ]);
    log.warn('cache.stats.reset', '缓存统计缺失或结构不符，已清空缓存并重建统计');
    return zeroStats();
  }

  /**
   * 只读统计，异常归零不抛出（内部淘汰判断用）。
   * @returns {Promise<{ entries: number, bytes: number }>}
   */
  async function readStatsQuietly() {
    try {
      return await runTransaction('readwrite', [STORE_ENTRIES, STORE_META, STORE_STATS], (tx) =>
        ensureStats(tx)
      );
    } catch (error) {
      log.warn('cache.error', '读取缓存统计失败', { reason: summarizeError(error) });
      return { entries: 0, bytes: 0 };
    }
  }

  /**
   * 淘汰一批：按 `by_lastUsedAt` 从最旧开始删除对应 `entries` 与 `meta`，并更新统计。
   * @returns {Promise<number>} 本批删除条数
   */
  async function evictBatchOnce() {
    return runTransaction(
      'readwrite',
      [STORE_ENTRIES, STORE_META, STORE_STATS],
      async (tx) => {
        const stats = await ensureStats(tx);
        const metaStore = tx.objectStore(STORE_META);
        const entriesStore = tx.objectStore(STORE_ENTRIES);

        let count = 0;
        let freed = 0;

        await new Promise((resolve, reject) => {
          const request = metaStore.index('by_lastUsedAt').openCursor();
          request.onerror = () => reject(request.error ?? new Error('读取缓存索引失败'));
          request.onsuccess = () => {
            const cursor = request.result;
            if (!cursor || count >= evictBatch) {
              resolve();
              return;
            }
            const key = cursor.primaryKey;
            freed += Number(cursor.value?.bytes) || 0;
            count += 1;
            entriesStore.delete(key);
            cursor.delete();
            cursor.continue();
          };
        });

        if (count === 0) return 0;

        const nextEntries = Math.max(0, stats.entries - count);
        const nextBytes = Math.max(0, stats.bytes - freed);
        await requestAsPromise(
          tx.objectStore(STORE_STATS).put({
            id: 'stats',
            entries: nextEntries,
            bytes: nextBytes,
            schemaVersion: CACHE_SCHEMA_VERSION,
          })
        );

        log.info('cache.evict', '淘汰缓存条目', {
          removed: count,
          freedBytes: freed,
          entries: nextEntries,
          bytes: nextBytes,
        });
        return count;
      }
    );
  }

  /**
   * 超出上限就分批淘汰到目标比例以下。
   * @param {number} [ratio]
   * @returns {Promise<void>}
   */
  async function evictIfNeeded(ratio = evictTargetRatio) {
    const limitBytes = maxBytes * ratio;
    const limitEntries = maxEntries * ratio;
    const startGeneration = generation;

    for (let round = 0; round < EVICT_MAX_BATCHES_PER_RUN; round += 1) {
      const stats = await readStatsQuietly();
      if (stats.bytes <= limitBytes && stats.entries <= limitEntries) return;
      if (generation !== startGeneration) return;
      if (stats.entries === 0) {
        // 统计仍超限但没有条目：重置统计，避免死循环。
        await runTransaction('readwrite', [STORE_ENTRIES, STORE_META, STORE_STATS], async (tx) => {
          await requestAsPromise(tx.objectStore(STORE_STATS).put(zeroStats()));
        });
        return;
      }

      const removed = await evictBatchOnce();
      if (removed === 0) return;
    }
  }

  /**
   * 写入一条译文（同一事务内更新 entries / meta / stats）。
   * @param {string} key
   * @param {string} text
   * @param {number} bytes
   * @param {string} domain
   * @returns {Promise<void>}
   */
  async function writeEntry(key, text, bytes, domain) {
    await runTransaction(
      'readwrite',
      [STORE_ENTRIES, STORE_META, STORE_STATS],
      async (tx) => {
        const entriesStore = tx.objectStore(STORE_ENTRIES);
        const metaStore = tx.objectStore(STORE_META);
        const statsStore = tx.objectStore(STORE_STATS);

        const stats = await ensureStats(tx);
        const oldMeta = await requestAsPromise(metaStore.get(key));
        const createdAt =
          oldMeta && Number.isFinite(oldMeta.createdAt) ? oldMeta.createdAt : now();
        const oldBytes = oldMeta && Number.isFinite(oldMeta.bytes) ? oldMeta.bytes : 0;
        const keptDomain =
          oldMeta && typeof oldMeta.domain === 'string' && oldMeta.domain !== ''
            ? oldMeta.domain
            : domain;

        await Promise.all([
          requestAsPromise(entriesStore.put({ key, text, bytes, createdAt })),
          requestAsPromise(
            metaStore.put({ key, bytes, createdAt, lastUsedAt: now(), domain: keptDomain })
          ),
        ]);

        await requestAsPromise(
          statsStore.put({
            id: 'stats',
            entries: Math.max(0, stats.entries + (oldMeta ? 0 : 1)),
            bytes: Math.max(0, stats.bytes - oldBytes + bytes),
            schemaVersion: CACHE_SCHEMA_VERSION,
          })
        );
      }
    );
  }

  /**
   * 命中后异步回写访问时间：同一 SW 生命周期内同一 key 最多一次，且不超过最小间隔。
   * @param {string} key
   */
  function scheduleTouch(key) {
    if (touched.has(key)) return;
    if (touched.size >= touchSetLimit) touched.clear();
    touched.add(key);

    const at = now();
    void enqueue(async () => {
      try {
        await runTransaction('readwrite', [STORE_META], async (tx) => {
          const metaStore = tx.objectStore(STORE_META);
          const meta = await requestAsPromise(metaStore.get(key));
          if (!meta) return;
          const last = Number.isFinite(meta.lastUsedAt) ? meta.lastUsedAt : 0;
          if (at - last < touchIntervalMs) return;
          await requestAsPromise(metaStore.put({ ...meta, lastUsedAt: at }));
        });
      } catch {
        // 访问时间只影响淘汰顺序，失败无需处理。
      }
    }).catch(() => {});
  }

  return {
    /**
     * 读取一条缓存。
     * @param {string} key
     * @returns {Promise<{ text: string, bytes: number, createdAt: number } | null>}
     */
    async get(key) {
      if (typeof key !== 'string' || key === '') return null;
      try {
        const entry = await runTransaction('readonly', [STORE_ENTRIES], (tx) =>
          requestAsPromise(tx.objectStore(STORE_ENTRIES).get(key))
        );
        if (!isValidEntry(entry)) return null;
        scheduleTouch(key);
        return { text: entry.text, bytes: entry.bytes, createdAt: entry.createdAt };
      } catch (error) {
        log.warn('cache.error', '读取缓存失败，按未命中处理', { reason: summarizeError(error) });
        return null;
      }
    },

    /**
     * 在一个只读事务中读多条缓存。
     * @param {string[]} keys
     * @returns {Promise<Map<string, { text: string, bytes: number, createdAt: number }>>}
     */
    async getMany(keys) {
      const list = Array.isArray(keys) ? keys.filter((key) => typeof key === 'string' && key !== '') : [];
      const found = new Map();
      if (list.length === 0) return found;

      try {
        const results = await runTransaction('readonly', [STORE_ENTRIES], (tx) => {
          const entriesStore = tx.objectStore(STORE_ENTRIES);
          return Promise.all(list.map((key) => requestAsPromise(entriesStore.get(key))));
        });

        results.forEach((entry, index) => {
          if (!isValidEntry(entry)) return;
          const key = list[index];
          found.set(key, { text: entry.text, bytes: entry.bytes, createdAt: entry.createdAt });
          scheduleTouch(key);
        });
        return found;
      } catch (error) {
        log.warn('cache.error', '批量读取缓存失败，按未命中处理', {
          reason: summarizeError(error),
        });
        return new Map();
      }
    },

    /**
     * 写入一条译文；失败只记日志并返回 `written: false`，不抛出。
     * @param {string} key
     * @param {string} text
     * @param {{ generation?: number, domain?: string }} [options]
     * @returns {Promise<{ written: boolean, bytes: number }>}
     */
    async set(key, text, options = {}) {
      if (typeof key !== 'string' || key === '') return { written: false, bytes: 0 };
      if (typeof text !== 'string' || text.trim() === '') return { written: false, bytes: 0 };

      const expected = options.generation;
      const checkGeneration = Number.isFinite(expected);
      if (checkGeneration && expected !== generation) return { written: false, bytes: 0 };

      const domain = normalizeMetaDomain(options.domain);
      const bytes = measureBytes(text);

      return enqueue(async () => {
        if (checkGeneration && expected !== generation) return { written: false, bytes: 0 };

        try {
          await writeEntry(key, text, bytes, domain);
        } catch (error) {
          log.warn('cache.quota', '写入缓存失败，先淘汰再重试', {
            bytes,
            reason: summarizeError(error),
          });
          try {
            await evictIfNeeded(0.7);
            await writeEntry(key, text, bytes, domain);
          } catch (retryError) {
            log.warn('cache.error', '写入缓存失败，已放弃本次写入', {
              bytes,
              reason: summarizeError(retryError),
            });
            return { written: false, bytes: 0 };
          }
        }

        try {
          await evictIfNeeded();
        } catch (error) {
          log.warn('cache.error', '缓存淘汰失败', { reason: summarizeError(error) });
        }

        return { written: true, bytes };
      });
    },

    /**
     * 清空缓存库并重置统计；失败抛出，由调用方归一为 OTHER。
     * @returns {Promise<{ cleared: number, freedBytes: number }>}
     */
    async clear() {
      generation += 1;

      return enqueue(async () => {
        const result = await runTransaction(
          'readwrite',
          [STORE_ENTRIES, STORE_META, STORE_STATS],
          async (tx) => {
            const stored = await requestAsPromise(tx.objectStore(STORE_STATS).get('stats'));
            const cleared = isValidStats(stored) ? stored.entries : 0;
            const freedBytes = isValidStats(stored) ? stored.bytes : 0;

            await Promise.all([
              requestAsPromise(tx.objectStore(STORE_ENTRIES).clear()),
              requestAsPromise(tx.objectStore(STORE_META).clear()),
              requestAsPromise(tx.objectStore(STORE_STATS).put(zeroStats())),
            ]);

            return { cleared, freedBytes };
          }
        );

        touched.clear();
        log.info('cache.clear', '已清空缓存', {
          cleared: result.cleared,
          freedBytes: result.freedBytes,
        });
        return result;
      });
    },

    /**
     * 读取占用汇总；只读 `stats` 一行，不扫描条目。
     * @returns {Promise<{ entries: number, bytes: number, maxBytes: number, maxEntries: number }>}
     */
    async stats() {
      const stats = await runTransaction(
        'readwrite',
        [STORE_ENTRIES, STORE_META, STORE_STATS],
        (tx) => ensureStats(tx)
      );
      return {
        entries: stats.entries,
        bytes: stats.bytes,
        maxBytes,
        maxEntries,
      };
    },

    /**
     * 当前清空代；清空前已开始、清空后完成的写入据此跳过。
     * @returns {number}
     */
    generation() {
      return generation;
    },

    /**
     * 关闭数据库连接（测试与 SW 卸载用）。
     * @returns {Promise<void>}
     */
    async close() {
      const pending = dbPromise;
      dbPromise = null;
      touched.clear();
      if (!pending) return;
      try {
        const db = await pending;
        db.close();
      } catch {
        // 打开失败或已关闭，忽略。
      }
    },
  };
}

/**
 * 把异常压成不含文本、key 与地址的简短摘要。
 * @param {unknown} error
 * @returns {string}
 */
function summarizeError(error) {
  const name = String(error?.name ?? 'Error');
  const message = String(error?.message ?? '');
  return message ? `${name}: ${message.slice(0, 120)}` : name;
}

/** @type {ReturnType<typeof createCacheStore> | null} */
let singleton = null;

/**
 * 后台共用单例；A2 查/写缓存与 A1 统计/清空都从这里取。
 * @returns {ReturnType<typeof createCacheStore>}
 */
export function getCacheStore() {
  if (!singleton) singleton = createCacheStore();
  return singleton;
}
