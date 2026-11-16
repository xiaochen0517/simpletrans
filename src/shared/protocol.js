/**
 * E1 消息协议
 *
 * 模块：公共模块（E）/ E1
 * 职责：定义扩展内部的统一错误码、错误分类标志、消息名、端口名与载荷校验辅助，作为后台、弹窗、设置页与页面注入的协议来源。
 * 依赖：无（P1 起）。
 * 实现阶段：P1–P2（错误码在 P1 落地；消息名、端口名与报文在 P2 落地，见 docs/modules/E1-消息协议.md）
 */

/** 统一错误码。分类依据见项目架构 6.8。 */
export const ERROR_CODES = Object.freeze({
  CONFIG: 'CONFIG', // 配置：缺密钥 / 缺引擎 / 配置无效
  AUTH: 'AUTH', // 鉴权与额度：鉴权失败 / 额度不足
  RATE_LIMIT: 'RATE_LIMIT', // 限流
  NETWORK: 'NETWORK', // 网络错误 / 超时 / 流中断
  BATCH_ALIGN: 'BATCH_ALIGN', // 批量对齐：输出与输入对不上
  CANCELLED: 'CANCELLED', // 取消：用户取消 / 连接关闭
  OTHER: 'OTHER', // 其它：不支持的语言等
});

/**
 * 每个错误码的分类标志。
 * - retryable：是否可重试（仅限流、网络、超时、流中断重试）。
 * - splittable：是否通过拆批解决（仅批量对齐）。
 * - fallbackable：是否可切换备用引擎（配置/鉴权/额度，以及重试仍失败的限流）。
 */
export const ERROR_FLAGS = Object.freeze({
  [ERROR_CODES.CONFIG]: Object.freeze({ retryable: false, splittable: false, fallbackable: true }),
  [ERROR_CODES.AUTH]: Object.freeze({ retryable: false, splittable: false, fallbackable: true }),
  // 限流重试仍失败后才切换备用（见架构 6.8）；切换时机由 P9 决定。
  [ERROR_CODES.RATE_LIMIT]: Object.freeze({ retryable: true, splittable: false, fallbackable: true }),
  [ERROR_CODES.NETWORK]: Object.freeze({ retryable: true, splittable: false, fallbackable: false }),
  [ERROR_CODES.BATCH_ALIGN]: Object.freeze({ retryable: false, splittable: true, fallbackable: false }),
  [ERROR_CODES.CANCELLED]: Object.freeze({ retryable: false, splittable: false, fallbackable: false }),
  [ERROR_CODES.OTHER]: Object.freeze({ retryable: false, splittable: false, fallbackable: false }),
});

/**
 * 判断是否已知错误码。
 * @param {string} code
 * @returns {boolean}
 */
export function isKnownCode(code) {
  return Object.prototype.hasOwnProperty.call(ERROR_CODES, code);
}

/**
 * 取错误码的分类标志；未知码归入 OTHER。
 * @param {string} code
 * @returns {{ retryable: boolean, splittable: boolean, fallbackable: boolean }}
 */
export function errorInfo(code) {
  return ERROR_FLAGS[code] ?? ERROR_FLAGS[ERROR_CODES.OTHER];
}

/** 页面注入与后台之间唯一的长连接端口名（架构 5.2、5.5）。 */
export const PORT_NAME = 'st-gateway';

/**
 * 扩展内部消息名。
 * 4.6 的清单在这里完整声明；P2 只实现其中的控制面与数据面消息，其余名字由后续阶段接入。
 */
export const MESSAGE_TYPES = Object.freeze({
  // 控制面：一次性消息
  ROUTE: 'ST_ROUTE', // 弹窗 → 后台：命令转发（P7）
  START: 'ST_START', // 后台 → 页面注入：开始整页任务（P4/P7）
  TOGGLE: 'ST_TOGGLE', // 后台 → 页面注入：切换当前段（P4）
  CLEAR: 'ST_CLEAR', // 后台 → 页面注入：清除全部译文（P4）
  LIST_ENGINES: 'ST_LIST_ENGINES', // 设置页 → 后台：引擎列表（P2）
  TEST_ENGINE: 'ST_TEST_ENGINE', // 设置页 → 后台：测试翻译（P2）

  // 数据面：长连接
  PING: 'ST_PING',
  PONG: 'ST_PONG',
  TRANSLATE_BATCH: 'ST_TRANSLATE_BATCH',
  ITEM_START: 'ST_ITEM_START',
  ITEM_DELTA: 'ST_ITEM_DELTA',
  ITEM_DONE: 'ST_ITEM_DONE',
  ITEM_ERROR: 'ST_ITEM_ERROR',
  BATCH_DONE: 'ST_BATCH_DONE',
  CANCEL_BATCH: 'ST_CANCEL_BATCH',
  CANCEL_ITEM: 'ST_CANCEL_ITEM',
  CLOSE: 'ST_CLOSE',
  ENGINE_CHANGED: 'ST_ENGINE_CHANGED', // 后台 → 页面注入：切备用（P9）
  LOG_CONFIG: 'ST_LOG_CONFIG', // 后台 → 页面注入：连接建立后下发日志级别（P3）
});

