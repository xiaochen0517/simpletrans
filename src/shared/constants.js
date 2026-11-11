/**
 * SimpleTrans 运行期常量
 *
 * 只放“调参”的值，业务语义放在 protocol.js / settings.js。
 * 单位：毫秒（除注明外）。
 */

/** 数据面长连接名称。 */
export const PORT_NAME = 'st-gateway';

/** Background 增量合并窗口：把 token 流攒成一条消息再发。 */
export const DELTA_FLUSH_MS = 80;

/** Content 增量渲染节流窗口。 */
export const RENDER_THROTTLE_MS = 80;

/** 心跳间隔（任务进行中）。 */
export const HEARTBEAT_MS = 20_000;

/** 状态镜像写入节流。 */
export const STATUS_THROTTLE_MS = 300;

/** 任务结束后状态键的保留时间，便于弹窗读取终态。 */
export const STATUS_TTL_MS = 30_000;

/** 默认并发。 */
export const DEFAULT_CONCURRENCY = 3;
export const MAX_CONCURRENCY = 4;

/** 流式超时。 */
export const TIMEOUTS = Object.freeze({
  /** 首字节：超过则 abort 并重试。 */
  FIRST_DELTA_MS: 15_000,
  /** 增量间隔：超过则判定 STREAM_BROKEN。 */
  IDLE_MS: 30_000,
  /** 单段总时长上限。 */
  SEGMENT_MS: 120_000,
});

/** 重试策略。 */
export const RETRY = Object.freeze({
  MAX_ATTEMPTS: 2,
  BASE_DELAY_MS: 1_000,
});

/** 支持的目标语言（Options 下拉与 prompt 共同使用）。 */
export const SUPPORTED_LANGS = Object.freeze([
  { value: 'zh-CN', label: '简体中文' },
  { value: 'en', label: 'English' },
  { value: 'ja', label: '日本語' },
  { value: 'ko', label: '한국어' },
]);
