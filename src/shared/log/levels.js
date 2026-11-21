/**
 * E4 日志等级
 *
 * 模块：公共模块（E）/ E4
 * 职责：定义日志等级、阈值、归一与设置页选项；只做纯计算，不输出、不读写存储。
 * 依赖：无。
 */

/**
 * 等级数值：数值越大越严重；`off` 为关闭。
 * 与浏览器 DevTools 的 Verbose / Info / Warning / Error 四级对应，
 * `debug` 对应 Verbose，`off` 是扩展自己的关闭项。
 */
export const LOG_LEVELS = Object.freeze({
  debug: 10,
  info: 20,
  warn: 30,
  error: 40,
  off: 100,
});

/** 默认级别：默认显示 Info、Warning、Error，Debug 需要手动打开。 */
export const DEFAULT_LOG_LEVEL = 'info';

/** 设置页短标签；完整标签见 LOG_LEVEL_OPTIONS。 */
export const LOG_LEVEL_LABELS = Object.freeze({
  debug: '详细',
  info: '信息',
  warn: '警告',
  error: '错误',
  off: '关闭',
});

/** 设置页下拉选项；顺序从最详细到关闭。 */
export const LOG_LEVEL_OPTIONS = Object.freeze([
  Object.freeze({ value: 'debug', label: '详细（Verbose）' }),
  Object.freeze({ value: 'info', label: '信息（Info）' }),
  Object.freeze({ value: 'warn', label: '警告（Warning）' }),
  Object.freeze({ value: 'error', label: '错误（Error）' }),
  Object.freeze({ value: 'off', label: '关闭（Off）' }),
]);

/**
 * 归一等级：只认五个已知值，其余回退默认 `info`。
 * @param {unknown} value
 * @returns {'debug'|'info'|'warn'|'error'|'off'}
 */
export function normalizeLevel(value) {
  return Object.hasOwn(LOG_LEVELS, value) ? /** @type {keyof typeof LOG_LEVELS} */ (value) : DEFAULT_LOG_LEVEL;
}

/**
 * 判断一条记录是否应输出。
 * @param {unknown} configured 设置级别
 * @param {unknown} recordLevel 记录级别
 * @returns {boolean}
 */
export function shouldLog(configured, recordLevel) {
  const threshold = LOG_LEVELS[normalizeLevel(configured)];
  const rank = LOG_LEVELS[recordLevel];
  if (typeof rank !== 'number') return false;
  if (threshold === LOG_LEVELS.off) return false;
  return rank >= threshold;
}
