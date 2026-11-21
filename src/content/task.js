/**
 * D5 任务调度
 *
 * 模块：页面注入（D）/ D5（任务调度属流程机制，见项目架构 6.2）
 * 职责：悬停单段与整页翻译共用同一提交函数，经 `ST_PAGE_SUBMIT` 把段落发到后台；整页提交当前视口
 *       附近的段落，并在页面会话期间按 200ms 防抖增量提交新出现的段落；按提交记录把逐段结果帧
 *       （含流式增量）显示到对应段落；P9 起支持失败段单段刷新、清除前取消后台提交与重连后续传一次；
 *       P14 起把定稿译文写入 D6 镜像，并按 D6 的调用恢复丢失容器的译文。
 * 依赖：D1（视口附近段落与段落 id）、D3（渲染）、D6（译文镜像，可选注入）、E1、公共数值、E4。
 * 实现阶段：P4（悬停单段任务）、P5（批次 `domain`）、P6.1（统一提交、页面会话与滚动增量）；
 *           P6.3 结果来源改为后台 D4 帧：提交前登记临时提交记录，命中帧可早到，提交失败时标错并清理；
 *           P9 增加 `retry()`、`clearAll()` 前取消、`resumeAfterReconnect()` 与 `applyBatchDone()`；
 *           P14 增加 `restore()` / `forget()` 与镜像、隐藏集合的调用。
 *
 * 页面不做分批、不做同文本去重、不负责真实翻译：这些都属于后台（P6.3 / P6.4）。
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
 * 创建任务控制器：统一提交 + 页面会话滚动增量 + 结果回显 + 悬停单段。
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
 *   cancelRequest?: (requestId: string) => void,
 *   heal?: {
 *     remember?: (source: string, translated: string, host?: Element | null) => boolean,
 *     hide?: (source: string) => void,
 *     unhide?: (host: Element | null, source: string) => void,
 *     reset?: () => void,
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
  cancelRequest,
  heal = null,
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
    /** 本次断连是否已经自动续传过；每次断连最多续传一次。 */
    resumeUsed: false,
    /** 重连次数，只用于日志。 */
    reconnectCount: 0,
  };

  /** 结果来源：后台 D4 帧经 `applyResultFrame` 进入，页面不再生成假数据。 */

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
   * 自愈模块的安全调用：镜像、隐藏集合或重置失败都不影响提交与显示。
   * @param {'remember'|'hide'|'unhide'|'reset'} method
   * @param {...unknown} args
   */
  function callHeal(method, ...args) {
    try {
      heal?.[method]?.(...args);
    } catch {
      // 自愈失败只影响自动恢复，不影响页面任务。
    }
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
   * 把一批段落标记为「提交中」。
   * @param {Array<object>} paragraphs
   */
  function renderSubmitting(paragraphs) {
    for (const paragraph of paragraphs) {
      const host = paragraph.host;
      if (!host || host.isConnected === false) continue;
      try {
        renderer.showSubmitting(host);
      } catch {
        // 单个宿主渲染失败不影响其它段落。
      }
    }
  }

  /**
   * 登记一次提交：提交记录、段落注册表与「最近一次提交」索引。
   * 发送前先登记（状态 `submitting`），后台命中帧可以早于回执到达并直接路由。
   * @param {string} requestId
   * @param {'page'|'single'} scope
   * @param {Array<object>} paragraphs
   * @param {'submitting'|'submitted'} [status]
   * @returns {object} 提交记录
   */
  function registerSubmission(requestId, scope, paragraphs, status = 'submitting') {
    const submission = {
      requestId,
      scope,
      status,
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
        state: status,
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
   * 提交成功：把仍停在 `submitting` 的段落推进到「已提交」；
   * 已经收到结果帧（loading / streaming / done）的段落保持当前状态。
   * @param {object} submission
   */
  function completeSubmission(submission) {
    submission.status = 'submitted';
    for (const [itemId, item] of submission.items) {
      page.submittedHosts.add(itemId);
      page.attemptedHosts.add(itemId);
      if (item.state !== 'submitting') continue;
      item.state = 'submitted';
      if (item.host?.isConnected === false) continue;
      try {
        renderer.showSubmitted(item.host);
      } catch {
        // 单个宿主渲染失败不影响其它段落。
      }
    }
  }

  /**
   * 提交失败：未收到结果的段落标错，并清理临时提交记录与索引。
   * @param {object} submission
   * @param {string} message
   */
  function failSubmission(submission, message) {
    submission.status = 'error';
    for (const [itemId, item] of submission.items) {
      const live = item.state === 'submitting' || item.state === 'loading' || item.state === 'streaming';
      if (live && item.host?.isConnected !== false) {
        try {
          renderer.showSubmitError(item.host, message);
        } catch {
          // 单个宿主渲染失败不影响其它段落。
        }
      }
      cancelFlush(itemId);
      if (page.latestRequest.get(itemId) === submission.requestId) {
        page.latestRequest.delete(itemId);
        page.registry.delete(itemId);
      }
    }
    page.submissions.delete(submission.requestId);
    if (page.requestId === submission.requestId) page.requestId = null;
  }

  /**
   * 发送一条 `ST_PAGE_SUBMIT`；发送前先登记临时提交，让早到的命中帧可路由。
   * @param {'page'|'single'} scope
   * @param {Array<object>} paragraphs
   * @param {string} [traceId]
   * @returns {Promise<{ requestId: string, submission: object, response: object | null }>}
   */
  async function submitBatch(scope, paragraphs, traceId) {
    const requestId = nextSubmitRequestId();
    const itemIds = paragraphs.map(paragraphIdOf).filter(Boolean);
    for (const itemId of itemIds) page.inFlightHosts.add(itemId);

    const submission = registerSubmission(requestId, scope, paragraphs, 'submitting');
    const payload = buildPayload(scope, paragraphs, requestId, traceId);
    let response = null;
    try {
      response = typeof submit === 'function' ? await submit(payload) : null;
    } catch {
      response = null;
    }

    for (const itemId of itemIds) page.inFlightHosts.delete(itemId);
    return { requestId, submission, response };
  }

  /**
   * 停掉所有待刷新计时器；不清页面标记与会话数据。
   */
  function stopResultPipeline() {
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

      renderSubmitting(fresh);
      const { requestId, submission, response } = await submitBatch('page', fresh, page.traceId);
      if (token !== page.sessionToken) return;

      for (const paragraph of fresh) {
        const itemId = paragraphIdOf(paragraph);
        if (itemId) page.attemptedHosts.add(itemId);
      }

      if (response?.ok && response.data?.accepted) {
        completeSubmission(submission);
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
        failSubmission(submission, message);
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
   * 生产路径由 `content/index.js` 把 D4 帧转发到这里；测试可直接调用。
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
        callHeal('remember', item.text, text, host);
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
    page.resumeUsed = false;
    stopScroll();
    stopResultPipeline();
    callHeal('reset');
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
    const { requestId, submission, response } = await submitBatch(
      'page',
      collected,
      traceId ?? page.traceId
    );
    if (token !== page.sessionToken) return status();

    if (!response?.ok || !response.data?.accepted) {
      const code = response?.error?.code ?? ERROR_CODES.NETWORK;
      const message = response?.error?.message ?? MESSAGES.submitFailed;
      failSubmission(submission, message);
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

    completeSubmission(submission);
    page.phase = 'submitted';
    installScroll();
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
   * 悬停单段：已显示/失败的标记直接移除；其它情况走同一提交函数。
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
    const text = normalizeText(extractText(host));

    if (state === 'done' || state === 'error' || state === 'submitted') {
      renderer.remove(host);
      page.registry.delete(itemId);
      if (text) callHeal('hide', text);
      traceLog.info('task.toggle', '移除段落标记', { action: 'hidden' });
      return ok('hidden');
    }

    if (state === 'submitting' || state === 'loading' || state === 'streaming') {
      traceLog.debug('task.toggle', '段落正在处理，忽略重复触发', { action: 'submitting' });
      return ok('submitting');
    }

    if (!text || !hasLetter(text)) {
      traceLog.debug('segment.skip', '段落没有可翻译文本', { action: 'no-target' });
      return ok('no-target');
    }

    const paragraph = { index: 0, hostId: itemId, text, host };
    const epoch = page.labelEpoch;
    page.resumeUsed = false;
    callHeal('unhide', host, text);
    renderer.showSubmitting(host);
    const { requestId, submission, response } = await submitBatch(
      'single',
      [paragraph],
      traceId ?? page.traceId
    );

    // 提交期间页面被清除或重新触发：丢弃旧结果，避免清除后又冒出一条标记。
    if (epoch !== page.labelEpoch) {
      traceLog.debug('task.cancel', '单段提交结果已过期', { requestId, action: 'hidden' });
      return ok('hidden');
    }

    if (response?.ok && response.data?.accepted) {
      completeSubmission(submission);
      page.attemptedHosts.add(itemId);
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
    failSubmission(submission, message);
    traceLog.warn('task.error', '单段提交失败', {
      action: 'failed',
      requestId,
      code,
    });
    return { ok: false, error: makeError(code, message, response?.error?.reason) };
  }

  /**
   * 失败段「刷新」：只在渲染状态为 `error` 时重发当前段，复用 `ST_PAGE_SUBMIT(scope='single')`。
   * 不启动滚动监听、不清除其它标记、不影响同页其它段。
   * @param {Element} host
   * @param {string} [traceId]
   * @returns {Promise<{ ok: true, data: { action: string } } | { ok: false, error: object }>}
   */
  async function retry(host, traceId) {
    if (!host || host.nodeType !== 1 || host.isConnected === false) return ok('no-target');
    if (renderer.getState(host) !== 'error') return ok('ignored');

    const itemId = ensureHost(host);
    const text = normalizeText(extractText(host));
    if (!text || !hasLetter(text)) return ok('no-target');

    const traceLog = traceOf(traceId ?? page.traceId);
    const epoch = page.labelEpoch;
    page.resumeUsed = false;
    callHeal('unhide', host, text);
    renderer.showSubmitting(host);

    const { requestId, submission, response } = await submitBatch(
      'single',
      [{ index: 0, hostId: itemId, text, host }],
      traceId ?? page.traceId
    );

    // 提交期间页面被清除或重新触发：丢弃旧结果，避免清除后又冒出一条标记。
    if (epoch !== page.labelEpoch) {
      traceLog.debug('task.retry', '单段刷新结果已过期', { requestId, itemId, action: 'hidden' });
      return ok('hidden');
    }

    if (response?.ok && response.data?.accepted) {
      completeSubmission(submission);
      page.attemptedHosts.add(itemId);
      traceLog.info('task.retry', '失败段已重新提交', {
        requestId,
        itemId,
        action: 'submitted',
        code: null,
      });
      return ok('submitted');
    }

    const code = response?.error?.code ?? ERROR_CODES.NETWORK;
    const message = response?.error?.message ?? MESSAGES.submitFailed;
    failSubmission(submission, message);
    traceLog.warn('task.retry', '失败段重新提交失败', {
      requestId,
      itemId,
      action: 'failed',
      code,
    });
    return { ok: false, error: makeError(code, message, response?.error?.reason) };
  }

  /**
   * 自动恢复：把会话内镜像的定稿译文重新挂到已丢失译文容器的宿主。
   * 只由 D6 在「原文未变化」时调用；不提交、不改变页面会话与已提交集合。
   * @param {Element} host
   * @param {string} source
   * @param {string} translated
   * @returns {boolean}
   */
  function restore(host, source, translated) {
    if (!host || host.nodeType !== 1 || host.isConnected === false) return false;
    if (typeof source !== 'string' || source === '') return false;
    if (typeof translated !== 'string' || translated === '') return false;

    const itemId = ensureHost(host);
    if (!itemId) return false;
    if (!renderer.showDone(host, translated)) return false;

    page.registry.set(itemId, { host, text: source });
    page.attemptedHosts.add(itemId);
    traceOf(page.traceId).debug('page.restore', '自动恢复译文', {
      itemId,
      textLength: source.length,
    });
    return true;
  }

  /**
   * 原文已经变化：注销该段注册表与最近提交索引，避免重连续传或迟到帧再落到它上面。
   * @param {Element} host
   * @returns {boolean}
   */
  function forget(host) {
    const itemId = hostIdOf(host);
    if (!itemId) return false;
    page.registry.delete(itemId);
    page.latestRequest.delete(itemId);
    return true;
  }

  /**
   * 后台回收重连后的续传：只在页面会话处于 `submitted` 且有未完成段时执行，每次断连最多一次。
   * 未完成段 = 渲染状态不是 `done` 的已登记段落；已完成段不重发。
   * @returns {Promise<object | null>} 续传后的状态；未续传时返回 null
   */
  async function resumeAfterReconnect() {
    if (page.phase !== 'submitted') return null;
    if (page.resumeUsed) return null;

    const token = page.sessionToken;
    const pending = [...page.registry.entries()].filter(([itemId, entry]) => {
      if (!entry?.host || entry.host.isConnected === false) return false;
      if (page.inFlightHosts.has(itemId)) return false;
      return renderer.getState(entry.host) !== 'done';
    });
    if (pending.length === 0) return null;

    page.resumeUsed = true;
    page.reconnectCount += 1;
    page.submissions.clear();
    page.latestRequest.clear();
    stopResultPipeline();

    const paragraphs = pending.map(([itemId, entry]) => ({
      hostId: itemId,
      text: entry.text,
      host: entry.host,
    }));
    renderSubmitting(paragraphs);

    const traceLog = traceOf(page.traceId);
    const { requestId, submission, response } = await submitBatch(
      'page',
      paragraphs,
      page.traceId
    );
    if (token !== page.sessionToken) return null;

    if (response?.ok && response.data?.accepted) {
      completeSubmission(submission);
      traceLog.info('task.resume', '重连后已续传未完成段', {
        requestId,
        pending: paragraphs.length,
        reconnectCount: page.reconnectCount,
      });
      return status();
    }

    const code = response?.error?.code ?? ERROR_CODES.NETWORK;
    const message = response?.error?.message ?? MESSAGES.submitFailed;
    failSubmission(submission, message);
    traceLog.warn('task.resume', '重连后续传失败，等待手动刷新', {
      requestId,
      pending: paragraphs.length,
      reconnectCount: page.reconnectCount,
      code,
    });
    return status();
  }

  /**
   * 后台批次结束：清理该提交的临时记录与段落索引，之后迟到帧按 `no-submission` 丢弃。
   * 渲染状态、段落注册表与已提交集合保留，失败段仍可点「刷新」。
   * @param {{ payload?: object }} frame
   * @returns {boolean} 是否清理了提交记录
   */
  function applyBatchDone(frame) {
    const requestId = frame?.payload?.requestId;
    if (typeof requestId !== 'string') return false;
    const submission = page.submissions.get(requestId);
    if (!submission) return false;

    for (const itemId of submission.items.keys()) {
      cancelFlush(itemId);
      if (page.latestRequest.get(itemId) === requestId) page.latestRequest.delete(itemId);
    }
    page.submissions.delete(requestId);
    if (page.requestId === requestId) page.requestId = null;
    return true;
  }

  /**
   * 清除全部标记、译文与结果状态，并结束页面会话与滚动监听。
   * 清除前先对当前页面所有未结束提交发取消（尽力而为），避免后台继续请求与写缓存。
   * @returns {{ ok: true, data: { removed: number } }}
   */
  function clearAll() {
    let cancelled = 0;
    for (const requestId of page.submissions.keys()) {
      if (typeof cancelRequest !== 'function') break;
      try {
        cancelRequest(requestId);
        cancelled += 1;
      } catch {
        // 连接已断开等情况：取消失败不阻塞清除。
      }
    }

    page.sessionToken += 1;
    page.labelEpoch += 1;
    page.resumeUsed = false;
    stopScroll();
    stopResultPipeline();
    callHeal('reset');
    resetSessionData();
    page.phase = 'idle';
    page.lastError = null;

    const removed = renderer.clearAll();
    logger.info('task.cancel', '已清除全部标记', { removed, cancelled, reason: 'clear' });
    return { ok: true, data: { removed } };
  }

  /**
   * 页面卸载：停止滚动监听、结果来源与刷新计时器，不清除页面上的标记。
   */
  function dispose() {
    page.sessionToken += 1;
    stopScroll();
    stopResultPipeline();
    logger.info('task.cancel', '页面卸载，停止任务', { cancelled: 0, reason: 'dispose' });
  }

  /**
   * 页面从 bfcache 恢复：页面会话仍在时重新安装滚动监听。
   */
  function resume() {
    if (page.phase === 'submitted') installScroll();
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
    retry,
    restore,
    forget,
    clearAll,
    dispose,
    resume,
    resumeAfterReconnect,
    applyBatchDone,
    applyResultFrame,
    getStatus,
  };
}
