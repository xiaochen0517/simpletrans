/**
 * A3 提示词模板
 *
 * 模块：后台服务（A）/ A3
 * 职责：提供默认 system 提示词模板、占位符校验与展开、单段/批量输出格式，以及提示词哈希（供 A4 缓存 key）。
 * 依赖：E3 引擎类型目录（默认模板、长度上限与占位符校验，P6.2 起）。
 * 实现阶段：P6.2（翻译实例参数配置）
 *
 * 提示词正文不进入日志；本模块只返回字符串与哈希，不读写存储、不调用引擎。
 */

import {
  DEFAULT_SYSTEM_PROMPT,
  isDefaultPrompt,
  MAX_PROMPT_CHARS,
  PROMPT_PLACEHOLDERS,
  validatePromptTemplate,
} from '../config/registry.js';

/** 提示词模板与输出格式的结构版本；模板结构、默认模板或语言显示名映射变化时递增。 */
export const PROMPT_VERSION = 2;

export {
  DEFAULT_SYSTEM_PROMPT,
  isDefaultPrompt,
  MAX_PROMPT_CHARS,
  PROMPT_PLACEHOLDERS,
  validatePromptTemplate,
};

/** 目标语言显示名（当前只有中文；多语言映射后续补充）。 */
export const LANG_NAMES = Object.freeze({ zh: '中文' });

/** 当前支持的目标语言。 */
export const SUPPORTED_TARGET_LANGS = Object.freeze(Object.keys(LANG_NAMES));

/**
 * 判断目标语言是否受支持。
 * @param {unknown} lang
 * @returns {boolean}
 */
export function isSupportedTargetLang(lang) {
  return typeof lang === 'string' && Object.hasOwn(LANG_NAMES, lang);
}

/** 程序提供的输出格式规则；用户模板不能修改这段内容。 */
export const OUTPUT_FORMATS = Object.freeze({
  single: '只输出译文本身，不要添加任何解释、前后缀、引号或 Markdown 代码块。',
  batch:
    '输入是 JSONL：每行一个 JSON 对象，含 id、text。' +
    '只输出 JSONL：每行一个 JSON 对象 {"id":"...","text":"译文"}；顺序不限，id 必须与输入一致；' +
    '不要输出解释、前后缀、Markdown 代码块或任何其它内容。',
});

/**
 * 取实际使用的模板：空值回退默认模板（旧实例或运行时缺字段）。
 * @param {unknown} template
 * @returns {string}
 */
function resolveTemplate(template) {
  const text = template == null ? '' : String(template);
  return text.trim() === '' ? DEFAULT_SYSTEM_PROMPT : text;
}

/**
 * 归一模板文本：去首尾空白、统一换行，供哈希使用。
 * @param {unknown} template
 * @returns {string}
 */
export function normalizePromptText(template) {
  return resolveTemplate(template).trim().replace(/\r\n?/g, '\n');
}

/**
 * 展开系统提示：替换 `{{targetLang}}` 与 `{{outputFormat}}`。
 * @param {{ targetLang?: string, template?: string, mode?: 'single'|'batch' }} [params]
 * @returns {string}
 */
export function buildSystemPrompt({ targetLang, template, mode = 'single' } = {}) {
  const lang = LANG_NAMES[targetLang] ?? targetLang ?? '目标语言';
  const outputFormat = OUTPUT_FORMATS[mode] ?? OUTPUT_FORMATS.single;
  return resolveTemplate(template)
    .replaceAll('{{targetLang}}', lang)
    .replaceAll('{{outputFormat}}', outputFormat)
    .trim();
}

/**
 * 计算提示词哈希：归一后做 SHA-256，返回小写十六进制。
 * 计算失败时抛错，由 A2 按「本批不参与缓存」降级。
 * @param {unknown} template
 * @returns {Promise<string>}
 */
export async function hashPrompt(template) {
  const normalized = normalizePromptText(template);
  const subtle = globalThis.crypto?.subtle;
  if (!subtle || typeof subtle.digest !== 'function') {
    throw new TypeError('当前环境不支持 SHA-256，无法计算提示词哈希');
  }
  const digest = await subtle.digest('SHA-256', new TextEncoder().encode(normalized));
  const bytes = new Uint8Array(digest);
  let out = '';
  for (const byte of bytes) out += byte.toString(16).padStart(2, '0');
  return out;
}
