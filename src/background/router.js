/**
 * A1 消息路由（控制面）
 *
 * 模块：后台服务（A）/ A1
 * 职责：处理设置页与弹窗的一次性消息：引擎列表、测试翻译、缓存占用与清空、标签页命令转发、
 *       页面注入的统一段落提交；把结果回给调用方。
 * 依赖：E1（protocol）、E2（settings）、E3（instances/registry）、E3 语言目录、A3（adapter）、
 *       A4（cache）、A2（gateway 的并发名额）、公共数值。
 *
 * 标签页转发入口：整页按钮与快捷键统一走 `togglePageTranslation`（`ST_ROUTE` 的 `toggle` 与
 * commands.js 共用），页面状态查询走 `ST_ROUTE` 的 `status`，页面悬停手势走 `ST_HOVER_TRIGGER`；
 * 快捷键命令入口先用 `cancelHoverGesture` 广播范围取消，再执行切换。前两处共用 `sendToFrames`
 * 的补注入与错误归一，悬停手势由 `forwardHoverTrigger` 直接广播。
 */

import {
  ERROR_CODES,
  FAILURE_REASONS,
  MESSAGE_TYPES,
  findForbiddenField,
  isKnownMessageType,
  makeError,
  normalizeDomain,
  normalizeTraceId,
} from '../shared/protocol.js';
import { MAX_PAGE_PARAGRAPHS, MAX_SEGMENT_CHARS } from '../shared/constants.js';
import { getSettings } from '../shared/settings.js';
import { isSupportedTargetLang } from '../shared/languages.js';
import { createLogger } from '../shared/log/logger.js';
import {
  getInstanceCredentials,
  getInstances,
  getPublicSettings,
  isInstancePermitted,
  requiresKey,
} from '../shared/config/instances.js';
import { getEngineType, getTypeLabel, validateInstance } from '../shared/config/registry.js';
import { getCacheStore } from '../shared/cache/store.js';
import { translate, TranslateError } from '../shared/translate/adapter.js';
import {
  normalizeConcurrency,
  withUpstreamSlot,
  acceptPageSubmit,
  findConnection,
  listFrames,
} from './gateway.js';
import { quickTranslate } from './quick.js';

/** A1 日志入口。 */
const log = createLogger('A1');

/** 每个标签页同一时刻只允许一次补注入。 */
const injecting = new Map();

/** Chrome 在目标页没有监听器时给出的错误特征。 */
const NO_RECEIVER_PATTERN =
  /Receiving end does not exist|Could not establish connection|message port closed/i;

/**
 * 处理一条一次性消息。
 * @param {{ type?: string, payload?: object }} message
 * @param {{ id?: string }} sender
 * @returns {Promise<{ ok: true, data?: unknown } | { ok: false, error: object }>}
 */
export async function handleMessage(message, sender) {
  if (!sender || sender.id !== chrome.runtime.id) {
    log.warn('message.rejected', '拒绝来自扩展外部的消息');
    return failure(ERROR_CODES.OTHER, '拒绝来自扩展外部的消息');
  }
  if (!message || typeof message !== 'object' || typeof message.type !== 'string') {
    log.warn('message.rejected', '无法识别的消息');
    return failure(ERROR_CODES.OTHER, '无法识别的消息', FAILURE_REASONS.INVALID_MESSAGE);
  }

  const traceId = normalizeTraceId(message.payload?.traceId);
  log.debug('message.received', '收到一次性消息', { type: message.type, traceId });

  try {
    let response;
    if (message.type === MESSAGE_TYPES.LIST_ENGINES) {
      response = await listEngines();
    } else if (message.type === MESSAGE_TYPES.TEST_ENGINE) {
      response = await testEngine(message.payload);
    } else if (message.type === MESSAGE_TYPES.QUICK_TRANSLATE) {
      response = await quickTranslate(message.payload);
    } else if (message.type === MESSAGE_TYPES.GET_SELECTION) {
      response = await readSelection(message.payload, traceId);
    } else if (message.type === MESSAGE_TYPES.CACHE_STATS) {
      response = await cacheStats();
    } else if (message.type === MESSAGE_TYPES.CLEAR_CACHE) {
      response = await clearCache();
    } else if (message.type === MESSAGE_TYPES.ROUTE) {
      response = await routeCommand(message.payload, traceId);
    } else if (message.type === MESSAGE_TYPES.HOVER_TRIGGER) {
      response = await forwardHoverTrigger(sender);
    } else if (message.type === MESSAGE_TYPES.HOVER_RANGE) {
      response = await forwardHoverRange(sender, message.payload);
    } else if (message.type === MESSAGE_TYPES.PAGE_SUBMIT) {
      response = await receivePageSubmit(message.payload, sender, traceId);
    } else {
      const text = isKnownMessageType(message.type) ? '该消息暂未实现' : '无法识别的消息';
      response = failure(ERROR_CODES.OTHER, text, FAILURE_REASONS.INVALID_MESSAGE);
    }

    if (!response.ok) {
      log.warn('message.rejected', '控制面请求失败', {
        type: message.type,
        code: response.error?.code,
        ...(response.error?.reason ? { reason: response.error.reason } : {}),
        ...(traceId ? { traceId } : {}),
      });
    }
    return response;
  } catch (error) {
    log.error('message.error', '控制面请求异常', { type: message.type }, error);
    return failure(ERROR_CODES.OTHER, `请求处理失败：${error?.message ?? error}`);
  }
}

