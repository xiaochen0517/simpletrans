/**
 * A2 请求网关
 *
 * 模块：后台服务（A）/ A2
 * 职责：接收页面注入的批次请求与统一段落提交，校验载荷、控制全局并发与每连接在途数量、查缓存、调用 A3
 *       并转发增量与定稿；处理取消、断线与批超时；不保存任务状态，不写 storage。
 * 依赖：A3（adapter）、A4（cache）、E1（protocol）、E2（settings）、E3（instances/registry）、
 *       E3 OpenAI 缓存 profile、语言目录、constants.js。
 */

import {
  ERROR_CODES,
  FAILURE_REASONS,
  MESSAGE_TYPES,
  PORT_NAME,
  findForbiddenField,
  makeError,
  normalizeDomain,
  normalizeTraceId,
} from '../shared/protocol.js';
import {
  AI_TIMEOUT_MS,
  BAIDU_BATCH_MAX_BYTES,
  BAIDU_SEGMENT_MAX_BYTES,
  BAIDU_TIMEOUT_MS,
  MAX_BATCH_CHARS,
  MAX_BATCH_CONTEXT_CHARS,
  MAX_BATCH_ITEMS,
  MAX_CONTEXT_CHARS,
  MAX_INFLIGHT_BATCHES_PER_PORT,
  MAX_SEGMENT_CHARS,
  QPS_WINDOW_MS,
} from '../shared/constants.js';
import { getSettings } from '../shared/settings.js';
import { isSupportedTargetLang } from '../shared/languages.js';
import { createLogger, getLogLevel, setLogLevel } from '../shared/log/logger.js';
import { normalizeLevel } from '../shared/log/levels.js';
import { DEFAULT_HOVER_SHORTCUT, normalizeHoverShortcut } from '../shared/shortcut.js';
import {
  getActiveInstance,
  getInstanceCredentials,
  resolveActiveInstance,
} from '../shared/config/instances.js';
import {
  BAIDU_QPS,
  DEFAULT_BATCH_MAX_CHARS,
  DEFAULT_MAX_CONCURRENCY,
  ENGINE_TYPE_IDS,
  normalizeBatchSize,
  normalizePositiveInt,
} from '../shared/config/registry.js';
import { buildCacheKey, CACHE_KEY_VERSION } from '../shared/cache/key.js';
import { getCacheStore } from '../shared/cache/store.js';
import { translate, TranslateError } from '../shared/translate/adapter.js';
import { BATCH_ENCODING_VERSION } from '../shared/translate/batch.js';
import { buildLLMProfile } from '../shared/translate/openai-profile.js';
import { translationQueue } from '../shared/translate/queue.js';
import { hashPrompt, PROMPT_VERSION } from '../shared/translate/prompt.js';

/** 网关日志入口。 */
const log = createLogger('A2');

/** 当前实例不可用时的用户提示（按原因 + 实例类型细化）。 */
const INSTANCE_ERROR_MESSAGES = Object.freeze({
  'no-instance': '没有可用的翻译实例',
  unavailable: '没有可用的翻译实例',
  unsupported: '不支持的实例类型',
  invalid: '实例配置无效，请到设置页检查',
  disabled: '当前实例已停用',
  'missing-key': '缺少密钥',
  permission: '未授权访问该接口域名，请到设置页重新授权',
});

/** 百度翻译实例缺凭据时的提示。 */
const BAIDU_CREDENTIAL_MESSAGE = 'APPID 或密钥未配置完整';

/**
 * 按实例类型取提交超时：OpenAI 180 秒；百度 30 秒。
 * @param {Record<string, unknown>} instance
 * @returns {number}
 */
function batchTimeoutMs(instance) {
  return instance?.type === ENGINE_TYPE_IDS.BAIDU
    ? BAIDU_TIMEOUT_MS.batch
    : AI_TIMEOUT_MS.batchTotal;
}

/**
 * 按实例类型取单批字节上限：只有百度限制 UTF-8 字节。
 * @param {Record<string, unknown>} instance
 * @returns {number}
 */
function batchMaxBytesFor(instance) {
  return instance?.type === ENGINE_TYPE_IDS.BAIDU
    ? BAIDU_BATCH_MAX_BYTES
    : Number.POSITIVE_INFINITY;
}

/**
 * 把当前实例不可用原因转成用户提示。
 * @param {string | null} reason
 * @param {Record<string, unknown> | null} candidate
 * @returns {string}
 */
function instanceErrorMessage(reason, candidate) {
  if (reason === 'missing-key' && candidate?.type === ENGINE_TYPE_IDS.BAIDU) {
    return BAIDU_CREDENTIAL_MESSAGE;
  }
  return INSTANCE_ERROR_MESSAGES[reason] ?? '没有可用的翻译实例';
}

/**
 * 计算一次提交的缓存 profile：OpenAI 用 endpoint 指纹与生成参数哈希；百度用固定值。
 * @param {Record<string, unknown>} instance
 * @param {{ sourceLang?: string }} settings
 * @param {string} targetLang
 * @returns {Promise<{ engineType: string, endpointFingerprint: string, model: string,
 *   sourceLang: string, targetLang: string, promptVersion: number, promptHash: string,
 *   generationHash: string, batchEncodingVersion: number }>}
 */
async function buildCacheProfile(instance, settings, targetLang) {
  const sourceLang = settings.sourceLang ?? 'auto';
  if (instance.type === ENGINE_TYPE_IDS.BAIDU) {
    return {
      engineType: ENGINE_TYPE_IDS.BAIDU,
      endpointFingerprint: 'baidu',
      model: instance.model ?? 'general',
      sourceLang,
      targetLang,
      promptVersion: 0,
      promptHash: 'none',
      generationHash: 'baidu:v1',
      batchEncodingVersion: BATCH_ENCODING_VERSION,
    };
  }
  const { endpointFingerprint, generationHash } = await buildLLMProfile(instance);
  const promptHash = await hashPrompt(instance.systemPrompt);
  return {
    engineType: ENGINE_TYPE_IDS.OPENAI,
    endpointFingerprint,
    model: instance.model,
    sourceLang,
    targetLang,
    promptVersion: PROMPT_VERSION,
    promptHash,
    generationHash,
    batchEncodingVersion: BATCH_ENCODING_VERSION,
  };
}

/**
 * 计算文本 UTF-8 字节数（百度切批使用）。
 * @param {string} text
 * @returns {number}
 */
function utf8Bytes(text) {
  return new TextEncoder().encode(String(text ?? '')).length;
}

/** 已连接端口：Port → { port, tabId, frameId, batches, submissions, disconnected, configSent }。只在内存中存在。 */
const connections = new Map();

/** `"<tabId>:<frameId>"` → 该 frame 的 st-gateway 连接；一次性提交按它路由结果帧。 */
const frameConnections = new Map();

/**
 * 连接键：同一标签页的不同 frame 各有独立连接，同一 frame 重连才替换。
 * @param {number} tabId
 * @param {number} frameId
 * @returns {string}
 */
function frameKey(tabId, frameId) {
  return `${tabId}:${frameId}`;
}

/** 在途共享执行：分组键 → shared。跨提交、跨连接复用，只在当前 Service Worker 内存中。 */
const inFlightByKey = new Map();

/** 无 requestId 的提交用内部键占位，避免两次匿名提交互相覆盖。 */
let anonymousSubmissionSeq = 0;

/** 全局上游并发信号量。 */
let activeSlots = 0;
let slotLimit = DEFAULT_MAX_CONCURRENCY;
const slotWaiters = [];

