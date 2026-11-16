// @vitest-environment jsdom
/**
 * D3 译文渲染测试
 *
 * 用 jsdom 验证内嵌插入、两种格式、四种状态、文本写入安全、隐藏与清除；
 * 不加载真实 chrome，不联网。
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

describe('D3 内嵌结构', () => {
  it('块级段落：译文容器是宿主的最后一个子节点，用 br 换行', () => {
    const p = host('<div><p id="p">Original <strong>text</strong>.</p></div>');
    expect(renderer.showLoading(p)).toBe(true);

    const container = translationOf(p);
    expect(container).not.toBeNull();
    expect(container.parentElement).toBe(p);
    expect(p.lastElementChild).toBe(container);
    expect(container.getAttribute('data-st-for')).toBe(p.getAttribute(HOST_ATTR));
    expect(container.getAttribute('data-st-state')).toBe('loading');
    expect(container.getAttribute('data-st-mode')).toBe('block');
    expect(container.getAttribute('dir')).toBe('auto');

    const first = container.firstElementChild;
    expect(first.tagName).toBe('BR');
    expect(first.nextElementSibling.tagName).toBe('FONT');
    expect(renderer.getText(p)).toBe('正在翻译…');
  });

  it('列表项与表格单元格：译文同样追加到宿主内部末尾', () => {
    const li = host('<ul><li id="p">Item</li></ul>');
    renderer.showDone(li, '项目');
    const liTranslation = translationOf(li);
    expect(liTranslation).not.toBeNull();
    expect(li.nextElementSibling).toBe(null);
    expect(li.lastElementChild).toBe(liTranslation);
    expect(renderer.getText(li)).toBe('项目');

    const td = host('<table><tbody><tr><td id="p">Cell</td></tr></tbody></table>');
    renderer.showDone(td, '单元格');
    const tdTranslation = translationOf(td);
    expect(tdTranslation).not.toBeNull();
    expect(td.lastElementChild).toBe(tdTranslation);
    expect(td.nextElementSibling).toBe(null);
  });

  it('行内宿主：译文与原文同一行，用两个不换行空格分隔', () => {
    const div = host('<div id="p" style="display:inline-block">Inline block</div>');
    renderer.showDone(div, '译文');

    const container = translationOf(div);
    expect(container.getAttribute('data-st-mode')).toBe('inline');
    expect(container.firstChild.nodeType).toBe(Node.TEXT_NODE);
    expect(container.firstChild.nodeValue).toBe('\u00A0\u00A0');
    expect(container.querySelector('font').textContent).toBe('译文');
    expect(renderer.getText(div)).toBe('译文');
  });

  it('span 与 button 作为宿主时，译文插入到该标签内部', () => {
    const span = host('<p><span id="p">Hello</span></p>');
    renderer.showDone(span, '你好');
    expect(span.lastElementChild).toBe(translationOf(span));
    expect(translationOf(span).getAttribute('data-st-mode')).toBe('inline');
    expect(span.parentElement.querySelector(`[${TRANSLATION_ATTR}]`)).toBe(translationOf(span));

    const button = host('<p><button id="p">Submit</button></p>');
    renderer.showDone(button, '提交');
    expect(button.lastElementChild).toBe(translationOf(button));
    expect(translationOf(button).getAttribute('data-st-mode')).toBe('inline');
    expect(renderer.getText(button)).toBe('提交');
  });

  it('换行模式由宿主计算样式决定，p 可被改成行内、span 可被改成块级', () => {
    const inlineP = host('<p id="p" style="display:inline">Hello</p>');
    renderer.showDone(inlineP, '你好');
    expect(translationOf(inlineP).getAttribute('data-st-mode')).toBe('inline');
    expect(translationOf(inlineP).firstChild.nodeType).toBe(Node.TEXT_NODE);

    const blockSpan = host('<p><span id="p" style="display:block">Hello</span></p>');
    renderer.showDone(blockSpan, '你好');
    expect(translationOf(blockSpan).getAttribute('data-st-mode')).toBe('block');
    expect(translationOf(blockSpan).firstElementChild.tagName).toBe('BR');
  });

  it('同一宿主重复显示只保留一个容器', () => {
    const p = host('<p id="p">Original</p>');
    renderer.showLoading(p);
    renderer.showLoading(p);
    renderer.showDone(p, '译文');

    expect(document.querySelectorAll(`[${TRANSLATION_ATTR}]`)).toHaveLength(1);
    expect(p.lastElementChild).toBe(translationOf(p));
  });
});

describe('D3 状态与文本', () => {
  it('加载、流式、完成、失败四种状态可区分', () => {
    const p = host('<p id="p">Original</p>');

    renderer.showLoading(p);
    expect(renderer.getState(p)).toBe('loading');
    expect(translationOf(p).getAttribute('data-st-state')).toBe('loading');

    renderer.update(p, '部分译文');
    expect(renderer.getState(p)).toBe('streaming');
    expect(renderer.getText(p)).toBe('部分译文');

    renderer.showDone(p, '最终译文');
    expect(renderer.getState(p)).toBe('done');
    expect(translationOf(p).getAttribute('data-st-state')).toBe('done');
    expect(renderer.getText(p)).toBe('最终译文');

    renderer.showError(p, '密钥无效');
    expect(renderer.getState(p)).toBe('error');
    expect(renderer.getText(p)).toBe('翻译失败：密钥无效');
    expect(translationOf(p).getAttribute('data-st-state')).toBe('error');
  });

  it('译文只按纯文本写入，不解析 HTML', () => {
    const p = host('<p id="p">Original</p>');
    renderer.showDone(p, '<b>不是标签</b>');

    const container = translationOf(p);
    expect(container.querySelector('b')).toBe(null);
    expect(renderer.getText(p)).toBe('<b>不是标签</b>');
  });

  it('空白错误信息回退为通用提示', () => {
    const p = host('<p id="p">Original</p>');
    renderer.showError(p, '   ');
    expect(renderer.getText(p)).toBe('翻译失败：翻译失败，请重试');
  });
});

describe('D3 隐藏、清除与容错', () => {
  it('隐藏只移除译文容器，原文与换行都不残留', () => {
    const p = host('<p id="p">Original</p>');
    renderer.showDone(p, '译文');
    expect(renderer.remove(p)).toBe(true);

    expect(document.querySelector(`[${TRANSLATION_ATTR}]`)).toBe(null);
    expect(p.textContent).toBe('Original');
    expect(p.querySelector('br')).toBe(null);
    expect(renderer.getState(p)).toBe(null);
    expect(renderer.getText(p)).toBe('');
    expect(renderer.remove(p)).toBe(false);
  });

  it('清除全部返回移除数量', () => {
    document.body.innerHTML = '<p id="a">A</p><p id="b">B</p>';
    const a = document.getElementById('a');
    const b = document.getElementById('b');
    ensureHost(a);
    ensureHost(b);

    renderer.showDone(a, '甲');
    renderer.showDone(b, '乙');
    expect(renderer.clearAll()).toBe(2);
    expect(document.querySelector(`[${TRANSLATION_ATTR}]`)).toBe(null);
  });

  it('宿主已从文档移除时安全跳过', () => {
    const p = host('<p id="p">Original</p>');
    p.remove();
    expect(() => renderer.showDone(p, '译文')).not.toThrow();
    expect(renderer.showDone(p, '译文')).toBe(false);
  });

  it('容器被页面删除后再次更新会重建，并保持原有格式', () => {
    const p = host('<p id="p">Original</p>');
    renderer.showDone(p, '译文');
    translationOf(p).remove();

    renderer.update(p, '新译文');
    const container = translationOf(p);
    expect(container).not.toBeNull();
    expect(container.getAttribute('data-st-mode')).toBe('block');
    expect(container.firstElementChild.tagName).toBe('BR');
    expect(renderer.getText(p)).toBe('新译文');
  });
});
