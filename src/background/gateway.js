/**
 * A2 请求网关
 *
 * 模块：后台服务（A）/ A2
 * 职责：接收页面注入的批次请求，校验载荷、控制全局并发与每连接在途数量、调用 A3 并转发增量与定稿；
 *       处理取消、断线与批超时；不保存任务状态，不写 storage。
 * 依赖：A3（adapter）、E1（protocol）、E2（settings）、E3（instances/registry）、constants.js（P2 起）。
 * 实现阶段：P2（后台网关与页面通道）
 */

import {
  ERROR_CODES,
  FAILURE_REASONS,
  MESSAGE_TYPES,
  PORT_NAME,
  findForbiddenField,
  makeError,
  normalizeTraceId,
} from '../shared/protocol.js';
import {
  AI_TIMEOUT_MS,
  DEFAULT_CONCURRENCY,
  GLOBAL_CONCURRENCY,
  MAX_BATCH_CHARS,
  MAX_BATCH_CONTEXT_CHARS,
  MAX_BATCH_ITEMS,
  MAX_CONTEXT_CHARS,
  MAX_INFLIGHT_BATCHES_PER_PORT,
  MAX_SEGMENT_CHARS,
} from '../shared/constants.js';
import { getSettings } from '../shared/settings.js';
import { createLogger, getLogLevel, setLogLevel } from '../shared/log/logger.js';
import { normalizeLevel } from '../shared/log/levels.js';
import { getInstances, getKey } from '../shared/config/instances.js';
import { validateInstance } from '../shared/config/registry.js';
import { isSupportedTargetLang, translate, TranslateError } from '../shared/translate/adapter.js';

/** 网关日志入口。 */
const log = createLogger('A2');

/** 已连接端口：Port → { port, batches, disconnected, logConfigSent }。只在内存中存在。 */
const connections = new Map();

/** 全局上游并发信号量。 */
let activeSlots = 0;
let slotLimit = DEFAULT_CONCURRENCY;
const slotWaiters = [];

/**
 * 归一用户并发数：1–4，非法值回退默认 3。
 * @param {unknown} value
 * @returns {number}
 */
export function normalizeConcurrency(value) {
  const n = Number(value);
  if (!Number.isFinite(n) || n < 1) return DEFAULT_CONCURRENCY;
  return Math.min(Math.floor(n), GLOBAL_CONCURRENCY);
}

function pumpSlots() {
  while (activeSlots < slotLimit && slotWaiters.length > 0) {
    activeSlots += 1;
    const resolve = slotWaiters.shift();
    resolve();
  }
}

function acquireSlot() {
  return new Promise((resolve) => {
    slotWaiters.push(resolve);
    pumpSlots();
  });
}

function releaseSlot() {
  activeSlots = Math.max(0, activeSlots - 1);
  pumpSlots();
}

/**
 * 在全局并发名额内执行一次上游调用。所有上游出口（批次与测试翻译）都必须经过这里。
 * @template T
 * @param {() => Promise<T>} fn
 * @param {number} [limit]
 * @returns {Promise<T>}
 */
export async function withUpstreamSlot(fn, limit) {
  const effective =
    limit == null ? normalizeConcurrency((await getSettings()).concurrency) : normalizeConcurrency(limit);
  slotLimit = effective;
  pumpSlots();
  await acquireSlot();
  try {
    return await fn();
  } finally {
    releaseSlot();
  }
}

/**
 * 注册一个 st-gateway 端口。端口名或发送方不合法时直接断开。
 * @param {chrome.runtime.Port} port
 * @returns {object | null}
 */
export function handleConnect(port) {
  if (!port || port.name !== PORT_NAME || port.sender?.id !== chrome.runtime.id) {
    try {
      port?.disconnect?.();
    } catch {
      // 端口已断开，忽略。
    }
    return null;
  }

  const conn = { port, batches: new Map(), disconnected: false, logConfigSent: false };
  connections.set(port, conn);
  log.info('gateway.connect', '网关已连接', { tabId: port.sender?.tab?.id ?? null });

  port.onMessage.addListener((message) => onMessage(conn, message));
  port.onDisconnect.addListener(() => cleanupConnection(conn));
  return conn;
}

