/**
 * A3 翻译队列
 *
 * 模块：后台服务（A）/ A3
 * 职责：按 P6.3 切好的批次排队执行；以实例 `maxConcurrency` 限制同时在途的 job 数；
 *       单段批走单段 `translate` 保留逐字流式，多段批走 `translateBatch` 按段解析并回调。
 * 依赖：A3 adapter（translate / translateBatch / TranslateError）、A3 batch（编码版本）、
 *       E1 protocol（错误码）、E3 registry（默认并发）、E4 logger。
 * 实现阶段：P6.4（批量翻译）
 *
 * 队列只在 Service Worker 内存中存在：不持久化、不写缓存、不持有页面连接，结果通过回调交给 A2。
 */

import { ERROR_CODES } from '../protocol.js';
import { DEFAULT_MAX_CONCURRENCY } from '../config/registry.js';
import { createLogger } from '../log/logger.js';
import { BATCH_ENCODING_VERSION } from './batch.js';
import { translate, translateBatch, TranslateError } from './adapter.js';

const log = createLogger('A3');

/** 并发上限过高时只记 warn，不夹紧用户配置。 */
const QUEUE_LIMIT_WARN = 16;

/**
 * 批次内原文总长度（只用于日志）。
 * @param {Array<{ text?: string }>} groups
 * @returns {number}
 */
function groupsChars(groups) {
  return groups.reduce((sum, group) => sum + String(group?.text ?? '').length, 0);
}

/**
 * 调用 A2 回调并吞掉回调自身异常，避免中断队列或触发二次回调。
 * @param {Function | undefined} fn
 * @param {unknown} arg
 */
function invoke(fn, arg) {
  if (typeof fn !== 'function') return;
  try {
    fn(arg);
  } catch (error) {
    log.warn('queue.callback', '队列回调异常', { reason: error?.name ?? 'Error' });
  }
}

/**
 * 执行单段批：走单段 `translate`，保留 `onDelta` 逐字流式与上游 usage。
 * @param {object} job
 * @param {object} group
 * @returns {Promise<{ usage: object | null, mode: 'single' }>}
 */
async function runSingleJob(job, group) {
  const startedAt = Date.now();
  const result = await translate({
    text: group.text,
    targetLang: job.targetLang,
    instance: job.instance,
    signal: job.controller?.signal,
    onDelta: (delta) => job.onDelta?.(delta),
  });

  const text = typeof result?.text === 'string' ? result.text : '';
  log.debug('batch.item', '单段批已返回', {
    jobId: job.jobId,
    groupId: 'g0',
    elapsedMs: Date.now() - startedAt,
  });
  job.onItem?.({ group, text, usage: result?.usage ?? null, mode: 'single' });
  return { usage: result?.usage ?? null, mode: 'single' };
}

/**
 * 执行多段批：一次 `translateBatch`，按 JSONL 解析出一段就回调一段，usage 只归整批。
 * @param {object} job
 * @param {object[]} groups
 * @returns {Promise<{ usage: object | null, mode: 'batch' }>}
 */
async function runBatchJob(job, groups) {
  const startedAt = Date.now();
  const entries = groups.map((group, index) => ({
    group,
    groupId: `g${index}`,
    text: String(group?.text ?? ''),
  }));
  const byId = new Map(entries.map((entry) => [entry.groupId, entry]));

  const result = await translateBatch({
    items: entries.map(({ groupId, text }) => ({ groupId, text })),
    targetLang: job.targetLang,
    instance: job.instance,
    signal: job.controller?.signal,
    onItem: ({ groupId, text }) => {
      const entry = byId.get(groupId);
      // 运行期间被取消并从 job 摘除的 group 不再回调。
      if (!entry || !job.groups.includes(entry.group)) return;
      log.debug('batch.item', '批量段落已返回', {
        jobId: job.jobId,
        groupId,
        elapsedMs: Date.now() - startedAt,
      });
      job.onItem?.({ group: entry.group, text, usage: null, mode: 'batch' });
    },
  });

  return { usage: result?.usage ?? null, mode: 'batch' };
}