/**
 * 返回全部实例的公开字段；不创建默认实例，列表为空时返回空数组。
 * @returns {Promise<{ ok: true, data: { instances: Array<object> } } | { ok: false, error: object }>}
 */
async function listEngines() {
  try {
    const { instances } = await getPublicSettings();
    return { ok: true, data: { instances } };
  } catch (error) {
    return failure(ERROR_CODES.OTHER, `读取引擎列表失败：${error?.message ?? error}`);
  }
}

/**
 * 读取缓存占用；失败归为 OTHER，设置页显示「占用信息暂不可用」。
 * @returns {Promise<{ ok: true, data: object } | { ok: false, error: object }>}
 */
async function cacheStats() {
  try {
    return { ok: true, data: await getCacheStore().stats() };
  } catch {
    return failure(ERROR_CODES.OTHER, '读取缓存占用失败，请稍后重试');
  }
}

/**
 * 清空译文缓存；只作用于 `simpletrans-cache`，不影响密钥与设置。
 * @returns {Promise<{ ok: true, data: object } | { ok: false, error: object }>}
 */
async function clearCache() {
  try {
    return { ok: true, data: await getCacheStore().clear() };
  } catch {
    return failure(ERROR_CODES.OTHER, '清空缓存失败，请稍后重试');
  }
}

/**
 * 只读当前活动标签页的选中文字：截断到单段上限，页面不可注入时返回空文本。
 * @param {unknown} payload
 * @param {string} [traceId]
 * @returns {Promise<{ ok: true, data: { text: string, truncated: boolean } } | { ok: false, error: object }>}
 */
async function readSelection(payload, traceId) {
  if (payload != null) {
    if (typeof payload !== 'object' || Array.isArray(payload)) {
      return failure(ERROR_CODES.OTHER, '请求参数无效', FAILURE_REASONS.INVALID_MESSAGE);
    }
    if (findForbiddenField(payload)) {
      return failure(ERROR_CODES.OTHER, '请求包含不允许的字段', FAILURE_REASONS.FORBIDDEN_FIELD);
    }
  }

  let tabs = [];
  try {
    tabs = await chrome.tabs.query({ active: true, lastFocusedWindow: true });
  } catch {
    tabs = [];
  }
  const tab = Array.isArray(tabs) ? tabs.find((entry) => entry?.active) ?? tabs[0] : null;
  if (!tab?.id) return { ok: true, data: { text: '', truncated: false } };

  let domain = '';
  try {
    domain = normalizeDomain(new URL(String(tab.url ?? '')).hostname);
  } catch {
    domain = '';
  }

  try {
    const results = await chrome.scripting.executeScript({
      target: { tabId: tab.id },
      func: () => String(window.getSelection()?.toString() ?? ''),
    });
    const raw = Array.isArray(results) ? String(results[0]?.result ?? '') : '';
    const text = raw.trim();
    const truncated = text.length > MAX_SEGMENT_CHARS;
    log.withTrace(traceId).debug('selection.read', '已读取页面选中文字', {
      length: text.length,
      truncated,
      domain,
    });
    return {
      ok: true,
      data: { text: truncated ? text.slice(0, MAX_SEGMENT_CHARS) : text, truncated },
    };
  } catch {
    log.withTrace(traceId).debug('selection.read', '页面不支持读取选区', {
      length: 0,
      truncated: false,
      domain,
    });
    return { ok: true, data: { text: '', truncated: false } };
  }
}

/**
 * 读取设置并校验扩展启用；整页切换使用，失败文案与测试翻译一致。
 * @returns {Promise<{ ok: true, settings: object } | { ok: false, error: object }>}
 */
async function readEnabledSettings() {
  let settings;
  try {
    settings = await getSettings();
  } catch {
    return failure(ERROR_CODES.CONFIG, '读取设置失败');
  }
  if (settings.enabled === false) return failure(ERROR_CODES.CONFIG, '扩展已停用');
  return { ok: true, settings };
}

/**
 * 取当前窗口的活动标签页。
 * @returns {Promise<{ ok: true, tab: object } | { ok: false, error: object }>}
 */
