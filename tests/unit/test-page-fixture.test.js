/**
 * C6 翻译测试页夹具结构测试（P6.5）
 *
 * 直接读取并解析 `src/testpage/index.html`，验证它是一份稳定、离线、可翻译的固定夹具：
 * - 语言、`main` 与页内操作条（两个按钮、无模拟开关）的骨架；
 * - 区块的 id、`data-test-section`、`<h2>` 与顺序；
 * - 必需的前端 HTML 类型；正文英文、操作条中文且不参与翻译；
 * - 资源本地化与页内锚点；
 * - D1 应跳过的负例；
 * - 重渲染夹具的目标段落、三种重建模式与控件；
 * - 长文段数与唯一的入口脚本（无内联脚本）。
 *
 * 只检查结构是否具备，不判断译文措辞；翻译效果由人工验收。
 */

import { readFile } from 'node:fs/promises';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { JSDOM } from 'jsdom';
import { describe, expect, it } from 'vitest';

const ROOT = fileURLToPath(new URL('../../', import.meta.url));
const FIXTURE_PATH = join(ROOT, 'src', 'testpage', 'index.html');

/** 夹具区块，按页面从上到下的顺序。 */
const SECTION_IDS = [
  'overview',
  'typography',
  'lists',
  'tables',
  'quotes-code',
  'controls',
  'numbers',
  'long-article',
  'rerender',
  'non-translatable',
  'footer',
];

/** 夹具必须真实包含的前端文字类型。 */
const REQUIRED_TAGS = [
  'h1',
  'h2',
  'h3',
  'p',
  'ul',
  'ol',
  'li',
  'dl',
  'dt',
  'dd',
  'table',
  'caption',
  'thead',
  'tbody',
  'th',
  'td',
  'blockquote',
  'cite',
  'pre',
  'code',
  'strong',
  'em',
  'small',
  'mark',
  'abbr',
  'sup',
  'sub',
  'a',
  'button',
  'label',
  'input',
  'textarea',
  'select',
  'details',
  'summary',
];

/** D1 现有规则应跳过的负例。 */
const NEGATIVE_SELECTORS = [
  '[translate="no"]',
  '.notranslate',
  '[data-simpletrans-ignore]',
  '[contenteditable]',
  'input[value]',
  'input[placeholder]',
  'textarea',
  'select',
  '[hidden]',
  'details:not([open])',
  '[aria-hidden="true"]',
];

/** 可能加载外部资源、必须保持本地相对路径的元素与属性。 */
const RESOURCE_ATTRIBUTES = [
  ['script', 'src'],
  ['link', 'href'],
  ['img', 'src'],
  ['iframe', 'src'],
  ['source', 'src'],
  ['video', 'src'],
  ['audio', 'src'],
];

const HAN = /\p{Script=Han}/u;
const EXTERNAL_URL = /^(?:https?:)?\/\//i;

const html = await readFile(FIXTURE_PATH, 'utf8');
const { document } = new JSDOM(html).window;

