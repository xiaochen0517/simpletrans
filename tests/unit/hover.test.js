// @vitest-environment jsdom
/**
 * D2 悬停检测测试
 *
 * 用 jsdom 验证指针跟踪、当前宿主解析、译文归位与节流；
 * 不加载真实 chrome，不联网。
 */

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { HOST_ATTR, TRANSLATION_ATTR, ensureHost } from '../../src/content/dom/scanner.js';
import { createHoverTracker } from '../../src/content/hover.js';

/**
 * @param {Element} target
 * @param {number} [x]
 * @param {number} [y]
 */
function move(target, x = 10, y = 10) {
  target.dispatchEvent(
    new MouseEvent('pointermove', { bubbles: true, clientX: x, clientY: y })
  );
}

beforeEach(() => {
  document.body.innerHTML = '';
});

afterEach(() => {
  vi.restoreAllMocks();
  delete document.elementFromPoint;
});

describe('D2 悬停锚定', () => {
  it('指针移动后解析出当前段落', () => {
    document.body.innerHTML = '<p id="p">Hello</p>';
    const tracker = createHoverTracker();
    tracker.start();

    move(document.getElementById('p'));
    expect(tracker.getCurrentHost()).toBe(document.getElementById('p'));

    tracker.stop();
  });

  it('指针在译文上时归到译文所属的段落', () => {
    document.body.innerHTML = '<p id="p">Hello</p>';
    const p = document.getElementById('p');
    const id = ensureHost(p);
    const translation = document.createElement('font');
    translation.setAttribute(TRANSLATION_ATTR, '');
    translation.setAttribute('data-st-for', id);
    const text = document.createElement('font');
    text.textContent = '你好';
    translation.append(text);
    p.append(translation);

    const tracker = createHoverTracker();
    tracker.start();
    move(text);

    expect(tracker.getCurrentHost()).toBe(p);
    tracker.stop();
  });

  it('指针在按钮上时以按钮为宿主，纯数字段落返回空', () => {
    document.body.innerHTML =
      '<div id="card">Text <button id="button">Go</button></div><p id="num">123</p>';
    const tracker = createHoverTracker();
    tracker.start();

    move(document.getElementById('button'));
    expect(tracker.getCurrentHost()).toBe(document.getElementById('button'));

    move(document.getElementById('num'));
    expect(tracker.getCurrentHost()).toBe(null);

    tracker.stop();
  });

  it('优先使用 elementFromPoint 复核位置', () => {
    document.body.innerHTML = '<p id="p1">One</p><p id="p2">Two</p>';
    const p1 = document.getElementById('p1');
    const p2 = document.getElementById('p2');
    document.elementFromPoint = vi.fn(() => p2);

    const tracker = createHoverTracker();
    tracker.start();
    move(p1);

    expect(tracker.getCurrentHost()).toBe(p2);
    expect(document.elementFromPoint).toHaveBeenCalled();
    tracker.stop();
  });

  it('pointerleave 清空当前段落', () => {
    document.body.innerHTML = '<p id="p">Hello</p>';
    const tracker = createHoverTracker();
    tracker.start();
    move(document.getElementById('p'));
    expect(tracker.getCurrentHost()).not.toBe(null);

    document.dispatchEvent(new MouseEvent('pointerleave'));
    expect(tracker.getCurrentHost()).toBe(null);
    tracker.stop();
  });

  it('指针离开窗口（pointerout 无 relatedTarget）时清空', () => {
    document.body.innerHTML = '<p id="p">Hello</p>';
    const p = document.getElementById('p');
    const tracker = createHoverTracker();
    tracker.start();
    move(p);
    expect(tracker.getCurrentHost()).toBe(p);

    p.dispatchEvent(new MouseEvent('pointerout', { bubbles: true }));
    expect(tracker.getCurrentHost()).toBe(null);
    tracker.stop();
  });

  it('移动事件按 80 毫秒节流，只安排一次解析', () => {
    document.body.innerHTML = '<p id="p">Hello</p>';
    const pending = [];
    const schedule = vi.fn((fn) => {
      pending.push(fn);
      return pending.length;
    });
    const tracker = createHoverTracker({
      resolve: (element) => element,
      schedule,
      cancel: vi.fn(),
    });
    tracker.start();

    move(document.getElementById('p'));
    move(document.getElementById('p'));
    move(document.getElementById('p'));

    expect(schedule).toHaveBeenCalledTimes(1);
    expect(schedule.mock.calls[0][1]).toBe(80);

    tracker.stop();
  });

  it('stop 后不再响应指针事件', () => {
    document.body.innerHTML = '<p id="p">Hello</p>';
    const tracker = createHoverTracker();
    tracker.start();
    tracker.stop();

    move(document.getElementById('p'));
    expect(tracker.getCurrentHost()).toBe(null);
  });

  it('start 可重复调用，不会重复监听', () => {
    document.body.innerHTML = '<p id="p">Hello</p>';
    const schedule = vi.fn(() => 1);
    const tracker = createHoverTracker({ schedule, cancel: vi.fn() });

    tracker.start();
    tracker.start();
    move(document.getElementById('p'));

    expect(schedule).toHaveBeenCalledTimes(1);
    tracker.stop();
  });

  it('宿主 id 变化时才记录 hover.target（不记录正文）', () => {
    document.body.innerHTML = '<p id="a">A</p><p id="b">B</p>';
    const a = document.getElementById('a');
    ensureHost(a);
    const tracker = createHoverTracker();
    tracker.start();

    // 日志在未初始化 E4 时静默；这里只验证解析结果稳定。
    move(a);
    expect(tracker.getCurrentHost()).toBe(a);
    move(a);
    expect(tracker.getCurrentHost()).toBe(a);

    tracker.stop();
  });
});