/**
 * 默认 job 执行器：单段批保留流式，多段批一次上游请求；有 `withSlot` 时经过 A2 的全局名额。
 * @param {object} job
 * @returns {Promise<{ usage: object | null, mode: string }>}
 */
async function runJob(job) {
  const groups = Array.isArray(job.groups) ? job.groups : [];
  if (groups.length === 0) return { usage: null, mode: 'empty' };

  const mode = groups.length === 1 ? 'single' : 'batch';
  const startedAt = Date.now();
  log.debug('batch.request', '执行翻译批次', {
    jobId: job.jobId,
    requestId: job.requestId ?? null,
    batchId: job.batchId ?? null,
    mode,
    groups: groups.length,
    chars: groupsChars(groups),
    encodingVersion: BATCH_ENCODING_VERSION,
    waitMs: job.queuedAt ? startedAt - job.queuedAt : 0,
  });

  const run = () => {
    // 排队等待上游名额期间可能已被取消：拿到名额后不再发请求。
    if (job.controller?.signal?.aborted) {
      throw new TranslateError(ERROR_CODES.CANCELLED, '翻译已取消');
    }
    return mode === 'single' ? runSingleJob(job, groups[0]) : runBatchJob(job, groups);
  };
  return typeof job.withSlot === 'function' ? job.withSlot(run, job.concurrency) : run();
}

/**
 * 创建翻译队列实例。测试可注入 `execute` 控制完成顺序，不依赖真实计时器与上游。
 *
 * @param {{ execute?: (job: object) => Promise<{ usage?: object | null, mode?: string }> }} [options]
 */
