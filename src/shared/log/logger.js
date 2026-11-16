/**
 * E4 日志入口
 *
 * 模块：公共模块（E）/ E4
 * 职责：初始化日志、按级别过滤、生成统一控制台输出、安装全局异常捕获、绑定 traceId。
 * 依赖：levels.js、record.js（P3 起）。
 * 实现阶段：P3（日志模块与调试输出）
 *
 * 约束：只输出到当前上下文的浏览器控制台；不读写浏览器存储、不走消息、不落盘、不上报。
 *       未调用 initLogging 前保持静默，避免测试与模块导入阶段产生输出。
 */

import { DEFAULT_LOG_LEVEL, normalizeLevel, shouldLog } from './levels.js';
import { createRecord, createSessionId, formatLine, sanitizeError } from './record.js';

/** 允许的上下文；非法值回退 background。 */
const CONTEXTS = new Set(['background', 'popup', 'options', 'content']);

/** 记录级别到控制台方法。 */
const CONSOLE_METHOD = Object.freeze({
  debug: 'debug',
  info: 'info',
  warn: 'warn',
  error: 'error',
});

/** 当前日志配置。 */
const state = {
  initialized: false,
  context: 'background',
  level: DEFAULT_LOG_LEVEL,
  sessionId: null,
  version: undefined,
  origin: undefined,
};

/** 全局异常捕获状态。 */
let handlersInstalled = false;
/** @type {EventTarget | null} */
let handlerTarget = null;
/** @type {{ error: Function, unhandledrejection: Function } | null} */
let handlerFns = null;

/**
 * 归一上下文。
 * @param {unknown} value
 * @returns {'background'|'popup'|'options'|'content'}
 */
function normalizeContext(value) {
  return CONTEXTS.has(value) ? value : 'background';
}

/**
 * 归一 traceId：非空字符串且 ≤ 64 才保留。
 * @param {unknown} value
 * @returns {string | undefined}
 */
export function normalizeTraceId(value) {
  if (typeof value !== 'string') return undefined;
  const trimmed = value.trim();
  return trimmed.length > 0 && trimmed.length <= 64 ? trimmed : undefined;
}

/**
 * 初始化日志。可重复调用；未传 sessionId 时保留原值。
 * @param {{
 *   context?: 'background'|'popup'|'options'|'content',
 *   level?: string,
 *   sessionId?: string,
 *   version?: string,
 *   origin?: string,
 *   captureErrors?: boolean,
 * }} [options]
 * @returns {object} 当前日志元信息
 */
export function initLogging(options = {}) {
  const {
    context = 'background',
    level = DEFAULT_LOG_LEVEL,
    sessionId,
    version,
    origin,
    captureErrors = false,
  } = options;

  state.context = normalizeContext(context);
  state.level = normalizeLevel(level);
  state.sessionId = sessionId ?? state.sessionId ?? createSessionId();
  if (version !== undefined) state.version = version;
  if (origin !== undefined) state.origin = origin;
  state.initialized = true;

  if (captureErrors) installGlobalErrorHandlers();
  return getLogMeta();
}

/**
 * 重置日志状态（测试用）；同时移除已安装的全局异常监听。
 */
export function resetLogging() {
  uninstallGlobalErrorHandlers();
  state.initialized = false;
  state.context = 'background';
  state.level = DEFAULT_LOG_LEVEL;
  state.sessionId = null;
  state.version = undefined;
  state.origin = undefined;
}

/**
 * 当前日志元信息，用于 logger.ready。
 * @returns {object}
 */
export function getLogMeta() {
  /** @type {Record<string, unknown>} */
  const meta = {
    context: state.context,
    level: state.level,
    sessionId: state.sessionId,
  };
  if (state.version !== undefined) meta.version = state.version;
  if (state.origin !== undefined) meta.origin = state.origin;
  return meta;
}

/**
 * 设置级别；非法值归一为 info。
 * @param {unknown} level
 * @returns {'debug'|'info'|'warn'|'error'|'off'}
 */
export function setLogLevel(level) {
  state.level = normalizeLevel(level);
  return state.level;
}

/**
 * @returns {string}
 */
export function getLogLevel() {
  return state.level;
}

/**
 * 生成新的 traceId。
 * @returns {string}
 */
export function newTraceId() {
  return `t-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 8)}`;
}

/**
 * 输出一条记录。
 * @param {string} level
 * @param {string} scope
 * @param {string | undefined} traceId
 * @param {string} event
 * @param {string} message
 * @param {unknown} data
 * @param {unknown} error
 */
function emit(level, scope, traceId, event, message, data, error) {
  if (!state.initialized || !shouldLog(state.level, level)) return;

  let line;
  try {
    const record = createRecord({
      level,
      scope,
      ctx: state.context,
      event,
      message,
      data,
      error,
      traceId,
      sessionId: state.sessionId,
    });
    line = formatLine(record);
  } catch {
    return;
  }

  const method = CONSOLE_METHOD[level] ?? 'log';
  try {
    const fn = typeof console?.[method] === 'function' ? console[method] : console?.log;
    fn?.call(console, line);
  } catch {
    // 控制台异常不影响业务。
  }
}

