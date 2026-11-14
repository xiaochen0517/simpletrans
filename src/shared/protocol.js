/**
 * E1 消息协议
 *
 * 模块：公共模块（E）/ E1
 * 职责：定义扩展内部的统一错误码与错误分类标志，作为后台、弹窗、设置页与页面注入的协议来源。
 * 依赖：无（P1 起）。
 * 实现阶段：P1–P2（错误码在 P1 落地；消息名与报文在 P2 落地，见 docs/modules/E1-消息协议.md）
 *
 * P1 只落错误码与分类标志；消息名（控制面 ST_LIST_ENGINES/ST_TEST_ENGINE 与数据面消息）留 P2。
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
  // 限流重试仍失败后才切换备用（见架构 6.8）；P1 只落布尔标志，切换时机由 P8 决定。
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
