// @vitest-environment jsdom
/**
 * D1 段落提取测试
 *
 * 用 jsdom 验证容器判定、跳过规则、文本归一、译文到宿主的映射（P4 契约不变），
 * 以及 P6.1 的视口段落枚举：文档顺序、最外层宿主、按钮单独成段、跳过规则、
 * 只收集视口内段落、不做同文本合并、页面内唯一段落 id、5000 上限、分片让出与日志。
 * 段落不再携带上下文。不加载真实 chrome，不联网。
 */

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import {
  HOST_ATTR,
  TRANSLATION_ATTR,
  collectParagraphs,
  ensureHost,
  extractText,
  findContainer,
  hasLetter,
  isBlockHost,
  isElementInViewport,
  isElementInNearViewport,
  isHidden,
  isSkipped,
  normalizeText,
  resolveAt,
} from '../../src/content/dom/scanner.js';
import { MAX_PAGE_PARAGRAPHS } from '../../src/shared/constants.js';

/**
 * @param {string} html
 * @returns {Element}
 */
function mount(html) {
  document.body.innerHTML = html;
  return document.body;
}

beforeEach(() => {
  vi.useFakeTimers();
  document.head.innerHTML = '';
  document.body.innerHTML = '';
  window.innerWidth = 1000;
  window.innerHeight = 800;
});

afterEach(() => {
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
  vi.useRealTimers();
});

/** 段落 id 的形状：h + 6 位实例标记 + - + 序号。 */
const HOST_ID_PATTERN = /^h[a-z0-9]{6}-\d+$/;

describe('D1 文本归一', () => {
  it('去掉零宽字符，合并空白并去首尾空白', () => {
    expect(normalizeText('  Hello\u200b\n\t world  ')).toBe('Hello world');
    expect(normalizeText('\uFEFF')).toBe('');
    expect(normalizeText(null)).toBe('');
  });

  it('至少包含一个字母才算可译文本', () => {
    expect(hasLetter('Hello')).toBe(true);
    expect(hasLetter('中文')).toBe(true);
    expect(hasLetter('123 !!! 😀')).toBe(false);
  });
});

describe('D1 容器判定', () => {
  it('指针在行内元素上时归到该行内元素（最近的文字标签）', () => {
    mount('<p id="p">Hello <strong id="strong">world</strong></p>');
    expect(resolveAt(document.getElementById('strong'))).toBe(document.getElementById('strong'));
    expect(resolveAt(document.getElementById('p'))).toBe(document.getElementById('p'));
  });

  it('span 与 button 都可以作为宿主', () => {
    mount('<p><span id="span">Hello</span><button id="button">Go</button></p>');
    expect(resolveAt(document.getElementById('span'))).toBe(document.getElementById('span'));
    expect(resolveAt(document.getElementById('button'))).toBe(document.getElementById('button'));
  });

  it('只有行内内容的 div 可以成为段落', () => {
    mount('<div id="d">Hello <em>world</em></div>');
    expect(resolveAt(document.getElementById('d'))).toBe(document.getElementById('d'));
  });

  it('包含块级子元素的 div 不成为段落，内部 p 才是', () => {
    mount('<div id="outer"><p id="p">Hello</p></div>');
    expect(resolveAt(document.getElementById('p'))).toBe(document.getElementById('p'));
    expect(resolveAt(document.getElementById('outer'))).toBe(null);
  });

  it('列表项与表格单元格可以成为段落', () => {
    mount('<ul><li id="li">Item text</li></ul><table><tbody><tr><td id="td">Cell text</td></tr></tbody></table>');
    expect(resolveAt(document.getElementById('li'))).toBe(document.getElementById('li'));
    expect(resolveAt(document.getElementById('td'))).toBe(document.getElementById('td'));
  });

  it('纯数字、符号与空白不成段', () => {
    mount('<p id="num">12345</p><p id="sym">!!!</p><p id="empty">   </p>');
    expect(resolveAt(document.getElementById('num'))).toBe(null);
    expect(resolveAt(document.getElementById('sym'))).toBe(null);
    expect(resolveAt(document.getElementById('empty'))).toBe(null);
  });

  it('文本提取排除脚本、样式、表单控件与按钮，保留行内代码', () => {
    mount(
      '<p id="p">Use <code>npm</code> <button>Go</button><script>bad()</script><span>now</span></p>'
    );
    expect(normalizeText(extractText(document.getElementById('p')))).toBe('Use npm now');
  });
});

