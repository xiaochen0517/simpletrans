/**
 * 段落提取
 *
 * 模块：页面注入（D）/ D1
 * 职责：从指针所在元素向上找最近的文字宿主（任意标签，含 span、button 等行内/交互标签），归一文本并登记宿主。
 * 依赖：无（纯 DOM 逻辑，P4 起）。
 * 实现阶段：P4（段落提取、悬停锚定与译文渲染）
 *
 * 约束：不读 storage、不发消息、不直接调用 console（日志由调用方经 E4 输出）。
 */

/** 宿主标记：值为 h1、h2…，由 D1 分配。 */
export const HOST_ATTR = 'data-st-host';

/** 译文容器标记：存在即表示该宿主有加载、流式、完成或失败显示。 */
export const TRANSLATION_ATTR = 'data-st-translation';

/** 页面显式声明不翻译的忽略标记（保留给后续规则扩展）。 */
export const IGNORE_ATTR = 'data-simpletrans-ignore';

/** 指针落在其中时不触发翻译、也不向上找宿主的表单与编辑控件。 */
const FORM_CONTROL_TAGS = new Set(['INPUT', 'TEXTAREA', 'SELECT', 'OPTION', 'OPTGROUP']);

/** 提取宿主文本时整体跳过的子树：脚本、样式、媒体、表单控件与按钮（按钮自身作为宿主时除外）。 */
const TEXT_SKIP_TAGS = new Set([
  'SCRIPT',
  'STYLE',
  'NOSCRIPT',
  'TEMPLATE',
  'SVG',
  'CANVAS',
  'IFRAME',
  'OBJECT',
  'EMBED',
  'VIDEO',
  'AUDIO',
  'INPUT',
  'TEXTAREA',
  'SELECT',
  'OPTION',
  'OPTGROUP',
  'BUTTON',
]);

/** 计算样式为这些值时，子元素不算块级（不影响段落成段）。 */
const INLINE_DISPLAYS = new Set([
  'inline',
  'inline-block',
  'inline-flex',
  'inline-grid',
  'inline-table',
  'contents',
  'none',
  'ruby',
  'ruby-base',
  'ruby-text',
]);

/** 宿主的计算样式为这些块级容器时，译文另起一行（<br>）。 */
const BLOCK_DISPLAYS = new Set([
  'block',
  'flow-root',
  'list-item',
  'table',
  'table-caption',
  'table-cell',
  'table-row',
  'table-row-group',
  'table-header-group',
  'table-footer-group',
  'flex',
  'grid',
]);

/** 计算样式不可用时，按标签兜底判断块级。 */
const BLOCK_TAGS = new Set([
  'ADDRESS',
  'ARTICLE',
  'ASIDE',
  'BLOCKQUOTE',
  'CAPTION',
  'DD',
  'DETAILS',
  'DIV',
  'DL',
  'DT',
  'FIELDSET',
  'FIGCAPTION',
  'FIGURE',
  'FOOTER',
  'FORM',
  'H1',
  'H2',
  'H3',
  'H4',
  'H5',
  'H6',
  'HEADER',
  'HR',
  'LI',
  'MAIN',
  'NAV',
  'OL',
  'P',
  'PRE',
  'SECTION',
  'SUMMARY',
  'TABLE',
  'TBODY',
  'TD',
  'TFOOT',
  'TH',
  'THEAD',
  'TR',
  'UL',
]);

/** 指针落在这些元素内时，不向上找段落。 */
const POINTER_BLOCKED_SELECTOR = [
  'input',
  'textarea',
  'select',
  'option',
  'optgroup',
  '[contenteditable=""]',
  '[contenteditable="true"]',
  '[contenteditable="plaintext-only"]',
  '[role="textbox"]',
  '[role="combobox"]',
].join(',');

/** 页面声明不翻译的区域。 */
const NO_TRANSLATE_SELECTOR = `[translate="no"], .notranslate, [${IGNORE_ATTR}]`;

/** 宿主 id 序号：只在当前页面生命周期内递增。 */
let hostSequence = 0;

/**
 * 读取计算样式；不可用时返回 null。
 * @param {Element} element
 * @returns {CSSStyleDeclaration | null}
 */
function computedStyle(element) {
  try {
    const view = element.ownerDocument?.defaultView;
    return view?.getComputedStyle?.(element) ?? null;
  } catch {
    return null;
  }
}

/**
 * 归一文本：去零宽字符，连续空白合并为一个空格，首尾去空白。
 * @param {unknown} value
 * @returns {string}
 */
export function normalizeText(value) {
  return String(value ?? '')
    .replace(/[\u200B-\u200D\uFEFF]/g, '')
    .replace(/\s+/g, ' ')
    .trim();
}

/**
 * 文本是否至少包含一个 Unicode 字母（纯数字、符号、emoji 不翻译）。
 * @param {string} text
 * @returns {boolean}
 */
export function hasLetter(text) {
  return /\p{L}/u.test(text);
}

/**
 * 元素的子元素是否构成块级布局（用于判断容器是否已经包含块级结构）。
 * @param {Element} element
 * @returns {boolean}
 */
function hasBlockChild(element) {
  for (const child of element.children) {
    // 译文容器固定为行内 font，不参与宿主是否含块级子元素的判定。
    if (child.hasAttribute?.(TRANSLATION_ATTR)) continue;
    const display = computedStyle(child)?.display;
    if (display) {
      if (!INLINE_DISPLAYS.has(display)) return true;
      continue;
    }
    if (BLOCK_TAGS.has(child.tagName)) return true;
  }
  return false;
}