async function readActiveTab() {
  let tabs = [];
  try {
    tabs = await chrome.tabs.query({ active: true, lastFocusedWindow: true });
  } catch {
    tabs = [];
  }
  const tab = Array.isArray(tabs) ? tabs.find((entry) => entry?.active) ?? tabs[0] : null;
  if (!tab?.id) {
    log.warn('message.rejected', '没有活动标签页', { reason: FAILURE_REASONS.NO_ACTIVE_TAB });
    return failure(ERROR_CODES.OTHER, '没有可用的标签页', FAILURE_REASONS.NO_ACTIVE_TAB);
  }
  return { ok: true, tab };
}

/**
 * 向标签页各 frame 发开始命令。
 * @param {number} tabId
 * @param {object} settings
 * @param {string} [traceId]
 * @returns {Promise<{ ok: true, data?: object } | { ok: false, error: object }>}
 */
async function startOnTab(tabId, settings, traceId) {
  log.withTrace(traceId).info('route.command', '处理路由命令', { command: 'start', tabId });
  return sendToFramesAndAggregate(tabId, {
    type: MESSAGE_TYPES.START,
    payload: {
      targetLang: settings.targetLang,
      ...(traceId ? { traceId } : {}),
    },
  }, 'start');
}

/**
 * 向标签页各 frame 发清除命令。
 * @param {number} tabId
 * @param {string} [traceId]
 * @returns {Promise<{ ok: true, data: { removed: number } } | { ok: false, error: object }>}
 */
async function clearOnTab(tabId, traceId) {
  log.withTrace(traceId).info('route.command', '处理路由命令', { command: 'clear', tabId });
  return sendToFramesAndAggregate(tabId, {
    type: MESSAGE_TYPES.CLEAR,
    payload: { ...(traceId ? { traceId } : {}) },
  }, 'clear');
}

/**
 * 查询标签页各 frame 的整页会话状态。
 * @param {number} tabId
 * @param {string} [traceId]
 * @returns {Promise<{ ok: true, data: { active: boolean } } | { ok: false, error: object }>}
 */
async function statusOnTab(tabId, traceId) {
  log.withTrace(traceId).debug('route.command', '查询页面状态', { tabId });
  return sendToFramesAndAggregate(tabId, {
    type: MESSAGE_TYPES.GET_STATUS,
    payload: { ...(traceId ? { traceId } : {}) },
  }, 'status');
}

/** 同一标签页的整页切换串行执行；只保存进行中的 Promise，不保存页面会话状态。 */
const toggles = new Map();

/**
 * 把一次切换排入标签页队列，保证后一次看到前一次完成后的会话状态。
 * @param {number} tabId
 * @param {() => Promise<object>} job
 * @returns {Promise<object>}
 */
function serializeToggle(tabId, job) {
  const previous = toggles.get(tabId) ?? Promise.resolve();
  const next = previous.catch(() => {}).then(job);
  toggles.set(tabId, next);
  const cleanup = () => {
    if (toggles.get(tabId) === next) toggles.delete(tabId);
  };
  void next.then(cleanup, cleanup);
  return next;
}

/**
 * 整页切换：查询活动标签页会话状态，已开启则显示原文，未开启则开始翻译。
 * 弹窗主按钮与整页快捷键共用本入口；返回的 `action` 供弹窗更新文字。
 * @param {string} [traceId]
 * @returns {Promise<{ ok: true, data: { action: 'started', phase: string, total: number } | { action: 'cleared', removed: number } } | { ok: false, error: object }>}
 */
export async function togglePageTranslation(traceId) {
  const settingsResult = await readEnabledSettings();
  if (!settingsResult.ok) return settingsResult;

  const tabResult = await readActiveTab();
  if (!tabResult.ok) return tabResult;

  const { tab } = tabResult;
  const { settings } = settingsResult;

  return serializeToggle(tab.id, async () => {
    const traceLog = log.withTrace(traceId);
    const status = await statusOnTab(tab.id, traceId);
    if (!status.ok) {
      traceLog.warn('command.rejected', '切换前查询页面状态失败', {
        tabId: tab.id,
        code: status.error?.code ?? ERROR_CODES.OTHER,
        reason: status.error?.reason ?? null,
      });
      return status;
    }

    if (status.data?.active === true) {
      const cleared = await clearOnTab(tab.id, traceId);
      if (!cleared.ok) return cleared;
      return {
        ok: true,
        data: { action: 'cleared', removed: Number(cleared.data?.removed) || 0 },
      };
    }

    const started = await startOnTab(tab.id, settings, traceId);
    if (!started.ok) return started;
    return {
      ok: true,
      data: {
        action: 'started',
        phase: started.data?.phase ?? 'idle',
        total: Number(started.data?.total) || 0,
      },
    };
  });
}

/**
 * 弹窗命令：`toggle` 走统一整页切换；`status` 只读整页会话状态，不读设置、不检查实例。
 * @param {unknown} payload
 * @param {string} [traceId]
 * @returns {Promise<{ ok: true, data?: object } | { ok: false, error: object }>}
 */