/**
 * 归一用户并发数：正整数，非法值回退默认 4；不设固定上限。
 * 并发唯一来源是实例 `maxConcurrency`，`settings.concurrency` 只作旧实例迁移回退。
 * @param {unknown} value
 * @returns {number}
 */
export function normalizeConcurrency(value) {
  const n = Number(value);
  if (!Number.isFinite(n) || n < 1) return DEFAULT_MAX_CONCURRENCY;
  return Math.floor(n);
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

/** QPS 门控状态：实例 id → { times: number[], chain: Promise }。只在后台内存中，不持久化。 */
const qpsGates = new Map();

/**
 * 取实例的应用层 QPS：只有百度翻译需要；其它类型与非法值返回 0（不门控）。
 * @param {Record<string, unknown> | null | undefined} instance
 * @returns {number}
 */
function qpsLimitOf(instance) {
  if (!instance || instance.type !== ENGINE_TYPE_IDS.BAIDU) return 0;
  const value = Number(instance.qps);
  if (!Number.isFinite(value)) return BAIDU_QPS.default;
  return Math.max(0, Math.min(Math.floor(value), BAIDU_QPS.max));
}

/**
 * 取实例的 QPS 门控：每个实例一条串行链，保证并发调用不会同时抢到同一窗口。
 * @param {string} instanceId
 * @returns {{ times: number[], chain: Promise<void> }}
 */
function getQpsGate(instanceId) {
  let gate = qpsGates.get(instanceId);
  if (!gate) {
    gate = { times: [], chain: Promise.resolve() };
    qpsGates.set(instanceId, gate);
  }
  return gate;
}

/**
 * 可被 abort 提前结束的等待；`signal` 已中止时立即返回。
 * @param {number} ms
 * @param {AbortSignal | undefined} signal
 * @returns {Promise<void>}
 */
function delayWithSignal(ms, signal) {
  if (!(Number(ms) > 0)) return Promise.resolve();
  if (signal?.aborted) return Promise.resolve();
  return new Promise((resolve) => {
    let timer = null;
    const finish = () => {
      if (timer != null) clearTimeout(timer);
      timer = null;
      signal?.removeEventListener?.('abort', finish);
      resolve();
    };
    timer = setTimeout(finish, ms);
    signal?.addEventListener?.('abort', finish, { once: true });
  });
}

/**
 * 在实例的 QPS 滑动窗口内取得一次上游请求额度；等待不占全局并发名额。
 * 已中止时抛 `CANCELLED`，不发请求。
 * @param {Record<string, unknown> | null | undefined} instance
 * @param {AbortSignal | undefined} signal
 * @returns {Promise<void>}
 */
async function acquireQps(instance, signal) {
  const qps = qpsLimitOf(instance);
  if (qps <= 0 || typeof instance?.id !== 'string' || instance.id === '') return;

  const gate = getQpsGate(instance.id);
  const previous = gate.chain;
  let release;
  gate.chain = new Promise((resolve) => {
    release = resolve;
  });
  await previous;
  try {
    for (;;) {
      if (signal?.aborted) {
        log.debug('qps.reject', 'QPS 等待已取消', {
          instanceId: instance.id,
          qps,
          reason: 'cancelled',
        });
        throw new TranslateError(ERROR_CODES.CANCELLED, '翻译已取消');
      }

      const now = Date.now();
      gate.times = gate.times.filter((time) => now - time < QPS_WINDOW_MS);
      if (gate.times.length < qps) {
        gate.times.push(now);
        return;
      }

      const waitMs = QPS_WINDOW_MS - (now - gate.times[0]) + 1;
      log.debug('qps.wait', '等待实例 QPS 窗口', {
        instanceId: instance.id,
        qps,
        waitMs,
        pending: gate.times.length,
      });
      await delayWithSignal(waitMs, signal);
    }
  } finally {
    release();
  }
}

/**
 * 在全局并发名额内执行一次上游调用。所有上游出口（批次与测试翻译）都必须经过这里。
 * 百度实例先等 QPS 窗口再占并发名额；未传实例或实例没有 QPS 时跳过门控。
 * @template T
 * @param {() => Promise<T>} fn
 * @param {number} [limit] 实例 `maxConcurrency`；省略时读当前生效实例
 * @param {Record<string, unknown> | null} [instance] 提交时快照的实例；决定 QPS 额度
 * @param {AbortSignal} [signal] 提交的取消信号；QPS 等待可被提前结束
 * @returns {Promise<T>}
 */
export async function withUpstreamSlot(fn, limit, instance, signal) {
  const target =
    instance ??
    (limit == null
      ? await getActiveInstance({ requireKey: false, requirePermission: false })
      : null);
  const effective = normalizeConcurrency(limit ?? target?.maxConcurrency);
  await acquireQps(target, signal);
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
 * 同一标签页的不同 frame（`sender.frameId`）各自保留连接；只有同一 frame 重连才关闭旧连接。
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

  const tabId = Number.isInteger(port.sender?.tab?.id) ? port.sender.tab.id : null;
  const frameId = Number.isInteger(port.sender?.frameId) ? port.sender.frameId : 0;
  const key = tabId == null ? null : frameKey(tabId, frameId);
  const previous = key == null ? null : frameConnections.get(key);
  const conn = {
    port,
    tabId,
    frameId,
    batches: new Map(),
    submissions: new Map(),
    disconnected: false,
    configSent: false,
  };
  connections.set(port, conn);
  if (key != null) {
    frameConnections.set(key, conn);
    if (previous && previous !== conn && !previous.disconnected) {
      log.info('gateway.replace', '同一 frame 建立新连接，关闭旧连接', { tabId, frameId });
      cleanupConnection(previous);
    }
  }
  log.info('gateway.connect', '网关已连接', { tabId, frameId });

  port.onMessage.addListener((message) => onMessage(conn, message));
  port.onDisconnect.addListener(() => cleanupConnection(conn));
  return conn;
}

/**
 * 按标签页与 frame 查找当前可用的网关连接；一次性提交没有 port，只能按 `sender.tab.id + sender.frameId` 路由。
 * @param {unknown} tabId
 * @param {unknown} [frameId] 省略时按顶层 frame（0）查找
 * @returns {object | null}
 */
export function findConnection(tabId, frameId = 0) {
  if (!Number.isInteger(tabId)) return null;
  const frame = Number.isInteger(frameId) ? frameId : 0;
  const conn = frameConnections.get(frameKey(tabId, frame));
  return conn && !conn.disconnected ? conn : null;
}

/**
 * 列出某标签页全部活动 frame 连接，按 frameId 升序。
 * @param {unknown} tabId
 * @returns {Array<object>}
 */
export function listFrames(tabId) {
  if (!Number.isInteger(tabId)) return [];
  const frames = [];
  for (const conn of frameConnections.values()) {
    if (conn.tabId === tabId && !conn.disconnected) frames.push(conn);
  }
  return frames.sort((a, b) => a.frameId - b.frameId);
}

/**
 * 每个连接只下发一次连接配置：日志级别与悬停快捷键共用一次设置读取。
 * 读取失败时日志级别用当前缓存值、悬停快捷键回退默认，不中断连接。
 * @param {object} conn
 */
async function sendConnectionConfig(conn) {
  if (!conn || conn.disconnected || conn.configSent) return;
  conn.configSent = true;

  let level = getLogLevel();
  let hoverShortcut = DEFAULT_HOVER_SHORTCUT;
  try {
    const settings = await getSettings();
    level = normalizeLevel(settings.logLevel);
    hoverShortcut = normalizeHoverShortcut(settings.hoverShortcut);
    setLogLevel(level);
  } catch {
    // 读取失败时保留当前级别与默认快捷键，不中断连接。
  }

  if (conn.disconnected) return;
  send(conn, { type: MESSAGE_TYPES.LOG_CONFIG, payload: { level } });
  send(conn, { type: MESSAGE_TYPES.CONTENT_CONFIG, payload: { hoverShortcut } });
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
    void sendConnectionConfig(conn);
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
  let credentials;
  try {
    const resolved = await resolveActiveInstance({ requireKey: true, requirePermission: true });
    instance = resolved.instance;
    if (!instance) {
      rejectBatch(
        conn,
        requestId,
        ERROR_CODES.CONFIG,
        instanceErrorMessage(resolved.reason, resolved.candidate),
        undefined
      );
      return;
    }
    credentials = await getInstanceCredentials(instance);
  } catch {
    rejectBatch(conn, requestId, ERROR_CODES.CONFIG, '读取引擎配置失败', undefined);
    return;
  }

  // 缓存读取在实例与凭据检查之后、批次创建之前：命中仍要求实例可用。
  const cacheEnabled = settings.cacheEnabled !== false;
  const cacheDomain = normalizeDomain(payload.domain);
  const cacheGeneration = cacheEnabled ? getCacheStore().generation() : 0;
  let cacheKeys = null;
  let cacheEntries = new Map();

  if (cacheEnabled) {
    log.debug('cache.key.version', '缓存 key 版本', { version: CACHE_KEY_VERSION });
    try {
      const profile = await buildCacheProfile(instance, settings, targetLang);
      cacheKeys = await Promise.all(
        normalized.map((item) =>
          buildCacheKey({
            ...profile,
            text: item.text,
          })
        )
      );
    } catch (error) {
      cacheKeys = null;
      log.warn('cache.error', '缓存 key 计算失败，本批不参与缓存', {
        requestId,
        reason: error?.name ?? 'Error',
      });
    }

    if (cacheKeys) {
      try {
        cacheEntries = await getCacheStore().getMany(cacheKeys);
      } catch (error) {
        cacheEntries = new Map();
        log.warn('cache.error', '缓存读取失败，本批按未命中处理', {
          requestId,
          reason: error?.name ?? 'Error',
        });
      }
    }
  }

  const batch = {
    requestId,
    traceId,
    conn,
    cancelled: false,
    timedOut: false,
    finished: false,
    items: normalized.map((item, index) => ({
      ...item,
      cacheKey: cacheKeys ? cacheKeys[index] : null,
      state: 'pending',
      settled: false,
      started: false,
      controller: null,
    })),
    done: 0,
    failed: 0,
    cancelledCount: 0,
    cacheEnabled,
    cacheKeys,
    cacheEntries,
    cacheGeneration,
    cacheDomain,
    cacheHits: 0,
    cacheMisses: 0,
    cacheWrites: 0,
    deadlineTimer: null,
  };

  conn.batches.set(requestId, batch);
  batch.deadlineTimer = setTimeout(() => onBatchTimeout(batch), batchTimeoutMs(instance));
  log.withTrace(traceId).info('batch.start', '开始处理批次', {
    requestId,
    items: batch.items.length,
    targetLang,
  });

  const limit = normalizeConcurrency(instance.maxConcurrency);
  void runBatch(batch, {
    targetLang,
    sourceLang: settings.sourceLang,
    instance,
    credentials,
    limit,
  }).catch((error) => {
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
 * @param {{ targetLang: string, sourceLang?: string, instance: object, credentials: object, limit: number }} context
 */
async function runBatch(batch, { targetLang, sourceLang, instance, credentials, limit }) {
  for (const item of batch.items) {
    if (batch.finished) return;
    if (item.settled || item.state !== 'pending') continue;

    const cached = item.cacheKey ? batch.cacheEntries.get(item.cacheKey) : null;
    if (cached) {
      // 命中：ST_ITEM_START → ST_ITEM_DONE，不发增量，不占上游名额，不调用 A3。
      const started = send(batch.conn, {
        type: MESSAGE_TYPES.ITEM_START,
        payload: { requestId: batch.requestId, itemId: item.itemId },
      });
      if (!started) return;

      batch.cacheHits += 1;
      settle(batch, item, 'done', { notify: true, text: cached.text, usage: null });
      log.withTrace(batch.traceId).debug('cache.hit', '缓存命中，跳过上游', {
        requestId: batch.requestId,
        itemId: item.itemId,
        bytes: cached.bytes,
      });
      continue;
    }

    if (batch.cacheEnabled && batch.cacheKeys) {
      batch.cacheMisses += 1;
      log.withTrace(batch.traceId).debug('cache.miss', '缓存未命中', {
        requestId: batch.requestId,
        itemId: item.itemId,
      });
    }

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
          sourceLang,
          instance: { ...instance, ...credentials },
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
        writeCacheEntry(batch, item, result);
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
 * 定稿后异步写缓存：只在 A3 成功且译文非空时调用，写入不阻塞定稿帧。
 * 写入失败只记日志（store 内部已记录 cache.error / cache.quota），不改变该段结果。
 * @param {object} batch
 * @param {object} item
 * @param {{ text?: string }} result
 */
function writeCacheEntry(batch, item, result) {
  if (!batch.cacheEnabled || !item.cacheKey) return;
  const text = typeof result?.text === 'string' ? result.text : '';
  if (text.trim() === '') return;

  batch.cacheWrites += 1;
  void getCacheStore()
    .set(item.cacheKey, text, {
      generation: batch.cacheGeneration,
      domain: batch.cacheDomain,
    })
    .then((outcome) => {
      if (!outcome?.written) return;
      log.withTrace(batch.traceId).debug('cache.write', '已写入缓存', {
        requestId: batch.requestId,
        itemId: item.itemId,
        bytes: outcome.bytes,
      });
    })
    .catch(() => {
      // 写入失败不影响翻译结果；详细原因已由 A4 记录。
    });
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
    cacheHits: batch.cacheHits ?? 0,
    cacheMisses: batch.cacheMisses ?? 0,
    cacheWrites: batch.cacheWrites ?? 0,
  });
}

/**
 * @param {object} conn
 * @param {unknown} payload
 */
function cancelBatch(conn, payload) {
  const requestId = payload?.requestId;
  const submission = conn.submissions.get(requestId);
  if (submission) {
    cancelSubmission(submission);
    return;
  }

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
  const submission = conn.submissions.get(payload?.requestId);
  if (submission) {
    cancelItemOfSubmission(submission, payload?.itemId);
    return;
  }

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
 * 清理一个连接：结束提交、摘除订阅、abort 在途请求并移除映射；重复调用幂等。
 * @param {object} conn
 * @returns {{ pendingSubmissions: number, pendingBatches: number, sharedReleased: number }}
 */
function cleanupConnection(conn) {
  if (conn.disconnected) {
    return { pendingSubmissions: 0, pendingBatches: 0, sharedReleased: 0 };
  }
  conn.disconnected = true;
  const pendingSubmissions = conn.submissions.size;
  const pendingBatches = conn.batches.size;
  connections.delete(conn.port);
  if (conn.tabId != null) {
    const key = frameKey(conn.tabId, conn.frameId ?? 0);
    if (frameConnections.get(key) === conn) frameConnections.delete(key);
  }
  log.info('gateway.disconnect', '网关已断开', {
    tabId: conn.tabId ?? null,
    frameId: conn.frameId ?? 0,
    pendingBatches,
    pendingSubmissions,
  });

  const touchedShared = new Set();
  for (const submission of [...conn.submissions.values()]) {
    submission.finished = true;
    if (submission.deadlineTimer) clearTimeout(submission.deadlineTimer);
    const pendingItems = submission.items.filter((item) => !item.settled);
    for (const shared of takeSubscriptions(pendingItems)) touchedShared.add(shared);
    for (const item of pendingItems) {
      item.settled = true;
      item.state = 'cancelled';
      item.subscriber = null;
    }
  }
  conn.submissions.clear();
  for (const shared of touchedShared) releaseSharedIfUnused(undefined, shared);

  for (const batch of conn.batches.values()) {
    batch.finished = true;
    if (batch.deadlineTimer) clearTimeout(batch.deadlineTimer);
    for (const item of batch.items) {
      if (item.state === 'inflight') item.controller?.abort();
      item.settled = true;
    }
  }
  conn.batches.clear();

  return { pendingSubmissions, pendingBatches, sharedReleased: touchedShared.size };
}

/**
 * 标签页关闭兜底清理：按 `tabId` 找到该标签页所有 frame 连接并逐一清理；
 * 与端口断开的 `cleanupConnection` 幂等。
 * @param {number} tabId
 * @returns {boolean} 是否清理了至少一个仍在活动的连接
 */
export function cleanupTab(tabId) {
  if (!Number.isInteger(tabId)) return false;

  const targets = [...frameConnections.values()].filter(
    (conn) => conn.tabId === tabId && !conn.disconnected
  );
  if (targets.length === 0) {
    log.debug('tab.cleanup', '标签页已关闭，没有需要清理的连接', { tabId });
    return false;
  }

  let pendingSubmissions = 0;
  let pendingBatches = 0;
  let sharedReleased = 0;
  for (const conn of targets) {
    const counts = cleanupConnection(conn);
    pendingSubmissions += counts.pendingSubmissions;
    pendingBatches += counts.pendingBatches;
    sharedReleased += counts.sharedReleased;
  }
  log.info('tab.cleanup', '标签页已关闭，已清理网关连接', {
    tabId,
    frames: targets.length,
    pendingSubmissions,
    pendingBatches,
    sharedReleased,
  });
  return true;
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

/* ------------------------------------------------------------------------- *
 * 页面提交：缓存预取、命中回显、唯一 key 分组、切批与队列入队
 * ------------------------------------------------------------------------- */

/**
 * 按「单批段数」「批次最大字符数」与可选的「单批 UTF-8 字节数」以段（group）为单位切批；绝不拆段。
 * 字节上限只用于百度翻译（`batchMaxBytes` 省略或非有限值时忽略）。
 * 单段超过字符/字节上限时单独成批并标记 `oversize`，只用于日志计数。
 * @param {Array<{ text: string }>} groups
 * @param {{ batchSize?: unknown, batchMaxChars?: unknown, batchMaxBytes?: unknown }} [options]
 * @returns {Array<{ groups: object[], chars: number, bytes: number, oversize: boolean, state: string }>}
 */
export function splitBatches(groups, { batchSize, batchMaxChars, batchMaxBytes } = {}) {
  const size = normalizeBatchSize(batchSize);
  const maxChars = normalizePositiveInt(batchMaxChars, DEFAULT_BATCH_MAX_CHARS);
  const maxBytes =
    Number.isFinite(Number(batchMaxBytes)) && Number(batchMaxBytes) > 0
      ? Number(batchMaxBytes)
      : Number.POSITIVE_INFINITY;
  const batches = [];
  let current = [];
  let chars = 0;
  let bytes = 0;

  const flush = () => {
    if (current.length === 0) return;
    batches.push({
      groups: current,
      chars,
      bytes,
      oversize: current.some(
        (group) => group.text.length > maxChars || utf8Bytes(group.text) > maxBytes
      ),
      emitted: false,
      state: 'pending',
    });
    current = [];
    chars = 0;
    bytes = 0;
  };

  for (const group of Array.isArray(groups) ? groups : []) {
    const length = group.text.length;
    const groupBytes = utf8Bytes(group.text);
    // 段间用换行连接，按 1 字节分隔符计入字节预算。
    const separator = current.length > 0 ? 1 : 0;
    if (
      current.length > 0 &&
      (current.length >= size ||
        chars + length > maxChars ||
        bytes + separator + groupBytes > maxBytes)
    ) {
      flush();
    }
    current.push(group);
    chars += length;
    bytes += (current.length > 1 ? 1 : 0) + groupBytes;
    if (current.length >= size) flush();
  }
  flush();
  return batches;
}

/**
 * 归一提交段落：`hostId` 兼作结果帧 `itemId`；缺失时补一个页面用不到的占位 id。
 * @param {Array<{ hostId?: string, text: string }>} paragraphs
 */
function normalizeSubmitItems(paragraphs) {
  return paragraphs.map((paragraph, index) => ({
    index,
    itemId:
      typeof paragraph.hostId === 'string' && paragraph.hostId !== ''
        ? paragraph.hostId
        : `p-${index}`,
    text: paragraph.text,
    cacheKey: null,
    groupKey: null,
    group: null,
    subscriber: null,
    state: 'pending',
    settled: false,
  }));
}

/**
 * 接收一次页面提交：读取设置/实例/密钥 → 计算 key → 一次预取缓存 → 命中回显 →
 * 未命中分组切批 → 批次入 A3 队列执行。初始化失败时逐段发 `ST_ITEM_ERROR`，
 * 再发 `ST_BATCH_DONE(ok:false)`，避免页面停在「已提交」。
 *
 * @param {{
 *   requestId?: string | null,
 *   traceId?: string,
 *   scope?: 'page' | 'single',
 *   targetLang?: string,
 *   domain?: string,
 *   viewport?: { width?: number, height?: number },
 *   paragraphs?: Array<{ hostId?: string, text: string }>,
 *   tabId?: number,
 *   frameId?: number,
 * }} input
 * @returns {Promise<{ accepted: true } | { accepted: false, error: object }>}
 */
export async function acceptPageSubmit({
  requestId = null,
  traceId,
  scope = 'page',
  targetLang,
  domain,
  paragraphs = [],
  tabId,
  frameId = 0,
} = {}) {
  const conn = findConnection(tabId, frameId);
  if (!conn) {
    return {
      accepted: false,
      error: makeError(
        ERROR_CODES.NETWORK,
        '页面通道未连接，请刷新后重试',
        FAILURE_REASONS.NOT_CONNECTED
      ),
    };
  }
  if (requestId != null && conn.submissions.has(requestId)) {
    return {
      accepted: false,
      error: makeError(ERROR_CODES.OTHER, '请求编号重复', FAILURE_REASONS.DUPLICATE_REQUEST),
    };
  }

  const submissionKey = requestId ?? `anon-${(anonymousSubmissionSeq += 1)}`;

  const traceLog = log.withTrace(traceId);
  const items = normalizeSubmitItems(Array.isArray(paragraphs) ? paragraphs : []);
  const rejectInit = (code, message, reason) => {
    rejectSubmission(conn, { requestId, traceId, items }, code, message, reason);
    return { accepted: true };
  };

  let settings;
  try {
    settings = await getSettings();
  } catch {
    return rejectInit(ERROR_CODES.CONFIG, '读取设置失败');
  }
  if (settings.enabled === false) return rejectInit(ERROR_CODES.CONFIG, '扩展已停用');

  const target = targetLang ?? settings.targetLang;
  if (!isSupportedTargetLang(target)) {
    return rejectInit(ERROR_CODES.OTHER, '不支持的目标语言', FAILURE_REASONS.UNSUPPORTED_LANG);
  }

  let instance;
  let credentials;
  try {
    const resolved = await resolveActiveInstance({ requireKey: true, requirePermission: true });
    instance = resolved.instance;
    if (!instance) {
      return rejectInit(
        ERROR_CODES.CONFIG,
        instanceErrorMessage(resolved.reason, resolved.candidate)
      );
    }
    credentials = await getInstanceCredentials(instance);
  } catch {
    return rejectInit(ERROR_CODES.CONFIG, '读取引擎配置失败');
  }

  // 单段超限（字符或百度 UTF-8 字节）的段落不进入分组与批次，其余段落按部分成功处理。
  const oversizedItems = [];
  const activeItems = [];
  for (const item of items) {
    if (item.text.length > MAX_SEGMENT_CHARS) {
      oversizedItems.push({ item, message: `单段超过 ${MAX_SEGMENT_CHARS} 字符` });
    } else if (
      instance.type === ENGINE_TYPE_IDS.BAIDU &&
      utf8Bytes(item.text) > BAIDU_SEGMENT_MAX_BYTES
    ) {
      oversizedItems.push({ item, message: '文本过长，请分段后重试' });
    } else {
      activeItems.push(item);
    }
  }

  // key 与缓存：缓存关闭也计算 key，用于同 key 分组与在途复用。
  const cacheEnabled = settings.cacheEnabled !== false;
  const cacheDomain = normalizeDomain(domain);
  const cacheGeneration = cacheEnabled ? getCacheStore().generation() : 0;

  let keys = null;
  let keyOk = false;
  try {
    const profile = await buildCacheProfile(instance, settings, target);
    keys = await Promise.all(
      activeItems.map((item) => buildCacheKey({ ...profile, text: item.text }))
    );
    keyOk = true;
  } catch (error) {
    keys = null;
    keyOk = false;
    log.warn('cache.error', '缓存 key 计算失败，本次提交不参与缓存', {
      requestId,
      reason: error?.name ?? 'Error',
    });
  }

  activeItems.forEach((item, index) => {
    item.cacheKey = keyOk ? keys[index] : null;
    item.groupKey = item.cacheKey ?? `fallback:${item.text}`;
  });

  // 唯一 key 分组：同一 key 的多个段落合并为一个 group，只执行一次。
  const groups = new Map();
  for (const item of activeItems) {
    let group = groups.get(item.groupKey);
    if (!group) {
      group = {
        key: item.groupKey,
        cacheKey: item.cacheKey,
        text: item.text,
        items: [],
        cacheEntry: null,
        shared: null,
        state: 'pending',
      };
      groups.set(item.groupKey, group);
    }
    group.items.push(item);
    item.group = group;
  }

  // 一次预取全部唯一 key：空数组不查缓存；读取失败按全部未命中处理。
  let cacheEntries = new Map();
  const uniqueKeys = [...new Set([...groups.values()].map((group) => group.cacheKey).filter(Boolean))];
  if (cacheEnabled && keyOk && uniqueKeys.length > 0) {
    try {
      cacheEntries = await getCacheStore().getMany(uniqueKeys);
    } catch (error) {
      cacheEntries = new Map();
      log.warn('cache.error', '缓存读取失败，本次提交按未命中处理', {
        requestId,
        reason: error?.name ?? 'Error',
      });
    }
  }
  for (const group of groups.values()) {
    const entry = group.cacheKey ? cacheEntries.get(group.cacheKey) : null;
    if (entry) {
      group.cacheEntry = entry;
      group.state = 'cache-hit';
    }
  }

  const missGroups = [...groups.values()].filter((group) => group.state !== 'cache-hit');
  // 已在途的 group 只订阅，不进入新批次；其余 group 才切批与入队。
  const inFlightGroups = missGroups.filter((group) => inFlightByKey.has(group.key));
  const newGroups = missGroups.filter((group) => !inFlightByKey.has(group.key));
  const batchSize = normalizeBatchSize(instance.batchSize);
  const batchMaxChars = normalizePositiveInt(instance.batchMaxChars, DEFAULT_BATCH_MAX_CHARS);
  const batchMaxBytes = batchMaxBytesFor(instance);
  const batches = splitBatches(newGroups, { batchSize, batchMaxChars, batchMaxBytes });
  batches.forEach((batch, index) => {
    batch.id = `b${index}`;
  });
  const limit = normalizeConcurrency(instance.maxConcurrency);

  const submission = {
    requestId,
    submissionKey,
    traceId,
    scope,
    conn,
    tabId,
    targetLang: target,
    domain: cacheDomain,
    items,
    groups,
    batches,
    plan: {
      cacheEnabled,
      cacheKeys: keyOk ? uniqueKeys.length : 0,
      cacheEntries: cacheEntries.size,
      generation: cacheGeneration,
      domain: cacheDomain,
      batchSize,
      batchMaxChars,
      ...(Number.isFinite(batchMaxBytes) ? { batchMaxBytes } : {}),
    },
    done: 0,
    failed: 0,
    cancelledCount: 0,
    cacheHits: 0,
    cacheMisses: 0,
    cacheWrites: 0,
    dedupeHits: 0,
    dedupeShared: 0,
    dedupeJoined: 0,
    finished: false,
    cancelled: false,
    timedOut: false,
    deadlineTimer: null,
  };

  for (const group of groups.values()) {
    if (group.items.length <= 1) continue;
    submission.dedupeHits += group.items.length - 1;
    traceLog.debug('dedupe.merge', '同一提交内同 key 段落合并', {
      requestId,
      items: group.items.length,
    });
  }

  conn.submissions.set(submissionKey, submission);
  submission.deadlineTimer = setTimeout(
    () => onSubmissionTimeout(submission),
    batchTimeoutMs(instance)
  );

  traceLog.debug('batch.plan', '页面提交批次计划', {
    requestId,
    items: items.length,
    groups: groups.size,
    batches: batches.length,
    batchSize,
    batchMaxChars,
    batchChars: batches.reduce((sum, batch) => sum + batch.chars, 0),
    oversizeBatches: batches.filter((batch) => batch.oversize).length,
    cacheEnabled,
    cacheHits: [...groups.values()].filter((group) => group.state === 'cache-hit').length,
    cacheMisses: missGroups.length,
  });
  traceLog.info('batch.start', '开始处理页面提交', {
    requestId,
    scope,
    items: items.length,
    batches: batches.length,
    cacheHits: [...groups.values()].filter((group) => group.state === 'cache-hit').length,
  });

  // 超长段落直接失败，不进入分组、批次与缓存；其余段落按部分成功处理。
  for (const entry of oversizedItems) {
    settleItem(submission, entry.item, 'failed', {
      notify: true,
      code: ERROR_CODES.OTHER,
      message: entry.message,
      reason: FAILURE_REASONS.TEXT_TOO_LONG,
    });
  }

  // 命中项立即回显；按页面顺序发帧，允许与未命中项的帧交错。
  for (const group of groups.values()) {
    if (group.state === 'cache-hit') fanOutCacheHit(submission, group);
  }

  if (cacheEnabled && keyOk) {
    for (const group of missGroups) {
      submission.cacheMisses += 1;
      traceLog.debug('cache.miss', '缓存未命中', { requestId, items: group.items.length });
    }
  }

  const context = {
    targetLang: target,
    sourceLang: settings.sourceLang,
    instance,
    credentials,
    limit,
    cacheEnabled,
    cacheGeneration,
    domain: cacheDomain,
  };
  // 拆批后的子批次沿用同一份上下文（实例、语言、凭据、缓存与 QPS 配置）。
  submission.context = context;

  // 已在途 group：只订阅既有共享执行，不重复入队。
  for (const group of inFlightGroups) {
    const shared = inFlightByKey.get(group.key);
    if (!shared) continue;
    subscribeGroup(submission, group, shared, { owner: false });
    traceLog.debug('dedupe.join', '订阅已有共享请求', { requestId, items: group.items.length });
  }

  // 新 group：先登记共享执行（批次等待期间新提交也能订阅），再按批入队。
  for (const group of newGroups) {
    const shared = createShared(submission, group, context);
    subscribeGroup(submission, group, shared, { owner: true });
    traceLog.debug('dedupe.owner', '创建共享请求', {
      requestId,
      items: group.items.length,
      subscribers: shared.subscribers.size,
    });
  }

  // 队列按实例 `maxConcurrency` 限制同时在途的批次数；批次内部再经过全局上游名额。
  translationQueue.setConcurrency(limit);
  for (const batch of batches) {
    batch.state = 'running';
    const handle = translationQueue.enqueueBatch(createBatchJob(submission, batch, context));
    for (const group of batch.groups) {
      if (group.shared) group.shared.jobHandle = handle;
    }
  }

  finishIfAllSettled(submission);
  return { accepted: true };
}

/**
 * 把一个批次包装成 A3 队列 job；job 只负责执行与回调，缓存、帧与计数仍由 A2 处理。
 * `canRetry` 交给队列：已产生输出、已取消或提交已超时的批次不重试，避免重复译文。
 * @param {object} submission
 * @param {object} batch
 * @param {object} context
 * @returns {object}
 */
function createBatchJob(submission, batch, context) {
  return {
    requestId: submission.requestId,
    batchId: batch.id ?? null,
    groups: batch.groups,
    targetLang: context.targetLang,
    sourceLang: context.sourceLang,
    instance: { ...context.instance, ...context.credentials },
    concurrency: context.limit,
    withSlot: (fn, limit, signal) => withUpstreamSlot(fn, limit, context.instance, signal),
    canRetry: () => !batch.emitted && !batch.cancelled && !submission.timedOut,
    onDelta: (delta) => forwardJobDelta(batch, delta),
    onItem: ({ group, text, usage }) => handleJobItem(submission, batch, group, text, usage),
    onBatchDone: () => handleJobDone(submission, batch),
    onBatchError: (error) => handleJobError(submission, batch, error),
  };
}

/**
 * 单段批的流式增量只转发给 owner；多段批没有增量。
 * 发出过增量即视为已产生输出，该批次不再自动重试。
 * @param {object} batch
 * @param {string} delta
 */
function forwardJobDelta(batch, delta) {
  const owner = batch?.groups?.[0]?.shared?.owner;
  if (!owner || owner.item.settled || typeof delta !== 'string') return;
  batch.emitted = true;
  send(owner.submission.conn, {
    type: MESSAGE_TYPES.ITEM_DELTA,
    payload: {
      requestId: owner.submission.requestId,
      itemId: owner.item.itemId,
      delta,
    },
  });
}

/**
 * 收到一个段落的批量结果：多段批的空译文按该段失败处理，其余立即写缓存并 fan-out。
 * @param {object} submission
 * @param {object} batch
 * @param {object} group
 * @param {string} text
 * @param {unknown} usage
 */
function handleJobItem(submission, batch, group, text, usage) {
  const shared = group?.shared;
  if (!shared || shared.state !== 'running') return;

  const value = typeof text === 'string' ? text : '';
  if (batch.groups.length >= 2 && value.trim() === '') {
    failShared(submission.traceId, shared, ERROR_CODES.OTHER, '引擎返回空译文');
    return;
  }
  batch.emitted = true;
  resolveShared(submission.traceId, shared, value, usage, batch.groups.length === 1 ? 'single' : 'batch');
}

/**
 * 批次结束时仍未解析的 group（共享执行仍在运行）；已解析与已失败的 group 不再参与拆分。
 * @param {object} batch
 * @returns {object[]}
 */
function unparsedGroups(batch) {
  return batch.groups.filter((group) => group.shared && group.shared.state === 'running');
}

/**
 * 批量对齐失败时二分拆批：未结算 group 按原顺序对半分给两个子批次，用新的 batchId 重新入队。
 * 子批次沿用同一 group 对象与共享执行记录，因此 `ST_ITEM_START` 状态、缓存 key 与订阅不变。
 * @param {object} submission
 * @param {object} batch
 * @param {object[]} groups 未结算 group
 * @returns {boolean} 是否拆出子批次
 */
function splitBatch(submission, batch, groups) {
  if (!Array.isArray(groups) || groups.length < 2) return false;
  const context = submission.context;
  if (!context || submission.finished || submission.conn?.disconnected) return false;

  const mid = Math.ceil(groups.length / 2);
  const depth = (batch.depth ?? 0) + 1;
  const parentId = batch.id ?? null;
  const children = [
    createChildBatch(submission, batch, groups.slice(0, mid), 'a', depth),
    createChildBatch(submission, batch, groups.slice(mid), 'b', depth),
  ];
  batch.state = 'split';

  log.withTrace(submission.traceId).info('batch.split', '批量结果对不上，拆成两个子批次', {
    requestId: submission.requestId,
    batchId: parentId,
    parentGroups: groups.length,
    leftGroups: children[0].groups.length,
    rightGroups: children[1].groups.length,
    depth,
  });

  for (const child of children) enqueueChildBatch(submission, child);
  return true;
}

/**
 * 构造一个子批次：沿用父批次的上下文与 group 对象，只替换 id 与 group 切片。
 * @param {object} submission
 * @param {object} batch
 * @param {object[]} groups
 * @param {string} suffix
 * @param {number} depth
 * @returns {object}
 */
function createChildBatch(submission, batch, groups, suffix, depth) {
  const chars = groups.reduce((sum, group) => sum + String(group?.text ?? '').length, 0);
  const child = {
    id: `${batch.id ?? 'b'}${suffix}`,
    groups,
    chars,
    bytes: 0,
    oversize: false,
    emitted: false,
    state: 'pending',
    depth,
    parentId: batch.id ?? null,
  };
  submission.batches.push(child);
  return child;
}

/**
 * 子批次重新入队；每个 group 的 `jobHandle` 改指子批次，取消时才能摘到正确的 job。
 * @param {object} submission
 * @param {object} batch
 */
function enqueueChildBatch(submission, batch) {
  const context = submission.context;
  if (!context) return;
  batch.state = 'running';
  translationQueue.setConcurrency(normalizeConcurrency(context.limit));
  const handle = translationQueue.enqueueBatch(createBatchJob(submission, batch, context));
  for (const group of batch.groups) {
    if (group.shared && group.shared.state === 'running') group.shared.jobHandle = handle;
  }
}

/**
 * 批次成功结束：已解析段落已结算；仍未被解析的 group 先尝试二分拆批，单段仍失败才标 `BATCH_ALIGN`。
 * @param {object} submission
 * @param {object} batch
 */
function handleJobDone(submission, batch) {
  const pending = unparsedGroups(batch);
  if (pending.length >= 2 && splitBatch(submission, batch, pending)) {
    finishIfAllSettled(submission);
    return;
  }

  batch.state = 'done';
  for (const group of pending) {
    failShared(submission.traceId, group.shared, ERROR_CODES.BATCH_ALIGN, '批量结果缺少该段');
  }
  finishIfAllSettled(submission);
}

/**
 * 批次失败：`BATCH_ALIGN` 且未结算 group ≥ 2 时二分拆批；其余情况按统一错误码失败，已解析 group 保留。
 * @param {object} submission
 * @param {object} batch
 * @param {unknown} error
 */
function handleJobError(submission, batch, error) {
  const code =
    error instanceof TranslateError
      ? error.code
      : error?.code === ERROR_CODES.BATCH_ALIGN
        ? ERROR_CODES.BATCH_ALIGN
        : ERROR_CODES.OTHER;
  const message = error?.message ?? '翻译失败';

  if (code === ERROR_CODES.BATCH_ALIGN) {
    const pending = unparsedGroups(batch);
    if (pending.length >= 2 && splitBatch(submission, batch, pending)) {
      finishIfAllSettled(submission);
      return;
    }
  }

  batch.state = 'failed';
  for (const group of batch.groups) {
    const shared = group.shared;
    if (!shared || shared.state !== 'running') continue;
    failShared(submission.traceId, shared, code, message);
  }
  finishIfAllSettled(submission);
}

/**
 * 初始化失败：逐段发 `ST_ITEM_ERROR`，再发 `ST_BATCH_DONE(ok:false)`。
 * @param {object} conn
 * @param {{ requestId?: string | null, traceId?: string, items: object[] }} submission
 * @param {string} code
 * @param {string} message
 * @param {string} [reason]
 */
function rejectSubmission(conn, { requestId = null, traceId, items = [] }, code, message, reason) {
  log.withTrace(traceId).warn('batch.reject', '页面提交初始化失败', {
    requestId,
    code,
    ...(reason ? { reason } : {}),
  });

  for (const item of items) {
    send(conn, {
      type: MESSAGE_TYPES.ITEM_ERROR,
      payload: {
        requestId,
        itemId: item.itemId,
        code,
        message,
        ...(reason ? { reason } : {}),
      },
    });
  }

  send(conn, {
    type: MESSAGE_TYPES.BATCH_DONE,
    payload: {
      requestId,
      ok: false,
      done: 0,
      failed: items.length,
      cancelled: 0,
      error: makeError(code, message, reason),
    },
  });
}

/**
 * 缓存命中回显：每个 item 都发 START → DONE，`usage` 为 null，不占执行器名额。
 * @param {object} submission
 * @param {object} group
 */
function fanOutCacheHit(submission, group) {
  const text = typeof group.cacheEntry?.text === 'string' ? group.cacheEntry.text : '';
  for (const item of group.items) {
    if (item.settled) continue;
    if (!send(submission.conn, {
      type: MESSAGE_TYPES.ITEM_START,
      payload: { requestId: submission.requestId, itemId: item.itemId },
    })) {
      return;
    }
    item.state = 'loading';
    submission.cacheHits += 1;
    log.withTrace(submission.traceId).debug('cache.hit', '缓存命中，跳过上游', {
      requestId: submission.requestId,
      itemId: item.itemId,
      bytes: group.cacheEntry?.bytes ?? null,
    });
    settleItem(submission, item, 'done', { notify: true, text, usage: null });
  }
}

/**
 * 创建一次共享执行；同一个 key 在 `inFlightByKey` 里只保留一个。
 * 批次 job 由 A3 队列执行，`jobHandle` 用于在无订阅者时摘除该 group。
 * @param {object} submission
 * @param {object} group
 * @param {object} context
 */
function createShared(submission, group, context) {
  const shared = {
    key: group.key,
    group,
    cacheKey: group.cacheKey,
    text: group.text,
    cacheEnabled: context.cacheEnabled,
    cacheGeneration: context.cacheGeneration,
    domain: context.domain,
    subscribers: new Set(),
    owner: null,
    state: 'running',
    jobHandle: null,
    startedAt: Date.now(),
    ownerSubmission: submission,
  };
  inFlightByKey.set(group.key, shared);
  return shared;
}

/**
 * 订阅一个共享执行：每个订阅 item 都先收到 `ST_ITEM_START`。
 * @param {object} submission
 * @param {object} group
 * @param {object} shared
 * @param {{ owner: boolean }} options
 */
function subscribeGroup(submission, group, shared, { owner }) {
  group.shared = shared;
  group.state = owner ? 'owner' : 'subscribed';
  for (const item of group.items) {
    if (item.settled || submission.conn.disconnected) continue;
    const subscriber = { submission, item };
    item.subscriber = subscriber;
    item.state = 'loading';
    shared.subscribers.add(subscriber);
    if (owner && !shared.owner) shared.owner = subscriber;
    if (!owner) submission.dedupeJoined += 1;
    send(submission.conn, {
      type: MESSAGE_TYPES.ITEM_START,
      payload: { requestId: submission.requestId, itemId: item.itemId },
    });
  }
  if (owner) submission.dedupeShared += 1;
}

/**
 * 成功收到一个 group 的译文：按 group 写一次缓存，fan-out 给全部订阅者并从在途表移除。
 * 多段批的每个 `ST_ITEM_DONE.usage` 为 `null`；单段批只把上游 usage 给 owner。
 * @param {string} traceId
 * @param {object} shared
 * @param {string} text
 * @param {unknown} usage
 * @param {'single'|'batch'} mode
 */
function resolveShared(traceId, shared, text, usage, mode) {
  if (!shared || shared.state !== 'running') return;
  shared.state = 'done';
  if (inFlightByKey.get(shared.key) === shared) inFlightByKey.delete(shared.key);

  // 先计入写入数再 fan-out，让同一次提交的 batch.done 能看到本次写入；实际写入仍异步。
  const shouldWrite = shared.cacheEnabled && shared.cacheKey && text.trim() !== '';
  if (shouldWrite && shared.ownerSubmission) shared.ownerSubmission.cacheWrites += 1;

  for (const subscriber of [...shared.subscribers]) {
    settleItem(subscriber.submission, subscriber.item, 'done', {
      notify: true,
      text,
      usage: mode === 'single' && subscriber === shared.owner ? (usage ?? null) : null,
    });
  }
  shared.subscribers.clear();

  if (shouldWrite) writeSharedCache(shared, text);
  log.withTrace(traceId).debug('dedupe.done', '共享请求完成', {
    requestId: shared.ownerSubmission?.requestId ?? null,
    mode,
    subscribers: shared.subscribers.size,
  });
}

/**
 * 共享执行失败：从在途表移除，按统一错误码结算全部订阅者；已成功 group 不回滚。
 * @param {string} traceId
 * @param {object} shared
 * @param {string} code
 * @param {string} message
 */
function failShared(traceId, shared, code, message) {
  if (!shared || shared.state !== 'running') return;
  shared.state = 'failed';
  if (inFlightByKey.get(shared.key) === shared) inFlightByKey.delete(shared.key);

  log.withTrace(traceId).warn('dedupe.error', '共享请求失败', {
    requestId: shared.ownerSubmission?.requestId ?? null,
    code,
    subscribers: shared.subscribers.size,
  });
  for (const subscriber of [...shared.subscribers]) {
    settleItem(subscriber.submission, subscriber.item, 'failed', {
      notify: true,
      code,
      message,
    });
  }
  shared.subscribers.clear();
}

/**
 * 成功定稿后按 group 写一次缓存；失败只记日志，不影响已发出的定稿帧。
 * @param {object} shared
 * @param {string} text
 */
function writeSharedCache(shared, text) {
  const submission = shared.ownerSubmission;
  void getCacheStore()
    .set(shared.cacheKey, text, {
      generation: shared.cacheGeneration,
      domain: shared.domain,
    })
    .then((outcome) => {
      if (!outcome?.written) return;
      log.withTrace(submission?.traceId).debug('cache.write', '已写入缓存', {
        requestId: submission?.requestId ?? null,
        bytes: outcome.bytes,
      });
    })
    .catch(() => {
      // 写入失败不影响翻译结果；详细原因已由 A4 记录。
    });
}

/**
 * 结算一段：更新计数、发帧并在全部结算后结束提交。
 * @param {object} submission
 * @param {object} item
 * @param {'done'|'failed'|'cancelled'} outcome
 * @param {{ notify?: boolean, text?: string, usage?: unknown, code?: string, message?: string, reason?: string }} [options]
 * @returns {boolean}
 */
function settleItem(submission, item, outcome, options = {}) {
  if (!submission || !item || item.settled) return false;
  item.settled = true;
  item.state = outcome;
  item.subscriber = null;

  if (outcome === 'done') submission.done += 1;
  else if (outcome === 'failed') submission.failed += 1;
  else submission.cancelledCount += 1;

  if (outcome === 'failed') {
    log.withTrace(submission.traceId).warn('item.error', '段落翻译失败', {
      requestId: submission.requestId,
      itemId: item.itemId,
      code: options.code ?? ERROR_CODES.OTHER,
      ...(options.reason ? { reason: options.reason } : {}),
    });
  } else if (outcome === 'cancelled') {
    log.withTrace(submission.traceId).debug('item.cancel', '段落已取消', {
      requestId: submission.requestId,
      itemId: item.itemId,
    });
  }

  if (options.notify !== false) notifyItem(submission, item, outcome, options);
  finishIfAllSettled(submission);
  return true;
}

/**
 * 给页面发单段终态帧；连接已断开或提交已结束时不再发。
 * @param {object} submission
 * @param {object} item
 * @param {'done'|'failed'|'cancelled'} outcome
 * @param {object} options
 */
function notifyItem(submission, item, outcome, options) {
  const conn = submission.conn;
  if (!conn || conn.disconnected || submission.finished) return;
  const base = { requestId: submission.requestId, itemId: item.itemId };

  if (outcome === 'done') {
    send(conn, {
      type: MESSAGE_TYPES.ITEM_DONE,
      payload: { ...base, text: options.text ?? '', usage: options.usage ?? null },
    });
    return;
  }

  if (outcome === 'failed') {
    send(conn, {
      type: MESSAGE_TYPES.ITEM_ERROR,
      payload: {
        ...base,
        code: options.code ?? ERROR_CODES.OTHER,
        message: options.message ?? '翻译失败',
        ...(options.reason ? { reason: options.reason } : {}),
      },
    });
    return;
  }

  send(conn, {
    type: MESSAGE_TYPES.ITEM_ERROR,
    payload: { ...base, code: ERROR_CODES.CANCELLED, message: '翻译已取消' },
  });
}

/**
 * @param {object} submission
 */
function finishIfAllSettled(submission) {
  if (submission.finished) return;
  if (!submission.items.every((item) => item.settled)) return;
  finishSubmission(submission);
}

/**
 * 结束一次提交：发 `ST_BATCH_DONE` 并记录计数。
 * @param {object} submission
 */
function finishSubmission(submission) {
  if (submission.finished) return;
  submission.finished = true;
  if (submission.deadlineTimer) clearTimeout(submission.deadlineTimer);
  submission.conn?.submissions?.delete(submission.submissionKey ?? submission.requestId);

  send(submission.conn, {
    type: MESSAGE_TYPES.BATCH_DONE,
    payload: {
      requestId: submission.requestId,
      ok: submission.failed === 0 && submission.cancelledCount === 0,
      done: submission.done,
      failed: submission.failed,
      cancelled: submission.cancelledCount,
    },
  });

  log.withTrace(submission.traceId).info('batch.done', '批次结束', {
    requestId: submission.requestId,
    done: submission.done,
    failed: submission.failed,
    cancelled: submission.cancelledCount,
    cacheHits: submission.cacheHits,
    cacheMisses: submission.cacheMisses,
    cacheWrites: submission.cacheWrites,
    dedupeHits: submission.dedupeHits,
    dedupeShared: submission.dedupeShared,
    dedupeJoined: submission.dedupeJoined,
    uniqueGroups: submission.groups.size,
    batches: submission.batches.length,
  });
}

/**
 * 取消整个提交：先摘除订阅并结算，再释放无订阅者的共享执行。
 * @param {object} submission
 */
function cancelSubmission(submission) {
  if (!submission || submission.finished) return;
  submission.cancelled = true;
  const pendingItems = submission.items.filter((item) => !item.settled);
  const touched = takeSubscriptions(pendingItems);
  for (const item of pendingItems) {
    settleItem(submission, item, 'cancelled', { notify: false });
  }
  for (const shared of touched) releaseSharedIfUnused(submission.traceId, shared);
  finishIfAllSettled(submission);
}

/**
 * 取消单段：只移除本提交的订阅，不影响其它提交/连接。
 * @param {object} submission
 * @param {unknown} itemId
 */
function cancelItemOfSubmission(submission, itemId) {
  const item = submission.items.find((entry) => entry.itemId === itemId);
  if (!item || item.settled) return;
  const touched = takeSubscriptions([item]);
  settleItem(submission, item, 'cancelled', { notify: false });
  for (const shared of touched) releaseSharedIfUnused(submission.traceId, shared);
  finishIfAllSettled(submission);
}

/**
 * 摘除 item 的订阅但不触发取消，返回受影响的 shared 集合。
 * 调用方先结算 item，再调用 `releaseSharedIfUnused`，避免取消回调早于结算。
 * @param {object[]} items
 * @returns {Set<object>}
 */
function takeSubscriptions(items) {
  const touched = new Set();
  for (const item of items) {
    const shared = item.group?.shared;
    const subscriber = item.subscriber;
    item.subscriber = null;
    if (!shared) continue;
    if (subscriber) shared.subscribers.delete(subscriber);
    if (shared.owner === subscriber) shared.owner = null;
    touched.add(shared);
  }
  return touched;
}

/**
 * 共享执行已无订阅者时置取消，并从队列 job 摘除该 group；job 无剩余 group 时由队列 abort。
 * @param {string} traceId
 * @param {object} shared
 */
function releaseSharedIfUnused(traceId, shared) {
  if (!shared || shared.state !== 'running' || shared.subscribers.size > 0) return;
  shared.state = 'cancelled';
  if (inFlightByKey.get(shared.key) === shared) inFlightByKey.delete(shared.key);
  shared.jobHandle?.dropGroup(shared.group);
  log.withTrace(traceId).debug('dedupe.abort', '无订阅者，取消批次中的段落组', {
    requestId: shared.ownerSubmission?.requestId ?? null,
  });
}

/**
 * 提交超时：未结算段落以 NETWORK / BATCH_TIMEOUT 失败，并释放无订阅者的共享执行。
 * @param {object} submission
 */
function onSubmissionTimeout(submission) {
  if (submission.finished) return;
  submission.timedOut = true;
  const pendingItems = submission.items.filter((item) => !item.settled);
  const touched = takeSubscriptions(pendingItems);
  for (const item of pendingItems) {
    settleItem(submission, item, 'failed', {
      notify: true,
      code: ERROR_CODES.NETWORK,
      message: '翻译超时',
      reason: FAILURE_REASONS.BATCH_TIMEOUT,
    });
  }
  for (const shared of touched) releaseSharedIfUnused(submission.traceId, shared);
  finishIfAllSettled(submission);
}