describe('D1 跳过规则', () => {
  it('表单控件与可编辑区跳过，按钮与代码可以翻译', () => {
    mount(
      '<div><button id="button">Go</button><input id="input" value="x" />' +
        '<div id="editable" contenteditable="true">Edit</div>' +
        '<pre><code id="code">const a = 1</code></pre></div>'
    );
    expect(resolveAt(document.getElementById('button'))).toBe(document.getElementById('button'));
    expect(resolveAt(document.getElementById('input'))).toBe(null);
    expect(resolveAt(document.getElementById('editable'))).toBe(null);
    expect(resolveAt(document.getElementById('code'))).toBe(document.getElementById('code'));
    expect(isSkipped(document.getElementById('button'))).toBe(false);
    expect(isSkipped(document.getElementById('input'))).toBe(true);
    expect(isSkipped(document.getElementById('editable'))).toBe(true);
  });

  it('指针在按钮上时按钮自身成为宿主，不把周围正文当成按钮的段落', () => {
    mount('<div id="card">Some text <button id="button">Go</button></div>');
    expect(resolveAt(document.querySelector('#card button'))).toBe(document.querySelector('#card button'));
    expect(resolveAt(document.getElementById('card'))).toBe(document.getElementById('card'));
  });

  it('跳过隐藏、aria-hidden、折叠 details 与 translate=no', () => {
    mount(
      '<p id="none" style="display:none">Hidden</p>' +
        '<p id="aria" aria-hidden="true">Hidden</p>' +
        '<details><summary id="summary">Title</summary><p id="folded">Body</p></details>' +
        '<p id="notranslate" translate="no">Keep</p>'
    );
    expect(resolveAt(document.getElementById('none'))).toBe(null);
    expect(resolveAt(document.getElementById('aria'))).toBe(null);
    expect(resolveAt(document.getElementById('folded'))).toBe(null);
    expect(resolveAt(document.getElementById('summary'))).toBe(document.getElementById('summary'));
    expect(resolveAt(document.getElementById('notranslate'))).toBe(null);
    expect(isHidden(document.getElementById('none'))).toBe(true);
  });

  it('展开的 details 内容可以翻译', () => {
    mount('<details open><summary>Title</summary><p id="body">Body text</p></details>');
    expect(resolveAt(document.getElementById('body'))).toBe(document.getElementById('body'));
  });
});