/**
 * 提取段落文本：排除译文容器、脚本/样式/媒体子树与表单控件、按钮文字。
 * @param {Element} element
 * @returns {string}
 */
export function extractText(element) {
  const parts = [];
  const stack = [element];
  while (stack.length > 0) {
    const node = stack.pop();
    if (!node) continue;
    if (node.nodeType === 3) {
      parts.push(node.nodeValue ?? '');
      continue;
    }
    if (node.nodeType !== 1) continue;
    if (node.hasAttribute?.(TRANSLATION_ATTR)) continue;
    // 按钮自身作为宿主时提取其文字；作为其它宿主的后代时仍跳过，避免按钮标签混入正文。
    if (TEXT_SKIP_TAGS.has(node.tagName) && !(node === element && node.tagName === 'BUTTON')) continue;
    const children = node.childNodes;
    for (let index = children.length - 1; index >= 0; index -= 1) {
      stack.push(children[index]);
    }
  }
  return parts.join('');
}

/**
 * 元素是否命中页面声明的不翻译区域。
 * @param {Element} element
 * @returns {boolean}
 */
function isNoTranslate(element) {
  return Boolean(element.closest?.(NO_TRANSLATE_SELECTOR));
}

/**
 * 元素是否属于应整段跳过的标签或交互控件。
 * @param {Element} element
 * @returns {boolean}
 */
export function isSkipped(element) {
  if (!element || element.nodeType !== 1) return true;
  if (FORM_CONTROL_TAGS.has(element.tagName)) return true;
  const role = element.getAttribute?.('role');
  if (role === 'textbox' || role === 'combobox') return true;
  if (element.isContentEditable) return true;
  const editable = element.getAttribute?.('contenteditable');
  if (editable != null && editable !== 'false') return true;
  if (isNoTranslate(element)) return true;
  return false;
}

/**
 * 元素是否被隐藏（自身或祖先）。
 * @param {Element} element
 * @returns {boolean}
 */
export function isHidden(element) {
  if (!element || element.nodeType !== 1) return true;
  if (element.closest?.('[hidden], [aria-hidden="true"]')) return true;

  const closedDetails = element.closest?.('details:not([open])');
  if (closedDetails) {
    const summary = element.closest?.('summary');
    if (!summary || summary.parentElement !== closedDetails) return true;
  }

  for (let node = element; node && node.nodeType === 1; node = node.parentElement) {
    const style = computedStyle(node);
    if (!style) continue;
    if (style.display === 'none') return true;
    if (style.visibility === 'hidden' || style.visibility === 'collapse') return true;
  }
  return false;
}

/**
 * 指针是否落在不应触发翻译的元素内。
 * @param {Element} element
 * @returns {boolean}
 */
function isPointerBlocked(element) {
  if (!element || element.nodeType !== 1) return true;
  if (element.closest?.(POINTER_BLOCKED_SELECTOR)) return true;
  return isNoTranslate(element);
}

/**
 * 宿主是否按块级布局排列：D3 用来选择 <br> 换行还是 &nbsp;&nbsp; 分隔。
 * 以计算样式为准，标签名只在计算样式不可用时兜底；display:contents 向上取实际布局。
 * @param {Element} host
 * @returns {boolean}
 */
export function isBlockHost(host) {
  for (let node = host; node && node.nodeType === 1; node = node.parentElement) {
    const display = computedStyle(node)?.display;
    if (!display || display === 'contents') continue;
    return BLOCK_DISPLAYS.has(display);
  }
  return BLOCK_TAGS.has(host.tagName);
}

/**
 * 从元素向上找最近的文字宿主。任意标签都可作为宿主，包括 span、a、button、code 等；
 * 宿主需要自身有可译文字，且不含块级子元素（否则文字属于更深层的块）。
 * @param {Element} element
 * @returns {Element | null}
 */
export function findContainer(element) {
  const doc = element?.ownerDocument;
  if (!doc) return null;
  for (let node = element; node && node !== doc.body && node !== doc.documentElement; node = node.parentElement) {
    if (node.nodeType !== 1) continue;
    if (isSkipped(node) || isHidden(node)) return null;
    if (hasBlockChild(node)) continue;
    const text = normalizeText(extractText(node));
    if (!text || !hasLetter(text)) continue;
    return node;
  }
  return null;
}

/**
 * 把指针元素解析为宿主：译文容器归到 data-st-for 指向的宿主；
 * 指针落在表单/编辑控件内时不向上找宿主，按钮、代码等标签正常参与。
 * @param {Element} element
 * @returns {Element | null}
 */
export function resolveAt(element) {
  if (!element || element.nodeType !== 1) return null;
  const doc = element.ownerDocument;

  const translation = element.closest?.(`[${TRANSLATION_ATTR}]`);
  if (translation) {
    const hostId = translation.getAttribute('data-st-for');
    if (!hostId || !doc) return null;
    return doc.querySelector(`[${HOST_ATTR}="${hostId}"]`);
  }

  if (isPointerBlocked(element)) return null;

  const registered = element.closest?.(`[${HOST_ATTR}]`);
  if (registered) return registered;

  return findContainer(element);
}

/**
 * 分配或复用宿主 id（h1、h2…）。
 * @param {Element} element
 * @returns {string}
 */
export function ensureHost(element) {
  const existing = element.getAttribute?.(HOST_ATTR);
  if (existing) return existing;
  hostSequence += 1;
  const id = `h${hostSequence}`;
  element.setAttribute(HOST_ATTR, id);
  return id;
}