/**
 * 每个连接只下发一次日志级别；读取设置失败时用当前缓存级别（默认 info）。
 * @param {object} conn
 */
async function sendLogConfig(conn) {
  if (!conn || conn.disconnected || conn.logConfigSent) return;
  conn.logConfigSent = true;

  let level = getLogLevel();
  try {
    const settings = await getSettings();
    level = normalizeLevel(settings.logLevel);
    setLogLevel(level);
  } catch {
    // 读取失败时保留当前级别，不中断连接。
  }

  if (conn.disconnected) return;
  send(conn, { type: MESSAGE_TYPES.LOG_CONFIG, payload: { level } });
}

/**
 * @param {object} conn
 * @param {unknown} message
 */
function onMessage(conn, message) {
  if (conn.disconnected) return;
  const type = message?.type;
  const payload = message?.payload;

  if (type === MESSAGE_TYPES.PING) {
    send(conn, {
      type: MESSAGE_TYPES.PONG,
      payload: { sentAt: payload?.sentAt ?? null, receivedAt: Date.now() },
    });
    void sendLogConfig(conn);
    return;
  }

  if (type === MESSAGE_TYPES.TRANSLATE_BATCH) {
    void beginBatch(conn, payload).catch((error) => {
      rejectBatch(
        conn,
        payload?.requestId,
        ERROR_CODES.OTHER,
        `请求处理失败：${error?.message ?? error}`,
        FAILURE_REASONS.INVALID_MESSAGE
      );
    });
    return;
  }

  if (type === MESSAGE_TYPES.CANCEL_BATCH) {
    cancelBatch(conn, payload);
    return;
  }

  if (type === MESSAGE_TYPES.CANCEL_ITEM) {
    cancelItem(conn, payload);
    return;
  }

  if (type === MESSAGE_TYPES.CLOSE) {
    cleanupConnection(conn);
    try {
      conn.port.disconnect();
    } catch {
      // 端口已断开，忽略。
    }
    return;
  }

  rejectBatch(
    conn,
    payload?.requestId,
    ERROR_CODES.OTHER,
    '无法识别的消息',
    FAILURE_REASONS.INVALID_MESSAGE
  );
}

function isValidRequestId(value) {
  return typeof value === 'string' && value.length > 0 && value.length <= 64;
}

/**
 * @param {object} conn
 * @param {unknown} payload
 */