describe('D1 宿主登记与译文映射', () => {
  it('ensureHost 复用同一个 id，并生成带实例前缀的段落 id', () => {
    mount('<p id="p">Hello</p>');
    const p = document.getElementById('p');
    const first = ensureHost(p);
    const second = ensureHost(p);
    expect(first).toBe(second);
    expect(p.getAttribute(HOST_ATTR)).toBe(first);
    expect(first).toMatch(HOST_ID_PATTERN);
  });

  it('不同 content 实例的段落 id 前缀不同，页面上遗留的旧 id 原样复用', async () => {
    mount('<p id="old">Old text</p><p id="a">A</p><p id="b">B</p>');
    const oldHost = document.getElementById('old');
    oldHost.setAttribute(HOST_ATTR, 'hlegacy1');

    vi.spyOn(Math, 'random').mockReturnValue(0.5);
    vi.resetModules();
    const first = await import('../../src/content/dom/scanner.js');
    const firstId = first.ensureHost(document.getElementById('a'));
    expect(firstId).toMatch(HOST_ID_PATTERN);

    vi.spyOn(Math, 'random').mockReturnValue(0.25);
    vi.resetModules();
    const second = await import('../../src/content/dom/scanner.js');
    const secondId = second.ensureHost(document.getElementById('b'));

    expect(secondId).toMatch(HOST_ID_PATTERN);
    expect(secondId).not.toBe(firstId);
    expect(second.ensureHost(oldHost)).toBe('hlegacy1');
  });

  it('指针落在译文容器上时归到 data-st-for 指向的宿主', () => {
    mount('<p id="p">Hello</p>');
    const p = document.getElementById('p');
    const id = ensureHost(p);
    const translation = document.createElement('font');
    translation.setAttribute(TRANSLATION_ATTR, '');
    translation.setAttribute('data-st-for', id);
    const text = document.createElement('font');
    text.textContent = '你好';
    translation.append(document.createElement('br'), text);
    p.appendChild(translation);

    expect(resolveAt(translation)).toBe(p);
    expect(resolveAt(text)).toBe(p);
    expect(resolveAt(p)).toBe(p);
  });

  it('嵌套在宿主内的译文不参与文本提取与块级子元素判定', () => {
    mount('<p id="p">Hello</p>');
    const p = document.getElementById('p');
    const id = ensureHost(p);
    const translation = document.createElement('font');
    translation.setAttribute(TRANSLATION_ATTR, '');
    translation.setAttribute('data-st-for', id);
    translation.setAttribute('data-st-mode', 'block');
    const text = document.createElement('font');
    text.textContent = '你好';
    translation.append(document.createElement('br'), text);
    p.appendChild(translation);

    expect(normalizeText(extractText(p))).toBe('Hello');
    expect(findContainer(p)).toBe(p);
    expect(resolveAt(p)).toBe(p);
    expect(resolveAt(text)).toBe(p);
  });

  it('页面把译文容器改成块级时，宿主仍可成段', () => {
    document.head.innerHTML = '<style>p > font { display: block; }</style>';
    mount('<p id="p">Hello</p>');
    const p = document.getElementById('p');
    ensureHost(p);
    const translation = document.createElement('font');
    translation.setAttribute(TRANSLATION_ATTR, '');
    p.appendChild(translation);

    expect(findContainer(p)).toBe(p);
    expect(normalizeText(extractText(p))).toBe('Hello');
  });

  it('行内代码自身可以翻译，段落文本仍包含行内代码', () => {
    mount('<p id="p">Use <code id="code">npm</code> now</p>');
    expect(resolveAt(document.getElementById('code'))).toBe(document.getElementById('code'));
    expect(normalizeText(extractText(document.getElementById('p')))).toBe('Use npm now');
  });

  it('超长段落仍能被解析出来，由 D5 决定是否请求', () => {
    mount(`<p id="p">${'a'.repeat(4001)}</p>`);
    expect(resolveAt(document.getElementById('p'))).toBe(document.getElementById('p'));
  });

  it('块级宿主判断：p/li 为块级，span 为行内', () => {
    mount('<p id="p">A</p><ul><li id="li">B</li></ul><span id="s">C</span>');
    expect(isBlockHost(document.getElementById('p'))).toBe(true);
    expect(isBlockHost(document.getElementById('li'))).toBe(true);
    expect(isBlockHost(document.getElementById('s'))).toBe(false);
  });

  it('findContainer 返回最近的文字标签，而不是块级祖先', () => {
    mount('<div id="d"><p id="p">Hello <em id="em">world</em></p></div>');
    expect(findContainer(document.getElementById('em'))).toBe(document.getElementById('em'));
    expect(findContainer(document.getElementById('p'))).toBe(document.getElementById('p'));
  });

  it('宿主是否换行以计算样式为准，而不是标签名', () => {
    mount(
      '<p id="inlineP" style="display:inline">A</p>' +
        '<span id="blockSpan" style="display:block">B</span>' +
        '<div id="inlineDiv" style="display:inline-block">C</div>' +
        '<p id="blockP">D</p>'
    );
    expect(isBlockHost(document.getElementById('inlineP'))).toBe(false);
    expect(isBlockHost(document.getElementById('blockSpan'))).toBe(true);
    expect(isBlockHost(document.getElementById('inlineDiv'))).toBe(false);
    expect(isBlockHost(document.getElementById('blockP'))).toBe(true);
  });
});

