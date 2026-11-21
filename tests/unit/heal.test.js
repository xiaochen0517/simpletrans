// @vitest-environment jsdom
/**
 * D6 译文自愈测试
 *
 * 用 jsdom + 真实渲染器验证：
 * - 会话内译文镜像与「同文同译」恢复；
 * - 子节点重建、宿主替换两种重渲染形态；
 * - 原文变化时不恢复、不提交，并移除旧译文容器；
 * - 用户隐藏、清除会话、镜像上限与反复重建的暂停；
 * - 自身写入不触发第二次恢复，start/stop 生命周期。
 *
 * 不加载真实 chrome，不联网。
 */

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { HOST_ATTR, TRANSLATION_ATTR, ensureHost } from '../../src/content/dom/scanner.js';
import { createHealer } from '../../src/content/heal.js';
import { createRenderer } from '../../src/content/dom/renderer.js';

/** @type {ReturnType<typeof createRenderer>} */
let renderer;
/** @type {ReturnType<typeof createHealer>} */
let healer;
/** @type {import('vitest').Mock} */
let restore;
/** @type {import('vitest').Mock} */
let forget;

/**
 * 新建一个带文本的段落宿主。
 * @param {string} text
 * @param {string} [tag]
 * @returns {Element}
 */
function mountHost(text, tag = 'p') {
  const host = document.createElement(tag);
  host.textContent = text;
  document.body.appendChild(host);
  ensureHost(host);
  return host;
}

/**
 * 把宿主的子节点换成同文本或新文本，模拟框架重建（译文容器随之删除）。
 * @param {Element} host
 * @param {string} text
 */
function rebuildChildren(host, text) {
  host.replaceChildren(document.createTextNode(text));
}

/**
 * 只替换原文文本节点、保留末尾译文容器，模拟「文本原地变化但容器还在」。
 * @param {Element} host
 * @param {string} text
 */
function rebuildTextKeepContainer(host, text) {
  const container = host.querySelector(`[${TRANSLATION_ATTR}]`);
  for (const child of [...host.childNodes]) {
    if (child !== container) host.removeChild(child);
  }
  host.insertBefore(document.createTextNode(text), container);
}

/**
 * 推进 MutationObserver 微任务与 150ms 去抖。
 * @param {number} [ms]
 */
async function settle(ms = 200) {
  await vi.advanceTimersByTimeAsync(ms);
  await vi.advanceTimersByTimeAsync(0);
  await Promise.resolve();
}

beforeEach(() => {
  vi.useFakeTimers();
  document.body.innerHTML = '';
  renderer = createRenderer({ document });
  restore = vi.fn((host, source, translated) => renderer.showDone(host, translated));
  forget = vi.fn();
  healer = createHealer({
    document,
    renderer,
    restore,
    forget,
    yieldToMain: async () => {},
  });
  healer.start();
});

afterEach(() => {
  healer?.stop();
  healer?.reset();
  renderer?.clearAll();
  vi.useRealTimers();
});

describe('D6 译文自愈：镜像与恢复', () => {
  it('子节点重建删除译文后，按同文本自动重挂，且不产生第二次恢复', async () => {
    const host = mountHost('Hello');
    healer.remember('Hello', '你好', host);
    renderer.showDone(host, '你好');

    rebuildChildren(host, 'Hello');
    await settle();

    expect(restore).toHaveBeenCalledTimes(1);
    expect(restore.mock.calls[0][0]).toBe(host);
    expect(restore.mock.calls[0][1]).toBe('Hello');
    expect(restore.mock.calls[0][2]).toBe('你好');
    expect(renderer.getState(host)).toBe('done');

    // 恢复写入的容器也会产生变更记录，但不应再次恢复。
    await settle();
    expect(restore).toHaveBeenCalledTimes(1);
  });

  it('宿主元素被替换为同文本新节点时，按文本命中镜像并恢复', async () => {
    const host = mountHost('Hello');
    healer.remember('Hello', '你好', host);
    renderer.showDone(host, '你好');

    const next = document.createElement('p');
    next.textContent = 'Hello';
    host.replaceWith(next);
    await settle();

    expect(restore).toHaveBeenCalledTimes(1);
    expect(restore.mock.calls[0][0]).toBe(next);
    expect(next.getAttribute(HOST_ATTR)).toMatch(/^h[a-z0-9]{6}-\d+$/);
    expect(renderer.getState(next)).toBe('done');
  });

  it('镜像未命中时什么都不做，不调用恢复', async () => {
    const host = mountHost('Never translated');
    rebuildChildren(host, 'Never translated');
    await settle();

    expect(restore).not.toHaveBeenCalled();
    expect(renderer.getState(host)).toBeNull();
  });

  it('同一原文更新译文后，恢复使用最新译文', async () => {
    const host = mountHost('Hello');
    healer.remember('Hello', '你好', host);
    healer.remember('Hello', '您好', host);
    renderer.showDone(host, '您好');

    rebuildChildren(host, 'Hello');
    await settle();

    expect(restore).toHaveBeenCalledWith(host, 'Hello', '您好');
  });

  it('镜像超过上限时淘汰最旧条目', async () => {
    for (let index = 0; index < 2001; index += 1) {
      healer.remember(`text ${index}`, `译文 ${index}`);
    }
    expect(healer.getMirrorSize()).toBe(2000);

    const evicted = mountHost('text 0');
    rebuildChildren(evicted, 'text 0');
    const kept = mountHost('text 2000');
    rebuildChildren(kept, 'text 2000');
    await settle();

    expect(restore).toHaveBeenCalledTimes(1);
    expect(restore.mock.calls[0][0]).toBe(kept);
  });

  it('空原文或空译文不写入镜像', () => {
    expect(healer.remember('', '你好')).toBe(false);
    expect(healer.remember('Hello', '')).toBe(false);
    expect(healer.getMirrorSize()).toBe(0);
  });
});