async function beginBatch(conn, payload) {
  if (!payload || typeof payload !== 'object' || Array.isArray(payload)) {
    rejectBatch(conn, null, ERROR_CODES.OTHER, '请求参数无效', FAILURE_REASONS.INVALID_MESSAGE);
    return;
  }

  const requestId = payload.requestId;
  if (!isValidRequestId(requestId)) {
    rejectBatch(conn, null, ERROR_CODES.OTHER, '请求编号无效', FAILURE_REASONS.INVALID_REQUEST_ID);
    return;
  }
  const traceId = normalizeTraceId(payload.traceId);
  if (conn.batches.has(requestId)) {
    rejectBatch(conn, requestId, ERROR_CODES.OTHER, '请求编号重复', FAILURE_REASONS.DUPLICATE_REQUEST);
    return;
  }

  const items = payload.items;
  if (!Array.isArray(items) || items.length < 1 || items.length > MAX_BATCH_ITEMS) {
    rejectBatch(
      conn,
      requestId,
      ERROR_CODES.OTHER,
      `批次需要 1–${MAX_BATCH_ITEMS} 段文本`,
      FAILURE_REASONS.INVALID_ITEMS
    );
    return;
  }

  const seenItemIds = new Set();
  const normalized = [];
  let totalChars = 0;
  let totalContextChars = 0;

  for (const raw of items) {
    if (!raw || typeof raw !== 'object' || Array.isArray(raw)) {
      rejectBatch(conn, requestId, ERROR_CODES.OTHER, '批次内容无效', FAILURE_REASONS.INVALID_ITEMS);
      return;
    }
    if (typeof raw.itemId !== 'string' || raw.itemId.length === 0 || raw.itemId.length > 64) {
      rejectBatch(conn, requestId, ERROR_CODES.OTHER, '段落编号无效', FAILURE_REASONS.INVALID_ITEMS);
      return;
    }
    if (seenItemIds.has(raw.itemId)) {
      rejectBatch(conn, requestId, ERROR_CODES.OTHER, '段落编号重复', FAILURE_REASONS.DUPLICATE_ITEM_ID);
      return;
    }
    seenItemIds.add(raw.itemId);

    if (typeof raw.text !== 'string') {
      rejectBatch(conn, requestId, ERROR_CODES.OTHER, '段落文本无效', FAILURE_REASONS.INVALID_ITEMS);
      return;
    }
    if (raw.text.trim() === '') {
      rejectBatch(conn, requestId, ERROR_CODES.OTHER, '存在空段落', FAILURE_REASONS.EMPTY_TEXT);
      return;
    }
    if (raw.text.length > MAX_SEGMENT_CHARS) {
      rejectBatch(
        conn,
        requestId,
        ERROR_CODES.OTHER,
        `单段超过 ${MAX_SEGMENT_CHARS} 字符`,
        FAILURE_REASONS.TEXT_TOO_LONG
      );
      return;
    }

    let context = '';
    if (raw.context != null) {
      if (typeof raw.context !== 'string') {
        rejectBatch(conn, requestId, ERROR_CODES.OTHER, '上下文无效', FAILURE_REASONS.INVALID_ITEMS);
        return;
      }
      if (raw.context.length > MAX_CONTEXT_CHARS) {
        rejectBatch(
          conn,
          requestId,
          ERROR_CODES.OTHER,
          `段落上下文超过 ${MAX_CONTEXT_CHARS} 字符`,
          FAILURE_REASONS.CONTEXT_TOO_LONG
        );
        return;
      }
      context = raw.context;
    }

    totalChars += raw.text.length;
    totalContextChars += context.length;
    normalized.push({ itemId: raw.itemId, text: raw.text, context });
  }

  if (totalChars > MAX_BATCH_CHARS) {
    rejectBatch(
      conn,
      requestId,
      ERROR_CODES.OTHER,
      `单批超过 ${MAX_BATCH_CHARS} 字符`,
      FAILURE_REASONS.BATCH_TOO_LARGE
    );
    return;
  }

  if (payload.context != null) {
    if (typeof payload.context !== 'string') {
      rejectBatch(conn, requestId, ERROR_CODES.OTHER, '批次上下文无效', FAILURE_REASONS.INVALID_ITEMS);
      return;
    }
    if (payload.context.length > MAX_BATCH_CONTEXT_CHARS) {
      rejectBatch(
        conn,
        requestId,
        ERROR_CODES.OTHER,
        `批次上下文超过 ${MAX_BATCH_CONTEXT_CHARS} 字符`,
        FAILURE_REASONS.CONTEXT_TOO_LONG
      );
      return;
    }
    totalContextChars += payload.context.length;
  }

  if (totalContextChars > MAX_BATCH_CONTEXT_CHARS) {
    rejectBatch(
      conn,
      requestId,
      ERROR_CODES.OTHER,
      `批次上下文合计超过 ${MAX_BATCH_CONTEXT_CHARS} 字符`,
      FAILURE_REASONS.CONTEXT_TOO_LONG
    );
    return;
  }

  const forbidden = findForbiddenField(payload);
  if (forbidden) {
    rejectBatch(
      conn,
      requestId,
      ERROR_CODES.OTHER,
      '请求包含不允许的字段',
      FAILURE_REASONS.FORBIDDEN_FIELD
    );
    return;
  }

  let settings;
  try {
    settings = await getSettings();
  } catch {
    rejectBatch(conn, requestId, ERROR_CODES.CONFIG, '读取设置失败', undefined);
    return;
  }

  const targetLang = payload.targetLang ?? settings.targetLang;
  if (!isSupportedTargetLang(targetLang)) {
    rejectBatch(
      conn,
      requestId,
      ERROR_CODES.OTHER,
      '不支持的目标语言',
      FAILURE_REASONS.UNSUPPORTED_LANG
    );
    return;
  }

  if (conn.batches.size >= MAX_INFLIGHT_BATCHES_PER_PORT) {
    rejectBatch(
      conn,
      requestId,
      ERROR_CODES.OTHER,
      '当前页面请求过多，请稍后重试',
      FAILURE_REASONS.TOO_MANY_INFLIGHT
    );
    return;
  }

  let instance;
  let apiKey;
  try {
    const list = await getInstances();
    instance = Array.isArray(list) ? list[0] : null;
    if (!instance || !validateInstance(instance).ok) {
      rejectBatch(conn, requestId, ERROR_CODES.CONFIG, '没有可用的引擎配置', undefined);
      return;
    }
    apiKey = await getKey(instance.id);
  } catch {
    rejectBatch(conn, requestId, ERROR_CODES.CONFIG, '读取引擎配置失败', undefined);
    return;
  }

  if (!apiKey) {
    rejectBatch(conn, requestId, ERROR_CODES.CONFIG, '缺少密钥，请先在设置页保存密钥', undefined);
    return;
  }

  const batch = {
    requestId,
    traceId,
    conn,
    cancelled: false,
    timedOut: false,
    finished: false,
    items: normalized.map((item) => ({
      ...item,
      state: 'pending',
      settled: false,
      started: false,
      controller: null,
    })),
    done: 0,
    failed: 0,
    cancelledCount: 0,
    deadlineTimer: null,
  };

  conn.batches.set(requestId, batch);
  batch.deadlineTimer = setTimeout(() => onBatchTimeout(batch), AI_TIMEOUT_MS.batchTotal);
  log.withTrace(traceId).info('batch.start', '开始处理批次', {
    requestId,
    items: batch.items.length,
    targetLang,
  });

  const limit = normalizeConcurrency(settings.concurrency);
  void runBatch(batch, { targetLang, instance, apiKey, limit }).catch((error) => {
    for (const item of batch.items) {
      if (!item.settled) {
        settle(batch, item, 'failed', {
          notify: true,
          code: ERROR_CODES.OTHER,
          message: `翻译失败：${error?.message ?? error}`,
        });
      }
    }
    finishBatch(batch);
  });
}

