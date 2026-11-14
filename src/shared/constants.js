/**
 * 公共数值
 *
 * 模块：公共模块（E）
 * 职责：集中超时、载荷上限等公共数值（见项目架构 5.3）；其它文件只引用，不各自定义。
 * 依赖：无（P1 起）。
 * 实现阶段：P1–P2
 *
 * P1 只落地当前用到的数值：单段上限与 AI 单段超时。
 * 其余 5.3 数值（心跳、重连、并发、批量超时等）随 P2–P5 对应模块落地时补充。
 */

/** 单段字符上限（架构 5.3 载荷上限）。 */
export const MAX_SEGMENT_CHARS = 4000;

/**
 * AI 单段超时（架构 5.3）。
 * - singleSegment：单段首响应超时，15 秒；
 * - delta：增量间隔超时，30 秒无新增量视为卡住；
 * - total：单段总计超时，120 秒，必须小于后台单次事件的 5 分钟上限。
 *
 * P1 适配器只强制 total；singleSegment/delta 的判定随 P2/P8 落地。
 */
export const AI_TIMEOUT_MS = Object.freeze({
  singleSegment: 15_000,
  delta: 30_000,
  total: 120_000,
});