describe('D6 译文自愈：原文变化与抑制', () => {
  it('原文变化时不恢复，移除旧容器并注销段落', async () => {
    const host = mountHost('Hello');
    healer.remember('Hello', '你好', host);
    renderer.showDone(host, '你好');

    rebuildTextKeepContainer(host, 'Hello world');
    await settle();

    expect(restore).not.toHaveBeenCalled();
    expect(renderer.getState(host)).toBeNull();
    expect(forget).toHaveBeenCalledWith(host);
  });

  it('原文变化后即使新文本在镜像里，也不恢复该宿主', async () => {
    const host = mountHost('Hello');
    healer.remember('Hello', '你好', host);
    healer.remember('Hello world', '你好，世界');
    renderer.showDone(host, '你好');

    rebuildChildren(host, 'Hello world');
    await settle();
    rebuildChildren(host, 'Hello world');
    await settle();

    expect(restore).not.toHaveBeenCalled();
    expect(renderer.getState(host)).toBeNull();
  });

  it('容器还在且原文未变时不重复恢复', async () => {
    const host = mountHost('Hello');
    healer.remember('Hello', '你好', host);
    renderer.showDone(host, '你好');

    host.appendChild(document.createElement('span'));
    await settle();

    expect(restore).not.toHaveBeenCalled();
    expect(renderer.getState(host)).toBe('done');
  });

  it('用户隐藏后不恢复，解除隐藏后恢复', async () => {
    const host = mountHost('Hello');
    healer.remember('Hello', '你好', host);
    healer.hide('Hello');
    renderer.showDone(host, '你好');

    rebuildChildren(host, 'Hello');
    await settle();
    expect(restore).not.toHaveBeenCalled();

    healer.unhide(host, 'Hello');
    rebuildChildren(host, 'Hello');
    await settle();
    expect(restore).toHaveBeenCalledTimes(1);
  });

  it('会话重置后镜像清空，不再恢复', async () => {
    const host = mountHost('Hello');
    healer.remember('Hello', '你好', host);
    renderer.showDone(host, '你好');

    healer.reset();
    rebuildChildren(host, 'Hello');
    await settle();

    expect(restore).not.toHaveBeenCalled();
    expect(healer.getMirrorSize()).toBe(0);
  });

  it('隐藏中的宿主不恢复', async () => {
    const host = mountHost('Hello');
    healer.remember('Hello', '你好', host);
    renderer.showDone(host, '你好');
    host.hidden = true;

    rebuildChildren(host, 'Hello');
    await settle();

    expect(restore).not.toHaveBeenCalled();
  });
});

describe('D6 译文自愈：防抖与生命周期', () => {
  it('同一文本在窗口内反复重建，达到阈值后暂停恢复', async () => {
    const host = mountHost('Hello');
    healer.remember('Hello', '你好', host);

    for (let index = 0; index < 6; index += 1) {
      renderer.showDone(host, '你好');
      rebuildChildren(host, 'Hello');
      await settle();
    }

    expect(restore).toHaveBeenCalledTimes(5);
  });

  it('stop 后不再观察，start 后继续恢复', async () => {
    const host = mountHost('Hello');
    healer.remember('Hello', '你好', host);

    healer.stop();
    rebuildChildren(host, 'Hello');
    await settle();
    expect(restore).not.toHaveBeenCalled();

    healer.start();
    rebuildChildren(host, 'Hello');
    await settle();
    expect(restore).toHaveBeenCalledTimes(1);
  });

  it('一次变更只安排一轮检查，连续重建只恢复一次', async () => {
    const host = mountHost('Hello');
    healer.remember('Hello', '你好', host);

    rebuildChildren(host, 'Hello');
    rebuildChildren(host, 'Hello');
    rebuildChildren(host, 'Hello');
    await settle();

    expect(restore).toHaveBeenCalledTimes(1);
  });
});