async function routeCommand(payload, traceId) {
  const command = payload?.command;
  if (command !== 'toggle' && command !== 'status') {
    log.warn('message.rejected', '未知的路由命令', {
      command: typeof command === 'string' ? command : null,
    });
    return failure(ERROR_CODES.OTHER, '未知命令', FAILURE_REASONS.INVALID_MESSAGE);
  }

  if (command === 'toggle') return togglePageTranslation(traceId);

  const tabResult = await readActiveTab();
  if (!tabResult.ok) return tabResult;
  return statusOnTab(tabResult.tab.id, traceId);
}

/**
 * 接收页面注入的统一段落提交：形状校验通过后按 `sender.tab.id + sender.frameId` 把提交转交 A2。
 * A2 负责缓存预取、命中回显、分组切批与队列执行；A1 只等到「提交已创建」，
 * 不等待翻译完成，也不因缓存未命中而阻塞回执。
 * @param {unknown} payload
 * @param {{ tab?: { id?: number }, frameId?: number }} [sender]
 * @param {string} [traceId]
 * @returns {Promise<{ ok: true, data: object } | { ok: false, error: object }>}
 */
export async function receivePageSubmit(payload, sender, traceId) {
  if (!payload || typeof payload !== 'object' || Array.isArray(payload)) {
    return failure(ERROR_CODES.OTHER, '请求参数无效', FAILURE_REASONS.INVALID_MESSAGE);
  }

  const scope = payload.scope == null ? 'page' : payload.scope;
  if (scope !== 'page' && scope !== 'single') {
    return failure(ERROR_CODES.OTHER, '提交范围无效', FAILURE_REASONS.INVALID_MESSAGE);
  }

  const requestId = payload.requestId == null ? null : payload.requestId;
  if (requestId != null && (typeof requestId !== 'string' || requestId.length > 64)) {
    return failure(ERROR_CODES.OTHER, '请求标识无效', FAILURE_REASONS.INVALID_MESSAGE);
  }

  const paragraphs = payload.paragraphs;
  if (!Array.isArray(paragraphs) || paragraphs.length < 1) {
    return failure(ERROR_CODES.OTHER, '段落列表无效', FAILURE_REASONS.INVALID_ITEMS);
  }
  if (paragraphs.length > MAX_PAGE_PARAGRAPHS) {
    return failure(
      ERROR_CODES.OTHER,
      `段落数量超过 ${MAX_PAGE_PARAGRAPHS} 段上限`,
      FAILURE_REASONS.INVALID_ITEMS
    );
  }
  if (scope === 'single' && paragraphs.length !== 1) {
    return failure(ERROR_CODES.OTHER, '单段提交只能包含 1 段', FAILURE_REASONS.INVALID_ITEMS);
  }

  let chars = 0;
  for (const raw of paragraphs) {
    if (!raw || typeof raw !== 'object' || Array.isArray(raw)) {
      return failure(ERROR_CODES.OTHER, '段落内容无效', FAILURE_REASONS.INVALID_ITEMS);
    }
    if (typeof raw.text !== 'string' || raw.text.trim() === '') {
      return failure(ERROR_CODES.OTHER, '存在空段落', FAILURE_REASONS.EMPTY_TEXT);
    }
    if (raw.hostId != null && (typeof raw.hostId !== 'string' || raw.hostId.length > 64)) {
      return failure(ERROR_CODES.OTHER, '段落标识无效', FAILURE_REASONS.INVALID_ITEMS);
    }
    chars += raw.text.length;
  }

  const forbidden = findForbiddenField(payload);
  if (forbidden) {
    return failure(ERROR_CODES.OTHER, '请求包含不允许的字段', FAILURE_REASONS.FORBIDDEN_FIELD);
  }

  const tabId = sender?.tab?.id;
  const frameId = Number.isInteger(sender?.frameId) ? sender.frameId : 0;
  if (findConnection(tabId, frameId) == null) {
    log.warn('message.rejected', '页面通道未连接', {
      requestId,
      tabId: tabId ?? null,
      frameId,
      reason: FAILURE_REASONS.NOT_CONNECTED,
    });
    return failure(
      ERROR_CODES.NETWORK,
      '页面通道未连接，请刷新后重试',
      FAILURE_REASONS.NOT_CONNECTED
    );
  }

  const traceLog = log.withTrace(traceId);
  traceLog.info('page.received', '后台已接收段落', {
    scope,
    requestId,
    paragraphs: paragraphs.length,
    chars,
    tabId: tabId ?? null,
    frameId,
  });
  paragraphs.forEach((raw, index) => {
    traceLog.debug('page.item', '后台接收段落', {
      index,
      hostId: raw.hostId ?? '',
      textLength: raw.text.length,
    });
  });

  const result = await acceptPageSubmit({
    requestId,
    traceId,
    scope,
    targetLang: payload.targetLang,
    domain: payload.domain,
    viewport: payload.viewport,
    paragraphs,
    tabId,
    frameId,
  });

  if (!result?.accepted) {
    return failure(
      result?.error?.code ?? ERROR_CODES.OTHER,
      result?.error?.message ?? '提交失败，请稍后重试',
      result?.error?.reason
    );
  }

  return {
    ok: true,
    data: { accepted: true, requestId, scope, paragraphs: paragraphs.length, chars },
  };
}

