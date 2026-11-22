/**
 * 段落提取
 *
 * 模块：页面注入（D）/ D1
 * 职责：悬停时从指针所在元素向上找最近的文字宿主；整页翻译时按文档顺序枚举视口附近的段落级宿主，
 *       给宿主分配页面内唯一段落 id，供 D5 统一提交与结果回显。
 * 依赖：公共数值（MAX_PAGE_PARAGRAPHS / SCAN_CHUNK_SIZE）；日志由调用方经 E4 注入。
 *
 * 约束：不读 storage、不发消息、不直接调用 console（日志由调用方经 E4 输出）。
 *
 * 规则见 docs/modules/D-页面注入.md#d1-段落提取。
 */

import {
  MAX_PAGE_PARAGRAPHS,
  MAX_SEGMENT_CHARS,
  SCAN_CHUNK_SIZE,
  VIEWPORT_MARGIN_RATIO,
} from '../../shared/constants.js';

/** 宿主标记：值为段落 id（`h<实例标记>-<序号>`），由 D1 分配，同时作为结果帧的 `itemId`。 */
export const HOST_ATTR = 'data-st-host';

/** 译文容器标记：存在即表示该宿主有加载、流式、完成或失败显示。 */
export const TRANSLATION_ATTR = 'data-st-translation';

/** 页面显式声明不翻译的忽略标记（保留给后续规则扩展）。 */
export const IGNORE_ATTR = 'data-simpletrans-ignore';

/** SVG 命名空间：内嵌 SVG 的 `tagName` 为小写（`svg`），不能只按大写标签名判断。 */
const SVG_NAMESPACE = 'http://www.w3.org/2000/svg';

/** 整页扫描整棵子树跳过的标签：脚本、样式、媒体与表单值控件（按钮除外，按钮单独收集）。 */
const SCAN_SKIP_TAGS = new Set([
  'SCRIPT',
  'STYLE',
  'NOSCRIPT',
  'TEMPLATE',
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
]);

/**
 * 是否属于「整棵子树跳过」的标签（脚本、样式、媒体、表单值控件、内嵌 SVG）。
 * @param {Element} element
 * @returns {boolean}
 */
function isSkipTag(element) {
  if (SCAN_SKIP_TAGS.has(element.tagName)) return true;
  return element.namespaceURI === SVG_NAMESPACE;
}

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

/** 宿主 id 序号：只在当前 content 实例内递增。 */
let hostSequence = 0;

/** 段落 id 的实例标记长度：6 位 `[0-9a-z]`。 */
const INSTANCE_TAG_LENGTH = 6;

/**
 * 生成当前 content 实例的段落 id 标记：模块加载时执行一次。
 * 只用于让重复注入后的新 id 不与页面上遗留的旧 id 相撞，不用于安全用途。
 * @returns {string}
 */
function createInstanceTag() {
  let tag = '';
  while (tag.length < INSTANCE_TAG_LENGTH) {
    const chunk = Math.random().toString(36).slice(2);
    tag += chunk === '' ? '0' : chunk;
  }
  return tag.slice(0, INSTANCE_TAG_LENGTH);
}

/** 当前实例标记；同一页面里的旧 id 由 `data-st-host` 原样复用。 */
const INSTANCE_TAG = createInstanceTag();

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
    // 内嵌 SVG 的文字不参与段落文本；其 `tagName` 为小写，按命名空间判断。
    if (node.namespaceURI === SVG_NAMESPACE) continue;
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
  if (element.namespaceURI === SVG_NAMESPACE) return true;
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
 * 悬停范围候选：从指针基宿主开始，沿祖先收集可作为一个段落翻译的文字宿主。
 * 只读 DOM 与计算样式，不打段落 id、不改文本。
 * 祖先必须未跳过、未隐藏、没有块级子元素且自身文字可译；遇到第一个不满足的祖先即停止。
 * @param {Element} element 指针所在元素
 * @returns {Array<{ host: Element, text: string }>} 由小到大的候选；基宿主在索引 0
 */
export function collectHoverRange(element) {
  if (!element || element.nodeType !== 1) return [];
  const base = resolveAt(element);
  if (!base) return [];
  const doc = base.ownerDocument;
  if (!doc) return [];

  const ranges = [];
  let node = base;
  while (node && node !== doc.body && node !== doc.documentElement) {
    const isBase = node === base;
    if (!isBase && (isSkipped(node) || isHidden(node) || hasBlockChild(node))) break;
    const text = normalizeText(extractText(node));
    if (!text || !hasLetter(text)) break;
    if (!isBase && text.length > MAX_SEGMENT_CHARS) break;
    ranges.push({ host: node, text });
    node = node.parentElement;
  }
  return ranges;
}

/**
 * 分配或复用段落 id（`h<实例标记>-<序号>`）。同一宿主多次调用返回同一个 id。
 * @param {Element} element
 * @returns {string}
 */
