/**
 * D5 状态上报与任务调度（P4 单段切片）
 *
 * 模块：页面注入（D）/ D5（任务调度属流程机制，见项目架构 6.2）
 * 职责：串联宿主提取、单段请求与渲染；维护在途批次、合并增量、处理取消与断线。
 * 依赖：D1（文本与宿主）、D3（渲染）、D4（桥）、E1、公共数值、E4（P4 起）。
 * 实现阶段：P4（段落提取、悬停锚定与译文渲染）；P5 起批次携带页面 `domain`（只作为缓存元数据）。
 *
 * P4 只做悬停单段：一次触发一个批次，不在页面侧缓存译文，不写 storage.session；
 * 整页任务、状态镜像、重试与备用切换留到 P6/P7/P9。
 */

import {
  ERROR_CODES,
  FAILURE_REASONS,
  MESSAGE_TYPES,
  makeError,
  normalizeDomain,
} from '../shared/protocol.js';
import { DISPLAY_UPDATE_THROTTLE_MS, MAX_SEGMENT_CHARS } from '../shared/constants.js';
import { createLogger } from '../shared/log/logger.js';
import { ensureHost, extractText, hasLetter, normalizeText } from './dom/scanner.js';

/** D5 日志入口。 */
const log = createLogger('D5');

/** 每次请求只含一段。 */
const ITEM_ID = 'i0';

/** 补注入后等待后台连接的最长时间；超时后显示失败，不无限加载。 */
const QUEUE_TIMEOUT_MS = 5_000;

/**
 * 当前页面 hostname，只作为缓存元数据随批次上报；取不到时为空串。
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
 * @param {string} action
 * @returns {{ ok: true, data: { action: string } }}
 */
function ok(action) {
  return { ok: true, data: { action } };
}

/**
 * 创建单段任务控制器。
 * @param {{
 *   bridge: { postBatch: Function, cancelBatch: Function },
 *   renderer: {
 *     showLoading: Function,
 *     update: Function,
 *     showDone: Function,
 *     showError: Function,
 *     remove: Function,
 *     clearAll: Function,
 *     getState: Function,
 *   },
 *   logger?: object,
 *   now?: () => number,
 *   schedule?: (fn: () => void, ms: number) => unknown,
 *   cancel?: (handle: unknown) => void,
 * }} deps
 */