// ---------------------------------------------------------------------------
// P6.1 视口段落枚举
// ---------------------------------------------------------------------------

/** 让扫描不做真实等待。 */
async function noYield() {}

/**
 * 执行视口扫描；默认注入「全部在视口内」，避免 jsdom 的零尺寸矩形导致空结果。
 * @param {object} [options]
 * @returns {Promise<Array<{ index: number, text: string, host: Element }>>}
 */
function scan(options = {}) {
  return collectParagraphs({ yieldToMain: noYield, inViewport: () => true, ...options });
}

/**
 * @param {Array<{ text: string }>} paragraphs
 * @returns {string[]}
 */
function textsOf(paragraphs) {
  return paragraphs.map((paragraph) => paragraph.text);
}

/**
 * @param {Array<{ host: Element }>} paragraphs
 * @returns {Element[]}
 */
function hostsOf(paragraphs) {
  return paragraphs.map((paragraph) => paragraph.host);
}

/**
 * 给元素一个自定义矩形，模拟真实布局。
 * @param {Element} element
 * @param {{ top?: number, left?: number, width?: number, height?: number }} rect
 */
function stubRect(element, rect) {
  const top = rect.top ?? 0;
  const left = rect.left ?? 0;
  const width = rect.width ?? 0;
  const height = rect.height ?? 0;
  element.getBoundingClientRect = () => ({
    x: left,
    y: top,
    top,
    left,
    width,
    height,
    right: left + width,
    bottom: top + height,
    toJSON() {},
  });
}

describe('D1 视口扫描（P6.1）：顺序与宿主', () => {
  it('从 body 按文档顺序返回 {index,text,host}，index 从 0 递增且不带上下文', async () => {
    mount(
      '<h1 id="h1">Title</h1>' +
        '<div id="wrap"><p id="p1">First</p><span id="s1">Second</span><p id="p2">Third</p></div>' +
        '<ul><li id="li">Fourth</li></ul>'
    );

    const paragraphs = await scan();

    expect(textsOf(paragraphs)).toEqual(['Title', 'First', 'Second', 'Third', 'Fourth']);
    expect(paragraphs.map((paragraph) => paragraph.index)).toEqual([0, 1, 2, 3, 4]);
    expect(paragraphs[0]).toEqual({
      index: 0,
      text: 'Title',
      host: document.getElementById('h1'),
    });
    expect(paragraphs[0]).not.toHaveProperty('context');
    expect(paragraphs[4].host).toBe(document.getElementById('li'));
  });

  it('p 内的行内标签并入同一段，span 不再单独成段', async () => {
    mount('<p id="p">Hello <span id="span">world</span> <strong>now</strong></p>');

    const paragraphs = await scan();

    expect(textsOf(paragraphs)).toEqual(['Hello world now']);
    expect(hostsOf(paragraphs)).toEqual([document.getElementById('p')]);
    expect(paragraphs[0].host).not.toBe(document.getElementById('span'));
  });

  it('嵌套块级取内层，外层容器不把裸文字当成段落', async () => {
    mount('<div id="outer">Bare text <p id="inner">Inner text</p></div>');

    const paragraphs = await scan();

    expect(textsOf(paragraphs)).toEqual(['Inner text']);
    expect(hostsOf(paragraphs)).toEqual([document.getElementById('inner')]);
  });

  it('宿主内的按钮文字单独成段，文档顺序且父段不含按钮文字', async () => {
    mount('<p id="p">Press <button id="b">Go</button> now</p>');

    const paragraphs = await scan();

    expect(textsOf(paragraphs)).toEqual(['Press now', 'Go']);
    expect(paragraphs.map((paragraph) => paragraph.index)).toEqual([0, 1]);
    expect(hostsOf(paragraphs)).toEqual([
      document.getElementById('p'),
      document.getElementById('b'),
    ]);
  });

  it('多个按钮按文档顺序单独成段', async () => {
    mount('<p id="p">Ask <button id="b1">Yes</button> or <button id="b2">No</button> now</p>');

    const paragraphs = await scan();

    expect(textsOf(paragraphs)).toEqual(['Ask or now', 'Yes', 'No']);
    expect(hostsOf(paragraphs)).toEqual([
      document.getElementById('p'),
      document.getElementById('b1'),
      document.getElementById('b2'),
    ]);
    const ids = paragraphs.map((paragraph) => paragraph.host.getAttribute(HOST_ATTR));
    expect(new Set(ids).size).toBe(3);
    for (const id of ids) expect(id).toMatch(HOST_ID_PATTERN);
  });

  it('纯数字、纯符号与纯 emoji 不成段', async () => {
    mount('<p>12345</p><p>!!!</p><p>😀</p><p id="keep">Keep</p>');

    const paragraphs = await scan();

    expect(textsOf(paragraphs)).toEqual(['Keep']);
  });

  it('返回的宿主都带 data-st-host，重复扫描复用同一个 id', async () => {
    mount('<p id="a">Alpha</p><p id="b">Beta</p>');
    expect(MAX_PAGE_PARAGRAPHS).toBe(5000);

    const first = await scan();
    const ids = first.map((paragraph) => paragraph.host.getAttribute(HOST_ATTR));
    expect(ids).toHaveLength(2);
    for (const id of ids) expect(id).toMatch(HOST_ID_PATTERN);

    const second = await scan();
    expect(second.map((paragraph) => paragraph.host.getAttribute(HOST_ATTR))).toEqual(ids);
  });

  it('可以指定扫描根节点，只返回该子树内的段落', async () => {
    mount('<p id="out">Outside</p><section id="in"><p id="inside">Inside</p></section>');

    const paragraphs = await scan({ root: document.getElementById('in') });

    expect(textsOf(paragraphs)).toEqual(['Inside']);
    expect(hostsOf(paragraphs)).toEqual([document.getElementById('inside')]);
  });
});

