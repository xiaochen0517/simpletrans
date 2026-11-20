/**
 * E1 消息协议
 *
 * 模块：公共模块（E）/ E1
 * 职责：定义扩展内部的统一错误码、错误分类标志、消息名、端口名与载荷校验辅助，作为后台、弹窗、设置页与页面注入的协议来源。
 * 依赖：无（P1 起）。
 * 实现阶段：P1–P5（错误码在 P1 落地；消息名、端口名与报文在 P2 落地；`traceId` 在 P3；
 *           `normalizeDomain` 与两条缓存消息在 P5 落地；`ST_ROUTE` / `ST_START` /
 *           `ST_PAGE_SUBMIT` 在 P6.1 落地，见 docs/modules/E1-消息协议.md；本轮段落去掉上下文，
 *           `hostId` 兼作结果帧 `itemId`）；P9 删除 `ST_ENGINE_CHANGED` 与 `fallbackable`，
 *           失败段「刷新」复用 `ST_PAGE_SUBMIT(scope='single')`；
 *           P11 增加 `ST_QUICK_TRANSLATE` 与 `ST_GET_SELECTION`（弹窗快速翻译）；
 *           P12 增加 `ST_CONTENT_CONFIG` 与 `ST_GET_STATUS`，删除 `ST_TOGGLE`。
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
 * 每个错误码的分类标志（P9 起）。
 * - retryable：是否可重试（仅限流、网络、超时、流中断重试）。
 * - splittable：是否通过拆批解决（仅批量对齐）。
 *
 * 失败只在同一实例内重试，不存在切换到其它实例或引擎的分支，因此没有额外的切换标志。
 */
export const ERROR_FLAGS = Object.freeze({
  [ERROR_CODES.CONFIG]: Object.freeze({ retryable: false, splittable: false }),
  [ERROR_CODES.AUTH]: Object.freeze({ retryable: false, splittable: false }),
  [ERROR_CODES.RATE_LIMIT]: Object.freeze({ retryable: true, splittable: false }),
  [ERROR_CODES.NETWORK]: Object.freeze({ retryable: true, splittable: false }),
  [ERROR_CODES.BATCH_ALIGN]: Object.freeze({ retryable: false, splittable: true }),
  [ERROR_CODES.CANCELLED]: Object.freeze({ retryable: false, splittable: false }),
  [ERROR_CODES.OTHER]: Object.freeze({ retryable: false, splittable: false }),
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
 * @returns {{ retryable: boolean, splittable: boolean }}
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
  ROUTE: 'ST_ROUTE', // 弹窗 → 后台：命令转发（P6.1 start / clear；P12 status）
  START: 'ST_START', // 后台 → 页面注入：开始整页取段并提交（P6.1）
  PAGE_SUBMIT: 'ST_PAGE_SUBMIT', // 页面注入 → 后台：统一提交段落（P6.1，scope=page/single；每段 index/hostId/text，hostId 即结果帧 itemId；后台校验、计数、逐段日志并回执）
  CLEAR: 'ST_CLEAR', // 后台 → 页面注入：清除全部标记与译文（P4）；响应 removed（P6.1）
  GET_STATUS: 'ST_GET_STATUS', // 后台 → 页面注入：读取整页会话状态（P12），响应 { active }
  LIST_ENGINES: 'ST_LIST_ENGINES', // 设置页 → 后台：引擎列表（P2）
  TEST_ENGINE: 'ST_TEST_ENGINE', // 设置页 → 后台：测试翻译（P2）
  QUICK_TRANSLATE: 'ST_QUICK_TRANSLATE', // 弹窗 → 后台：快速翻译（P11），返回纯文本译文
  GET_SELECTION: 'ST_GET_SELECTION', // 弹窗 → 后台：读取当前活动标签页选中文字（P11）
  CACHE_STATS: 'ST_CACHE_STATS', // 设置页 → 后台：读取缓存占用（P5）
  CLEAR_CACHE: 'ST_CLEAR_CACHE', // 设置页 → 后台：清空缓存（P5）

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
  LOG_CONFIG: 'ST_LOG_CONFIG', // 后台 → 页面注入：连接建立后下发日志级别（P3）
  CONTENT_CONFIG: 'ST_CONTENT_CONFIG', // 后台 → 页面注入：连接建立后下发内容配置（P12，目前为悬停快捷键）
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

/** 域名（hostname）字符串上限。 */
export const MAX_DOMAIN_CHARS = 253;

/** 合法 hostname：若干标签，每段 1–63 字符，只允许字母、数字与连字符。 */
const HOSTNAME_PATTERN = /^[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?(?:\.[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?)*$/;

/**
 * 归一页面 hostname：小写、去首尾空白与末尾点；带协议、端口、路径或非法字符时返回空串。
 * 内容侧与网关共用同一规则；只作为缓存来源元数据，不参与缓存 key 与命中判断。
 * @param {unknown} value
 * @returns {string}
 */
export function normalizeDomain(value) {
  if (typeof value !== 'string') return '';
  const lower = value.trim().toLowerCase().replace(/\.+$/, '');
  if (lower === '' || lower.length > MAX_DOMAIN_CHARS) return '';
  return HOSTNAME_PATTERN.test(lower) ? lower : '';
}