/**
 * @param {unknown} payload
 * @returns {Promise<{ ok: true, data: object } | { ok: false, error: object }>}
 */
async function testEngine(payload) {
  if (!payload || typeof payload !== 'object' || Array.isArray(payload)) {
    return failure(ERROR_CODES.OTHER, '请求参数无效', FAILURE_REASONS.INVALID_MESSAGE);
  }
  const traceId = normalizeTraceId(payload.traceId);
  const traceLog = log.withTrace(traceId);

  if (findForbiddenField(payload)) {
    return failure(ERROR_CODES.OTHER, '请求包含不允许的字段', FAILURE_REASONS.FORBIDDEN_FIELD);
  }

  const text = typeof payload.text === 'string' ? payload.text : '';
  if (text.trim() === '') {
    return failure(ERROR_CODES.OTHER, '请输入待翻译文本', FAILURE_REASONS.EMPTY_TEXT);
  }
  if (text.length > MAX_SEGMENT_CHARS) {
    return failure(
      ERROR_CODES.OTHER,
      `文本超过 ${MAX_SEGMENT_CHARS} 字符上限`,
      FAILURE_REASONS.TEXT_TOO_LONG
    );
  }

  let settings;
  try {
    settings = await getSettings();
  } catch {
    return failure(ERROR_CODES.CONFIG, '读取设置失败');
  }
  if (settings.enabled === false) return failure(ERROR_CODES.CONFIG, '扩展已停用');

  const targetLang = payload.targetLang ?? settings.targetLang;
  if (!isSupportedTargetLang(targetLang)) {
    return failure(ERROR_CODES.OTHER, '不支持的目标语言', FAILURE_REASONS.UNSUPPORTED_LANG);
  }

  if (
    payload.instanceId != null &&
    (typeof payload.instanceId !== 'string' ||
      payload.instanceId === '' ||
      payload.instanceId.length > 64)
  ) {
    return failure(ERROR_CODES.OTHER, '实例标识无效', FAILURE_REASONS.INVALID_MESSAGE);
  }

  traceLog.info('engine.test.start', '开始测试翻译', {
    textLength: text.length,
    targetLang,
    instanceId: typeof payload.instanceId === 'string' ? payload.instanceId : null,
  });

  let instances;
  try {
    instances = await getInstances();
  } catch {
    return failure(ERROR_CODES.CONFIG, '读取引擎配置失败');
  }

  let instance;
  if (typeof payload.instanceId === 'string') {
    instance = instances.find((item) => item.id === payload.instanceId) ?? null;
    if (!instance) return failure(ERROR_CODES.CONFIG, '实例不存在');
  } else {
    const activeId = settings.activeInstanceId;
    instance = instances.find((item) => item.id === activeId) ?? instances[0] ?? null;
    if (!instance) return failure(ERROR_CODES.CONFIG, '没有可用的翻译实例');
  }

  if (!getEngineType(instance.type)) {
    return failure(ERROR_CODES.CONFIG, '不支持的实例类型');
  }
  const validation = validateInstance(instance);
  if (!validation.ok) {
    return failure(ERROR_CODES.CONFIG, validation.errors[0] ?? '实例配置无效');
  }

  let credentials;
  try {
    credentials = await getInstanceCredentials(instance);
  } catch {
    return failure(ERROR_CODES.CONFIG, '读取实例凭据失败');
  }
  if (requiresKey(instance)) {
    const complete =
      instance.type === 'baidu'
        ? Boolean(credentials.appId && credentials.secretKey)
        : Boolean(credentials.apiKey);
    if (!complete) {
      return failure(
        ERROR_CODES.CONFIG,
        instance.type === 'baidu' ? 'APPID 或密钥未配置完整' : '缺少密钥，请先在设置页保存密钥'
      );
    }
  }

  if (!(await isInstancePermitted(instance))) {
    return failure(ERROR_CODES.CONFIG, '未授权访问该接口域名，请到设置页重新授权');
  }

  let elapsedMs = 0;
  try {
    const result = await withUpstreamSlot(async () => {
      const startedAt = performance.now();
      try {
        return await translate({
          text,
          targetLang,
          sourceLang: settings.sourceLang,
          instance: { ...instance, ...credentials },
        });
      } finally {
        elapsedMs = Math.round(performance.now() - startedAt);
      }
    }, normalizeConcurrency(instance.maxConcurrency), instance);

    traceLog.info('engine.test.done', '测试翻译完成', {
      ok: true,
      elapsedMs,
      instanceId: instance.id,
      type: instance.type,
      totalTokens: result.usage?.totalTokens ?? null,
      chars: text.length,
    });

    return {
      ok: true,
      data: {
        text: result.text,
        elapsedMs,
        usage: result.usage ?? null,
        chars: text.length,
        engine: {
          id: instance.id,
          name: instance.name,
          type: instance.type,
          typeLabel: getTypeLabel(instance.type),
          preset: instance.type === 'openai' ? instance.preset : null,
          model: instance.model,
        },
      },
    };
  } catch (error) {
    const code = error instanceof TranslateError ? error.code : ERROR_CODES.OTHER;
    traceLog.warn('engine.test.done', '测试翻译失败', {
      ok: false,
      code,
      elapsedMs,
      instanceId: instance.id,
      type: instance.type,
    });
    if (error instanceof TranslateError) {
      return failure(error.code, error.message);
    }
    return failure(ERROR_CODES.OTHER, `翻译失败：${error?.message ?? error}`);
  }
}

