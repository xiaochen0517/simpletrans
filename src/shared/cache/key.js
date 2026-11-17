/**
 * A4 缓存 key
 *
 * 模块：后台服务（A）/ A4
 * 职责：按 key 版本、引擎类型、endpoint 指纹、模型、语言、提示词版本/哈希、生成参数哈希、
 *       批量编码版本与原文计算稳定的缓存 key（SHA-256）。
 * 依赖：无（P5 起）。
 * 实现阶段：P5（译文缓存）；P6.2 升级 key v2；P8-2 升级 key v3：
 *           用 endpoint 指纹 + 生成参数哈希替代思考强度，区分 OpenAI/百度与自定义 endpoint。
 *
 * 域名不进入 key：同一原文与同一组条件在任意页面得到同一个 key。
 * 调用方在 key 计算失败时按「本批不参与缓存」处理，本模块只抛错，不打印日志。
 */

/** key 结构版本：字段增删、顺序变化或语义变化时递增。 */
export const CACHE_KEY_VERSION = 3;

/** 逻辑 key 前缀，同时出现在 IndexedDB 主键里。 */
export const CACHE_KEY_PREFIX = `cache:v${CACHE_KEY_VERSION}:`;

/**
 * 归一必填文本字段：非空字符串（或可转成非空字符串的数值）才接受。
 * @param {string} name
 * @param {unknown} value
 * @returns {string}
 */
function requireField(name, value) {
  if (typeof value === 'number' && Number.isFinite(value)) return String(value);
  if (typeof value !== 'string' || value.trim() === '') {
    throw new TypeError(`缓存 key 缺少 ${name}`);
  }
  return value;
}

/**
 * 把字节数组转成小写十六进制。
 * @param {ArrayBuffer} buffer
 * @returns {string}
 */
function toHex(buffer) {
  const bytes = new Uint8Array(buffer);
  let out = '';
  for (const byte of bytes) out += byte.toString(16).padStart(2, '0');
  return out;
}

/**
 * 计算缓存 key。
 *
 * 参与 key 的字段按固定顺序组成数组：key 版本、引擎类型、endpoint 指纹、模型、源语言、
 * 目标语言、提示词版本、提示词哈希、生成参数哈希、批量编码版本、原文；整体
 * `JSON.stringify` 后做 SHA-256。百度使用固定 profile：指纹 `baidu`、模型 `general`、
 * 提示词哈希 `none`、生成参数哈希 `baidu:v1`、提示词版本 0。
 *
 * @param {{
 *   keyVersion?: unknown,
 *   engineType: unknown,
 *   endpointFingerprint: unknown,
 *   model: unknown,
 *   sourceLang?: unknown,
 *   targetLang: unknown,
 *   promptVersion: unknown,
 *   promptHash: unknown,
 *   generationHash: unknown,
 *   batchEncodingVersion: unknown,
 *   text: unknown,
 * }} input
 * @returns {Promise<string>} `cache:v3:<64 位十六进制>`
 */
export async function buildCacheKey(input = {}) {
  const keyVersion = requireField('keyVersion', input.keyVersion ?? CACHE_KEY_VERSION);
  const engineType = requireField('engineType', input.engineType);
  const endpointFingerprint = requireField('endpointFingerprint', input.endpointFingerprint);
  const model = requireField('model', input.model);
  const targetLang = requireField('targetLang', input.targetLang);
  const promptVersion = requireField('promptVersion', input.promptVersion);
  const promptHash = requireField('promptHash', input.promptHash);
  const generationHash = requireField('generationHash', input.generationHash);
  const batchEncodingVersion = requireField('batchEncodingVersion', input.batchEncodingVersion);
  const text = requireField('text', input.text);
  const sourceLang =
    typeof input.sourceLang === 'string' && input.sourceLang.trim() !== ''
      ? input.sourceLang
      : 'auto';

  const parts = [
    keyVersion,
    engineType,
    endpointFingerprint,
    model,
    sourceLang,
    targetLang,
    promptVersion,
    promptHash,
    generationHash,
    batchEncodingVersion,
    text,
  ].map((part) => String(part));

  const payload = JSON.stringify(parts);
  const subtle = globalThis.crypto?.subtle;
  if (!subtle || typeof subtle.digest !== 'function') {
    throw new TypeError('当前环境不支持 SHA-256，无法计算缓存 key');
  }

  const digest = await subtle.digest('SHA-256', new TextEncoder().encode(payload));
  return CACHE_KEY_PREFIX + toHex(digest);
}
