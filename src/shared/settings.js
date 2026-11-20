/**
 * E2 设置
 *
 * 模块：公共模块（E）/ E2
 * 职责：定义设置 schema v2、默认值、枚举归一与读写；提供密钥存放位置（keyStorage）的分区选择。
 * 依赖：E2 存储读写（storage.js）、语言目录（languages.js，P8-2 起）。
 * 实现阶段：P1（引擎层与密钥配置）；P8-2 升级 schema v2：增加 `configVersion`，
 *           移除默认 `concurrency`，语言改由共享目录校验，未知字段保留；
 *           P11 增加弹窗初始页 `popupDefaultTab`；P11 增加主题 `theme`；
 *           P12 增加悬停翻译快捷键 `hoverShortcut`。
 *
 * 每实例凭据、提示词与当前实例改选由 E3（config/instances.js）承担，因为需要实例 id。
 */

import { STORAGE_KEYS, read, write } from './storage.js';
import {
  DEFAULT_SOURCE_LANG,
  DEFAULT_TARGET_LANG,
  isSupportedSourceLang,
  isSupportedTargetLang,
} from './languages.js';
import { DEFAULT_HOVER_SHORTCUT, normalizeHoverShortcut } from './shortcut.js';

/** 当前设置 schema 版本；迁移完成后写入。 */
export const CONFIG_VERSION = 2;

/** 默认设置（完整编辑界面见 P8-3；这里定 schema 与默认值）。 */
export const DEFAULT_SETTINGS = Object.freeze({
  configVersion: CONFIG_VERSION,
  enabled: true, // 扩展总开关
  sourceLang: DEFAULT_SOURCE_LANG, // 源语言：auto / en
  targetLang: DEFAULT_TARGET_LANG, // 目标语言：zh / en / ja / ko
  keyStorage: 'local', // 凭据存放位置：local / sync
  cacheEnabled: true, // 译文缓存开关
  logLevel: 'info', // 日志级别：debug / info / warn / error / off
  activeInstanceId: null, // 当前生效实例 id
  popupDefaultTab: 'default', // 弹窗初始页：default / quick
  theme: 'system', // 界面主题：system / light / dark
  hoverShortcut: DEFAULT_HOVER_SHORTCUT, // 悬停翻译修饰键：ctrl / alt / shift / command
});

/** 弹窗初始页取值。 */
export const POPUP_DEFAULT_TABS = Object.freeze(['default', 'quick']);

/** 主题取值。 */
export const THEMES = Object.freeze(['system', 'light', 'dark']);

/**
 * 归一布尔值：只认真正的布尔与字符串 `'true'`/`'false'`，其余回退默认。
 * @param {unknown} value
 * @param {boolean} fallback
 * @returns {boolean}
 */
function normalizeBoolean(value, fallback) {
  if (typeof value === 'boolean') return value;
  if (value === 'true') return true;
  if (value === 'false') return false;
  return fallback;
}

/**
 * 归一 keyStorage 取值：只认 `sync`，其余一律 `local`。
 * @param {string} [value]
 * @returns {'local'|'sync'}
 */
export function normalizeKeyStorage(value) {
  return value === 'sync' ? 'sync' : 'local';
}

/**
 * 归一弹窗初始页：只认 `quick`，其余一律 `default`。
 * @param {unknown} value
 * @returns {'default'|'quick'}
 */
export function normalizePopupDefaultTab(value) {
  return value === 'quick' ? 'quick' : 'default';
}

/**
 * 归一主题：只认 `light` / `dark`，其余一律 `system`（跟随系统）。
 * @param {unknown} value
 * @returns {'system'|'light'|'dark'}
 */
export function normalizeTheme(value) {
  return value === 'light' || value === 'dark' ? value : 'system';
}

/**
 * 解析实际主题：`system` 时按系统暗色偏好，显式主题直接返回。
 * @param {unknown} theme
 * @param {boolean} prefersDark
 * @returns {'light'|'dark'}
 */
export function resolveTheme(theme, prefersDark) {
  const normalized = normalizeTheme(theme);
  if (normalized === 'system') return prefersDark ? 'dark' : 'light';
  return normalized;
}

/**
 * 归一设置：合并默认值、归一枚举与开关，保留未知字段。
 * 不写存储；`configVersion` 缺失时按默认 2 返回（迁移判定读原始存储）。
 * @param {unknown} raw
 * @returns {Record<string, unknown>}
 */
export function normalizeSettings(raw) {
  const source = raw && typeof raw === 'object' && !Array.isArray(raw) ? raw : {};
  const merged = { ...DEFAULT_SETTINGS, ...source };
  const version = Number(merged.configVersion);

  return {
    ...merged,
    configVersion: Number.isInteger(version) && version >= 0 ? version : CONFIG_VERSION,
    enabled: normalizeBoolean(merged.enabled, DEFAULT_SETTINGS.enabled),
    sourceLang: isSupportedSourceLang(merged.sourceLang)
      ? merged.sourceLang
      : DEFAULT_SETTINGS.sourceLang,
    targetLang: isSupportedTargetLang(merged.targetLang)
      ? merged.targetLang
      : DEFAULT_SETTINGS.targetLang,
    keyStorage: normalizeKeyStorage(merged.keyStorage),
    cacheEnabled: normalizeBoolean(merged.cacheEnabled, DEFAULT_SETTINGS.cacheEnabled),
    logLevel:
      typeof merged.logLevel === 'string' && merged.logLevel.trim() !== ''
        ? merged.logLevel
        : DEFAULT_SETTINGS.logLevel,
    activeInstanceId:
      typeof merged.activeInstanceId === 'string' && merged.activeInstanceId.trim() !== ''
        ? merged.activeInstanceId
        : null,
    popupDefaultTab: normalizePopupDefaultTab(merged.popupDefaultTab),
    theme: normalizeTheme(merged.theme),
    hoverShortcut: normalizeHoverShortcut(merged.hoverShortcut),
  };
}

/**
 * 读取普通设置并与默认值合并，缺字段补默认、不丢未知字段。
 * @returns {Promise<Record<string, unknown>>}
 */
export async function getSettings() {
  const data = await read('sync', STORAGE_KEYS.settings);
  return normalizeSettings(data[STORAGE_KEYS.settings]);
}

/**
 * 合并保存普通设置，返回保存后的完整设置。
 * @param {Record<string, unknown>} partial
 * @returns {Promise<Record<string, unknown>>}
 */
export async function saveSettings(partial) {
  const next = normalizeSettings({ ...(await getSettings()), ...partial });
  await write('sync', { [STORAGE_KEYS.settings]: next });
  return next;
}

/**
 * 按当前 keyStorage 归一结果返回凭据存放分区。
 * @returns {Promise<'local'|'sync'>}
 */
export async function keyArea() {
  const settings = await getSettings();
  return normalizeKeyStorage(settings.keyStorage);
}