/**
 * @param {string} code
 * @param {string} message
 * @param {string} [reason]
 * @returns {{ ok: false, error: object }}
 */
function failure(code, message, reason) {
  return { ok: false, error: makeError(code, message, reason) };
}

/**
 * 把一次性命令送到标签页的顶层 frame；页面注入未运行时先补样式再补脚本，然后重发一次。
 * 保留给只关心顶层 frame 的调用与测试；整页命令走 `sendToFramesAndAggregate`。
 * @param {number} tabId
 * @param {{ type: string, payload?: object }} message
 * @returns {Promise<{ ok: true, data?: object } | { ok: false, error: object }>}
 */
export async function sendToTab(tabId, message) {
  const sent = await sendFrames(tabId, message);
  if (!sent.ok) return sent;
  for (const entry of sent.results) {
    if (entry.status === 'fulfilled') return entry.value;
  }
  return failure(
    ERROR_CODES.OTHER,
    '页面尚未准备好，请刷新后重试',
    FAILURE_REASONS.NO_RECEIVER
  );
}

/**
 * 把命令发到标签页的所有 frame，并按命令类型汇总响应。
 * 汇总后的数据形状与单 frame 页面一致，弹窗无需区分 frame 数量。
 * @param {number} tabId
 * @param {{ type: string, payload?: object }} message
 * @param {'start' | 'clear' | 'status'} kind
 * @returns {Promise<{ ok: true, data?: object } | { ok: false, error: object }>}
 */
async function sendToFramesAndAggregate(tabId, message, kind) {
  const sent = await sendFrames(tabId, message);
  if (!sent.ok) return sent;

  if (kind === 'start') return aggregateStart(sent.results);
  if (kind === 'clear') return aggregateClear(sent.results);
  return aggregateStatus(sent.results);
}

/**
 * 并发向标签页各 frame 发送命令。
 *
 * 有已建立 Port 的 frame 时逐 frame 发送（带 `frameId`）；一个都没有时退回广播，
 * 失败再补注入并重发，保证扩展更新后未刷新的普通页面仍可触发一次。
 *
 * @param {number} tabId
 * @param {{ type: string, payload?: object }} message
 * @returns {Promise<{ ok: true, results: Array<PromiseSettledResult<object> & { frameId: number }> } | { ok: false, error: object }>}
 */
async function sendFrames(tabId, message) {
  if (!Number.isInteger(tabId)) {
    return failure(ERROR_CODES.OTHER, '没有可用的标签页', FAILURE_REASONS.NO_ACTIVE_TAB);
  }

  const connected = listFrames(tabId).map((conn) => conn.frameId);
  if (connected.length > 0) {
    return { ok: true, results: await settleFrames(tabId, message, connected) };
  }

  try {
    const value = await chrome.tabs.sendMessage(tabId, message);
    return { ok: true, results: [{ status: 'fulfilled', value, frameId: 0 }] };
  } catch (error) {
    if (!NO_RECEIVER_PATTERN.test(String(error?.message ?? error))) {
      log.warn('message.rejected', '无法与页面通信', {
        tabId,
        reason: FAILURE_REASONS.NO_RECEIVER,
      });
      return failure(
        ERROR_CODES.OTHER,
        '无法与页面通信，请刷新后重试',
        FAILURE_REASONS.NO_RECEIVER
      );
    }
  }

  let injected;
  try {
    injected = await ensureInjected(tabId);
  } catch {
    return failure(
      ERROR_CODES.OTHER,
      '当前页面无法翻译，请在普通网页上使用',
      FAILURE_REASONS.INJECTION_FAILED
    );
  }

  const frameIds = Array.isArray(injected) && injected.length > 0 ? injected : [0];
  return { ok: true, results: await settleFrames(tabId, message, frameIds) };
}

