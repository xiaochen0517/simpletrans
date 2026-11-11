/**
 * 用户设置
 *
 * - 非敏感设置存 `chrome.storage.sync`（跨设备同步）；
 * - API Key 的存放位置由用户选择（`keyStorage`）：默认 `local`，可切 `sync`；
 *   两个区域都只在 Background 读取，切换时迁移并清除旧位置。
 *
 * @see docs/demand/20261111-02-插件架构设计与选型.md §5.8
 */

import { AREA, readArea, removeAreaKeys, writeArea } from './storage.js';

/** 密钥字段名（历史字段，保持不变以兼容旧数据）。 */
export const SECRET_FIELD = 'deepseekApiKey';

/** 非敏感设置默认值。`keyStorage` 是唯一会写回 sync 的“位置类”设置。 */
export const DEFAULT_SETTINGS = Object.freeze({
  enabled: true,
  targetLang: 'zh-CN',
  keyStorage: AREA.LOCAL,
  concurrency: 3,
  cacheEnabled: true,
});

const SETTING_KEYS = Object.keys(DEFAULT_SETTINGS);

/**
 * @param {unknown} value
 * @returns {'local' | 'sync'}
 */
function normalizeKeyStorage(value) {
  return value === AREA.SYNC ? AREA.SYNC : AREA.LOCAL;
}

/**
 * @param {Record<string, unknown>} raw
 */
function pickSettings(raw) {
  /** @type {Record<string, unknown>} */
  const picked = {};
  for (const key of SETTING_KEYS) {
    if (raw[key] !== undefined) picked[key] = raw[key];
  }
  picked.keyStorage = normalizeKeyStorage(picked.keyStorage);
  return picked;
}

/**
 * 读取当前密钥存放区域。
 * @returns {Promise<'local' | 'sync'>}
 */
export async function getKeyStorage() {
  const { keyStorage } = await readArea(AREA.SYNC, { keyStorage: DEFAULT_SETTINGS.keyStorage });
  return normalizeKeyStorage(keyStorage);
}

/**
 * 读取 API Key。旧版本把密钥存在 sync，这里做一次惰性迁移。
 * @returns {Promise<string>}
 */
export async function getApiKey() {
  const preferred = await getKeyStorage();
  const current = await readArea(preferred, { [SECRET_FIELD]: '' });
  if (current[SECRET_FIELD]) return String(current[SECRET_FIELD]);

  if (preferred !== AREA.SYNC) {
    const legacy = await readArea(AREA.SYNC, { [SECRET_FIELD]: '' });
    if (legacy[SECRET_FIELD]) {
      const value = String(legacy[SECRET_FIELD]);
      await writeArea(preferred, { [SECRET_FIELD]: value });
      await removeAreaKeys(AREA.SYNC, [SECRET_FIELD]);
      return value;
    }
  }
  return '';
}

/**
 * 读取非敏感设置（Popup / 任务层使用）。**永不返回密钥**。
 */
export async function getPublicSettings() {
  const raw = await readArea(AREA.SYNC, DEFAULT_SETTINGS);
  return { ...DEFAULT_SETTINGS, ...pickSettings(raw) };
}

/**
 * 读取全部设置（含密钥，供设置页使用；其它页面不要调用）。
 */
export async function getSettings() {
  const settings = await getPublicSettings();
  const apiKey = await getApiKey();
  return { ...settings, [SECRET_FIELD]: apiKey };
}

/**
 * 写入设置。可同时包含 `keyStorage` 与密钥，内部按正确顺序迁移。
 * @param {Record<string, unknown>} patch
 */
export async function saveSettings(patch = {}) {
  /** @type {Record<string, unknown>} */
  const plain = {};
  for (const key of SETTING_KEYS) {
    if (key === 'keyStorage') continue;
    if (patch[key] !== undefined) plain[key] = patch[key];
  }

  if (patch.keyStorage !== undefined) {
    await setKeyStorage(patch.keyStorage);
  }
  if (patch[SECRET_FIELD] !== undefined) {
    await setApiKey(patch[SECRET_FIELD]);
  }
  if (Object.keys(plain).length > 0) {
    await writeArea(AREA.SYNC, plain);
  }
}

/**
 * 切换密钥存放区域：写入新区域、清除其它区域，最后记录选择。
 * @param {'local' | 'sync'} target
 */
export async function setKeyStorage(target) {
  const next = normalizeKeyStorage(target);
  const previous = await getKeyStorage();
  const source = next === previous ? next : previous;
  const { [SECRET_FIELD]: existing } = await readArea(source, { [SECRET_FIELD]: '' });

  const value = existing == null ? '' : String(existing);
  await writeArea(next, { [SECRET_FIELD]: value });

  const other = next === AREA.SYNC ? AREA.LOCAL : AREA.SYNC;
  await removeAreaKeys(other, [SECRET_FIELD]);
  if (next !== previous) await removeAreaKeys(previous, [SECRET_FIELD]);

  await writeArea(AREA.SYNC, { keyStorage: next });
}

/**
 * 写入 API Key 到指定区域（默认当前选择），并清除另一区域避免残留两份。
 * @param {string} value
 * @param {'local' | 'sync'} [storage]
 */
export async function setApiKey(value, storage) {
  const target = normalizeKeyStorage(storage ?? (await getKeyStorage()));
  await writeArea(target, { [SECRET_FIELD]: String(value ?? '') });
  const other = target === AREA.SYNC ? AREA.LOCAL : AREA.SYNC;
  await removeAreaKeys(other, [SECRET_FIELD]);
  return target;
}

/** 清除两个区域中的密钥。 */
export async function clearApiKey() {
  await removeAreaKeys(AREA.LOCAL, [SECRET_FIELD]);
  await removeAreaKeys(AREA.SYNC, [SECRET_FIELD]);
}

/**
 * 脱敏展示，例如 `sk-1***cdef`。
 * @param {string} key
 */
export function maskApiKey(key) {
  const value = String(key ?? '');
  if (value.length <= 8) return value ? '****' : '';
  return `${value.slice(0, 4)}****${value.slice(-4)}`;
}
