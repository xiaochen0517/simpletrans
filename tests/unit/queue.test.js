/**
 * A3 翻译队列测试（P6.4）
 *
 * 注入假 `execute`，只测 FIFO、并发上限、取消、摘除 group、统计与回调口径；
 * 不依赖真实计时器、引擎或网络。
 */

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { ERROR_CODES } from '../../src/shared/protocol.js';
import { RETRY_DELAYS_MS, RETRY_JITTER_MS } from '../../src/shared/constants.js';
import { DEFAULT_MAX_CONCURRENCY } from '../../src/shared/config/registry.js';
import { createTranslationQueue } from '../../src/shared/translate/queue.js';
import { initLogging, resetLogging } from '../../src/shared/log/logger.js';

/** 可手动结算的 Promise。 */
function makeDeferred() {
  let resolve;
  let reject;
  const promise = new Promise((res, rej) => {
    resolve = res;
    reject = rej;
  });
  return { promise, resolve, reject };
}

/** 让队列的微任务（execute / then / finally）跑完。 */
async function flush() {
  await new Promise((resolve) => setTimeout(resolve, 0));
}

/**
 * 创建记录型假执行器：每个 job 返回一个待结算 Promise。
 */
function makeExecutor() {
  const calls = [];
  const execute = vi.fn((job) => {
    const deferred = makeDeferred();
    calls.push({ job, ...deferred });
    return deferred.promise;
  });
  return { execute, calls };
}

/** 构造一个最小 job。 */
function makeJob(id, overrides = {}) {
  return {
    requestId: `r-${id}`,
    batchId: `b-${id}`,
    groups: [{ key: `k-${id}`, text: `text-${id}` }],
    ...overrides,
  };
}