/**
 * 逐段顺序执行一批。
 * @param {object} batch
 * @param {{ targetLang: string, instance: object, apiKey: string, limit: number }} context
 */
async function runBatch(batch, { targetLang, instance, apiKey, limit }) {
  for (const item of batch.items) {
    if (batch.finished) return;
    if (item.settled || item.state !== 'pending') continue;

    item.state = 'inflight';
    const controller = new AbortController();
    item.controller = controller;

    try {
      const result = await withUpstreamSlot(async () => {
        // 排队期间可能已被取消或断线：拿到名额后再检查，避免发出多余的 START。
        if (controller.signal.aborted) {
          throw Object.assign(new Error('翻译已取消'), { code: ERROR_CODES.CANCELLED });
        }
        const started = send(batch.conn, {
          type: MESSAGE_TYPES.ITEM_START,
          payload: { requestId: batch.requestId, itemId: item.itemId },
        });
        if (!started) {
          controller.abort();
          throw Object.assign(new Error('与后台的连接已断开'), { code: ERROR_CODES.NETWORK });
        }
        item.started = true;

        return translate({
          text: item.text,
          targetLang,
          instance: { ...instance, apiKey },
          signal: controller.signal,
          onDelta: (delta) => {
            if (item.settled) return;
            const ok = send(batch.conn, {
              type: MESSAGE_TYPES.ITEM_DELTA,
              payload: { requestId: batch.requestId, itemId: item.itemId, delta },
            });
            if (!ok) controller.abort();
          },
        });
      }, limit);

      if (item.settled) continue;

      if (batch.timedOut) {
        settle(batch, item, 'failed', {
          notify: true,
          code: ERROR_CODES.NETWORK,
          message: '翻译超时',
          reason: FAILURE_REASONS.BATCH_TIMEOUT,
        });
      } else if (batch.cancelled) {
        settle(batch, item, 'cancelled', { notify: true });
      } else {
        settle(batch, item, 'done', {
          notify: true,
          text: result.text,
          usage: result.usage ?? null,
        });
      }
    } catch (error) {
      if (item.settled) continue;
      if (batch.timedOut) {
        settle(batch, item, 'failed', {
          notify: true,
          code: ERROR_CODES.NETWORK,
          message: '翻译超时',
          reason: FAILURE_REASONS.BATCH_TIMEOUT,
        });
      } else if (batch.cancelled || error?.code === ERROR_CODES.CANCELLED) {
        // 排队中被取消的段还没有 START，不发 ITEM_ERROR。
        settle(batch, item, 'cancelled', { notify: item.started === true });
      } else {
        const code = error instanceof TranslateError ? error.code : ERROR_CODES.OTHER;
        const message = error?.message ?? '翻译失败';
        settle(batch, item, 'failed', { notify: true, code, message });
      }
    } finally {
      item.controller = null;
    }
  }

  finishBatch(batch);
}

