/**
 * D5 任务调度
 *
 * 模块：页面注入（D）/ D5（任务调度属流程机制，见项目架构 6.2）
 * 职责：Ctrl 单段与整页翻译共用同一提交函数，经 `ST_PAGE_SUBMIT` 把段落发到后台；整页提交当前视口
 *       附近的段落，并在页面会话期间按 200ms 防抖增量提交新出现的段落；按提交记录把逐段结果帧
 *       （含流式增量）显示到对应段落。
 * 依赖：D1（视口附近段落与段落 id）、D3（渲染）、E1、公共数值、E4。
 * 实现阶段：P4（悬停单段任务）、P5（批次 `domain`）、P6.1（统一提交、页面会话与滚动增量）；
 *           本轮增加提交记录、段落注册表与结果回显，结果来源由 `resultsFactory` 注入的假数据提供。
 *
 * 页面不做分批、不做同文本去重、不负责真实翻译：这些都属于后台（P6.2 / P6.4）。
 * 提交是一次性控制消息（`ST_PAGE_SUBMIT`），后台收到并回执即视为提交成功；
 * 结果帧复用数据面 `ST_ITEM_*` 形状，按 `requestId + itemId` 路由到段落。
 * 任务数据只在页面内存，不写 `storage.session`（状态镜像归 P7）。
 */

import { ERROR_CODES, MESSAGE_TYPES, makeError, normalizeDomain } from '../shared/protocol.js';
import { DISPLAY_UPDATE_THROTTLE_MS, SCROLL_SUBMIT_DEBOUNCE_MS } from '../shared/constants.js';
import { createLogger } from '../shared/log/logger.js';
import {
  HOST_ATTR,
  collectParagraphs,
  ensureHost,
  extractText,
  hasLetter,
  normalizeText,
} from './dom/scanner.js';

/** D5 日志入口。 */
const log = createLogger('D5');

/** 用户可见的提示语。 */
const MESSAGES = Object.freeze({
  submitFailed: '提交失败，请稍后重试',
});

/** 页面会消费的结果帧类型；其余帧交给其它模块处理。 */
const RESULT_FRAME_TYPES = new Set([
  MESSAGE_TYPES.ITEM_START,
  MESSAGE_TYPES.ITEM_DELTA,
  MESSAGE_TYPES.ITEM_DONE,
  MESSAGE_TYPES.ITEM_ERROR,
]);

/**
 * 当前页面 hostname，只作为缓存元数据随提交上报；取不到时为空串。
 * 只取 hostname，不带协议、端口、路径与查询串。
 * @returns {string}
 */
function currentDomain() {
  try {
    return normalizeDomain(typeof location !== 'undefined' ? location.hostname : '');
  } catch {
    return '';
  }
}

/**
 * 当前视口尺寸，只用于日志与后台定位。
 * @returns {{ width: number, height: number }}
 */
function currentViewport() {
  const view = typeof window !== 'undefined' ? window : undefined;
  return {
    width: Number(view?.innerWidth ?? 0),
    height: Number(view?.innerHeight ?? 0),
  };
}

/**
 * 读取宿主的段落 id；没有时返回空串。
 * @param {Element} host
 * @returns {string}
 */
function hostIdOf(host) {
  return host?.getAttribute?.(HOST_ATTR) ?? '';
}

/**
 * 读取段落的段落 id：优先用扫描结果已带的值，其次读宿主属性。
 * @param {{ hostId?: string, host?: Element }} paragraph
 * @returns {string}
 */
function paragraphIdOf(paragraph) {
  return paragraph?.hostId ?? hostIdOf(paragraph?.host);
}

/**
 * @param {string} action
 * @returns {{ ok: true, data: { action: string } }}
 */
function ok(action) {
  return { ok: true, data: { action } };
}