describe('A3 翻译队列（P6.4）', () => {
  beforeEach(() => {
    initLogging({ level: 'off', sessionId: 'queue-test' });
    vi.spyOn(console, 'debug').mockImplementation(() => {});
    vi.spyOn(console, 'info').mockImplementation(() => {});
    vi.spyOn(console, 'warn').mockImplementation(() => {});
  });

  afterEach(() => {
    resetLogging();
    vi.restoreAllMocks();
  });

  it('默认并发取实例默认值 4，FIFO 启动并释放名额', async () => {
    const { execute, calls } = makeExecutor();
    const queue = createTranslationQueue({ execute });
    const doneOrder = [];

    expect(queue.getQueueStats().limit).toBe(DEFAULT_MAX_CONCURRENCY);

    for (let i = 0; i < 5; i += 1) {
      queue.enqueueBatch(
        makeJob(i, {
          onBatchDone: () => doneOrder.push(i),
          onBatchError: () => doneOrder.push(`error-${i}`),
        })
      );
    }

    await flush();
    expect(calls.map((call) => call.job.requestId)).toEqual(['r-0', 'r-1', 'r-2', 'r-3']);
    expect(queue.getQueueStats()).toMatchObject({ pending: 1, running: 4, started: 4 });

    calls[1].resolve({ usage: { totalTokens: 2 }, mode: 'single' });
    await flush();
    expect(calls.map((call) => call.job.requestId)).toContain('r-4');
    expect(doneOrder).toEqual([1]);
    expect(queue.getQueueStats()).toMatchObject({ running: 4, done: 1 });
  });

  it('limit=1 时串行执行，前一个结束才启动下一个', async () => {
    const { execute, calls } = makeExecutor();
    const queue = createTranslationQueue({ execute });
    queue.setConcurrency(1);

    for (let i = 0; i < 3; i += 1) queue.enqueueBatch(makeJob(i));
    await flush();
    expect(calls).toHaveLength(1);

    calls[0].resolve({ usage: null, mode: 'single' });
    await flush();
    expect(calls).toHaveLength(2);

    calls[1].resolve({ usage: null, mode: 'single' });
    await flush();
    expect(calls).toHaveLength(3);
    expect(queue.getQueueStats().maxRunning).toBe(1);
  });

  it('提高 limit 只影响 pending，不改运行中的 job', async () => {
    const { execute, calls } = makeExecutor();
    const queue = createTranslationQueue({ execute });
    queue.setConcurrency(1);

    queue.enqueueBatch(makeJob(0));
    queue.enqueueBatch(makeJob(1));
    queue.enqueueBatch(makeJob(2));
    await flush();
    expect(calls).toHaveLength(1);

    queue.setConcurrency(3);
    await flush();
    expect(calls.map((call) => call.job.requestId)).toEqual(['r-0', 'r-1', 'r-2']);
    expect(queue.getQueueStats()).toMatchObject({ running: 3, pending: 0, maxRunning: 3 });
  });

  it('非法并发值被忽略，不改变当前上限', async () => {
    const { execute } = makeExecutor();
    const queue = createTranslationQueue({ execute });
    queue.setConcurrency(2);

    for (const value of [0, -1, 'x', null, undefined, 2.7]) queue.setConcurrency(value);
    expect(queue.getQueueStats().limit).toBe(2);
  });

  it('空 groups 不入队，返回空句柄', async () => {
    const { execute } = makeExecutor();
    const queue = createTranslationQueue({ execute });

    const handle = queue.enqueueBatch({ groups: [] });
    expect(handle.jobId).toBeNull();
    expect(handle.dropGroup()).toBe(false);
    handle.cancel();
    await flush();

    expect(execute).not.toHaveBeenCalled();
    expect(queue.getQueueStats()).toMatchObject({ pending: 0, running: 0, started: 0 });
  });

  it('取消排队中的 job：立即移除、回调 CANCELLED、不再执行', async () => {
    const { execute, calls } = makeExecutor();
    const queue = createTranslationQueue({ execute });
    queue.setConcurrency(1);

    const first = queue.enqueueBatch(makeJob(0));
    const onBatchError = vi.fn();
    const second = queue.enqueueBatch(makeJob(1, { onBatchError }));
    await flush();
    expect(calls).toHaveLength(1);

    expect(second.cancel()).toBe(true);
    expect(onBatchError).toHaveBeenCalledTimes(1);
    expect(onBatchError.mock.calls[0][0]).toMatchObject({ code: ERROR_CODES.CANCELLED });
    expect(queue.getQueueStats()).toMatchObject({ pending: 0, cancelled: 1 });

    calls[0].resolve({ usage: null, mode: 'single' });
    await flush();
    expect(calls).toHaveLength(1);
    expect(first.jobId).toBe(1);
  });

  it('取消执行中的 job：abort 控制器，执行器拒绝后不回调 onBatchError', async () => {
    const { execute, calls } = makeExecutor();
    const queue = createTranslationQueue({ execute });
    const onBatchError = vi.fn();
    const onBatchDone = vi.fn();
    const handle = queue.enqueueBatch(makeJob(0, { onBatchError, onBatchDone }));
    await flush();

    expect(handle.cancel()).toBe(true);
    const controllerSignal = calls[0].job.controller.signal;
    expect(controllerSignal.aborted).toBe(true);

    calls[0].reject(Object.assign(new Error('aborted'), { name: 'AbortError' }));
    await flush();

    expect(onBatchError).not.toHaveBeenCalled();
    expect(onBatchDone).not.toHaveBeenCalled();
    expect(queue.getQueueStats()).toMatchObject({ running: 0, cancelled: 1 });
  });

  it('摘除 group：还有其它 group 时继续执行，最后一个 group 摘除后取消 job', async () => {
    const { execute, calls } = makeExecutor();
    const queue = createTranslationQueue({ execute });
    const groupA = { key: 'a', text: 'A' };
    const groupB = { key: 'b', text: 'B' };
    const onBatchError = vi.fn();
    const handle = queue.enqueueBatch({
      requestId: 'r-drop',
      groups: [groupA, groupB],
      onBatchError,
    });
    await flush();

    expect(handle.dropGroup(groupA)).toBe(true);
    expect(calls[0].job.groups).toEqual([groupB]);
    expect(onBatchError).not.toHaveBeenCalled();

    expect(handle.dropGroup(groupB)).toBe(true);
    // 执行中的 job 被取消时只 abort，不回调 onBatchError；名额立即释放。
    expect(onBatchError).not.toHaveBeenCalled();
    expect(calls[0].job.controller.signal.aborted).toBe(true);
    expect(queue.getQueueStats()).toMatchObject({ running: 0, cancelled: 1 });

    calls[0].reject(Object.assign(new Error('aborted'), { name: 'AbortError' }));
    await flush();
    expect(onBatchError).not.toHaveBeenCalled();
  });

  it('执行失败回调 onBatchError 一次并释放名额', async () => {
    const { execute, calls } = makeExecutor();
    const queue = createTranslationQueue({ execute });
    const onBatchError = vi.fn();
    const onBatchDone = vi.fn();
    queue.enqueueBatch(makeJob(0, { onBatchError, onBatchDone }));
    await flush();

    calls[0].reject(new Error('boom'));
    await flush();

    expect(onBatchError).toHaveBeenCalledTimes(1);
    expect(onBatchDone).not.toHaveBeenCalled();
    expect(queue.getQueueStats()).toMatchObject({ running: 0, failed: 1, done: 0 });
  });

  it('回调自身抛错不会触发第二次回调，也不阻断队列', async () => {
    const execute = vi.fn(async () => ({ usage: null, mode: 'batch' }));
    const queue = createTranslationQueue({ execute });
    const onBatchError = vi.fn();

    queue.enqueueBatch(
      makeJob(0, {
        onBatchDone: () => {
          throw new Error('callback failed');
        },
        onBatchError,
      })
    );
    queue.enqueueBatch(makeJob(1));
    await flush();

    expect(onBatchError).not.toHaveBeenCalled();
    expect(queue.getQueueStats()).toMatchObject({ done: 2, failed: 0 });
  });

  it('getQueueStats 只含统计字段，不暴露 job', async () => {
    const { execute } = makeExecutor();
    const queue = createTranslationQueue({ execute });
    queue.enqueueBatch(makeJob(0));

    const stats = queue.getQueueStats();
    expect(Object.keys(stats).sort()).toEqual(
      ['cancelled', 'done', 'failed', 'limit', 'maxRunning', 'pending', 'running', 'started'].sort()
    );
    expect(stats).not.toHaveProperty('jobs');
  });
});