describe('D1 视口扫描（P6.1）：跳过规则', () => {
  it('跳过脚本、样式、媒体、表单值控件与可编辑区整棵子树', async () => {
    mount(
      '<p id="keep">Keep this</p>' +
        '<script>bad()</script>' +
        '<style>.x{}</style>' +
        '<noscript>No script</noscript>' +
        '<template>Template text</template>' +
        '<canvas>Canvas text</canvas>' +
        '<iframe>Frame text</iframe>' +
        '<object>Object text</object>' +
        '<embed />' +
        '<video>Video text</video>' +
        '<audio>Audio text</audio>' +
        '<textarea>Area text</textarea>' +
        '<input value="Input value" />' +
        '<select><option>Option text</option></select>' +
        '<div id="editable" contenteditable="true">Edit me</div>' +
        '<div role="textbox">Role textbox</div>' +
        '<div role="combobox">Role combobox</div>'
    );

    const paragraphs = await scan();

    expect(textsOf(paragraphs)).toEqual(['Keep this']);
  });

  it('contenteditable="false" 不算可编辑，可以成段', async () => {
    mount('<div id="editable" contenteditable="false">Not editable</div>');

    const paragraphs = await scan();

    expect(textsOf(paragraphs)).toEqual(['Not editable']);
    expect(hostsOf(paragraphs)).toEqual([document.getElementById('editable')]);
  });

  it('跳过 svg 整棵子树', async () => {
    mount('<p id="keep">Keep this</p><svg><text id="svgText">Svg text</text></svg>');

    const paragraphs = await scan();

    expect(textsOf(paragraphs)).toEqual(['Keep this']);
  });

  it('跳过 hidden、aria-hidden、display:none、visibility:hidden / collapse 与折叠 details', async () => {
    mount(
      '<p id="keep">Keep visible</p>' +
        '<p hidden>Hidden attr</p>' +
        '<p aria-hidden="true">Aria hidden</p>' +
        '<p style="display:none">Display none</p>' +
        '<p style="visibility:hidden">Visibility hidden</p>' +
        '<p style="visibility:collapse">Visibility collapse</p>' +
        '<div style="display:none"><p>Nested hidden</p></div>' +
        '<details><summary id="summary">Folded title</summary><p>Folded body</p></details>'
    );

    const paragraphs = await scan();

    expect(textsOf(paragraphs)).toEqual(['Keep visible', 'Folded title']);
    expect(hostsOf(paragraphs)).toEqual([document.getElementById('keep'), document.getElementById('summary')]);
  });

  it('展开的 details 内容正常扫描', async () => {
    mount('<details open><summary>Open title</summary><p id="body">Open body</p></details>');

    const paragraphs = await scan();

    expect(textsOf(paragraphs)).toEqual(['Open title', 'Open body']);
  });

  it('跳过 translate=no、.notranslate 与 data-simpletrans-ignore 子树', async () => {
    mount(
      '<p id="keep">Keep translated</p>' +
        '<p translate="no">Declared no</p>' +
        '<p class="notranslate">Class no</p>' +
        '<p data-simpletrans-ignore>Ignored</p>' +
        '<div translate="no"><p>Nested declared no</p></div>' +
        '<p id="fresh">Fresh</p>'
    );

    const paragraphs = await scan();

    expect(textsOf(paragraphs)).toEqual(['Keep translated', 'Fresh']);
  });

  it('跳过译文容器子树与已带译文容器的宿主', async () => {
    mount(
      '<p id="keep">Keep translated</p>' +
        `<section id="wrap"><div ${TRANSLATION_ATTR}><p>Nested translation</p></div></section>` +
        `<p id="done">Already done <font ${TRANSLATION_ATTR} data-st-for="h1">译文</font></p>` +
        '<p id="fresh">Fresh text</p>'
    );

    const paragraphs = await scan();

    expect(textsOf(paragraphs)).toEqual(['Keep translated', 'Fresh text']);
    expect(hostsOf(paragraphs)).toEqual([document.getElementById('keep'), document.getElementById('fresh')]);
  });
});