export function createTranslationQueue({ execute = runJob } = {}) {
  const pending = [];
  const running = new Map();
  const stats = {
    limit: DEFAULT_MAX_CONCURRENCY,
    started: 0,
    done: 0,
    failed: 0,
    cancelled: 0,
    maxRunning: 0,
  };
  let nextId = 1;

  /**
   * 在并发上限内启动队首 job。
   */
  function pump() {
    while (running.size < stats.limit && pending.length > 0) {
      const job = pending.shift();
      job.state = 'running';
      job.startedAt = Date.now();
      running.set(job.jobId, job);
      stats.started += 1;
      stats.maxRunning = Math.max(stats.maxRunning, running.size);

      log.debug('queue.start', '开始执行翻译任务', {
        jobId: job.jobId,
        requestId: job.requestId ?? null,
        batchId: job.batchId ?? null,
        groups: Array.isArray(job.groups) ? job.groups.length : 0,
        waitMs: job.startedAt - job.queuedAt,
        running: running.size,
        limit: stats.limit,
      });

      void Promise.resolve()
        .then(() => execute(job))
        .then((result) => {
          if (job.state === 'cancelled') return;
          job.state = 'done';
          job.result = result ?? null;
          stats.done += 1;
          invoke(job.onBatchDone, {
            usage: result?.usage ?? null,
            mode: result?.mode ?? null,
          });
        })
        .catch((error) => {
          if (job.state === 'cancelled') return;
          job.state = 'failed';
          stats.failed += 1;
          invoke(job.onBatchError, error);
        })
        .finally(() => {
          job.finishedAt = Date.now();
          running.delete(job.jobId);
          log.debug('queue.done', '翻译任务结束', {
            jobId: job.jobId,
            requestId: job.requestId ?? null,
            state: job.state,
            mode: job.result?.mode ?? null,
            batchItems: Array.isArray(job.groups) ? job.groups.length : 0,
            elapsedMs: job.finishedAt - (job.startedAt ?? job.finishedAt),
            usage: job.result?.usage ?? null,
            pending: pending.length,
            running: running.size,
          });
          pump();
        });
    }
  }

  /**
   * 设置并发上限：正整数，非法值忽略；只影响之后启动的 pending job。
   * @param {unknown} value
   */
  function setConcurrency(value) {
    const n = Number(value);
    if (!Number.isFinite(n) || n < 1) return stats.limit;
    stats.limit = Math.floor(n);
    if (stats.limit > QUEUE_LIMIT_WARN) {
      log.warn('queue.limit', '翻译队列并发上限较高', { limit: stats.limit });
    }
    pump();
    return stats.limit;
  }

  /**
   * 从一个 job 中摘除 group；job 没有 group 时取消整个 job。
   * @param {number} jobId
   * @param {object} group
   * @returns {boolean}
   */
  function dropGroup(jobId, group) {
    const job =
      pending.find((entry) => entry.jobId === jobId) ?? running.get(jobId) ?? null;
    if (!job) return false;
    const index = job.groups.indexOf(group);
    if (index < 0) return false;
    job.groups.splice(index, 1);
    log.debug('queue.cancel', '从翻译任务摘除段落组', {
      jobId,
      requestId: job.requestId ?? null,
      remaining: job.groups.length,
    });
    if (job.groups.length === 0) cancelJob(jobId, 'no-subscriber');
    return true;
  }

  /**
   * 取消 job：pending 立即移除并回调取消；running 置取消并 abort，由执行器收尾。
   * @param {number} jobId
   * @param {string} [reason]
   * @returns {boolean}
   */
  function cancelJob(jobId, reason = 'cancelled') {
    const index = pending.findIndex((job) => job.jobId === jobId);
    if (index >= 0) {
      const [job] = pending.splice(index, 1);
      job.state = 'cancelled';
      stats.cancelled += 1;
      log.debug('queue.cancel', '取消排队中的翻译任务', {
        jobId,
        requestId: job.requestId ?? null,
        reason,
        pending: pending.length,
        running: running.size,
      });
      invoke(job.onBatchError, new TranslateError(ERROR_CODES.CANCELLED, '翻译已取消'));
      return true;
    }

    const job = running.get(jobId);
    if (!job || job.state !== 'running') return false;
    job.state = 'cancelled';
    stats.cancelled += 1;
    log.debug('queue.cancel', '取消执行中的翻译任务', {
      jobId,
      requestId: job.requestId ?? null,
      reason,
      pending: pending.length,
      running: running.size,
    });
    try {
      job.controller?.abort();
    } catch {
      // abort 失败不影响名额释放。
    }
    // 立即释放队列名额；执行器可能稍后才因 abort 收尾，届时 finally 只做幂等清理。
    running.delete(jobId);
    pump();
    return true;
  }

  /**
   * 入队一个批次 job。
   * @param {object} job
   * @returns {{ jobId: number | null, cancel: () => void, dropGroup: (group: object) => boolean }}
   */
  function enqueueBatch(job) {
    const groups = Array.isArray(job?.groups) ? job.groups.slice() : [];
    if (groups.length === 0) {
      return { jobId: null, cancel() {}, dropGroup() { return false; } };
    }

    const entry = {
      ...job,
      jobId: nextId++,
      groups,
      state: 'pending',
      controller: job.controller ?? new AbortController(),
      queuedAt: Date.now(),
      startedAt: null,
      finishedAt: null,
      result: null,
    };
    pending.push(entry);
    log.debug('queue.enqueue', '翻译任务入队', {
      jobId: entry.jobId,
      requestId: entry.requestId ?? null,
      batchId: entry.batchId ?? null,
      groups: groups.length,
      chars: groupsChars(groups),
      pending: pending.length,
      running: running.size,
      limit: stats.limit,
    });
    pump();
    return {
      jobId: entry.jobId,
      cancel: () => cancelJob(entry.jobId),
      dropGroup: (group) => dropGroup(entry.jobId, group),
    };
  }

  /**
   * 队列统计快照；只用于日志与测试，不进入页面协议。
   * @returns {{ limit: number, pending: number, running: number, started: number, done: number, failed: number, cancelled: number, maxRunning: number }}
   */
  function getQueueStats() {
    return {
      limit: stats.limit,
      pending: pending.length,
      running: running.size,
      started: stats.started,
      done: stats.done,
      failed: stats.failed,
      cancelled: stats.cancelled,
      maxRunning: stats.maxRunning,
    };
  }

  return { setConcurrency, enqueueBatch, cancelJob, dropGroup, getQueueStats };
}

/** 全局翻译队列单例；A2 入队、A3 执行。 */
export const translationQueue = createTranslationQueue();