describe('A3 翻译队列：重试（P9）', () => {
  /**
   * 构造带错误码的失败。
   * @param {string} code
   * @returns {Error & { code: string }}
   */
  function failWith(code) {
    return Object.assign(new Error(`fail-${code}`), { code });
  }

  it('可重试错误按 1 秒、2 秒 + 抖动重试，第三次成功只回调一次 onBatchDone', async () => {
    const waits = [];
    const execute = vi
      .fn()
      .mockRejectedValueOnce(failWith(ERROR_CODES.NETWORK))
      .mockRejectedValueOnce(failWith(ERROR_CODES.RATE_LIMIT))
      .mockResolvedValueOnce({ usage: { totalTokens: 3 }, mode: 'batch' });
    const queue = createTranslationQueue({
      execute,
      wait: async (ms) => {
        waits.push(ms);
      },
      random: () => 0.5,
    });
    const onBatchDone = vi.fn();
    const onBatchError = vi.fn();

    queue.enqueueBatch(makeJob(0, { onBatchDone, onBatchError }));
    await flush();

    expect(execute).toHaveBeenCalledTimes(3);
    expect(waits).toEqual([
      RETRY_DELAYS_MS[0] + Math.floor(RETRY_JITTER_MS * 0.5),
      RETRY_DELAYS_MS[1] + Math.floor(RETRY_JITTER_MS * 0.5),
    ]);
    expect(onBatchDone).toHaveBeenCalledTimes(1);
    expect(onBatchDone.mock.calls[0][0]).toMatchObject({ mode: 'batch' });
    expect(onBatchError).not.toHaveBeenCalled();
    expect(queue.getQueueStats()).toMatchObject({ done: 1, failed: 0 });
  });

  it('最多 3 次尝试：用尽后只回调一次 onBatchError', async () => {
    const execute = vi.fn().mockRejectedValue(failWith(ERROR_CODES.NETWORK));
    const queue = createTranslationQueue({ execute, wait: async () => {}, random: () => 0 });
    const onBatchDone = vi.fn();
    const onBatchError = vi.fn();

    queue.enqueueBatch(makeJob(0, { onBatchDone, onBatchError }));
    await flush();

    expect(execute).toHaveBeenCalledTimes(3);
    expect(onBatchDone).not.toHaveBeenCalled();
    expect(onBatchError).toHaveBeenCalledTimes(1);
    expect(onBatchError.mock.calls[0][0]).toMatchObject({ code: ERROR_CODES.NETWORK });
    expect(queue.getQueueStats()).toMatchObject({ failed: 1, done: 0 });
  });

  it('不可重试错误（鉴权、批量对齐、未知码）只执行一次', async () => {
    for (const code of [ERROR_CODES.AUTH, ERROR_CODES.BATCH_ALIGN, 'NOPE']) {
      const execute = vi.fn().mockRejectedValue(failWith(code));
      const queue = createTranslationQueue({ execute, wait: async () => {}, random: () => 0 });
      const onBatchError = vi.fn();

      queue.enqueueBatch(makeJob(0, { onBatchError }));
      await flush();

      expect(execute, code).toHaveBeenCalledTimes(1);
      expect(onBatchError).toHaveBeenCalledTimes(1);
    }
  });

  it('canRetry 返回 false（已产生输出）时不再重试', async () => {
    const execute = vi.fn().mockRejectedValue(failWith(ERROR_CODES.NETWORK));
    const queue = createTranslationQueue({ execute, wait: async () => {}, random: () => 0 });
    const canRetry = vi.fn(() => false);
    const onBatchError = vi.fn();

    queue.enqueueBatch(makeJob(0, { canRetry, onBatchError }));
    await flush();

    expect(execute).toHaveBeenCalledTimes(1);
    expect(canRetry).toHaveBeenCalledTimes(1);
    expect(onBatchError).toHaveBeenCalledTimes(1);
  });

  it('自定义 maxAttempts / retryDelays 生效', async () => {
    const waits = [];
    const execute = vi.fn().mockRejectedValue(failWith(ERROR_CODES.RATE_LIMIT));
    const queue = createTranslationQueue({
      execute,
      wait: async (ms) => {
        waits.push(ms);
      },
      random: () => 0,
    });

    queue.enqueueBatch(makeJob(0, { maxAttempts: 2, retryDelays: [50] }));
    await flush();

    expect(execute).toHaveBeenCalledTimes(2);
    expect(waits).toEqual([50]);
  });

  it('取消重试等待：立即停止，不再执行也不回调 onBatchError', async () => {
    let releaseWait = null;
    const execute = vi.fn().mockRejectedValue(failWith(ERROR_CODES.NETWORK));
    const queue = createTranslationQueue({
      execute,
      wait: () =>
        new Promise((resolve) => {
          releaseWait = resolve;
        }),
      random: () => 0,
    });
    const onBatchError = vi.fn();
    const onBatchDone = vi.fn();

    const handle = queue.enqueueBatch(makeJob(0, { onBatchError, onBatchDone }));
    await vi.waitFor(() => expect(typeof releaseWait).toBe('function'));

    expect(handle.cancel()).toBe(true);
    releaseWait();
    await flush();

    expect(execute).toHaveBeenCalledTimes(1);
    expect(onBatchError).not.toHaveBeenCalled();
    expect(onBatchDone).not.toHaveBeenCalled();
    expect(queue.getQueueStats()).toMatchObject({ cancelled: 1, failed: 0 });
  });
});