export function createTask({
  bridge,
  renderer,
  logger = log,
  now = () => Date.now(),
  schedule = (fn, ms) => setTimeout(fn, ms),
  cancel = (handle) => clearTimeout(handle),
} = {}) {
  /** @type {Map<string, { requestId: string, host: Element, buffer: string, status: string, timer: unknown, startedAt: number, traceId?: string }>} */
  const requests = new Map();
  let sequence = 0;

  function nextRequestId() {
    sequence += 1;
    return `b-${now().toString(36)}-${sequence}`;
  }

  /**
   * @param {object} request
   */
  function clearTimer(request) {
    if (request.timer != null) {
      cancel(request.timer);
      request.timer = null;
    }
  }

  /**
   * @param {object} request
   */
  function clearQueueTimer(request) {
    if (request.queueTimer != null) {
      cancel(request.queueTimer);
      request.queueTimer = null;
    }
  }

  /**
   * @param {object} request
   */
  function cleanup(request) {
    clearTimer(request);
    clearQueueTimer(request);
    requests.delete(request.requestId);
  }

  /**
   * @param {Element} host
   * @returns {object | null}
   */
  function findRequest(host) {
    for (const request of requests.values()) {
      if (request.host === host) return request;
    }
    return null;
  }

  /**
   * @param {object} request
   */
  function flush(request) {
    request.timer = null;
    renderer.update(request.host, request.buffer);
  }

  /**
   * @param {object} request
   */
  function scheduleFlush(request) {
    if (request.timer != null) return;
    request.timer = schedule(() => flush(request), DISPLAY_UPDATE_THROTTLE_MS);
  }

  /**
   * 取消一个在途批次；桥未连接或已断开时只记日志，不影响页面清理。
   * @param {string} requestId
   * @param {object} [request]
   */
  function cancelRequest(requestId, request) {
    if (request && !request.sent) {
      logger.debug('task.cancel', '取消排队中的请求', { requestId });
      cleanup(request);
      return;
    }
    try {
      bridge.cancelBatch(requestId);
    } catch (error) {
      logger.warn('task.cancel', '取消批次失败', {
        requestId,
        reason: error?.reason ?? null,
      });
    }
    if (request) {
      logger.debug('task.cancel', '已取消单段请求', { requestId });
      cleanup(request);
    }
  }

  /**
   * 提交已登记的请求；桥尚未连上时排队，等连接建立后自动发出。
   * @param {object} request
   * @returns {{ ok: true } | { ok: false, queued: true } | { ok: false, queued: false, error: object }}
   */
  function submit(request) {
    if (request.sent) return { ok: true };
    const traceLog = request.traceId && typeof logger.withTrace === 'function'
      ? logger.withTrace(request.traceId)
      : logger;

    try {
      bridge.postBatch({
        requestId: request.requestId,
        ...(request.traceId ? { traceId: request.traceId } : {}),
        domain: currentDomain(),
        items: [{ itemId: ITEM_ID, text: request.text }],
      });
    } catch (error) {
      const reason = error?.reason;
      if (reason === FAILURE_REASONS.NOT_CONNECTED || reason === FAILURE_REASONS.DISCONNECTED) {
        request.status = 'queued';
        clearQueueTimer(request);
        request.queueTimer = schedule(() => {
          request.queueTimer = null;
          if (requests.get(request.requestId) !== request) return;
          renderer.showError(request.host, '连接后台超时，请稍后重试');
          traceLog.warn('task.error', '等待后台连接超时', {
            requestId: request.requestId,
            code: ERROR_CODES.NETWORK,
          });
          cleanup(request);
        }, QUEUE_TIMEOUT_MS);
        traceLog.debug('task.request', '桥未连接，等待连接后提交', {
          requestId: request.requestId,
        });
        return { ok: false, queued: true };
      }

      cleanup(request);
      const message = error?.message ?? '无法连接后台，请稍后重试';
      renderer.showError(request.host, message);
      traceLog.warn('task.error', '提交翻译请求失败', {
        requestId: request.requestId,
        code: error?.code ?? ERROR_CODES.NETWORK,
        reason: reason ?? null,
      });
      return {
        ok: false,
        queued: false,
        error: makeError(error?.code ?? ERROR_CODES.NETWORK, message, reason),
      };
    }

    request.sent = true;
    request.status = 'loading';
    clearQueueTimer(request);
    traceLog.info('task.request', '提交单段翻译', {
      requestId: request.requestId,
      textLength: request.text.length,
    });
    return { ok: true };
  }

  return {
    /**
     * 切换宿主段落的译文状态。
     * @param {Element} host
     * @param {string} [traceId]
     * @returns {{ ok: true, data: { action: string } } | { ok: false, error: object }}
     */
    toggle(host, traceId) {
      if (!host || host.nodeType !== 1 || host.isConnected === false) {
        return ok('no-target');
      }

      ensureHost(host);
      const traceLog = traceId && typeof logger.withTrace === 'function' ? logger.withTrace(traceId) : logger;
      const state = renderer.getState(host);

      if (state === 'loading' || state === 'streaming') {
        const request = findRequest(host);
        if (request) cancelRequest(request.requestId, request);
        renderer.remove(host);
        traceLog.info('task.toggle', '取消加载中的段落', { action: 'cancelled', traceId });
        return ok('cancelled');
      }

      if (state === 'done') {
        renderer.remove(host);
        traceLog.info('task.toggle', '隐藏段落译文', { action: 'hidden', traceId });
        return ok('hidden');
      }

      if (state === 'error') renderer.remove(host);

      const text = normalizeText(extractText(host));
      if (!text || !hasLetter(text)) {
        traceLog.debug('segment.skip', '段落没有可翻译文本', { action: 'no-target', traceId });
        return ok('no-target');
      }

      if (text.length > MAX_SEGMENT_CHARS) {
        renderer.showError(host, `段落超过 ${MAX_SEGMENT_CHARS} 字符，暂不支持`);
        traceLog.warn('task.toggle', '段落超过单段上限', {
          action: 'too-long',
          textLength: text.length,
          traceId,
        });
        return ok('too-long');
      }

      const requestId = nextRequestId();
      const request = {
        requestId,
        host,
        text,
        buffer: '',
        status: 'loading',
        sent: false,
        timer: null,
        queueTimer: null,
        startedAt: now(),
        traceId,
      };
      requests.set(requestId, request);
      renderer.showLoading(host);

      const submitted = submit(request);
      if (!submitted.ok && !submitted.queued) {
        return { ok: false, error: submitted.error };
      }
      return ok('translating');
    },

    /**
     * 桥连接状态变化：连接建立后补发排队请求；连接永久关闭时结束等待。
     * @param {string} state
     */
    onBridgeState(state) {
      if (state === 'connected') {
        for (const request of [...requests.values()]) {
          if (request.sent) continue;
          submit(request);
        }
        return;
      }

      if (state === 'closed') {
        for (const request of [...requests.values()]) {
          renderer.showError(request.host, '扩展已重新加载，请刷新页面');
          cleanup(request);
        }
      }
    },

    /**
     * 处理后台帧。
     * @param {object} frame
     */
    onFrame(frame) {
      const type = frame?.type;
      const payload = frame?.payload;
      if (!payload || typeof payload.requestId !== 'string') return;
      const request = requests.get(payload.requestId);
      if (!request) return;
      if (payload.itemId != null && payload.itemId !== ITEM_ID) return;

      const traceLog = request.traceId && typeof logger.withTrace === 'function'
        ? logger.withTrace(request.traceId)
        : logger;

      if (type === MESSAGE_TYPES.ITEM_START) {
        request.status = 'streaming';
        return;
      }

      if (type === MESSAGE_TYPES.ITEM_DELTA) {
        request.buffer += String(payload.delta ?? '');
        scheduleFlush(request);
        return;
      }

      if (type === MESSAGE_TYPES.ITEM_DONE) {
        clearTimer(request);
        const text = String(payload.text ?? '').trim();
        if (!text) {
          renderer.showError(request.host, '引擎返回空译文，请重试');
          traceLog.warn('task.error', '引擎返回空译文', {
            requestId: request.requestId,
            code: ERROR_CODES.OTHER,
          });
        } else {
          renderer.showDone(request.host, text);
          traceLog.info('task.done', '段落翻译完成', {
            requestId: request.requestId,
            textLength: text.length,
            elapsedMs: Math.max(0, now() - request.startedAt),
          });
        }
        cleanup(request);
        return;
      }

      if (type === MESSAGE_TYPES.ITEM_ERROR) {
        clearTimer(request);
        if (payload.code === ERROR_CODES.CANCELLED) {
          renderer.remove(request.host);
          traceLog.debug('task.cancel', '段落请求已取消', { requestId: request.requestId });
        } else {
          renderer.showError(request.host, payload.message ?? '翻译失败');
          traceLog.warn('task.error', '段落翻译失败', {
            requestId: request.requestId,
            code: payload.code ?? ERROR_CODES.OTHER,
            reason: payload.reason ?? null,
          });
        }
        cleanup(request);
        return;
      }

      if (type === MESSAGE_TYPES.BATCH_DONE) {
        clearTimer(request);
        const message = payload?.error?.message ?? '翻译未完成，请重试';
        renderer.showError(request.host, message);
        traceLog.warn('task.error', '批次未产生段落结果', {
          requestId: request.requestId,
          code: payload?.error?.code ?? ERROR_CODES.OTHER,
        });
        cleanup(request);
      }
    },

    /**
     * 断线时把在途段落置为失败态。
     * @param {string[]} pendingRequestIds
     */
    onDisconnect(pendingRequestIds) {
      const ids = pendingRequestIds ?? [];
      for (const requestId of ids) {
        const request = requests.get(requestId);
        if (!request) continue;
        clearTimer(request);
        renderer.showError(request.host, '与后台的连接已断开，请稍后重试');
        cleanup(request);
      }
      if (ids.length > 0) {
        log.warn('task.error', '连接断开，在途段落已中止', {
          pending: ids.length,
          code: ERROR_CODES.NETWORK,
        });
      }
    },

    /**
     * 清除全部译文并取消在途请求。
     * @returns {{ ok: true, data: { removed: number, cancelled: number } }}
     */
    clearAll() {
      let cancelled = 0;
      for (const request of [...requests.values()]) {
        cancelRequest(request.requestId, request);
        cancelled += 1;
      }
      requests.clear();
      const removed = renderer.clearAll();
      log.info('task.clear', '已清除全部译文', { removed, cancelled });
      return { ok: true, data: { removed, cancelled } };
    },

    /**
     * 页面卸载时取消在途请求；不主动删除页面上的译文。
     */
    dispose() {
      for (const request of [...requests.values()]) {
        clearTimer(request);
        clearQueueTimer(request);
        try {
          bridge.cancelBatch(request.requestId);
        } catch {
          // 页面正在卸载，取消失败无需处理。
        }
      }
      requests.clear();
    },
  };
}