describe('D1 视口扫描（P6.1）：视口、上下文与去重', () => {
  it('只收集 inViewport(host) 为真的段落，视口外的段落不收集', async () => {
    mount('<p id="a">Alpha</p><p id="b">Beta</p><p id="c">Gamma</p>');
    const visible = new Set([document.getElementById('a'), document.getElementById('c')]);
    const inViewport = vi.fn((host) => visible.has(host));

    const paragraphs = await scan({ inViewport });

    expect(textsOf(paragraphs)).toEqual(['Alpha', 'Gamma']);
    expect(hostsOf(paragraphs)).toEqual([document.getElementById('a'), document.getElementById('c')]);
    expect(inViewport).toHaveBeenCalledWith(document.getElementById('a'));
    expect(inViewport).toHaveBeenCalledWith(document.getElementById('b'));
    expect(inViewport).toHaveBeenCalledWith(document.getElementById('c'));
  });

  it('视口外的段落不收集，也不分配段落 id', async () => {
    mount('<p id="a">Alpha</p><p id="b">Beta</p><p id="c">Gamma</p>');
    const visible = new Set([document.getElementById('a'), document.getElementById('c')]);

    const paragraphs = await scan({ inViewport: (host) => visible.has(host) });

    expect(textsOf(paragraphs)).toEqual(['Alpha', 'Gamma']);
    expect(document.getElementById('b').getAttribute(HOST_ATTR)).toBe(null);
    expect(paragraphs.every((paragraph) => !('context' in paragraph))).toBe(true);
  });

  it('同文本不合并：每个宿主各有独立段落 id，各占一个 index', async () => {
    mount('<p id="a">Same text</p><p id="b">Other text</p><p id="c">  Same   text  </p>');

    const paragraphs = await scan();

    expect(textsOf(paragraphs)).toEqual(['Same text', 'Other text', 'Same text']);
    expect(paragraphs.map((paragraph) => paragraph.index)).toEqual([0, 1, 2]);
    expect(hostsOf(paragraphs)).toEqual([
      document.getElementById('a'),
      document.getElementById('b'),
      document.getElementById('c'),
    ]);
    const ids = paragraphs.map((paragraph) => paragraph.host.getAttribute(HOST_ATTR));
    expect(new Set(ids).size).toBe(3);
    for (const id of ids) expect(id).toMatch(HOST_ID_PATTERN);
  });

  it('jsdom 中默认视口判定为不可见，不注入 inViewport 时不收集（需求 4.5）', async () => {
    mount('<p>Any paragraph</p>');

    const paragraphs = await collectParagraphs({ yieldToMain: noYield });

    expect(paragraphs).toEqual([]);
  });
});