export function ensureHost(element) {
  const existing = element.getAttribute?.(HOST_ATTR);
  if (existing) return existing;
  hostSequence += 1;
  const id = `h${INSTANCE_TAG}-${hostSequence}`;
  element.setAttribute(HOST_ATTR, id);
  return id;
}

/**
 * 元素矩形是否与当前视口相交；宽高都为 0 的元素（隐藏或空盒）视为不可见。
 * `marginRatio` 为视口上下各扩展的屏数，0 表示严格视口。
 * @param {Element} element
 * @param {number} [marginRatio]
 * @returns {boolean}
 */
export function isElementInViewport(element, marginRatio = 0) {
  if (!element || element.isConnected === false || typeof element.getBoundingClientRect !== 'function') {
    return false;
  }
  let rect;
  try {
    rect = element.getBoundingClientRect();
  } catch {
    return false;
  }
  if (!rect || (rect.width === 0 && rect.height === 0)) return false;
  const view = element.ownerDocument?.defaultView;
  const width = Number(view?.innerWidth ?? 0);
  const height = Number(view?.innerHeight ?? 0);
  const margin = height * (Number.isFinite(marginRatio) ? Math.max(0, marginRatio) : 0);
  return rect.bottom > -margin && rect.top < height + margin && rect.right > 0 && rect.left < width;
}

/**
 * 元素是否与「当前视口上下各半屏」相交。
 * @param {Element} element
 * @returns {boolean}
 */
export function isElementInNearViewport(element) {
  return isElementInViewport(element, VIEWPORT_MARGIN_RATIO);
}

/**
 * 默认为扫描让出主线程：优先 `requestIdleCallback`，不可用时退回 `setTimeout(0)`。
 * @returns {Promise<void>}
 */
function defaultYield() {
  if (typeof requestIdleCallback === 'function') {
    return new Promise((resolve) => {
      requestIdleCallback(() => resolve(), { timeout: 50 });
    });
  }
  return new Promise((resolve) => {
    setTimeout(resolve, 0);
  });
}

/**
 * 把子元素逆序压栈，弹出顺序即文档顺序。
 * @param {Element[]} stack
 * @param {Element} element
 */
function pushChildren(stack, element) {
  const children = element.children;
  if (!children) return;
  for (let index = children.length - 1; index >= 0; index -= 1) {
    stack.push(children[index]);
  }
}

/**
 * 宿主末尾是否已有译文容器（已翻译或已标记，不再重复收集）。
 * @param {Element} element
 * @returns {boolean}
 */
function hasTranslationChild(element) {
  const children = element.children;
  if (!children) return false;
  for (let index = 0; index < children.length; index += 1) {
    if (children[index].hasAttribute?.(TRANSLATION_ATTR)) return true;
  }
  return false;
}

/**
 * 元素自身是否被计算样式隐藏（祖先状态由遍历继承，不向上查找）。
 * @param {Element} element
 * @returns {boolean}
 */
function isHiddenSelf(element) {
  const style = computedStyle(element);
  if (!style) return false;
  if (style.display === 'none') return true;
  if (style.visibility === 'hidden' || style.visibility === 'collapse') return true;
  return false;
}

/**
 * 整页扫描是否整棵子树跳过：脚本/样式/媒体/表单值控件、页面声明不翻译、可编辑区、
 * 译文容器与已翻译宿主、隐藏内容。
 * @param {Element} element
 * @returns {boolean}
 */
function shouldSkipSubtree(element) {
  if (isSkipTag(element)) return true;
  if (element.hasAttribute?.(TRANSLATION_ATTR)) return true;
  if (element.hasAttribute?.('hidden')) return true;
  if (element.getAttribute?.('aria-hidden') === 'true') return true;
  if (String(element.getAttribute?.('translate') ?? '').toLowerCase() === 'no') return true;
  if (element.classList?.contains('notranslate')) return true;
  if (element.hasAttribute?.(IGNORE_ATTR)) return true;
  const editable = element.getAttribute?.('contenteditable');
  if (editable != null && editable !== 'false') return true;
  if (element.isContentEditable === true) return true;
  const role = element.getAttribute?.('role');
  if (role === 'textbox' || role === 'combobox') return true;
  if (hasTranslationChild(element)) return true;
  if (isHiddenSelf(element)) return true;
  return false;
}

/**
 * 折叠的 `<details>`：只处理它的 `summary`，其余内容不扫描。
 * @param {Element} element
 * @returns {Element | null}
 */
function closedDetailsSummary(element) {
  if (element.tagName !== 'DETAILS' || element.hasAttribute?.('open')) return null;
  for (const child of element.children) {
    if (child.tagName === 'SUMMARY') return child;
  }
  return null;
}

/**
 * 段落级宿主的文本：不含块级子元素、归一后非空且至少含一个字母；不满足返回空串。
 * @param {Element} element
 * @param {Document} doc
 * @returns {string}
 */
