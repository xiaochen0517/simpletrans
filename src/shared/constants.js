/**
 * 公共数值
 *
 * 模块：公共模块（E）
 * 职责：集中超时、心跳、重连、载荷上限与实例数量等公共数值；其它文件只引用，不各自定义。
 * 依赖：无。
 *
 * 翻译并发、单批段数与批次字符数的默认值属于实例配置，见 E3 registry.js；
 * 本文件可被页面注入引用，因此不得出现服务商地址、密钥字段或签名相关词。
 */

/** 单段字符上限（数据面载荷上限）。 */
export const MAX_SEGMENT_CHARS = 4000;

/** 单批段数上限。 */
export const MAX_BATCH_ITEMS = 12;

/** 单批字符上限。 */
export const MAX_BATCH_CHARS = 12_000;

/** 每段上下文上限。 */
export const MAX_CONTEXT_CHARS = 400;

/** 每批上下文上限。 */
export const MAX_BATCH_CONTEXT_CHARS = 1_200;

/** 每个连接的在途批次上限。 */
export const MAX_INFLIGHT_BATCHES_PER_PORT = 4;

/** 译文显示更新节流：合并增量，按帧刷新。 */
export const DISPLAY_UPDATE_THROTTLE_MS = 80;

/** 悬停范围预览：滚轮累计多少像素升降一级。 */
export const HOVER_RANGE_WHEEL_STEP = 40;

/** 心跳间隔：页面注入发 ST_PING，后台回 ST_PONG。 */
export const HEARTBEAT_INTERVAL_MS = 20_000;

/** 心跳超时：发出 ST_PING 后 10 秒未收到 ST_PONG 即重连。 */
export const HEARTBEAT_TIMEOUT_MS = 10_000;

/** 断线重连退避：1 秒、2 秒、4 秒，之后固定 4 秒。 */
export const RECONNECT_DELAYS_MS = Object.freeze([1000, 2000, 4000]);

/**
 * AI 超时。
 * - singleSegment：单段首响应超时，15 秒；
 * - delta：增量间隔超时，30 秒无新增量视为卡住；
 * - total：单段总计超时，120 秒；
 * - batchTotal：整批总计超时，180 秒，必须小于后台单次事件的 5 分钟上限。
 */
export const AI_TIMEOUT_MS = Object.freeze({
  singleSegment: 15_000,
  delta: 30_000,
  total: 120_000,
  batchTotal: 180_000,
});

/** 单页最多整页段落数：一次提交最多包含这么多段。 */
export const MAX_PAGE_PARAGRAPHS = 5_000;

/** 整页扫描每处理多少个元素让出一次主线程。 */
export const SCAN_CHUNK_SIZE = 500;

/** 整页取段的视口上下扩展比例（屏数）：上下各半屏。 */
export const VIEWPORT_MARGIN_RATIO = 0.5;

/** 滚动停止后等待多久再扫描并提交新段落（毫秒）。 */
export const SCROLL_SUBMIT_DEBOUNCE_MS = 200;

/** 页面重渲染后，合并 DOM 变更再检查译文是否丢失的去抖（毫秒）。 */
export const RESTORE_DEBOUNCE_MS = 150;

/** 单次恢复检查最多处理的候选宿主数。 */
export const RESTORE_MAX_CANDIDATES = 200;

/** 页面内译文镜像的条目上限，按写入顺序淘汰最旧条目。 */
export const RESTORE_MIRROR_LIMIT = 2_000;

/** 同一文本反复重建的统计窗口（毫秒）。 */
export const RESTORE_FLAP_WINDOW_MS = 10_000;

/** 同一文本在统计窗口内允许的自动恢复次数，超过即暂停。 */
export const RESTORE_FLAP_LIMIT = 5;

/** 超过重建阈值后暂停该文本自动恢复的时长（毫秒）。 */
export const RESTORE_FLAP_PAUSE_MS = 10_000;

/** 实例数量上限。 */
export const MAX_INSTANCES = 20;

/** 实例名称最大字符数。 */
export const MAX_INSTANCE_NAME_CHARS = 40;

/** `engineInstances` 序列化后的最大字节数，受 `storage.sync` 单条 8192 字节限制。 */
export const MAX_INSTANCE_BYTES = 7_500;

/** 百度翻译单段 UTF-8 字节上限：应用层留余量。 */
export const BAIDU_SEGMENT_MAX_BYTES = 4_800;

/** 百度翻译单批 `q` 的 UTF-8 字节上限：应用层留余量。 */
export const BAIDU_BATCH_MAX_BYTES = 4_800;

/**
 * 百度翻译超时。
 * - single：单段请求超时，15 秒；
 * - batch：整批请求超时，30 秒。
 */
export const BAIDU_TIMEOUT_MS = Object.freeze({
  single: 15_000,
  batch: 30_000,
});

/**
 * 失败重试等待（毫秒）：首次失败等 1 秒，第二次失败等 2 秒。
 * 重试次数由本数组长度推导，避免两处写死。
 */
export const RETRY_DELAYS_MS = Object.freeze([1000, 2000]);

/** 重试等待的随机抖动上限（毫秒）：避免多标签页同时重试造成尖峰。 */
export const RETRY_JITTER_MS = 250;

/** QPS 滑动窗口长度（毫秒）：同一实例任意窗口内请求数不超过实例 QPS。 */
export const QPS_WINDOW_MS = 1000;

/**
 * 译文缓存数据库版本。
 * A4 用它打开 IndexedDB；设置页「关于」只读展示，不引用缓存模块。
 */
export const CACHE_DB_VERSION = 2;
