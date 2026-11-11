/**
 * Provider 无关的翻译契约
 *
 * 具体实现（DeepSeek）在 deepseek.js；Background 只依赖本文件的提示词与输出
 * 归一化逻辑，便于后续替换/新增 provider。
 */

export const LANG_NAMES = Object.freeze({
  'zh-CN': '简体中文',
  zh: '简体中文',
  en: 'English',
  ja: '日本語',
  ko: '한국어',
});

/**
 * @param {string} lang BCP-47
 */
export function targetLangName(lang) {
  return LANG_NAMES[lang] ?? String(lang ?? '');
}

/**
 * 构造段级翻译的系统提示词。
 * 上下文只用于消歧，不允许模型输出上下文内容。
 *
 * @param {string} targetLang
 * @param {{ title?: string, prev?: string }} [ctx]
 */
export function buildSystemPrompt(targetLang, ctx) {
  const name = targetLangName(targetLang);
  const lines = [
    `你是一个专业的网页翻译引擎，请把用户提供的这段文本翻译为${name}。`,
    '要求：',
    '1. 只输出译文本身，不要解释、不要引号、不要重复原文；',
    '2. 保留原文中的专有名词、代码、数字与符号；',
    '3. 不要输出 Markdown 标记或注释。',
  ];
  if (ctx?.title) lines.push(`页面标题（仅用于理解上下文，不要翻译或输出）：${ctx.title}`);
  if (ctx?.prev) lines.push(`上一段原文（仅用于理解上下文，不要翻译或输出）：${ctx.prev}`);
  return lines.join('\n');
}

/**
 * 归一化模型输出：去掉首尾空白与偶发的代码围栏。
 * @param {string} text
 */
export function normalizeOutput(text) {
  return String(text ?? '')
    .replace(/^```[a-zA-Z]*\s*\n?/, '')
    .replace(/\n?```\s*$/, '')
    .trim();
}