function paragraphText(element, doc) {
  if (element === doc.body || element === doc.documentElement) return '';
  if (hasBlockChild(element)) return '';
  const text = normalizeText(extractText(element));
  if (!text || !hasLetter(text)) return '';
  return text;
}

/**
 * 收集选中宿主内部的按钮：按钮文字不并入父段，按文档顺序单独成段。
 * @param {Element} host
 * @param {Array<{ index: number, text: string, host: Element }>} paragraphs
 * @param {{ limit: number, inViewport: (host: Element) => boolean }} options
 */
function collectButtons(host, paragraphs, { limit, inViewport }) {
  if (typeof host.querySelectorAll !== 'function') return;
  for (const button of host.querySelectorAll('button')) {
    if (paragraphs.length >= limit) break;
    if (shouldSkipSubtree(button) || hasBlockChild(button)) continue;
    if (!inViewport(button)) continue;
    const text = normalizeText(extractText(button));
    if (!text || !hasLetter(text)) continue;
    ensureHost(button);
    paragraphs.push({ index: paragraphs.length, text, host: button });
  }
}

/**
 * 枚举视口附近的段落：按文档顺序扫描，选出最外层可译文字宿主并分配段落 id。
 *
 * 只读 DOM 与计算样式；不改页面文字；给选中的宿主打 `data-st-host`。不做同文本合并：
 * 每个宿主就是一个段落，去重与分批属于后台。段落不携带上下文。
 *
 * @param {{
 *   root?: Element,
 *   maxParagraphs?: number,
 *   chunkSize?: number,
 *   inViewport?: (host: Element) => boolean,
 *   yieldToMain?: () => Promise<void>,
 *   logger?: { debug: Function, info: Function, warn: Function } | null,
 *   now?: () => number,
 * }} [options]
 * @returns {Promise<Array<{ index: number, text: string, host: Element }>>}
 */
export async function collectParagraphs({
  root,
  maxParagraphs = MAX_PAGE_PARAGRAPHS,
  chunkSize = SCAN_CHUNK_SIZE,
  inViewport = isElementInNearViewport,
  yieldToMain = defaultYield,
  logger = null,
  now = () => Date.now(),
} = {}) {
  const doc = root?.ownerDocument ?? (typeof document !== 'undefined' ? document : null);
  if (!doc || !doc.body) throw new Error('没有可用的页面文档');
  const scanRoot = root ?? doc.body;
  if (!scanRoot || scanRoot.nodeType !== 1) throw new Error('扫描根节点不可用');

  const limit =
    Number.isFinite(maxParagraphs) && maxParagraphs > 0
      ? Math.floor(maxParagraphs)
      : MAX_PAGE_PARAGRAPHS;
  const chunk =
    Number.isFinite(chunkSize) && chunkSize > 0 ? Math.floor(chunkSize) : SCAN_CHUNK_SIZE;
  const visible = typeof inViewport === 'function' ? inViewport : isElementInNearViewport;

  const startedAt = now();
  /** @type {Array<{ index: number, text: string, host: Element }>} */
  const paragraphs = [];
  const stack = [scanRoot];
  let skipped = 0;
  let limited = false;
  let sinceYield = 0;

  logger?.debug?.('scan.start', '开始整页扫描', {});

  while (stack.length > 0) {
    if (sinceYield >= chunk) {
      sinceYield = 0;
      await yieldToMain();
    }
    sinceYield += 1;

    const element = stack.pop();
    if (!element || element.nodeType !== 1) continue;

    try {
      if (shouldSkipSubtree(element)) {
        skipped += 1;
        continue;
      }
      const summary = closedDetailsSummary(element);
      if (summary) {
        stack.push(summary);
        skipped += 1;
        continue;
      }
      const text = paragraphText(element, doc);
      if (text) {
        if (paragraphs.length >= limit) {
          limited = true;
          break;
        }
        if (!visible(element)) {
          // 视口外的段落不收集，也不进入其后代（行内后代不可能比宿主更可见）。
          skipped += 1;
          continue;
        }
        ensureHost(element);
        paragraphs.push({ index: paragraphs.length, text, host: element });
        collectButtons(element, paragraphs, { limit, inViewport: visible });
        // 选中宿主后不再把它的后代作为独立段落。
        continue;
      }
      pushChildren(stack, element);
    } catch {
      skipped += 1;
      if (logger?.debug) {
        logger.debug('scan.error', '读取元素失败，已跳过', {
          tag: typeof element.tagName === 'string' ? element.tagName : null,
        });
      }
    }
  }

  logger?.info?.('scan.done', '整页扫描完成', {
    paragraphs: paragraphs.length,
    skipped,
    elapsedMs: Math.max(0, now() - startedAt),
  });
  if (limited) logger?.warn?.('scan.limit', '已达到单页段落上限，停止扫描', { max: limit });
  return paragraphs;
}