describe('C6 翻译测试页夹具（P6.5）', () => {
  it('页面声明英文，包含 main 与不参与翻译的操作条', () => {
    expect(document.documentElement.getAttribute('lang')).toBe('en');

    const main = document.querySelector('main#test-page');
    expect(main).not.toBeNull();
    expect(main.tagName).toBe('MAIN');

    const toolbar = document.querySelector('header[data-simpletrans-ignore][translate="no"]');
    expect(toolbar).not.toBeNull();
    expect(toolbar.tagName).toBe('HEADER');
    expect(main.contains(toolbar)).toBe(false);
  });

  it('区块齐全，id 唯一，每个都有 data-test-section 与 h2', () => {
    const selector = SECTION_IDS.map((id) => `#${id}`).join(', ');
    expect(document.querySelectorAll(selector)).toHaveLength(SECTION_IDS.length);

    for (const id of SECTION_IDS) {
      const section = document.getElementById(id);
      expect(section, `缺少区块 #${id}`).not.toBeNull();
      expect(section.hasAttribute('data-test-section'), `#${id} 缺少 data-test-section`).toBe(
        true
      );
      expect(section.querySelector('h2'), `#${id} 缺少 <h2>`).not.toBeNull();
    }

    // 文档顺序与需求 2.2 的表格一致：除页脚外都在 main 内，页脚在 main 之后。
    const order = [...document.querySelectorAll('[data-test-section]')]
      .map((element) => element.id)
      .filter((id) => SECTION_IDS.includes(id));
    expect(order).toEqual(SECTION_IDS);
  });

  it('重渲染夹具包含目标段落、三种重建模式与独立控件', () => {
    const section = document.getElementById('rerender');
    const target = document.getElementById('rerender-target');
    const mode = document.getElementById('rerender-mode');
    const toggle = document.getElementById('rerender-toggle');
    const now = document.getElementById('rerender-now');
    const status = document.getElementById('rerender-status');

    expect(section).not.toBeNull();
    expect(target).not.toBeNull();
    expect(target.tagName).toBe('P');
    expect(target.textContent).toMatch(/source text did not change/);

    expect(mode).not.toBeNull();
    expect([...mode.options].map((option) => option.value)).toEqual([
      'children',
      'host',
      'text',
    ]);
    expect(toggle).not.toBeNull();
    expect(toggle.getAttribute('aria-pressed')).toBe('false');
    expect(now).not.toBeNull();
    expect(status).not.toBeNull();

    // 控件是测试工具，不参与翻译；不放回顶部操作条。
    const panel = section.querySelector('[data-simpletrans-ignore][translate="no"]');
    expect(panel).not.toBeNull();
    for (const element of [mode, toggle, now, status]) {
      expect(panel.contains(element)).toBe(true);
    }
    expect(document.querySelector('header').contains(toggle)).toBe(false);
  });

  it('操作条只有「翻译整页 / 显示原文」，不含模拟开关', () => {
    const toolbar = document.querySelector('header[data-simpletrans-ignore]');
    const start = document.getElementById('test-start');
    const clear = document.getElementById('test-clear');

    for (const button of [start, clear]) {
      expect(button).not.toBeNull();
      expect(button.tagName).toBe('BUTTON');
      expect(toolbar.contains(button)).toBe(true);
    }
    expect(document.getElementById('test-mode-slow')).toBeNull();
    expect(document.getElementById('test-mode-fail')).toBeNull();
    expect(toolbar.querySelectorAll('input')).toHaveLength(0);
  });

  it('真实包含需求列出的 HTML 类型', () => {
    for (const tag of REQUIRED_TAGS) {
      expect(document.getElementsByTagName(tag).length, `缺少 <${tag}>`).toBeGreaterThan(0);
    }
  });

  it('main 内正文不含汉字；中文操作条在 main 之外', () => {
    const main = document.querySelector('main#test-page');
    const toolbar = document.querySelector('header[data-simpletrans-ignore]');

    expect(main.textContent).not.toMatch(HAN);
    expect(toolbar.textContent).toMatch(HAN);
    expect(main.contains(toolbar)).toBe(false);
  });

  it('资源全部本地化，页面链接只用页内锚点', () => {
    for (const [tag, attribute] of RESOURCE_ATTRIBUTES) {
      for (const element of document.querySelectorAll(`${tag}[${attribute}]`)) {
        const value = element.getAttribute(attribute);
        expect(value, `<${tag} ${attribute}> 为空`).toBeTruthy();
        expect(value, `<${tag} ${attribute}="${value}"> 指向外部资源`).not.toMatch(EXTERNAL_URL);
      }
    }

    const anchors = document.querySelectorAll('a[href]');
    expect(anchors.length).toBeGreaterThan(0);
    for (const anchor of anchors) {
      const href = anchor.getAttribute('href');
      expect(href, `链接 "${anchor.textContent.trim()}" 不是页内锚点`).toMatch(/^#\S+$/);
    }
  });

  it('包含 D1 跳过规则的负例', () => {
    for (const selector of NEGATIVE_SELECTORS) {
      expect(document.querySelector(selector), `缺少负例 ${selector}`).not.toBeNull();
    }
  });

  it('长文区块至少有 8 个自然段', () => {
    expect(document.querySelectorAll('#long-article p').length).toBeGreaterThanOrEqual(8);
  });

  it('只有一个入口脚本，指向 ./main.js，且没有内联脚本', () => {
    const scripts = document.querySelectorAll('script');
    expect(scripts).toHaveLength(1);
    expect(scripts[0].getAttribute('src')).toBe('./main.js');
    expect(scripts[0].textContent.trim()).toBe('');
  });
});