/**
 * 创建模块 logger；可在模块加载期调用，输出时读取当前全局级别。
 * @param {string} scope 模块号，如 A2 / D4 / E4
 * @param {{ traceId?: string }} [options]
 * @returns {{
 *   debug: Function,
 *   info: Function,
 *   warn: Function,
 *   error: Function,
 *   withTrace: (traceId: string) => object,
 * }}
 */
export function createLogger(scope, options = {}) {
  const safeScope = typeof scope === 'string' && scope ? scope : 'E4';
  const traceId = normalizeTraceId(options.traceId);

  return {
    debug(event, message, data) {
      emit('debug', safeScope, traceId, event, message, data, undefined);
    },
    info(event, message, data) {
      emit('info', safeScope, traceId, event, message, data, undefined);
    },
    warn(event, message, data) {
      emit('warn', safeScope, traceId, event, message, data, undefined);
    },
    error(event, message, data, error) {
      emit('error', safeScope, traceId, event, message, data, error);
    },
    withTrace(nextTraceId) {
      return createLogger(safeScope, { traceId: nextTraceId });
    },
  };
}

/**
 * 判断页面注入的错误是否来自扩展自身脚本。
 * @param {string} filename
 * @returns {boolean}
 */
function isExtensionFile(filename) {
  if (typeof filename !== 'string' || !filename) return false;
  try {
    const base = globalThis.chrome?.runtime?.getURL?.('');
    return Boolean(base && filename.startsWith(base));
  } catch {
    return false;
  }
}

/**
 * 判断未处理拒绝是否来自扩展自身脚本。
 * @param {unknown} reason
 * @returns {boolean}
 */
function isExtensionRejection(reason) {
  try {
    const base = globalThis.chrome?.runtime?.getURL?.('');
    if (!base) return false;
    const text =
      typeof reason === 'string'
        ? reason
        : `${reason?.stack ?? ''}\n${reason?.message ?? ''}`;
    return text.includes(base);
  } catch {
    return false;
  }
}

/**
 * 判断是否为取消操作产生的 AbortError。
 * @param {unknown} reason
 * @returns {boolean}
 */
function isAbortReason(reason) {
  if (!reason) return false;
  return reason.name === 'AbortError' || reason.code === 20;
}

/**
 * 安装全局异常捕获；重复调用只安装一次。
 * @returns {boolean} 是否已安装
 */
export function installGlobalErrorHandlers() {
  if (handlersInstalled) return true;

  const target =
    state.context === 'background'
      ? globalThis
      : typeof window !== 'undefined'
        ? window
        : null;
  if (!target || typeof target.addEventListener !== 'function') return false;

  const onError = (event) => {
    try {
      if (state.context === 'content' && !isExtensionFile(event?.filename)) return;
      emit(
        'error',
        'E4',
        undefined,
        'global.error',
        '未捕获异常',
        {
          origin: state.origin,
          filename: event?.filename,
          lineno: event?.lineno,
          colno: event?.colno,
        },
        event?.error ?? { name: 'Error', message: event?.message }
      );
    } catch {
      // 捕获器自身异常必须吞掉。
    }
  };

  const onUnhandledRejection = (event) => {
    try {
      const reason = event?.reason;
      if (state.context === 'content' && !isExtensionRejection(reason)) return;

      // 取消（AbortError）是预期行为：记一条普通日志，并阻止浏览器把它当未处理错误打印。
      if (isAbortReason(reason)) {
        try {
          event?.preventDefault?.();
        } catch {
          // 某些 EventTarget 不支持 preventDefault，忽略。
        }
        emit(
          'info',
          'E4',
          undefined,
          'global.abort',
          '操作已取消',
          { origin: state.origin, name: reason?.name ?? 'AbortError' },
          undefined
        );
        return;
      }

      emit(
        'error',
        'E4',
        undefined,
        'global.unhandledrejection',
        '未处理的 Promise 拒绝',
        { origin: state.origin },
        sanitizeError(reason)
      );
    } catch {
      // 捕获器自身异常必须吞掉。
    }
  };

  target.addEventListener('error', onError);
  target.addEventListener('unhandledrejection', onUnhandledRejection);
  handlerTarget = target;
  handlerFns = { error: onError, unhandledrejection: onUnhandledRejection };
  handlersInstalled = true;
  return true;
}

/**
 * 移除全局异常监听（测试与重置用）。
 */
function uninstallGlobalErrorHandlers() {
  if (!handlersInstalled || !handlerTarget || !handlerFns) {
    handlersInstalled = false;
    handlerTarget = null;
    handlerFns = null;
    return;
  }
  try {
    handlerTarget.removeEventListener('error', handlerFns.error);
    handlerTarget.removeEventListener('unhandledrejection', handlerFns.unhandledrejection);
  } catch {
    // 目标已失效，忽略。
  }
  handlersInstalled = false;
  handlerTarget = null;
  handlerFns = null;
}
