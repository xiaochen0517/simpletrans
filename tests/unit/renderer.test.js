// @vitest-environment jsdom
/**
 * D3 提交状态渲染测试
 *
 * 用 jsdom 验证内嵌插入、两种格式、submitting / submitted / error 三种状态、
 * 文本写入安全、隐藏与清除；不加载真实 chrome，不联网。
 */

import { beforeEach, describe, expect, it } from 'vitest';
import { HOST_ATTR, TRANSLATION_ATTR, ensureHost } from '../../src/content/dom/scanner.js';
import { createRenderer } from '../../src/content/dom/renderer.js';

let renderer;

beforeEach(() => {
  document.body.innerHTML = '';
  renderer = createRenderer({ document });
});

/**
 * @param {string} html
 * @param {string} id
 * @returns {Element}
 */
function host(html, id = 'p') {
  document.body.innerHTML = html;
  const element = document.getElementById(id);
  ensureHost(element);
  return element;
}

/**
 * @param {Element} hostElement
 * @returns {Element | null}
 */
function translationOf(hostElement) {
  return hostElement.querySelector(`[${TRANSLATION_ATTR}]`);
}

/**
 * 读取内层状态文本。
 * @param {Element} hostElement
 * @returns {string}
 */
function textOf(hostElement) {
  const container = translationOf(hostElement);
  if (!container) return '';
  return container.querySelector('font')?.textContent ?? '';
}

describe('D3 内嵌结构', () => {
  it('块级段落：状态容器是宿主的最后一个子节点，用 br 换行', () => {
    const p = host('<div><p id="p">Original <strong>text</strong>.</p></div>');
    expect(renderer.showSubmitting(p)).toBe(true);

    const container = translationOf(p);
    expect(container).not.toBeNull();
    expect(container.parentElement).toBe(p);
    expect(p.lastElementChild).toBe(container);
    expect(container.getAttribute('data-st-for')).toBe(p.getAttribute(HOST_ATTR));
    expect(container.getAttribute('data-st-state')).toBe('submitting');
    expect(container.getAttribute('data-st-mode')).toBe('block');
    expect(container.getAttribute('dir')).toBe('auto');

    const first = container.firstElementChild;
    expect(first.tagName).toBe('BR');
    expect(first.nextElementSibling.tagName).toBe('FONT');
    expect(textOf(p)).toBe('正在提交…');
  });

  it('列表项与表格单元格：状态同样追加到宿主内部末尾', () => {
    const li = host('<ul><li id="p">Item</li></ul>');
    renderer.showSubmitted(li);
    const liTranslation = translationOf(li);
    expect(liTranslation).not.toBeNull();
    expect(li.nextElementSibling).toBe(null);
    expect(li.lastElementChild).toBe(liTranslation);
    expect(textOf(li)).toBe('已提交，等待翻译');

    const td = host('<table><tbody><tr><td id="p">Cell</td></tr></tbody></table>');
    renderer.showSubmitted(td);
    const tdTranslation = translationOf(td);
    expect(tdTranslation).not.toBeNull();
    expect(td.lastElementChild).toBe(tdTranslation);
    expect(td.nextElementSibling).toBe(null);
  });

  it('行内宿主：状态与原文同一行，用两个不换行空格分隔', () => {
    const div = host('<div id="p" style="display:inline-block">Inline block</div>');
    renderer.showSubmitted(div);

    const container = translationOf(div);
    expect(container.getAttribute('data-st-mode')).toBe('inline');
    expect(container.firstChild.nodeType).toBe(Node.TEXT_NODE);
    expect(container.firstChild.nodeValue).toBe('\u00A0\u00A0');
    expect(container.querySelector('font').textContent).toBe('已提交，等待翻译');
  });

  it('span 与 button 作为宿主时，状态插入到该标签内部', () => {
    const span = host('<p><span id="p">Hello</span></p>');
    renderer.showSubmitted(span);
    expect(span.lastElementChild).toBe(translationOf(span));
    expect(translationOf(span).getAttribute('data-st-mode')).toBe('inline');
    expect(span.parentElement.querySelector(`[${TRANSLATION_ATTR}]`)).toBe(translationOf(span));

    const button = host('<p><button id="p">Submit</button></p>');
    renderer.showSubmitted(button);
    expect(button.lastElementChild).toBe(translationOf(button));
    expect(translationOf(button).getAttribute('data-st-mode')).toBe('inline');
    expect(textOf(button)).toBe('已提交，等待翻译');
  });

  it('换行模式由宿主计算样式决定，p 可被改成行内、span 可被改成块级', () => {
    const inlineP = host('<p id="p" style="display:inline">Hello</p>');
    renderer.showSubmitted(inlineP);
    expect(translationOf(inlineP).getAttribute('data-st-mode')).toBe('inline');
    expect(translationOf(inlineP).firstChild.nodeType).toBe(Node.TEXT_NODE);

    const blockSpan = host('<p><span id="p" style="display:block">Hello</span></p>');
    renderer.showSubmitted(blockSpan);
    expect(translationOf(blockSpan).getAttribute('data-st-mode')).toBe('block');
    expect(translationOf(blockSpan).firstElementChild.tagName).toBe('BR');
  });

  it('同一宿主重复显示只保留一个容器', () => {
    const p = host('<p id="p">Original</p>');
    renderer.showSubmitting(p);
    renderer.showSubmitting(p);
    renderer.showSubmitted(p);

    expect(document.querySelectorAll(`[${TRANSLATION_ATTR}]`)).toHaveLength(1);
    expect(p.lastElementChild).toBe(translationOf(p));
    expect(renderer.getState(p)).toBe('submitted');
  });
});