/**
 * @param {number} tabId
 * @param {{ type: string, payload?: object }} message
 * @param {number[]} frameIds
 * @returns {Promise<Array<PromiseSettledResult<object> & { frameId: number }>>}
 */
async function settleFrames(tabId, message, frameIds) {
  const settled = await Promise.allSettled(
    frameIds.map((frameId) => chrome.tabs.sendMessage(tabId, message, { frameId }))
  );
  return settled.map((entry, index) => ({ ...entry, frameId: frameIds[index] }));
}

/**
 * 汇总整页启动响应：段数相加，任一 frame 提交成功即视为已提交。
 * @param {Array<PromiseSettledResult<object>>} results
 * @returns {{ ok: true, data: { phase: string, total: number } } | { ok: false, error: object }}
 */
function aggregateStart(results) {
  let total = 0;
  let succeeded = 0;
  let firstError = null;

  for (const entry of results) {
    const value = entry.status === 'fulfilled' ? entry.value : null;
    if (!value || value.ok !== true) {
      if (firstError == null) firstError = errorOf(entry);
      continue;
    }
    succeeded += 1;
    total += Number(value.data?.total) || 0;
  }

  if (succeeded === 0) return failureFrom(firstError);
  return { ok: true, data: { phase: total > 0 ? 'submitted' : 'idle', total } };
}

/**
 * 汇总清除响应：清除数相加。
 * @param {Array<PromiseSettledResult<object>>} results
 * @returns {{ ok: true, data: { removed: number } } | { ok: false, error: object }}
 */
function aggregateClear(results) {
  let removed = 0;
  let succeeded = 0;
  let firstError = null;

  for (const entry of results) {
    const value = entry.status === 'fulfilled' ? entry.value : null;
    if (!value || value.ok !== true) {
      if (firstError == null) firstError = errorOf(entry);
      continue;
    }
    succeeded += 1;
    removed += Number(value.data?.removed) || 0;
  }

  if (succeeded === 0) return failureFrom(firstError);
  return { ok: true, data: { removed } };
}

/**
 * 汇总会话状态：任一 frame 开启即视为开启。
 * @param {Array<PromiseSettledResult<object>>} results
 * @returns {{ ok: true, data: { active: boolean } } | { ok: false, error: object }}
 */
function aggregateStatus(results) {
  let active = false;
  let succeeded = 0;
  let firstError = null;

  for (const entry of results) {
    const value = entry.status === 'fulfilled' ? entry.value : null;
    if (!value || value.ok !== true) {
      if (firstError == null) firstError = errorOf(entry);
      continue;
    }
    succeeded += 1;
    if (value.data?.active === true) active = true;
  }

  if (succeeded === 0) return failureFrom(firstError);
  return { ok: true, data: { active } };
}

/**
 * 取一个失败 frame 的错误对象；内容侧返回的错误优先，通信异常归为网络错误。
 * @param {PromiseSettledResult<object>} entry
 * @returns {object | Error | null}
 */
function errorOf(entry) {
  if (entry.status === 'rejected') return entry.reason ?? null;
  const value = entry.value;
  if (value && value.ok === false) return value.error ?? null;
  return null;
}

/**
 * 把汇总过程中收集到的第一个错误转成统一失败响应。
 * @param {unknown} error
 * @returns {{ ok: false, error: object }}
 */
function failureFrom(error) {
  if (
    error &&
    typeof error === 'object' &&
    typeof error.code === 'string' &&
    typeof error.message === 'string'
  ) {
    return failure(error.code, error.message, error.reason);
  }
  if (error instanceof Error) {
    return failure(
      ERROR_CODES.NETWORK,
      '无法与页面通信，请刷新后重试',
      FAILURE_REASONS.NO_RECEIVER
    );
  }
  return failure(
    ERROR_CODES.OTHER,
    '页面没有返回结果，请刷新后重试',
    FAILURE_REASONS.NO_RECEIVER
  );
}

/**
 * 转发悬停范围阶段：页面注入在按下 / 取消时广播，后台向来源标签页全部 frame 转发，
 * 由实际持有指针的 frame 建立或取消远程范围会话。
 * @param {{ tab?: { id?: number } }} [sender]
 * @param {unknown} payload
 * @returns {Promise<{ ok: true, data: { forwarded: boolean } } | { ok: false, error: object }>}
 */
async function forwardHoverRange(sender, payload) {
  const tabId = sender?.tab?.id;
  if (!Number.isInteger(tabId)) {
    return failure(ERROR_CODES.OTHER, '没有可用的标签页', FAILURE_REASONS.NO_ACTIVE_TAB);
  }

  const phase = payload && typeof payload === 'object' ? payload.phase : undefined;
  if (phase !== 'begin' && phase !== 'cancel') {
    return failure(ERROR_CODES.OTHER, '范围阶段无效', FAILURE_REASONS.INVALID_MESSAGE);
  }

  try {
    await chrome.tabs.sendMessage(tabId, {
      type: MESSAGE_TYPES.HOVER_RANGE,
      payload: { phase },
    });
    return { ok: true, data: { forwarded: true } };
  } catch (error) {
    log.warn('message.rejected', '悬停范围转发失败', {
      tabId,
      phase,
      reason: FAILURE_REASONS.NO_RECEIVER,
    });
    return failure(
      ERROR_CODES.OTHER,
      '页面尚未准备好，请刷新后重试',
      FAILURE_REASONS.NO_RECEIVER
    );
  }
}