describe('D1 视口扫描（P6.1）：上限、分片、日志与异常', () => {
  it('达到 maxParagraphs 后停止扫描，并记录 scan.limit', async () => {
    mount('<p>A one</p><p>B two</p><p>C three</p><p>D four</p>');
    const logger = { debug: vi.fn(), info: vi.fn(), warn: vi.fn() };

    const paragraphs = await scan({ maxParagraphs: 3, logger });

    expect(textsOf(paragraphs)).toEqual(['A one', 'B two', 'C three']);
    expect(logger.warn).toHaveBeenCalledWith(
      'scan.limit',
      expect.any(String),
      expect.objectContaining({ max: 3 })
    );
  });

  it('默认单页上限为 5000 段', async () => {
    const parts = [];
    for (let index = 0; index < MAX_PAGE_PARAGRAPHS + 1; index += 1) {
      parts.push(`<p>Text ${index}</p>`);
    }
    mount(parts.join(''));
    const logger = { debug: vi.fn(), info: vi.fn(), warn: vi.fn() };

    const paragraphs = await scan({ logger });

    expect(paragraphs).toHaveLength(MAX_PAGE_PARAGRAPHS);
    expect(paragraphs[0].text).toBe('Text 0');
    expect(paragraphs[MAX_PAGE_PARAGRAPHS - 1].text).toBe(`Text ${MAX_PAGE_PARAGRAPHS - 1}`);
    expect(logger.warn).toHaveBeenCalledWith(
      'scan.limit',
      expect.any(String),
      expect.objectContaining({ max: MAX_PAGE_PARAGRAPHS })
    );
  });

  it('每处理 chunkSize 个元素让出一次主线程，结果不受分片影响', async () => {
    mount(
      '<p>T one</p><p>T two</p><p>T three</p><p>T four</p><p>T five</p><p>T six</p>'
    );
    const yieldToMain = vi.fn(async () => {});

    const paragraphs = await collectParagraphs({
      chunkSize: 3,
      inViewport: () => true,
      yieldToMain,
    });

    expect(textsOf(paragraphs)).toEqual([
      'T one',
      'T two',
      'T three',
      'T four',
      'T five',
      'T six',
    ]);
    // body + 6 个段落 = 7 个元素；弹到第 4、7 个元素前各让出一次。
    expect(yieldToMain).toHaveBeenCalledTimes(2);
  });

  it('元素数小于 chunkSize 时不让出主线程', async () => {
    mount('<p>Only one</p>');
    const yieldToMain = vi.fn(async () => {});

    await collectParagraphs({ chunkSize: 10, inViewport: () => true, yieldToMain });

    expect(yieldToMain).not.toHaveBeenCalled();
  });

  it('注入 logger 与 now 时输出 scan.start / scan.done 并带段落数、跳过数与耗时', async () => {
    mount('<p>Logged</p>');
    const logger = { debug: vi.fn(), info: vi.fn(), warn: vi.fn() };
    const now = vi.fn().mockReturnValueOnce(1000).mockReturnValueOnce(1060);

    await collectParagraphs({ logger, now, inViewport: () => true, yieldToMain: noYield });

    expect(now).toHaveBeenCalledTimes(2);
    expect(logger.debug).toHaveBeenCalledWith('scan.start', expect.any(String), {});
    expect(logger.info).toHaveBeenCalledWith(
      'scan.done',
      expect.any(String),
      expect.objectContaining({ paragraphs: 1, skipped: 0, elapsedMs: 60 })
    );
    expect(logger.warn).not.toHaveBeenCalled();
  });

  it('不传 logger 时不记录日志，也不抛错', async () => {
    mount('<p>Quiet</p>');

    const paragraphs = await scan();

    expect(textsOf(paragraphs)).toEqual(['Quiet']);
  });

  it('单个元素读取异常时记录 scan.error（debug）并继续扫描，日志不含文本', async () => {
    mount(
      '<p id="before">Before text</p>' +
        '<div id="bad">Bad secret text</div>' +
        '<p id="after">After text</p>'
    );
    Object.defineProperty(document.getElementById('bad'), 'classList', {
      configurable: true,
      get() {
        throw new Error('读取失败');
      },
    });
    const logger = { debug: vi.fn(), info: vi.fn(), warn: vi.fn() };

    const paragraphs = await scan({ logger });

    expect(textsOf(paragraphs)).toEqual(['Before text', 'After text']);
    expect(logger.debug).toHaveBeenCalledWith('scan.error', expect.any(String), { tag: 'DIV' });
    expect(JSON.stringify(logger.debug.mock.calls)).not.toContain('Bad secret text');
    expect(logger.warn).not.toHaveBeenCalled();
  });

  it('没有 document 时抛错', async () => {
    vi.stubGlobal('document', undefined);

    await expect(collectParagraphs()).rejects.toThrow();
  });

  it('根节点不可用时抛错', async () => {
    mount('<p>Any</p>');

    await expect(collectParagraphs({ root: {} })).rejects.toThrow();
  });
});