const KNOWN_MESSAGE_TYPES = new Set(Object.values(MESSAGE_TYPES));

/**
 * 判断是否架构 4.6 已声明的消息名。
 * @param {unknown} type
 * @returns {boolean}
 */
export function isKnownMessageType(type) {
  return typeof type === 'string' && KNOWN_MESSAGE_TYPES.has(type);
}

/**
 * 机器可读的失败原因。`code` 决定重试/拆批/切备用，`reason` 只用于定位具体校验项。
 */
export const FAILURE_REASONS = Object.freeze({
  INVALID_MESSAGE: 'INVALID_MESSAGE',
  INVALID_REQUEST_ID: 'INVALID_REQUEST_ID',
  DUPLICATE_REQUEST: 'DUPLICATE_REQUEST',
  INVALID_ITEMS: 'INVALID_ITEMS',
  DUPLICATE_ITEM_ID: 'DUPLICATE_ITEM_ID',
  EMPTY_TEXT: 'EMPTY_TEXT',
  TEXT_TOO_LONG: 'TEXT_TOO_LONG',
  BATCH_TOO_LARGE: 'BATCH_TOO_LARGE',
  CONTEXT_TOO_LONG: 'CONTEXT_TOO_LONG',
  FORBIDDEN_FIELD: 'FORBIDDEN_FIELD',
  UNSUPPORTED_LANG: 'UNSUPPORTED_LANG',
  TOO_MANY_INFLIGHT: 'TOO_MANY_INFLIGHT',
  BATCH_TIMEOUT: 'BATCH_TIMEOUT',
  DISCONNECTED: 'DISCONNECTED',
  NOT_CONNECTED: 'NOT_CONNECTED',
  EXTENSION_INVALIDATED: 'EXTENSION_INVALIDATED',
  NO_ACTIVE_TAB: 'NO_ACTIVE_TAB',
  NO_RECEIVER: 'NO_RECEIVER',
  INJECTION_FAILED: 'INJECTION_FAILED',
});

/**
 * 批次与控制面请求里不允许出现的字段：地址、密钥、模型等只能来自用户配置。
 * 见架构 5.5 第 2、3 条。
 *
 * 不导出、不加 Object.freeze：content 只需要消息名与失败原因，
 * 这里保持纯字面量，构建时才能把未使用的校验代码从 content 产物里摇掉。
 */
const FORBIDDEN_PAYLOAD_FIELDS = [
  'apiKey',
  'api_key',
  'key',
  'baseUrl',
  'url',
  'headers',
  'model',
  'instance',
  'engineId',
];

/**
 * 递归查找载荷中的禁止字段；找到返回字段名，否则返回 null。
 * @param {unknown} value
 * @returns {string | null}
 */
export function findForbiddenField(value) {
  if (!value || typeof value !== 'object') return null;
  const stack = [value];
  while (stack.length > 0) {
    const current = stack.pop();
    if (!current || typeof current !== 'object') continue;
    for (const [key, child] of Object.entries(current)) {
      if (FORBIDDEN_PAYLOAD_FIELDS.includes(key)) return key;
      if (child && typeof child === 'object') stack.push(child);
    }
  }
  return null;
}

/**
 * 构造统一错误对象。
 * @param {string} code
 * @param {string} message
 * @param {string} [reason]
 * @returns {{ code: string, message: string, reason?: string }}
 */
export function makeError(code, message, reason) {
  return reason ? { code, message, reason } : { code, message };
}

/**
 * 归一可选的 traceId：非空字符串且 ≤ 64 才保留，其余返回 undefined。
 * 只用于日志关联，不参与业务校验。
 * @param {unknown} value
 * @returns {string | undefined}
 */
export function normalizeTraceId(value) {
  if (typeof value !== 'string') return undefined;
  const trimmed = value.trim();
  return trimmed.length > 0 && trimmed.length <= 64 ? trimmed : undefined;
}