/**
 * 结算一段：更新计数，并按需发帧。pending 段被整批取消时不发帧。
 * @param {object} batch
 * @param {object} item
 * @param {'done'|'failed'|'cancelled'} outcome
 * @param {{ notify?: boolean, text?: string, usage?: unknown, code?: string, message?: string, reason?: string }} [options]
 */
function settle(batch, item, outcome, options = {}) {
  if (item.settled) return;
  item.settled = true;
  item.state = outcome;

  if (outcome === 'done') batch.done += 1;
  else if (outcome === 'failed') batch.failed += 1;
  else batch.cancelledCount += 1;

  if (outcome === 'failed') {
    log.withTrace(batch.traceId).warn('item.error', '段落翻译失败', {
      requestId: batch.requestId,
      itemId: item.itemId,
      code: options.code ?? ERROR_CODES.OTHER,
      ...(options.reason ? { reason: options.reason } : {}),
    });
  } else if (outcome === 'cancelled') {
    log.withTrace(batch.traceId).debug('item.cancel', '段落已取消', {
      requestId: batch.requestId,
      itemId: item.itemId,
    });
  }

  if (!options.notify || batch.conn.disconnected || batch.finished) return;

  if (outcome === 'done') {
    send(batch.conn, {
      type: MESSAGE_TYPES.ITEM_DONE,
      payload: {
        requestId: batch.requestId,
        itemId: item.itemId,
        text: options.text ?? '',
        usage: options.usage ?? null,
      },
    });
    return;
  }

  if (outcome === 'failed') {
    send(batch.conn, {
      type: MESSAGE_TYPES.ITEM_ERROR,
      payload: {
        requestId: batch.requestId,
        itemId: item.itemId,
        code: options.code ?? ERROR_CODES.OTHER,
        message: options.message ?? '翻译失败',
        ...(options.reason ? { reason: options.reason } : {}),
      },
    });
    return;
  }

  send(batch.conn, {
    type: MESSAGE_TYPES.ITEM_ERROR,
    payload: {
      requestId: batch.requestId,
      itemId: item.itemId,
      code: ERROR_CODES.CANCELLED,
      message: '翻译已取消',
    },
  });
}