describe('D1 视口判定（P6.1）', () => {
  it('矩形与视口相交时为真，部分可见也算', () => {
    mount('<p id="a">A</p><p id="b">B</p>');
    const a = document.getElementById('a');
    const b = document.getElementById('b');
    stubRect(a, { top: 10, left: 10, width: 100, height: 20 });
    stubRect(b, { top: -10, left: 10, width: 100, height: 20 });

    expect(isElementInViewport(a)).toBe(true);
    expect(isElementInViewport(b)).toBe(true);
  });

  it('完全在视口外、零尺寸与已脱离文档时为假', () => {
    mount('<p id="above">Above</p><p id="right">Right</p><p id="empty">Empty</p>');
    const above = document.getElementById('above');
    const right = document.getElementById('right');
    const empty = document.getElementById('empty');
    stubRect(above, { top: -100, left: 10, width: 100, height: 20 });
    stubRect(right, { top: 10, left: 2000, width: 100, height: 20 });
    stubRect(empty, { top: 10, left: 10, width: 0, height: 0 });
    const detached = document.createElement('p');
    detached.textContent = 'Detached';

    expect(isElementInViewport(above)).toBe(false);
    expect(isElementInViewport(right)).toBe(false);
    expect(isElementInViewport(empty)).toBe(false);
    expect(isElementInViewport(detached)).toBe(false);
    expect(isElementInViewport(null)).toBe(false);
  });

  it('视口上下各半屏范围：半屏内为真，超过半屏为假', () => {
    mount('<p id="above">Above</p><p id="below">Below</p><p id="far">Far</p>');
    const above = document.getElementById('above');
    const below = document.getElementById('below');
    const far = document.getElementById('far');
    stubRect(above, { top: -300, left: 10, width: 100, height: 20 });
    stubRect(below, { top: 1100, left: 10, width: 100, height: 20 });
    stubRect(far, { top: 1300, left: 10, width: 100, height: 20 });

    // 严格视口看不到上下半屏外的内容。
    expect(isElementInViewport(above)).toBe(false);
    expect(isElementInViewport(below)).toBe(false);

    // 上下各半屏（800 × 0.5 = 400）内的段落算「视口附近」。
    expect(isElementInViewport(above, 0.5)).toBe(true);
    expect(isElementInViewport(below, 0.5)).toBe(true);
    expect(isElementInNearViewport(above)).toBe(true);
    expect(isElementInNearViewport(below)).toBe(true);

    // 超过半屏的段落不收集。
    expect(isElementInNearViewport(far)).toBe(false);
    expect(isElementInViewport(far, 0.5)).toBe(false);
  });
});
