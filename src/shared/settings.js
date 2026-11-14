/**
 * E2 设置与密钥
 *
 * 模块：公共模块（E）/ E2
 * 职责：定义默认设置与密钥存放位置（keyStorage）的归一；读写普通设置。
 * 依赖：E2 存储读写（storage.js，P1 起）。
 * 实现阶段：P1（引擎层与密钥配置）
 *
 * 密钥的「键名 + 读写 + 公开/完整设置」由 E3（config/instances.js）承担，因为需要实例 id。
 * 这里只提供 keyStorage 归一与存储分区选择。
 */

import { STORAGE_KEYS, read, write } from './storage.js';

/** 默认设置（完整编辑界面留 P7，这里先定 schema 与默认值）。 */
export const DEFAULT_SETTINGS = Object.freeze({
  enabled: true, // 扩展总开关
  targetLang: 'zh', // 目标语言（P1 固定中文）
  sourceLang: 'auto', // 源语言（P1 固定 auto，智能识别延后）
  keyStorage: 'local', // 密钥存放位置：local / sync
  cacheEnabled: true, // 译文缓存开关（P4 生效）
  concurrency: 3, // 用户并发数（P2 生效）
});

/**
 * 归一 keyStorage 取值：只认 `sync`，其余一律 `local`。
 * @param {string} [value]
 * @returns {'local'|'sync'}
 */
export function normalizeKeyStorage(value) {
  return value === 'sync' ? 'sync' : 'local';
}

/**
 * 读取普通设置并与默认值合并，缺字段补默认、不丢未知字段。
 * @returns {Promise<Record<string, unknown>>}
 */
export async function getSettings() {
  const data = await read('sync', STORAGE_KEYS.settings);
  const stored = data[STORAGE_KEYS.settings];
  return { ...DEFAULT_SETTINGS, ...(stored && typeof stored === 'object' ? stored : {}) };
}

/**
 * 合并保存普通设置，返回保存后的完整设置。
 * @param {Record<string, unknown>} partial
 * @returns {Promise<Record<string, unknown>>}
 */
export async function saveSettings(partial) {
  const next = { ...(await getSettings()), ...partial };
  await write('sync', { [STORAGE_KEYS.settings]: next });
  return next;
}

/**
 * 按当前 keyStorage 归一结果返回密钥存放分区。
 * @returns {Promise<'local'|'sync'>}
 */
export async function keyArea() {
  const settings = await getSettings();
  return normalizeKeyStorage(settings.keyStorage);
}