function finishBatch(batch) {
  if (batch.finished) return;
  batch.finished = true;
  if (batch.deadlineTimer) clearTimeout(batch.deadlineTimer);
  batch.conn.batches.delete(batch.requestId);

  send(batch.conn, {
    type: MESSAGE_TYPES.BATCH_DONE,
    payload: {
      requestId: batch.requestId,
      ok: batch.failed === 0 && batch.cancelledCount === 0,
      done: batch.done,
      failed: batch.failed,
      cancelled: batch.cancelledCount,
    },
  });

  log.withTrace(batch.traceId).info('batch.done', '批次结束', {
    requestId: batch.requestId,
    done: batch.done,
    failed: batch.failed,
    cancelled: batch.cancelledCount,
  });
}

/**
 * @param {object} conn
 * @param {unknown} payload
 */
function cancelBatch(conn, payload) {
  const requestId = payload?.requestId;
  const batch = conn.batches.get(requestId);
  if (!batch || batch.finished) return;

  batch.cancelled = true;
  for (const item of batch.items) {
    if (item.settled) continue;
    if (item.state === 'pending') {
      settle(batch, item, 'cancelled', { notify: false });
    } else if (item.state === 'inflight') {
      item.controller?.abort();
    }
  }

  if (batch.items.every((item) => item.settled)) finishBatch(batch);
}

/**
 * @param {object} conn
 * @param {unknown} payload
 */
function cancelItem(conn, payload) {
  const batch = conn.batches.get(payload?.requestId);
  if (!batch || batch.finished) return;

  const item = batch.items.find((entry) => entry.itemId === payload?.itemId);
  if (!item || item.settled) return;

  if (item.state === 'pending') {
    settle(batch, item, 'cancelled', { notify: false });
    if (batch.items.every((entry) => entry.settled)) finishBatch(batch);
  } else if (item.state === 'inflight') {
    item.controller?.abort();
  }
}

/**
 * @param {object} batch
 */
function onBatchTimeout(batch) {
  if (batch.finished) return;
  batch.timedOut = true;

  for (const item of batch.items) {
    if (item.settled) continue;
    if (item.state === 'inflight') {
      settle(batch, item, 'failed', {
        notify: true,
        code: ERROR_CODES.NETWORK,
        message: '翻译超时',
        reason: FAILURE_REASONS.BATCH_TIMEOUT,
      });
      item.controller?.abort();
    } else {
      settle(batch, item, 'failed', {
        notify: true,
        code: ERROR_CODES.NETWORK,
        message: '翻译超时',
        reason: FAILURE_REASONS.BATCH_TIMEOUT,
      });
    }
  }

  finishBatch(batch);
}

/**
 * @param {object} conn
 */
function cleanupConnection(conn) {
  if (conn.disconnected) return;
  conn.disconnected = true;
  connections.delete(conn.port);
  log.info('gateway.disconnect', '网关已断开', { pendingBatches: conn.batches.size });

  for (const batch of conn.batches.values()) {
    batch.finished = true;
    if (batch.deadlineTimer) clearTimeout(batch.deadlineTimer);
    for (const item of batch.items) {
      if (item.state === 'inflight') item.controller?.abort();
      item.settled = true;
    }
  }
  conn.batches.clear();
}

/**
 * @param {object} conn
 * @param {object} frame
 * @returns {boolean}
 */
function send(conn, frame) {
  if (!conn || conn.disconnected) return false;
  try {
    conn.port.postMessage(frame);
    return true;
  } catch {
    cleanupConnection(conn);
    return false;
  }
}

/**
 * 整批拒绝：不创建批次，只发一次终态。
 * @param {object} conn
 * @param {unknown} requestId
 * @param {string} code
 * @param {string} message
 * @param {string} [reason]
 */
function rejectBatch(conn, requestId, code, message, reason) {
  log.warn('batch.reject', '批次被拒绝', {
    requestId: typeof requestId === 'string' ? requestId : null,
    code,
    ...(reason ? { reason } : {}),
  });

  send(conn, {
    type: MESSAGE_TYPES.BATCH_DONE,
    payload: {
      requestId: typeof requestId === 'string' ? requestId : null,
      ok: false,
      done: 0,
      failed: 0,
      cancelled: 0,
      error: makeError(code, message, reason),
    },
  });
}