describe('D3 状态与文本', () => {
  it('正在提交、已提交、提交失败三种状态可区分', () => {
    const p = host('<p id="p">Original</p>');

    renderer.showSubmitting(p);
    expect(renderer.getState(p)).toBe('submitting');
    expect(translationOf(p).getAttribute('data-st-state')).toBe('submitting');
    expect(textOf(p)).toBe('正在提交…');

    renderer.showSubmitted(p);
    expect(renderer.getState(p)).toBe('submitted');
    expect(translationOf(p).getAttribute('data-st-state')).toBe('submitted');
    expect(textOf(p)).toBe('已提交，等待翻译');

    renderer.showSubmitError(p, '网络不可用');
    expect(renderer.getState(p)).toBe('error');
    expect(translationOf(p).getAttribute('data-st-state')).toBe('error');
    expect(textOf(p)).toBe('提交失败：网络不可用');
  });

  it('状态文本只按纯文本写入，不解析 HTML', () => {
    const p = host('<p id="p">Original</p>');
    renderer.showSubmitError(p, '<b>不是标签</b>');

    const container = translationOf(p);
    expect(container.querySelector('b')).toBe(null);
    expect(textOf(p)).toBe('提交失败：<b>不是标签</b>');
  });

  it('空白错误信息回退为通用提示', () => {
    const p = host('<p id="p">Original</p>');
    renderer.showSubmitError(p, '   ');
    expect(textOf(p)).toBe('提交失败：提交失败，请重试');
  });
});

describe('D3 隐藏、清除与容错', () => {
  it('隐藏只移除状态容器，原文与换行都不残留', () => {
    const p = host('<p id="p">Original</p>');
    renderer.showSubmitted(p);
    expect(renderer.remove(p)).toBe(true);

    expect(document.querySelector(`[${TRANSLATION_ATTR}]`)).toBe(null);
    expect(p.textContent).toBe('Original');
    expect(p.querySelector('br')).toBe(null);
    expect(renderer.getState(p)).toBe(null);
    expect(renderer.remove(p)).toBe(false);
  });

  it('清除全部返回移除数量', () => {
    document.body.innerHTML = '<p id="a">A</p><p id="b">B</p>';
    const a = document.getElementById('a');
    const b = document.getElementById('b');
    ensureHost(a);
    ensureHost(b);

    renderer.showSubmitted(a);
    renderer.showSubmitted(b);
    expect(renderer.clearAll()).toBe(2);
    expect(document.querySelector(`[${TRANSLATION_ATTR}]`)).toBe(null);
  });

  it('宿主已从文档移除时安全跳过', () => {
    const p = host('<p id="p">Original</p>');
    p.remove();
    expect(() => renderer.showSubmitted(p)).not.toThrow();
    expect(renderer.showSubmitted(p)).toBe(false);
  });

  it('容器被页面删除后再次更新会重建，并保持原有格式', () => {
    const p = host('<p id="p">Original</p>');
    renderer.showSubmitted(p);
    translationOf(p).remove();

    renderer.showSubmitError(p, '重试');
    const container = translationOf(p);
    expect(container).not.toBeNull();
    expect(container.getAttribute('data-st-mode')).toBe('block');
    expect(container.firstElementChild.tagName).toBe('BR');
    expect(textOf(p)).toBe('提交失败：重试');
  });
});