/**
 * 取消当前活动标签页的悬停手势：向全部 frame 广播范围取消。
 * 只清理页面内的悬停状态，不拦截、不阻断、不改写调用方的命令；失败不抛错。
 * @param {string} [traceId]
 * @returns {Promise<{ ok: true, data: { forwarded: boolean } } | { ok: false, error: object }>}
 */
export async function cancelHoverGesture(traceId) {
  const active = await readActiveTab();
  if (!active.ok) return active;

  const tabId = active.tab.id;
  const traceLog = log.withTrace(traceId);
  try {
    await chrome.tabs.sendMessage(tabId, {
      type: MESSAGE_TYPES.HOVER_RANGE,
      payload: { phase: 'cancel' },
    });
    traceLog.debug('hotkey.cancel.command', '已广播悬停取消', { tabId });
    return { ok: true, data: { forwarded: true } };
  } catch {
    traceLog.debug('hotkey.cancel.command', '悬停取消广播失败', {
      tabId,
      reason: FAILURE_REASONS.NO_RECEIVER,
    });
    return failure(
      ERROR_CODES.OTHER,
      '页面尚未准备好，请刷新后重试',
      FAILURE_REASONS.NO_RECEIVER
    );
  }
}

/**
 * 转发悬停手势：页面注入的任意 frame 收到修饰键手势后，后台向该标签页全部 frame 广播，
 * 由实际持有指针的 frame 处理。页面与后台都不可用时由内容侧回退本地处理。
 * @param {{ tab?: { id?: number } }} [sender]
 * @returns {Promise<{ ok: true, data: { forwarded: boolean } } | { ok: false, error: object }>}
 */
async function forwardHoverTrigger(sender) {
  const tabId = sender?.tab?.id;
  if (!Number.isInteger(tabId)) {
    return failure(ERROR_CODES.OTHER, '没有可用的标签页', FAILURE_REASONS.NO_ACTIVE_TAB);
  }

  try {
    await chrome.tabs.sendMessage(tabId, { type: MESSAGE_TYPES.HOVER_TRIGGER });
    return { ok: true, data: { forwarded: true } };
  } catch (error) {
    log.warn('message.rejected', '悬停触发转发失败', {
      tabId,
      reason: FAILURE_REASONS.NO_RECEIVER,
    });
    return failure(
      ERROR_CODES.OTHER,
      '页面尚未准备好，请刷新后重试',
      FAILURE_REASONS.NO_RECEIVER
    );
  }
}

/**
 * 补注入页面脚本：先样式后脚本，与清单静态注入的顺序保持一致。
 * 先尝试 `allFrames`；没有跨源 frame 权限等情况下回退为只注入顶层 frame。
 * @param {number} tabId
 * @param {boolean} allFrames
 * @returns {Promise<number[]>} 实际注入到的 frame id
 */
async function injectFrames(tabId, allFrames) {
  const target = allFrames ? { tabId, allFrames: true } : { tabId };
  await chrome.scripting.insertCSS({ target, files: ['content.css'] });
  const results = await chrome.scripting.executeScript({ target, files: ['content.js'] });
  const frames = new Set([0]);
  for (const entry of Array.isArray(results) ? results : []) {
    if (Number.isInteger(entry?.frameId)) frames.add(entry.frameId);
  }
  return [...frames].sort((a, b) => a - b);
}

/**
 * 补注入页面脚本：优先覆盖全部 frame，失败时回退顶层 frame。
 * @param {number} tabId
 * @returns {Promise<number[]>}
 */
async function ensureInjected(tabId) {
  const running = injecting.get(tabId);
  if (running) return running;

  const job = (async () => {
    log.info('tab.inject', '页面未注入，开始补注入', { tabId });
    try {
      return await injectFrames(tabId, true);
    } catch {
      log.warn('tab.inject', '全 frame 补注入失败，回退顶层 frame', {
        tabId,
        reason: FAILURE_REASONS.INJECTION_FAILED,
      });
    }

    try {
      return await injectFrames(tabId, false);
    } catch (error) {
      log.warn('tab.inject', '页面注入失败', {
        tabId,
        reason: FAILURE_REASONS.INJECTION_FAILED,
      });
      throw error;
    }
  })().finally(() => {
    injecting.delete(tabId);
  });

  injecting.set(tabId, job);
  return job;
}
