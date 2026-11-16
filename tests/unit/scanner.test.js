// @vitest-environment jsdom
/**
 * D1 段落提取测试
 *
 * 用 jsdom 验证容器判定、跳过规则、文本归一与译文到宿主的映射；
 * 不加载真实 chrome，不联网。
 */

import { beforeEach, describe, expect, it } from 'vitest';
import {
  HOST_ATTR,
  TRANSLATION_ATTR,
  ensureHost,
  extractText,
  findContainer,
  hasLetter,
  isBlockHost,
  isHidden,
  isSkipped,
  normalizeText,
  resolveAt,
} from '../../src/content/dom/scanner.js';

/**
 * @param {string} html
 * @returns {Element}
 */
function mount(html) {
  document.body.innerHTML = html;
  return document.body;
}

beforeEach(() => {
  document.head.innerHTML = '';
  document.body.innerHTML = '';
});

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
  it('ensureHost 复用同一个 id', () => {
    mount('<p id="p">Hello</p>');
    const p = document.getElementById('p');
    const first = ensureHost(p);
    const second = ensureHost(p);
    expect(first).toBe(second);
    expect(p.getAttribute(HOST_ATTR)).toBe(first);
    expect(first).toMatch(/^h\d+$/);
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
