// @vitest-environment jsdom
/**
 * D2 悬停范围预览测试
 *
 * 用 jsdom 验证候选导航、唯一标记、边界与结束 / 取消后的清理；
 * 不加载真实 chrome，不联网。
 */

import { beforeEach, describe, expect, it } from 'vitest';
import { RANGE_ATTR, createHoverRange } from '../../src/content/range.js';

/**
 * @param {string} html
 */
function mount(html) {
  document.body.innerHTML = html;
}

beforeEach(() => {
  document.body.innerHTML = '';
});

describe('D2 悬停范围预览', () => {
  /**
   * @returns {{ range: object, span: Element, card: Element, collect: Function }}
   */
  function setup() {
    mount('<div id="card"><span id="a">a</span><span id="b">b</span></div>');
    const card = document.getElementById('card');
    const span = document.getElementById('a');
    const collect = () => [
      { host: span, text: 'a' },
      { host: card, text: 'ab' },
    ];
    return { range: createHoverRange({ collect }), span, card, collect };
  }

  it('begin 标记基宿主并返回候选级数', () => {
    const { range, span } = setup();
    expect(range.begin(span)).toBe(2);
    expect(span.hasAttribute(RANGE_ATTR)).toBe(true);
    expect(range.getHost()).toBe(span);
    expect(range.getIndex()).toBe(0);
    expect(range.getLevels()).toBe(2);
  });

  it('expand / shrink 移动唯一标记，边界不再变化', () => {
    const { range, span, card } = setup();
    range.begin(span);

    expect(range.expand()).toBe(true);
    expect(card.hasAttribute(RANGE_ATTR)).toBe(true);
    expect(span.hasAttribute(RANGE_ATTR)).toBe(false);
    expect(range.expand()).toBe(false);

    expect(range.shrink()).toBe(true);
    expect(span.hasAttribute(RANGE_ATTR)).toBe(true);
    expect(card.hasAttribute(RANGE_ATTR)).toBe(false);
    expect(range.shrink()).toBe(false);
  });

  it('end 返回最终宿主并移除标记', () => {
    const { range, span, card } = setup();
    range.begin(span);
    range.expand();

    expect(range.end()).toBe(card);
    expect(card.hasAttribute(RANGE_ATTR)).toBe(false);
    expect(range.getHost()).toBe(null);
    expect(range.getLevels()).toBe(0);
  });

  it('cancel 移除标记并清空候选', () => {
    const { range, span } = setup();
    range.begin(span);
    range.cancel();

    expect(span.hasAttribute(RANGE_ATTR)).toBe(false);
    expect(range.getHost()).toBe(null);
    expect(range.end()).toBe(null);
  });

  it('没有基宿主或没有候选时不标记', () => {
    const range = createHoverRange({ collect: () => [] });
    expect(range.begin(null)).toBe(0);
    expect(range.getHost()).toBe(null);
    expect(range.expand()).toBe(false);
    expect(range.shrink()).toBe(false);

    const empty = document.createElement('p');
    document.body.append(empty);
    expect(range.begin(empty)).toBe(0);
    expect(empty.hasAttribute(RANGE_ATTR)).toBe(false);
  });

  it('断开连接的宿主不写标记', () => {
    mount('<div id="card"><span id="a">a</span></div>');
    const card = document.getElementById('card');
    const span = document.getElementById('a');
    const range = createHoverRange({
      collect: () => [
        { host: span, text: 'a' },
        { host: card, text: 'ab' },
      ],
    });
    range.begin(span);
    card.remove();

    expect(range.expand()).toBe(true);
    expect(card.hasAttribute(RANGE_ATTR)).toBe(false);
  });
});
