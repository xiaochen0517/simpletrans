/**
 * 公共数值
 *
 * 模块：公共模块（E）
 * 职责：集中超时、并发、心跳、重连与载荷上限等公共数值（见项目架构 5.3）；其它文件只引用，不各自定义。
 * 依赖：无（P1 起）。
 * 实现阶段：P1–P2
 *
 * P1 落地单段上限与 AI 超时；P2 补齐心跳、重连、并发、批量上限与批总超时。
 */

/** 单段字符上限（架构 5.3 载荷上限）。 */
export const MAX_SEGMENT_CHARS = 4000;

/** 单批段数上限（架构 5.3）。 */
export const MAX_BATCH_ITEMS = 12;

/** 单批字符上限（架构 5.3）。 */
export const MAX_BATCH_CHARS = 12_000;

/** 每段上下文上限（架构 5.3）。 */
export const MAX_CONTEXT_CHARS = 400;

/** 每批上下文上限（架构 5.3）。 */
export const MAX_BATCH_CONTEXT_CHARS = 1_200;

/** 全局上游并发硬上限（架构 5.3）。 */
export const GLOBAL_CONCURRENCY = 4;

/** 用户并发数默认值（架构 5.3）；设置页可在 1–4 之间调整。 */
export const DEFAULT_CONCURRENCY = 3;

/** 每个连接的在途批次上限（架构 5.3）。 */
export const MAX_INFLIGHT_BATCHES_PER_PORT = 4;

/** 心跳间隔：页面注入发 ST_PING，后台回 ST_PONG（架构 5.3）。 */
export const HEARTBEAT_INTERVAL_MS = 20_000;

/** 心跳超时：发出 ST_PING 后 10 秒未收到 ST_PONG 即重连（架构 5.3）。 */
export const HEARTBEAT_TIMEOUT_MS = 10_000;

/** 断线重连退避：1 秒、2 秒、4 秒，之后固定 4 秒（架构 5.3）。 */
export const RECONNECT_DELAYS_MS = Object.freeze([1000, 2000, 4000]);

/**
 * AI 超时（架构 5.3）。
 * - singleSegment：单段首响应超时，15 秒（P9 落地判定）；
 * - delta：增量间隔超时，30 秒无新增量视为卡住（P9 落地判定）；
 * - total：单段总计超时，120 秒；
 * - batchTotal：整批总计超时，180 秒，必须小于后台单次事件的 5 分钟上限。
 */
export const AI_TIMEOUT_MS = Object.freeze({
  singleSegment: 15_000,
  delta: 30_000,
  total: 120_000,
  batchTotal: 180_000,
});