/**
 * 创建任务控制器：统一提交 + 页面会话滚动增量 + 结果回显 + Ctrl 单段。
 *
 * @param {{
 *   renderer: {
 *     showSubmitting: Function,
 *     showSubmitted: Function,
 *     showLoading: Function,
 *     update: Function,
 *     showDone: Function,
 *     showSubmitError: Function,
 *     showError: Function,
 *     remove: Function,
 *     clearAll: Function,
 *     getState: Function,
 *     has: Function,
 *   },
 *   submit?: (payload: object) => Promise<{ ok: boolean, data?: object, error?: object }>,
 *   resultsFactory?: (options: { onFrame: (frame: object) => void }) => {
 *     start: Function,
 *     cancelAll: Function,
 *     setMode?: Function,
 *     getMode?: Function,
 *   } | null,
 *   logger?: object,
 *   now?: () => number,
 *   schedule?: (fn: () => void, ms: number) => unknown,
 *   cancel?: (handle: unknown) => void,
 *   scan?: (options: object) => Promise<Array<object>>,
 *   inViewport?: (host: Element) => boolean,
 * }} deps
 */
export function createTask({
  renderer,
  submit,
  resultsFactory,
  logger = log,
  now = () => Date.now(),
  schedule = (fn, ms) => setTimeout(fn, ms),
  cancel = (handle) => clearTimeout(handle),
  scan = collectParagraphs,
  inViewport,
} = {}) {
  let sequence = 0;
  let scrollTimer = null;
  let scrollBound = false;
  let scrolling = false;
  let scrollPending = false;

  /** 每段的增量刷新计时器：段落 id → 计时器句柄。 */
  const flushTimers = new Map();

  /** 页面会话；段落只保存本会话已提交与在途的段落 id、提交记录与注册表。 */
  const page = {
    phase: 'idle',
    targetLang: undefined,
    traceId: undefined,
    requestId: null,
    /** @type {Set<string>} */
    submittedHosts: new Set(),
    /** @type {Set<string>} */
    attemptedHosts: new Set(),
    /** @type {Set<string>} */
    inFlightHosts: new Set(),
    /** @type {Map<string, object>} requestId → 提交记录 */
    submissions: new Map(),
    /** @type {Map<string, { host: Element, text: string }>} 段落 id → 宿主 */
    registry: new Map(),
    /** @type {Map<string, string>} 段落 id → 最近一次提交的 requestId */
    latestRequest: new Map(),
    sessionToken: 0,
    labelEpoch: 0,
    startedAt: 0,
    lastError: null,
  };

  /** 结果来源：本阶段为页面内假数据；P6.2 接入后台帧后移除。 */
  const results =
    typeof resultsFactory === 'function'
      ? resultsFactory({ onFrame: (frame) => applyResultFrame(frame) })
      : null;

  /**
   * @param {string} [traceId]
   * @returns {object}
   */
  function traceOf(traceId) {
    return traceId && typeof logger.withTrace === 'function'
      ? logger.withTrace(traceId)
      : logger;
  }

  /**
   * 状态响应。
   * @returns {{ ok: true, data: { phase: string, total: number } }}
   */
  function status() {
    return { ok: true, data: { phase: page.phase, total: page.submittedHosts.size } };
  }

  function nextSubmitRequestId() {
    sequence += 1;
    return `s-${now().toString(36)}-${sequence}`;
  }

  /**
   * 组装 `ST_PAGE_SUBMIT` 载荷；每段只有 index / hostId / text，不含 HTML、URL 或上下文。
   * @param {'page'|'single'} scope
   * @param {Array<object>} paragraphs
   * @param {string} requestId
   * @param {string} [traceId]
   * @returns {object}
   */
  function buildPayload(scope, paragraphs, requestId, traceId = page.traceId) {
    return {
      requestId,
      ...(traceId ? { traceId } : {}),
      scope,
      ...(page.targetLang ? { targetLang: page.targetLang } : {}),
      domain: currentDomain(),
      viewport: currentViewport(),
      paragraphs: paragraphs.map((paragraph, index) => ({
        index,
        hostId: paragraphIdOf(paragraph),
        text: paragraph.text,
      })),
    };
  }

  /**
   * 对一批段落执行一次渲染。
   * @param {Array<object>} paragraphs
   * @param {'submitting'|'submitted'|'error'} mode
   * @param {string} [message]
   */
  function renderParagraphs(paragraphs, mode, message) {
    for (const paragraph of paragraphs) {
      const host = paragraph.host;
      if (!host || host.isConnected === false) continue;
      try {
        if (mode === 'submitting') renderer.showSubmitting(host);
        else if (mode === 'submitted') renderer.showSubmitted(host);
        else renderer.showSubmitError(host, message ?? MESSAGES.submitFailed);
      } catch {
        // 单个宿主渲染失败不影响其它段落。
      }
    }
  }

  /**
   * 把一段或多段加入本会话已提交集合。
   * @param {Array<object>} paragraphs
   */
  function markSubmitted(paragraphs) {
    for (const paragraph of paragraphs) {
      const itemId = paragraphIdOf(paragraph);
      if (!itemId) continue;
      page.submittedHosts.add(itemId);
      page.attemptedHosts.add(itemId);
    }
  }

  /**
   * 登记一次提交：提交记录、段落注册表与「最近一次提交」索引。
   * @param {string} requestId
   * @param {'page'|'single'} scope
   * @param {Array<object>} paragraphs
   * @returns {object} 提交记录
   */
  function registerSubmission(requestId, scope, paragraphs) {
    const submission = {
      requestId,
      scope,
      token: page.sessionToken,
      epoch: page.labelEpoch,
      startedAt: now(),
      /** @type {Map<string, { host: Element, text: string, state: string, buffer: string }>} */
      items: new Map(),
    };
    for (const paragraph of paragraphs) {
      const itemId = paragraphIdOf(paragraph);
      if (!itemId) continue;
      submission.items.set(itemId, {
        host: paragraph.host,
        text: paragraph.text,
        state: 'submitted',
        buffer: '',
      });
      page.registry.set(itemId, { host: paragraph.host, text: paragraph.text });
      page.latestRequest.set(itemId, requestId);
    }
    page.submissions.set(requestId, submission);
    page.requestId = requestId;
    return submission;
  }

  /**
   * 发送一条 `ST_PAGE_SUBMIT`；提交期间把段落 id 记入在途集合。
   * @param {'page'|'single'} scope
   * @param {Array<object>} paragraphs
   * @param {string} [traceId]
   * @returns {Promise<{ requestId: string, response: object | null }>}
   */
  async function submitBatch(scope, paragraphs, traceId) {
    const requestId = nextSubmitRequestId();
    const itemIds = paragraphs.map(paragraphIdOf).filter(Boolean);
    for (const itemId of itemIds) page.inFlightHosts.add(itemId);

    page.requestId = requestId;
    const payload = buildPayload(scope, paragraphs, requestId, traceId);
    let response = null;
    try {
      response = typeof submit === 'function' ? await submit(payload) : null;
    } catch {
      response = null;
    }

    for (const itemId of itemIds) page.inFlightHosts.delete(itemId);
    return { requestId, response };
  }

  /**
   * 停掉当前结果来源与所有待刷新计时器；不清页面标记与会话数据。
   */
  function stopResultPipeline() {
    try {
      results?.cancelAll?.();
    } catch {
      // 结果来源异常不阻断清理。
    }
    for (const handle of flushTimers.values()) cancel(handle);
    flushTimers.clear();
  }

  /**
   * 清空会话数据：提交记录、注册表、最近提交索引与已提交/已尝试集合。
   */
  function resetSessionData() {
    page.submissions.clear();
    page.registry.clear();
    page.latestRequest.clear();
    page.submittedHosts.clear();
    page.attemptedHosts.clear();
    page.inFlightHosts.clear();
    page.requestId = null;
  }

  /**
   * 移除滚动监听、防抖计时器与扫描挂起标记。
   */
  function stopScroll() {
    if (scrollTimer != null) {
      cancel(scrollTimer);
      scrollTimer = null;
    }
    if (scrollBound && typeof window !== 'undefined') {
      window.removeEventListener('scroll', onScroll);
    }
    scrollBound = false;
    scrolling = false;
    scrollPending = false;
  }

  /**
   * 重置 200ms 防抖计时器；滚动停止后才扫描。
   */
  function resetScrollTimer() {
    if (scrollTimer != null) cancel(scrollTimer);
    scrollTimer = schedule(() => {
      scrollTimer = null;
      runScrollSubmit();
    }, SCROLL_SUBMIT_DEBOUNCE_MS);
  }

  /**
   * 滚动事件：只重置防抖，不在事件里扫描。
   */
  function onScroll() {
    if (page.phase !== 'submitted') return;
    if (scrolling) {
      scrollPending = true;
      return;
    }
    resetScrollTimer();
  }

  /**
   * 滚动停止后扫描视口附近段落，只提交新的段落 id。
   */
  async function runScrollSubmit() {
    if (page.phase !== 'submitted') return;
    if (scrolling) {
      scrollPending = true;
      return;
    }

    scrolling = true;
    const token = page.sessionToken;
    const traceLog = traceOf(page.traceId);

    try {
      let paragraphs;
      try {
        paragraphs = await scan({ ...(inViewport ? { inViewport } : {}), logger: traceLog });
      } catch {
        if (token === page.sessionToken) {
          traceLog.warn('page.error', '滚动扫描失败', { code: ERROR_CODES.OTHER });
        }
        return;
      }
      if (token !== page.sessionToken) return;

      const fresh = (Array.isArray(paragraphs) ? paragraphs : []).filter((paragraph) => {
        const itemId = paragraphIdOf(paragraph);
        return itemId && !page.attemptedHosts.has(itemId) && !page.inFlightHosts.has(itemId);
      });
      if (fresh.length === 0) return;

      renderParagraphs(fresh, 'submitting');
      const { requestId, response } = await submitBatch('page', fresh, page.traceId);
      if (token !== page.sessionToken) return;

      for (const paragraph of fresh) {
        const itemId = paragraphIdOf(paragraph);
        if (itemId) page.attemptedHosts.add(itemId);
      }

      if (response?.ok && response.data?.accepted) {
        renderParagraphs(fresh, 'submitted');
        markSubmitted(fresh);
        const submission = registerSubmission(requestId, 'page', fresh);
        try {
          results?.start?.(submission);
        } catch {
          // 结果来源异常不影响提交状态。
        }
        traceLog.info('page.submit', '滚动增量已提交', {
          requestId,
          scope: 'page',
          paragraphs: fresh.length,
          chars:
            response.data?.chars ??
            fresh.reduce((sum, paragraph) => sum + paragraph.text.length, 0),
          accepted: true,
        });
        traceLog.debug('page.scroll', '滚动增量提交完成', { added: fresh.length });
      } else {
        const code = response?.error?.code ?? ERROR_CODES.NETWORK;
        const message = response?.error?.message ?? MESSAGES.submitFailed;
        renderParagraphs(fresh, 'error', message);
        traceLog.warn('page.error', '滚动增量提交失败', {
          requestId,
          scope: 'page',
          paragraphs: fresh.length,
          code,
        });
      }
    } finally {
      scrolling = false;
      if (scrollPending) {
        scrollPending = false;
        if (page.phase === 'submitted') resetScrollTimer();
      }
    }
  }

  /**
   * 页面会话进入 `submitted` 后安装滚动监听。
   */
  function installScroll() {
    if (scrollBound || typeof window === 'undefined') return;
    window.addEventListener('scroll', onScroll, { passive: true });
    scrollBound = true;
  }

  /**
   * 从提交记录里找到某段的条目。
   * @param {string} itemId
   * @returns {{ submission: object, item: object } | null}
   */
  function findItem(itemId) {
    const requestId = page.latestRequest.get(itemId);
    if (!requestId) return null;
    const submission = page.submissions.get(requestId);
    const item = submission?.items.get(itemId);
    return item ? { submission, item } : null;
  }

  /**
   * 窗口到点后把累计增量写进 DOM。
   * @param {string} itemId
   */
  function flushItem(itemId) {
    const found = findItem(itemId);
    if (!found || found.item.state !== 'streaming') return;
    const host = page.registry.get(itemId)?.host;
    if (!host || host.isConnected === false) {
      page.registry.delete(itemId);
      return;
    }
    try {
      renderer.update(host, found.item.buffer);
    } catch {
      // 单段渲染失败不影响其它段落。
    }
  }

  /**
   * 为某段安排一次合并刷新：窗口内多次增量只写一次 DOM。
   * @param {string} itemId
   */
  function scheduleFlush(itemId) {
    if (flushTimers.has(itemId)) return;
    const handle = schedule(() => {
      flushTimers.delete(itemId);
      flushItem(itemId);
    }, DISPLAY_UPDATE_THROTTLE_MS);
    flushTimers.set(itemId, handle);
  }

  /**
   * 取消某段待刷新任务。
   * @param {string} itemId
   */
  function cancelFlush(itemId) {
    const handle = flushTimers.get(itemId);
    if (handle == null) return;
    cancel(handle);
    flushTimers.delete(itemId);
  }

  /**
   * 记录丢弃的结果帧；只记标识与原因，不记文本。
   * @param {string} requestId
   * @param {string} itemId
   * @param {string} reason
   */
  function dropResult(requestId, itemId, reason) {
    traceOf(page.traceId).debug('page.result.dropped', '结果帧已丢弃', {
      requestId,
      itemId,
      reason,
    });
  }

  /**
   * 结果入口：按 `requestId + itemId` 把帧路由到段落并渲染。
   * 本阶段由页面内假数据调用；P6.2 / P6.4 由 D4 帧转发到同一函数。
   * @param {{ type?: string, payload?: object }} frame
   * @returns {boolean} 是否应用到页面
   */
  function applyResultFrame(frame) {
    const type = frame?.type;
    const payload = frame?.payload;
    if (!payload || typeof payload !== 'object' || !RESULT_FRAME_TYPES.has(type)) return false;

    const requestId = payload.requestId;
    const itemId = payload.itemId;
    if (typeof requestId !== 'string' || typeof itemId !== 'string') return false;

    const submission = page.submissions.get(requestId);
    if (!submission) {
      dropResult(requestId, itemId, 'no-submission');
      return false;
    }
    if (submission.token !== page.sessionToken || submission.epoch !== page.labelEpoch) {
      dropResult(requestId, itemId, 'stale');
      return false;
    }
    if (page.latestRequest.get(itemId) !== requestId) {
      dropResult(requestId, itemId, 'superseded');
      return false;
    }

    const item = submission.items.get(itemId);
    if (!item) {
      dropResult(requestId, itemId, 'no-item');
      return false;
    }

    const host = page.registry.get(itemId)?.host;
    if (!host || host.isConnected === false) {
      page.registry.delete(itemId);
      dropResult(requestId, itemId, 'no-host');
      return false;
    }

    const traceLog = traceOf(page.traceId);
    switch (type) {
      case MESSAGE_TYPES.ITEM_START: {
        if (item.state === 'done') return false;
        item.state = 'loading';
        renderer.showLoading(host);
        break;
      }
      case MESSAGE_TYPES.ITEM_DELTA: {
        if (item.state === 'done') return false;
        item.state = 'streaming';
        item.buffer += typeof payload.delta === 'string' ? payload.delta : '';
        scheduleFlush(itemId);
        break;
      }
      case MESSAGE_TYPES.ITEM_DONE: {
        const text = typeof payload.text === 'string' ? payload.text : item.buffer;
        cancelFlush(itemId);
        item.state = 'done';
        item.buffer = text;
        renderer.showDone(host, text);
        break;
      }
      case MESSAGE_TYPES.ITEM_ERROR: {
        cancelFlush(itemId);
        item.state = 'error';
        renderer.showError(host, payload.message);
        traceLog.warn('page.result.error', '段落翻译失败', {
          requestId,
          itemId,
          code: payload.code ?? null,
        });
        break;
      }
      default:
        return false;
    }

    traceLog.debug('page.result', '接收结果帧', {
      requestId,
      itemId,
      type,
      state: item.state,
    });
    return true;
  }

  /**
   * 取当前视口附近段落并提交；成功后进入页面会话、监听滚动并开始结果回显。
   * @param {{ targetLang?: string, traceId?: string }} [options]
   * @returns {Promise<{ ok: true, data: { phase: string, total: number } } | { ok: false, error: object }>}
   */
  async function start({ targetLang, traceId } = {}) {
    if (page.phase === 'scanning' || page.phase === 'submitting') {
      return status();
    }

    page.sessionToken += 1;
    const token = page.sessionToken;
    page.labelEpoch += 1;
    stopScroll();
    stopResultPipeline();
    renderer.clearAll();
    resetSessionData();
    page.lastError = null;

    if (typeof targetLang === 'string' && targetLang.trim() !== '') {
      page.targetLang = targetLang.trim();
    }
    if (traceId) page.traceId = traceId;

    page.phase = 'scanning';
    page.startedAt = now();
    const traceLog = traceOf(traceId ?? page.traceId);

    let paragraphs;
    try {
      paragraphs = await scan({ ...(inViewport ? { inViewport } : {}), logger: traceLog });
    } catch {
      if (token !== page.sessionToken) return status();
      page.phase = 'error';
      page.lastError = ERROR_CODES.OTHER;
      traceLog.warn('page.error', '扫描页面失败', { code: ERROR_CODES.OTHER });
      return {
        ok: false,
        error: makeError(ERROR_CODES.OTHER, '扫描页面失败，请稍后重试'),
      };
    }
    if (token !== page.sessionToken) return status();

    const collected = Array.isArray(paragraphs) ? paragraphs : [];
    if (collected.length === 0) {
      page.phase = 'idle';
      return status();
    }

    page.phase = 'submitting';
    const { requestId, response } = await submitBatch('page', collected, traceId ?? page.traceId);
    if (token !== page.sessionToken) return status();

    if (!response?.ok || !response.data?.accepted) {
      const code = response?.error?.code ?? ERROR_CODES.NETWORK;
      const message = response?.error?.message ?? MESSAGES.submitFailed;
      renderParagraphs(collected, 'error', message);
      page.phase = 'error';
      page.lastError = code;
      traceLog.warn('page.error', '提交整页段落失败', {
        requestId,
        scope: 'page',
        paragraphs: collected.length,
        code,
      });
      return {
        ok: false,
        error: makeError(code, message, response?.error?.reason),
      };
    }

    renderParagraphs(collected, 'submitted');
    markSubmitted(collected);
    const submission = registerSubmission(requestId, 'page', collected);
    page.phase = 'submitted';
    installScroll();
    try {
      results?.start?.(submission);
    } catch {
      // 结果来源异常不影响提交状态。
    }
    traceLog.info('page.submit', '已提交整页段落', {
      requestId,
      scope: 'page',
      paragraphs: collected.length,
      chars:
        response.data?.chars ??
        collected.reduce((sum, paragraph) => sum + paragraph.text.length, 0),
      accepted: true,
      elapsedMs: Math.max(0, now() - page.startedAt),
    });
    return status();
  }

  /**
   * Ctrl 单段：已显示/失败的标记直接移除；其它情况走同一提交函数。
   * @param {Element} host
   * @param {string} [traceId]
   * @returns {Promise<{ ok: true, data: { action: string } } | { ok: false, error: object }>}
   */
  async function toggle(host, traceId) {
    if (!host || host.nodeType !== 1 || host.isConnected === false) {
      return ok('no-target');
    }

    const itemId = ensureHost(host);
    const traceLog = traceOf(traceId ?? page.traceId);
    const state = renderer.getState(host);

    if (state === 'done' || state === 'error' || state === 'submitted') {
      renderer.remove(host);
      page.registry.delete(itemId);
      traceLog.info('task.toggle', '移除段落标记', { action: 'hidden' });
      return ok('hidden');
    }

    if (state === 'submitting' || state === 'loading' || state === 'streaming') {
      traceLog.debug('task.toggle', '段落正在处理，忽略重复触发', { action: 'submitting' });
      return ok('submitting');
    }

    const text = normalizeText(extractText(host));
    if (!text || !hasLetter(text)) {
      traceLog.debug('segment.skip', '段落没有可翻译文本', { action: 'no-target' });
      return ok('no-target');
    }

    const paragraph = { index: 0, hostId: itemId, text, host };
    const epoch = page.labelEpoch;
    renderer.showSubmitting(host);
    const { requestId, response } = await submitBatch('single', [paragraph], traceId ?? page.traceId);

    // 提交期间页面被清除或重新触发：丢弃旧结果，避免清除后又冒出一条标记。
    if (epoch !== page.labelEpoch) {
      traceLog.debug('task.cancel', '单段提交结果已过期', { requestId, action: 'hidden' });
      return ok('hidden');
    }

    if (response?.ok && response.data?.accepted) {
      renderer.showSubmitted(host);
      page.submittedHosts.add(itemId);
      page.attemptedHosts.add(itemId);
      const submission = registerSubmission(requestId, 'single', [paragraph]);
      try {
        results?.start?.(submission);
      } catch {
        // 结果来源异常不影响提交状态。
      }
      traceLog.info('task.toggle', '单段已提交', {
        action: 'submitted',
        requestId,
        textLength: text.length,
      });
      return ok('submitted');
    }

    const code = response?.error?.code ?? ERROR_CODES.NETWORK;
    const message = response?.error?.message ?? MESSAGES.submitFailed;
    page.attemptedHosts.add(itemId);
    renderer.showSubmitError(host, message);
    traceLog.warn('task.error', '单段提交失败', {
      action: 'failed',
      requestId,
      code,
    });
    return { ok: false, error: makeError(code, message, response?.error?.reason) };
  }

  /**
   * 清除全部标记、译文与结果状态，并结束页面会话与滚动监听。
   * @returns {{ ok: true, data: { removed: number } }}
   */
  function clearAll() {
    page.sessionToken += 1;
    page.labelEpoch += 1;
    stopScroll();
    stopResultPipeline();
    resetSessionData();
    page.phase = 'idle';
    page.lastError = null;

    const removed = renderer.clearAll();
    logger.info('task.cancel', '已清除全部标记', { removed });
    return { ok: true, data: { removed } };
  }

  /**
   * 页面卸载：停止滚动监听、结果来源与刷新计时器，不清除页面上的标记。
   */
  function dispose() {
    page.sessionToken += 1;
    stopScroll();
    stopResultPipeline();
  }

  /**
   * 页面从 bfcache 恢复：页面会话仍在时重新安装滚动监听。
   */
  function resume() {
    if (page.phase === 'submitted') installScroll();
  }

  /**
   * 设置结果来源的模式（本阶段只有假数据源支持；P6.2 移除）。
   * @param {string} mode
   * @returns {string | null} 当前生效模式
   */
  function setResultMode(mode) {
    try {
      results?.setMode?.(mode);
      return results?.getMode?.() ?? null;
    } catch {
      return null;
    }
  }

  /**
   * 供测试与后续阶段读取提交状态快照。
   * @returns {{ phase: string, total: number }}
   */
  function getStatus() {
    return status().data;
  }

  return {
    start,
    toggle,
    clearAll,
    dispose,
    resume,
    setResultMode,
    applyResultFrame,
    getStatus,
  };
}
