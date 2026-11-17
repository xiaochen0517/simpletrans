/**
 * 语言目录
 *
 * 模块：公共模块（E）/ 语言目录
 * 职责：定义源/目标语言枚举、显示名与百度翻译语言码，供设置、提示词、网关、弹窗与设置页共享。
 * 依赖：无（P8-2 起）。
 * 实现阶段：P8-2（设置数据规范化、多实例与百度翻译）
 *
 * 纯数据与纯函数，可被页面注入以外的前端/后台模块引用；不含服务商地址与密钥。
 */

/** 自动识别源语言。 */
export const AUTO_LANG = 'auto';

/** 语言显示名（含自动识别，故源/目标共用一张表）。 */
export const LANGUAGES = Object.freeze({
  auto: '自动检测',
  zh: '中文',
  en: '英语',
  ja: '日语',
  ko: '韩语',
});

/** 允许的源语言。 */
export const SOURCE_LANGS = Object.freeze([AUTO_LANG, 'en']);

/** 允许的目标语言。 */
export const TARGET_LANGS = Object.freeze(['zh', 'en', 'ja', 'ko']);

/** 默认源语言。 */
export const DEFAULT_SOURCE_LANG = AUTO_LANG;

/** 默认目标语言。 */
export const DEFAULT_TARGET_LANG = 'zh';

/**
 * 判断源语言是否受支持。
 * @param {unknown} value
 * @returns {boolean}
 */
export function isSupportedSourceLang(value) {
  return typeof value === 'string' && SOURCE_LANGS.includes(value);
}

/**
 * 判断目标语言是否受支持。
 * @param {unknown} value
 * @returns {boolean}
 */
export function isSupportedTargetLang(value) {
  return typeof value === 'string' && TARGET_LANGS.includes(value);
}

/**
 * 取语言显示名；未知语言返回空串。
 * @param {unknown} value
 * @returns {string}
 */
export function languageLabel(value) {
  return typeof value === 'string' && Object.hasOwn(LANGUAGES, value) ? LANGUAGES[value] : '';
}

/** 百度翻译语言码；`ja` 映射为 `jp`、`ko` 映射为 `kor`。 */
export const BAIDU_LANG_CODES = Object.freeze({
  auto: 'auto',
  zh: 'zh',
  en: 'en',
  ja: 'jp',
  ko: 'kor',
});

/**
 * 取百度翻译语言码；不支持的语言返回 null。
 * @param {unknown} value
 * @returns {string | null}
 */
export function toBaiduLang(value) {
  return typeof value === 'string' && Object.hasOwn(BAIDU_LANG_CODES, value)
    ? BAIDU_LANG_CODES[value]
    : null;
}
