// @vitest-environment jsdom
/**
 * D5 任务测试
 *
 * 用 jsdom + 假提交验证 P6.1 的统一提交与结果回显：
 * - Ctrl 单段与整页都发 `ST_PAGE_SUBMIT`，只用 `scope` 区分；
 * - 整页首次提交、页面会话、滚动 200ms 防抖与段落 id 增量去重；
 * - 提交记录、结果帧路由（START / DELTA / DONE / ERROR）、迟到与作废帧丢弃；
 * - 提交成功/失败、重复触发、清除、页面生命周期与日志契约。
 * 不加载真实 chrome，不联网。
 */

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { ERROR_CODES, MESSAGE_TYPES } from '../../src/shared/protocol.js';
import { DISPLAY_UPDATE_THROTTLE_MS } from '../../src/shared/constants.js';
import { HOST_ATTR, TRANSLATION_ATTR, ensureHost } from '../../src/content/dom/scanner.js';
import { createRenderer } from '../../src/content/dom/renderer.js';
import { createTask } from '../../src/content/task.js';

/** 段落 id 的形状：h + 6 位实例标记 + - + 序号。 */
const HOST_ID_PATTERN = /^h[a-z0-9]{6}-\d+$/;

/** @type {ReturnType<typeof createRenderer>} */
let renderer;
/** @type {ReturnType<typeof createTask>} */
let task;

/**
 * @param {string} html
 * @param {string} [id]
 * @returns {Element}
 */
function mount(html, id = 'p') {
  document.body.innerHTML = html;
  return document.getElementById(id);
}

/**
 * @param {string[]} texts
 * @returns {Element[]}
 */
function mountTexts(texts) {
  document.body.innerHTML = texts.map((text, index) => `<p id="p${index}">${text}</p>`).join('');
  return texts.map((_, index) => document.getElementById(`p${index}`));
}

/**
 * 在现有文档末尾追加段落，保留原有宿主与其标记。
 * @param {string[]} texts
 * @param {number} [startIndex]
 * @returns {Element[]}
 */
function appendTexts(texts, startIndex = 0) {
  const hosts = texts.map((text, index) => {
    const element = document.createElement('p');
    element.id = `p${startIndex + index}`;
    element.textContent = text;
    document.body.appendChild(element);
    return element;
  });
  return hosts;
}

/**
 * @param {Element} host
 * @returns {Element | null}
 */
function translationOf(host) {
  return host.querySelector(`[${TRANSLATION_ATTR}]`);
}

/**
 * 读取状态文本。
 * @param {Element} host
 * @returns {string}
 */
function textOf(host) {
  const container = translationOf(host);
  return container?.querySelector('font')?.textContent ?? '';
}

/**
 * 构造扫描结果：index 按数组顺序，宿主都补上段落 id（模拟 D1 的职责）。
 * @param {Element[]} hosts
 * @param {string[]} texts
 * @returns {Array<{ index: number, text: string, host: Element }>}
 */
function paragraphsOf(hosts, texts) {
  return hosts.map((host, index) => {
    ensureHost(host);
    return {
      index,
      text: texts[index],
      host,
    };
  });
}

/**
 * 成功回执的假提交。
 * @returns {import('vitest').Mock}
 */
function acceptedSubmit() {
  return vi.fn(async (payload) => ({
    ok: true,
    data: {
      accepted: true,
      requestId: payload.requestId,
      scope: payload.scope,
      paragraphs: payload.paragraphs.length,
      chars: payload.paragraphs.reduce((sum, paragraph) => sum + paragraph.text.length, 0),
    },
  }));
}

/**
 * 用注入的扫描、提交与结果来源重建任务。
 * @param {{ scan?: Function, submit?: Function, inViewport?: Function, logger?: object, resultsFactory?: Function }} [deps]
 * @returns {ReturnType<typeof createTask>}
 */
function pageTask({
  scan = async () => [],
  submit = acceptedSubmit(),
  inViewport,
  logger,
  resultsFactory,
} = {}) {
  task = createTask({
    renderer,
    submit,
    scan,
    ...(inViewport ? { inViewport } : {}),
    ...(logger ? { logger } : {}),
    ...(resultsFactory ? { resultsFactory } : {}),
  });
  return task;
}

/**
 * 记录调用的结果来源桩：不自己造帧，用例直接调用 `task.applyResultFrame`。
 * @returns {{ start: Function, cancelAll: Function, setMode: Function, getMode: Function, starts: object[], cancels: number }}
 */
function resultSourceStub() {
  const source = {
    starts: [],
    cancels: 0,
    mode: 'normal',
    start: vi.fn((submission) => {
      source.starts.push(submission);
    }),
    cancelAll: vi.fn(() => {
      source.cancels += 1;
    }),
    setMode: vi.fn((mode) => {
      source.mode = mode;
    }),
    getMode: vi.fn(() => source.mode),
  };
  return source;
}

/**
 * 组装一条结果帧。
 * @param {string} type
 * @param {string} requestId
 * @param {string} itemId
 * @param {object} [extra]
 * @returns {{ type: string, payload: object }}
 */
function frameOf(type, requestId, itemId, extra = {}) {
  return { type, payload: { requestId, itemId, ...extra } };
}

/**
 * 派发滚动并推进 200ms 防抖。
 */
async function scrollAndWait() {
  window.dispatchEvent(new Event('scroll'));
  await vi.advanceTimersByTimeAsync(200);
}

beforeEach(() => {
  vi.useFakeTimers();
  document.body.innerHTML = '';
  window.innerWidth = 1280;
  window.innerHeight = 800;
  renderer = createRenderer({ document });
  task = createTask({ renderer, submit: acceptedSubmit(), scan: async () => [] });
});

afterEach(() => {
  task?.dispose?.();
  vi.unstubAllGlobals();
  vi.useRealTimers();
});

// ---------------------------------------------------------------------------
// 整页首次提交
// ---------------------------------------------------------------------------

describe('D5 整页统一提交（P6.1）：成功路径', () => {
  it('start 扫描后只提交一次，成功返回 submitted 并为每段写「已提交」标记', async () => {
    const hosts = mountTexts(['Hello', 'World']);
    const scan = vi.fn(async () => paragraphsOf(hosts, ['Hello', 'World']));
    const submit = acceptedSubmit();
    pageTask({ scan, submit });

    const response = await task.start({ targetLang: 'zh', traceId: 't-page-1' });

    expect(response).toEqual({ ok: true, data: { phase: 'submitted', total: 2 } });
    expect(scan).toHaveBeenCalledTimes(1);
    expect(submit).toHaveBeenCalledTimes(1);

    const payload = submit.mock.calls[0][0];
    expect(payload.requestId).toMatch(/^s-/);
    expect(payload.traceId).toBe('t-page-1');
    expect(payload.scope).toBe('page');
    expect(payload.targetLang).toBe('zh');
    expect(payload.domain).toBe(location.hostname);
    expect(payload.viewport).toEqual({ width: 1280, height: 800 });
    expect(payload.paragraphs).toEqual([
      { index: 0, hostId: hosts[0].getAttribute(HOST_ATTR), text: 'Hello' },
      { index: 1, hostId: hosts[1].getAttribute(HOST_ATTR), text: 'World' },
    ]);
    expect(payload.paragraphs[1]).not.toHaveProperty('context');
    expect(payload).not.toHaveProperty('batch');

    for (const host of hosts) {
      expect(renderer.getState(host)).toBe('submitted');
      expect(translationOf(host).getAttribute('data-st-state')).toBe('submitted');
      expect(textOf(host)).toBe('已提交，等待翻译');
    }
    expect(task.getStatus()).toEqual({ phase: 'submitted', total: 2 });
  });

  it('没有 targetLang / traceId 时载荷不带对应字段，requestId 仍为 s- 前缀', async () => {
    const hosts = mountTexts(['Hello']);
    const submit = acceptedSubmit();
    pageTask({ scan: async () => paragraphsOf(hosts, ['Hello']), submit });

    const response = await task.start();

    expect(response).toEqual({ ok: true, data: { phase: 'submitted', total: 1 } });
    const payload = submit.mock.calls[0][0];
    expect(payload.requestId).toMatch(/^s-/);
    expect(payload.scope).toBe('page');
    expect(payload).not.toHaveProperty('traceId');
    expect(payload).not.toHaveProperty('targetLang');
  });

  it('提交载荷的段落只有 index / hostId / text，不带上下文', async () => {
    const hosts = mountTexts(['One', 'Two']);
    const submit = acceptedSubmit();
    pageTask({ scan: async () => paragraphsOf(hosts, ['One', 'Two']), submit });

    await task.start({ targetLang: 'zh' });

    for (const paragraph of submit.mock.calls[0][0].paragraphs) {
      expect(Object.keys(paragraph).sort()).toEqual(['hostId', 'index', 'text']);
      expect(paragraph.hostId).toMatch(HOST_ID_PATTERN);
    }
  });

  it('同文本段落不去重：各自占一个 index、各自提交并各自标记', async () => {
    const hosts = mountTexts(['Same text', 'Same text']);
    const submit = acceptedSubmit();
    pageTask({ scan: async () => paragraphsOf(hosts, ['Same text', 'Same text']), submit });

    const response = await task.start({ targetLang: 'zh' });

    expect(response).toEqual({ ok: true, data: { phase: 'submitted', total: 2 } });
    const paragraphs = submit.mock.calls[0][0].paragraphs;
    expect(paragraphs.map((paragraph) => paragraph.index)).toEqual([0, 1]);
    expect(paragraphs[0].hostId).not.toBe(paragraphs[1].hostId);
    expect(document.querySelectorAll(`[${TRANSLATION_ATTR}]`)).toHaveLength(2);
    for (const host of hosts) expect(renderer.getState(host)).toBe('submitted');
  });

  it('视口附近没有段落时返回 idle / total 0，不提交也不监听滚动', async () => {
    const scan = vi.fn(async () => []);
    const submit = acceptedSubmit();
    pageTask({ scan, submit });

    const response = await task.start({ targetLang: 'zh' });

    expect(response).toEqual({ ok: true, data: { phase: 'idle', total: 0 } });
    expect(scan).toHaveBeenCalledTimes(1);
    expect(submit).not.toHaveBeenCalled();
    expect(task.getStatus()).toEqual({ phase: 'idle', total: 0 });
    expect(document.querySelector(`[${TRANSLATION_ATTR}]`)).toBe(null);

    await scrollAndWait();
    expect(submit).not.toHaveBeenCalled();
  });

  it('注入的 inViewport 会传给扫描，并注入日志入口', async () => {
    let options;
    const inViewport = () => true;
    pageTask({
      scan: async (received) => {
        options = received;
        return [];
      },
      inViewport,
    });

    await task.start({ targetLang: 'zh' });

    expect(options.inViewport).toBe(inViewport);
    expect(typeof options.logger?.debug).toBe('function');
    expect(typeof options.logger?.info).toBe('function');
  });
});

// ---------------------------------------------------------------------------
// 失败路径
// ---------------------------------------------------------------------------

describe('D5 整页统一提交（P6.1）：失败路径', () => {
  it('提交返回 ok:false 时所有段落 error，错误码与消息沿用后台', async () => {
    const hosts = mountTexts(['Hello', 'World']);
    const submit = vi.fn(async () => ({
      ok: false,
      error: { code: ERROR_CODES.CONFIG, message: '缺少密钥，请先在设置页保存密钥' },
    }));
    pageTask({ scan: async () => paragraphsOf(hosts, ['Hello', 'World']), submit });

    const response = await task.start({ targetLang: 'zh' });

    expect(response).toEqual({
      ok: false,
      error: { code: ERROR_CODES.CONFIG, message: '缺少密钥，请先在设置页保存密钥' },
    });
    for (const host of hosts) {
      expect(renderer.getState(host)).toBe('error');
      expect(textOf(host)).toContain('缺少密钥');
    }
    expect(task.getStatus().phase).toBe('error');
  });

  it('提交抛错时返回 NETWORK，并把所有段落标为失败', async () => {
    const hosts = mountTexts(['Hello', 'World']);
    const submit = vi.fn(async () => {
      throw new Error('boom');
    });
    pageTask({ scan: async () => paragraphsOf(hosts, ['Hello', 'World']), submit });

    const response = await task.start({ targetLang: 'zh' });

    expect(response.ok).toBe(false);
    expect(response.error.code).toBe(ERROR_CODES.NETWORK);
    for (const host of hosts) expect(renderer.getState(host)).toBe('error');
    expect(task.getStatus().phase).toBe('error');
  });

  it('提交返回 ok:true 但 accepted 不为 true 时按失败处理', async () => {
    const hosts = mountTexts(['Hello']);
    const submit = vi.fn(async () => ({ ok: true, data: { accepted: false } }));
    pageTask({ scan: async () => paragraphsOf(hosts, ['Hello']), submit });

    const response = await task.start({ targetLang: 'zh' });

    expect(response.ok).toBe(false);
    expect(renderer.getState(hosts[0])).toBe('error');
    expect(task.getStatus().phase).toBe('error');
  });

  it('扫描抛错返回 OTHER「扫描页面失败，请稍后重试」，不提交', async () => {
    const submit = acceptedSubmit();
    pageTask({
      scan: async () => {
        throw new Error('boom');
      },
      submit,
    });

    const response = await task.start({ targetLang: 'zh' });

    expect(response).toEqual({
      ok: false,
      error: { code: ERROR_CODES.OTHER, message: '扫描页面失败，请稍后重试' },
    });
    expect(submit).not.toHaveBeenCalled();
    expect(task.getStatus().phase).toBe('error');
  });

  it('提交失败时页面提示以「提交失败：」开头', async () => {
    const hosts = mountTexts(['Hello']);
    const submit = vi.fn(async () => ({
      ok: false,
      error: { code: ERROR_CODES.NETWORK, message: '网络不可用' },
    }));
    pageTask({ scan: async () => paragraphsOf(hosts, ['Hello']), submit });

    await task.start({ targetLang: 'zh' });

    expect(textOf(hosts[0])).toMatch(/^提交失败：/);
  });
});

// ---------------------------------------------------------------------------
// 并发、重复触发与清除
// ---------------------------------------------------------------------------

describe('D5 整页统一提交（P6.1）：并发、重复触发与清除', () => {
  it('扫描进行中再次 start 返回 scanning / total 0，不重复扫描或提交', async () => {
    const host = mountTexts(['Hello'])[0];
    let resolveScan;
    const scan = vi.fn(
      () =>
        new Promise((resolve) => {
          resolveScan = resolve;
        })
    );
    const submit = acceptedSubmit();
    pageTask({ scan, submit });

    const first = task.start({ targetLang: 'zh' });
    const second = await task.start({ targetLang: 'zh' });

    expect(second).toEqual({ ok: true, data: { phase: 'scanning', total: 0 } });
    expect(scan).toHaveBeenCalledTimes(1);
    expect(submit).not.toHaveBeenCalled();

    resolveScan(paragraphsOf([host], ['Hello']));
    expect(await first).toEqual({ ok: true, data: { phase: 'submitted', total: 1 } });
    expect(submit).toHaveBeenCalledTimes(1);
  });

  it('提交进行中再次 start 返回 submitting，不重复提交', async () => {
    const hosts = mountTexts(['Hello']);
    let releaseSubmit;
    let markSubmitCalled;
    const submitCalled = new Promise((resolve) => {
      markSubmitCalled = resolve;
    });
    const submit = vi.fn(() => {
      markSubmitCalled();
      return new Promise((resolve) => {
        releaseSubmit = resolve;
      });
    });
    pageTask({ scan: async () => paragraphsOf(hosts, ['Hello']), submit });

    const first = task.start({ targetLang: 'zh' });
    await submitCalled;
    const second = await task.start({ targetLang: 'zh' });

    expect(second).toEqual({ ok: true, data: { phase: 'submitting', total: 0 } });
    expect(submit).toHaveBeenCalledTimes(1);

    releaseSubmit({ ok: true, data: { accepted: true } });
    expect(await first).toEqual({ ok: true, data: { phase: 'submitted', total: 1 } });
  });

  it('重复触发先移除旧标记再重新扫描并提交新 requestId', async () => {
    const hosts = mountTexts(['Hello', 'World']);
    const containerCounts = [];
    const scan = vi.fn(async () => {
      containerCounts.push(document.querySelectorAll(`[${TRANSLATION_ATTR}]`).length);
      return paragraphsOf(hosts, ['Hello', 'World']);
    });
    const submit = acceptedSubmit();
    pageTask({ scan, submit });

    expect(await task.start({ targetLang: 'zh' })).toEqual({
      ok: true,
      data: { phase: 'submitted', total: 2 },
    });
    const firstRequestId = submit.mock.calls[0][0].requestId;

    expect(await task.start({ targetLang: 'zh' })).toEqual({
      ok: true,
      data: { phase: 'submitted', total: 2 },
    });

    expect(containerCounts).toEqual([0, 0]);
    expect(submit).toHaveBeenCalledTimes(2);
    const secondRequestId = submit.mock.calls[1][0].requestId;
    expect(secondRequestId).toMatch(/^s-/);
    expect(secondRequestId).not.toBe(firstRequestId);
    expect(document.querySelectorAll(`[${TRANSLATION_ATTR}]`)).toHaveLength(2);
    for (const host of hosts) expect(renderer.getState(host)).toBe('submitted');
  });

  it('重复触发时视口附近没有段落：返回 idle 并清理旧标记', async () => {
    const hosts = mountTexts(['One', 'Two']);
    const scan = vi
      .fn()
      .mockResolvedValueOnce(paragraphsOf(hosts, ['One', 'Two']))
      .mockResolvedValueOnce([]);
    const submit = acceptedSubmit();
    pageTask({ scan, submit });

    await task.start({ targetLang: 'zh' });
    expect(document.querySelectorAll(`[${TRANSLATION_ATTR}]`)).toHaveLength(2);

    const response = await task.start({ targetLang: 'zh' });

    expect(response).toEqual({ ok: true, data: { phase: 'idle', total: 0 } });
    expect(document.querySelectorAll(`[${TRANSLATION_ATTR}]`)).toHaveLength(0);
    expect(task.getStatus()).toEqual({ phase: 'idle', total: 0 });
    expect(submit).toHaveBeenCalledTimes(1);
  });

  it('clearAll 只返回 removed，清空 DOM 并停止滚动提交', async () => {
    const hosts = mountTexts(['One', 'Two']);
    const submit = acceptedSubmit();
    pageTask({
      scan: async () => paragraphsOf(hosts, ['One', 'Two']),
      submit,
    });
    await task.start({ targetLang: 'zh' });

    const singleHost = document.createElement('p');
    singleHost.textContent = 'Single';
    document.body.appendChild(singleHost);
    await task.toggle(singleHost);
    expect(submit).toHaveBeenCalledTimes(2);

    const result = task.clearAll();

    expect(result).toEqual({ ok: true, data: { removed: 3 } });
    expect(result.data).not.toHaveProperty('cancelled');
    expect(document.querySelectorAll(`[${TRANSLATION_ATTR}]`)).toHaveLength(0);
    expect(task.getStatus()).toEqual({ phase: 'idle', total: 0 });
    for (const host of [...hosts, singleHost]) {
      expect(host.getAttribute(HOST_ATTR)).toMatch(HOST_ID_PATTERN);
    }

    await scrollAndWait();
    expect(submit).toHaveBeenCalledTimes(2);
  });
});

// ---------------------------------------------------------------------------
// 滚动增量
// ---------------------------------------------------------------------------

describe('D5 整页统一提交（P6.1）：滚动增量', () => {
  it('滚动停止 200ms 后只提交新 hostId，并保留已提交标记', async () => {
    const hosts = mountTexts(['A', 'B']);
    const texts = ['A', 'B', 'C', 'D'];
    let scanned = paragraphsOf(hosts, ['A', 'B']);
    const scan = vi.fn(async () => scanned);
    const submit = acceptedSubmit();
    pageTask({ scan, submit });

    await task.start({ targetLang: 'zh' });
    expect(submit).toHaveBeenCalledTimes(1);

    const extraHosts = appendTexts(['C', 'D'], 2);
    const allHosts = [...hosts, ...extraHosts];
    scanned = paragraphsOf(allHosts, texts);
    await scrollAndWait();

    expect(submit).toHaveBeenCalledTimes(2);
    const payload = submit.mock.calls[1][0];
    expect(payload.scope).toBe('page');
    expect(payload.paragraphs.map((paragraph) => paragraph.hostId)).toEqual([
      allHosts[2].getAttribute(HOST_ATTR),
      allHosts[3].getAttribute(HOST_ATTR),
    ]);
    expect(task.getStatus()).toEqual({ phase: 'submitted', total: 4 });
    for (const host of allHosts) expect(renderer.getState(host)).toBe('submitted');

    // 已提交区域再次滚动不重复提交。
    await scrollAndWait();
    expect(submit).toHaveBeenCalledTimes(2);
  });

  it('滚动事件按 200ms 防抖，只在停止后提交一次', async () => {
    const hosts = mountTexts(['A', 'B']);
    const texts = ['A', 'B', 'C', 'D'];
    let scanned = paragraphsOf(hosts, ['A', 'B']);
    const submit = acceptedSubmit();
    pageTask({ scan: async () => scanned, submit });

    await task.start({ targetLang: 'zh' });

    const extraHosts = appendTexts(['C', 'D'], 2);
    const allHosts = [...hosts, ...extraHosts];
    scanned = paragraphsOf(allHosts, texts);
    window.dispatchEvent(new Event('scroll'));
    await vi.advanceTimersByTimeAsync(100);
    window.dispatchEvent(new Event('scroll'));
    await vi.advanceTimersByTimeAsync(100);
    window.dispatchEvent(new Event('scroll'));
    await vi.advanceTimersByTimeAsync(200);

    expect(submit).toHaveBeenCalledTimes(2);
  });

  it('滚动增量提交失败只标当前批，页面会话保持 submitted，再次触发可重试', async () => {
    const hosts = mountTexts(['A', 'B']);
    const texts = ['A', 'B', 'C', 'D'];
    let scanned = paragraphsOf(hosts, ['A', 'B']);
    const submit = vi
      .fn()
      .mockResolvedValueOnce({
        ok: true,
        data: { accepted: true, paragraphs: 2, chars: 2 },
      })
      .mockResolvedValueOnce({
        ok: false,
        error: { code: ERROR_CODES.NETWORK, message: '离线' },
      })
      .mockResolvedValue({
        ok: true,
        data: { accepted: true, paragraphs: 4, chars: 4 },
      });
    pageTask({ scan: async () => scanned, submit });

    await task.start({ targetLang: 'zh' });

    const extraHosts = appendTexts(['C', 'D'], 2);
    const allHosts = [...hosts, ...extraHosts];
    scanned = paragraphsOf(allHosts, texts);
    await scrollAndWait();

    expect(task.getStatus().phase).toBe('submitted');
    expect(renderer.getState(allHosts[2])).toBe('error');
    expect(renderer.getState(allHosts[3])).toBe('error');

    // 失败批已尝试过，继续滚动不会自动重试。
    await scrollAndWait();
    expect(submit).toHaveBeenCalledTimes(2);

    // 重新触发会清空标记与尝试集合，再次提交全部段落。
    const response = await task.start({ targetLang: 'zh' });
    expect(response).toEqual({ ok: true, data: { phase: 'submitted', total: 4 } });
    expect(submit).toHaveBeenCalledTimes(3);
    for (const host of allHosts) expect(renderer.getState(host)).toBe('submitted');
  });

  it('dispose 停止滚动监听，resume 在页面会话仍有效时重新安装', async () => {
    const hosts = mountTexts(['A', 'B']);
    const texts = ['A', 'B', 'C'];
    let scanned = paragraphsOf(hosts, ['A', 'B']);
    const submit = acceptedSubmit();
    pageTask({ scan: async () => scanned, submit });

    await task.start({ targetLang: 'zh' });

    task.dispose();
    const [hostC] = appendTexts(['C'], 2);
    const allHosts = [...hosts, hostC];
    scanned = paragraphsOf(allHosts, texts);
    await scrollAndWait();
    expect(submit).toHaveBeenCalledTimes(1);

    task.resume();
    await scrollAndWait();
    expect(submit).toHaveBeenCalledTimes(2);
    expect(renderer.getState(hostC)).toBe('submitted');
  });
});

// ---------------------------------------------------------------------------
// Ctrl 单段
// ---------------------------------------------------------------------------

describe('D5 统一提交（P6.1）：Ctrl 单段', () => {
  it('toggle 发 scope=single、1 段提交，成功后显示已提交', async () => {
    const p = mount('<p id="p">Hello world</p>');
    const submit = acceptedSubmit();
    pageTask({ submit });

    const result = await task.toggle(p, 't-1');

    expect(result).toEqual({ ok: true, data: { action: 'submitted' } });
    expect(submit).toHaveBeenCalledTimes(1);
    const payload = submit.mock.calls[0][0];
    expect(payload.scope).toBe('single');
    expect(payload.traceId).toBe('t-1');
    expect(payload.paragraphs).toHaveLength(1);
    expect(payload.paragraphs[0]).toMatchObject({
      index: 0,
      hostId: p.getAttribute(HOST_ATTR),
      text: 'Hello world',
    });
    expect(payload).not.toHaveProperty('targetLang');
    expect(renderer.getState(p)).toBe('submitted');
    expect(textOf(p)).toBe('已提交，等待翻译');
    expect(task.getStatus().total).toBe(1);
  });

  it('指针不在可译段落上时返回 no-target', async () => {
    expect(await task.toggle(null)).toEqual({ ok: true, data: { action: 'no-target' } });
    const num = mount('<p id="p">123</p>');
    expect(await task.toggle(num)).toEqual({ ok: true, data: { action: 'no-target' } });
  });

  it('单段不再本地拦截超长文本', async () => {
    const text = 'a'.repeat(5000);
    const p = mount(`<p id="p">${text}</p>`);
    const submit = acceptedSubmit();
    pageTask({ submit });

    const result = await task.toggle(p);

    expect(result).toEqual({ ok: true, data: { action: 'submitted' } });
    expect(submit.mock.calls[0][0].paragraphs[0].text).toHaveLength(5000);
  });

  it('已提交或失败的标记再次 toggle 只移除标记，不发起提交', async () => {
    const p = mount('<p id="p">Hello</p>');
    const submit = vi
      .fn()
      .mockResolvedValueOnce({
        ok: false,
        error: { code: ERROR_CODES.NETWORK, message: '离线' },
      })
      .mockResolvedValueOnce({
        ok: true,
        data: { accepted: true, paragraphs: 1, chars: 5 },
      });
    pageTask({ submit });

    const failed = await task.toggle(p);
    expect(failed.ok).toBe(false);
    expect(renderer.getState(p)).toBe('error');

    expect(await task.toggle(p)).toEqual({ ok: true, data: { action: 'hidden' } });
    expect(renderer.getState(p)).toBe(null);
    expect(submit).toHaveBeenCalledTimes(1);
  });

  it('提交中再次 toggle 返回 submitting，不重复提交', async () => {
    const p = mount('<p id="p">Hello</p>');
    let releaseSubmit;
    const submit = vi.fn(
      () =>
        new Promise((resolve) => {
          releaseSubmit = resolve;
        })
    );
    pageTask({ submit });

    const first = task.toggle(p);
    const second = await task.toggle(p);

    expect(second).toEqual({ ok: true, data: { action: 'submitting' } });
    expect(submit).toHaveBeenCalledTimes(1);

    releaseSubmit({ ok: true, data: { accepted: true } });
    expect(await first).toEqual({ ok: true, data: { action: 'submitted' } });
  });

  it('提交中 clearAll 后旧响应不重新写入标记', async () => {
    const p = mount('<p id="p">Hello</p>');
    let releaseSubmit;
    const submit = vi.fn(
      () =>
        new Promise((resolve) => {
          releaseSubmit = resolve;
        })
    );
    pageTask({ submit });

    const pending = task.toggle(p);
    expect(renderer.getState(p)).toBe('submitting');

    const cleared = task.clearAll();
    expect(cleared).toEqual({ ok: true, data: { removed: 1 } });

    releaseSubmit({ ok: true, data: { accepted: true } });
    expect(await pending).toEqual({ ok: true, data: { action: 'hidden' } });
    expect(renderer.getState(p)).toBe(null);
    expect(task.getStatus().total).toBe(0);
  });

  it('单段提交失败返回 ok:false，错误标记可再次移除', async () => {
    const p = mount('<p id="p">Hello</p>');
    const submit = vi.fn(async () => ({
      ok: false,
      error: { code: ERROR_CODES.NETWORK, message: '离线' },
    }));
    pageTask({ submit });

    const result = await task.toggle(p);

    expect(result.ok).toBe(false);
    expect(result.error.code).toBe(ERROR_CODES.NETWORK);
    expect(renderer.getState(p)).toBe('error');
    expect(textOf(p)).toBe('提交失败：离线');
  });

  it('单段成功加入已提交集合，页面滚动不会重复提交它', async () => {
    const hosts = mountTexts(['A', 'B']);
    const texts = ['A', 'B', 'C'];
    let scanned = paragraphsOf(hosts, ['A', 'B']);
    const submit = acceptedSubmit();
    pageTask({ scan: async () => scanned, submit });

    await task.start({ targetLang: 'zh' });
    expect(submit).toHaveBeenCalledTimes(1);

    const extraHosts = appendTexts(['C'], 2);
    const allHosts = [...hosts, ...extraHosts];
    scanned = paragraphsOf(allHosts, texts);
    await task.toggle(allHosts[2]);
    expect(submit).toHaveBeenCalledTimes(2);

    await scrollAndWait();
    expect(submit).toHaveBeenCalledTimes(2);
  });

  it('页面会话进行中，toggle 已提交段落只移除标记，不改变 phase', async () => {
    const hosts = mountTexts(['Hello', 'World']);
    pageTask({
      scan: async () => paragraphsOf(hosts, ['Hello', 'World']),
      submit: acceptedSubmit(),
    });
    await task.start({ targetLang: 'zh' });

    expect(await task.toggle(hosts[0])).toEqual({ ok: true, data: { action: 'hidden' } });

    expect(translationOf(hosts[0])).toBe(null);
    expect(renderer.getState(hosts[1])).toBe('submitted');
    expect(task.getStatus().phase).toBe('submitted');
  });
});

// ---------------------------------------------------------------------------
// 结果回显
// ---------------------------------------------------------------------------

describe('D5 结果回显（P6.1）', () => {
  /**
   * 启动一次整页提交，返回宿主、提交桩、结果来源与 requestId。
   * @param {string[]} [texts]
   * @returns {Promise<{ hosts: Element[], submit: import('vitest').Mock, source: object, requestId: string }>}
   */
  async function startPage(texts = ['Hello', 'World']) {
    const hosts = mountTexts(texts);
    const submit = acceptedSubmit();
    const source = resultSourceStub();
    pageTask({
      scan: async () => paragraphsOf(hosts, texts),
      submit,
      resultsFactory: () => source,
    });
    await task.start({ targetLang: 'zh' });
    return { hosts, submit, source, requestId: submit.mock.calls[0][0].requestId };
  }

  it('提交成功后把提交记录交给结果来源，START/DELTA/DONE 落到对应段落', async () => {
    const { hosts, source, requestId } = await startPage();
    expect(source.starts).toHaveLength(1);
    expect(source.starts[0].requestId).toBe(requestId);
    expect(source.starts[0].items.size).toBe(2);

    const [first, second] = hosts;
    const firstId = first.getAttribute(HOST_ATTR);

    expect(task.applyResultFrame(frameOf(MESSAGE_TYPES.ITEM_START, requestId, firstId))).toBe(true);
    expect(renderer.getState(first)).toBe('loading');
    expect(textOf(first)).toBe('翻译中…');
    expect(renderer.getState(second)).toBe('submitted');

    expect(
      task.applyResultFrame(
        frameOf(MESSAGE_TYPES.ITEM_DELTA, requestId, firstId, { delta: '【模拟 ' })
      )
    ).toBe(true);
    await vi.advanceTimersByTimeAsync(DISPLAY_UPDATE_THROTTLE_MS);
    expect(renderer.getState(first)).toBe('streaming');
    expect(textOf(first)).toBe('【模拟 ');

    expect(
      task.applyResultFrame(
        frameOf(MESSAGE_TYPES.ITEM_DELTA, requestId, firstId, { delta: `${firstId}】Hello` })
      )
    ).toBe(true);
    await vi.advanceTimersByTimeAsync(DISPLAY_UPDATE_THROTTLE_MS);
    expect(textOf(first)).toBe(`【模拟 ${firstId}】Hello`);

    expect(
      task.applyResultFrame(
        frameOf(MESSAGE_TYPES.ITEM_DONE, requestId, firstId, {
          text: `【模拟 ${firstId}】Hello world`,
        })
      )
    ).toBe(true);
    expect(renderer.getState(first)).toBe('done');
    expect(textOf(first)).toBe(`【模拟 ${firstId}】Hello world`);
    expect(renderer.getState(second)).toBe('submitted');
  });

  it('缓存回显式的 START → DONE（零增量）同样显示定稿译文', async () => {
    const { hosts, requestId } = await startPage(['Hello']);
    const host = hosts[0];
    const itemId = host.getAttribute(HOST_ATTR);

    expect(task.applyResultFrame(frameOf(MESSAGE_TYPES.ITEM_START, requestId, itemId))).toBe(true);
    expect(renderer.getState(host)).toBe('loading');

    expect(
      task.applyResultFrame(
        frameOf(MESSAGE_TYPES.ITEM_DONE, requestId, itemId, { text: `【模拟 ${itemId}】Hello` })
      )
    ).toBe(true);
    expect(renderer.getState(host)).toBe('done');
    expect(textOf(host)).toBe(`【模拟 ${itemId}】Hello`);
  });

  it('ITEM_ERROR 显示「翻译失败：」并保持页面会话', async () => {
    const { hosts, requestId } = await startPage(['Hello']);
    const host = hosts[0];
    const itemId = host.getAttribute(HOST_ATTR);

    task.applyResultFrame(frameOf(MESSAGE_TYPES.ITEM_START, requestId, itemId));

    expect(
      task.applyResultFrame(
        frameOf(MESSAGE_TYPES.ITEM_ERROR, requestId, itemId, {
          code: ERROR_CODES.NETWORK,
          message: '模拟失败',
        })
      )
    ).toBe(true);
    expect(renderer.getState(host)).toBe('error');
    expect(textOf(host)).toBe('翻译失败：模拟失败');
    expect(task.getStatus().phase).toBe('submitted');
  });

  it('未知 requestId、未知 itemId、非结果帧与空帧都丢弃且不改页面', async () => {
    const { hosts, requestId } = await startPage(['Hello']);
    const host = hosts[0];
    const itemId = host.getAttribute(HOST_ATTR);

    expect(
      task.applyResultFrame(frameOf(MESSAGE_TYPES.ITEM_DONE, 's-unknown', itemId, { text: 'x' }))
    ).toBe(false);
    expect(
      task.applyResultFrame(frameOf(MESSAGE_TYPES.ITEM_DONE, requestId, 'hunknown-1', { text: 'x' }))
    ).toBe(false);
    expect(task.applyResultFrame({ type: MESSAGE_TYPES.LOG_CONFIG, payload: {} })).toBe(false);
    expect(task.applyResultFrame(null)).toBe(false);
    expect(task.applyResultFrame({ type: MESSAGE_TYPES.ITEM_DONE })).toBe(false);

    expect(renderer.getState(host)).toBe('submitted');
    expect(textOf(host)).toBe('已提交，等待翻译');
  });

  it('宿主已断开时丢弃结果帧', async () => {
    const { hosts, requestId } = await startPage(['Hello']);
    const host = hosts[0];
    const itemId = host.getAttribute(HOST_ATTR);
    host.remove();

    expect(
      task.applyResultFrame(frameOf(MESSAGE_TYPES.ITEM_DONE, requestId, itemId, { text: 'x' }))
    ).toBe(false);
  });

  it('重新触发后旧 requestId 的结果帧被丢弃，新 requestId 正常生效', async () => {
    const { hosts, submit, requestId: firstRequestId } = await startPage(['Hello']);
    const host = hosts[0];
    const itemId = host.getAttribute(HOST_ATTR);

    await task.start({ targetLang: 'zh' });
    const secondRequestId = submit.mock.calls[1][0].requestId;
    expect(secondRequestId).not.toBe(firstRequestId);

    expect(
      task.applyResultFrame(
        frameOf(MESSAGE_TYPES.ITEM_DONE, firstRequestId, itemId, { text: '旧结果' })
      )
    ).toBe(false);
    expect(
      task.applyResultFrame(
        frameOf(MESSAGE_TYPES.ITEM_DONE, secondRequestId, itemId, { text: '新结果' })
      )
    ).toBe(true);
    expect(textOf(host)).toBe('新结果');
  });

  it('重复 START 不打断已定稿段落，DONE 后 DELTA 被忽略', async () => {
    const { hosts, requestId } = await startPage(['Hello']);
    const host = hosts[0];
    const itemId = host.getAttribute(HOST_ATTR);

    task.applyResultFrame(frameOf(MESSAGE_TYPES.ITEM_DONE, requestId, itemId, { text: '定稿' }));
    expect(task.applyResultFrame(frameOf(MESSAGE_TYPES.ITEM_START, requestId, itemId))).toBe(false);
    expect(
      task.applyResultFrame(frameOf(MESSAGE_TYPES.ITEM_DELTA, requestId, itemId, { delta: 'x' }))
    ).toBe(false);
    expect(textOf(host)).toBe('定稿');
  });

  it('清除与卸载会停止结果来源并丢弃在途帧', async () => {
    const { hosts, source, requestId } = await startPage(['Hello']);
    const host = hosts[0];
    const itemId = host.getAttribute(HOST_ATTR);

    task.clearAll();
    expect(source.cancels).toBeGreaterThanOrEqual(1);
    expect(
      task.applyResultFrame(frameOf(MESSAGE_TYPES.ITEM_DONE, requestId, itemId, { text: 'x' }))
    ).toBe(false);
    expect(translationOf(host)).toBe(null);

    await task.start({ targetLang: 'zh' });
    task.dispose();
    expect(source.cancels).toBeGreaterThanOrEqual(2);
  });

  it('setResultMode 转交给结果来源并返回生效模式', async () => {
    const { source } = await startPage(['Hello']);

    expect(task.setResultMode('fail')).toBe('fail');
    expect(source.setMode).toHaveBeenCalledWith('fail');
  });

  it('提交失败时不启动结果来源', async () => {
    const hosts = mountTexts(['Hello']);
    const source = resultSourceStub();
    pageTask({
      scan: async () => paragraphsOf(hosts, ['Hello']),
      submit: vi.fn(async () => ({
        ok: false,
        error: { code: ERROR_CODES.NETWORK, message: '离线' },
      })),
      resultsFactory: () => source,
    });

    await task.start({ targetLang: 'zh' });

    expect(source.start).not.toHaveBeenCalled();
    expect(source.starts).toHaveLength(0);
  });

  it('滚动增量提交的结果也登记到结果来源，并能落到新增段落', async () => {
    const hosts = mountTexts(['A', 'B']);
    let scanned = paragraphsOf(hosts, ['A', 'B']);
    const submit = acceptedSubmit();
    const source = resultSourceStub();
    pageTask({ scan: async () => scanned, submit, resultsFactory: () => source });

    await task.start({ targetLang: 'zh' });
    expect(source.starts).toHaveLength(1);

    const [extra] = appendTexts(['C'], 2);
    scanned = paragraphsOf([...hosts, extra], ['A', 'B', 'C']);
    await scrollAndWait();

    expect(source.starts).toHaveLength(2);
    const requestId = submit.mock.calls[1][0].requestId;
    const itemId = extra.getAttribute(HOST_ATTR);
    expect(source.starts[1].requestId).toBe(requestId);
    expect(
      task.applyResultFrame(
        frameOf(MESSAGE_TYPES.ITEM_DONE, requestId, itemId, { text: `【模拟 ${itemId}】C` })
      )
    ).toBe(true);
    expect(textOf(extra)).toBe(`【模拟 ${itemId}】C`);
  });
});

// ---------------------------------------------------------------------------
// 日志契约
// ---------------------------------------------------------------------------

describe('D5 统一提交（P6.1）：日志契约', () => {
  /**
   * @returns {object}
   */
  function makeLogger() {
    const logger = { debug: vi.fn(), info: vi.fn(), warn: vi.fn() };
    logger.withTrace = vi.fn(() => logger);
    return logger;
  }

  it('整页成功记录 page.submit，不记录原文；后台逐段日志由 A1 输出', async () => {
    const logger = makeLogger();
    const longText = 'A'.repeat(80);
    const hosts = mountTexts([longText, 'World']);
    const submit = acceptedSubmit();
    pageTask({
      scan: async () => paragraphsOf(hosts, [longText, 'World']),
      submit,
      logger,
    });

    await task.start({ targetLang: 'zh', traceId: 't-log' });

    const submitCall = logger.info.mock.calls.find((call) => call[0] === 'page.submit');
    expect(submitCall).toBeTruthy();
    expect(submitCall[2]).toMatchObject({
      requestId: expect.stringMatching(/^s-/),
      scope: 'page',
      paragraphs: 2,
      chars: 85,
      accepted: true,
    });
    expect(typeof submitCall[2].elapsedMs).toBe('number');

    expect(logger.info.mock.calls.some((call) => call[0] === 'page.item')).toBe(false);
    expect(logger.debug.mock.calls.some((call) => call[0] === 'page.item')).toBe(false);
    expect(JSON.stringify(logger.info.mock.calls)).not.toContain(longText);
    expect(JSON.stringify(logger.debug.mock.calls)).not.toContain(longText);
    expect(logger.warn).not.toHaveBeenCalled();
  });

  it('滚动增量记录 page.scroll 与 page.submit', async () => {
    const logger = makeLogger();
    const hosts = mountTexts(['A', 'B']);
    const texts = ['A', 'B', 'C'];
    let scanned = paragraphsOf(hosts, ['A', 'B']);
    const submit = acceptedSubmit();
    pageTask({ scan: async () => scanned, submit, logger });

    await task.start({ targetLang: 'zh' });
    const extraHosts = appendTexts(['C'], 2);
    const allHosts = [...hosts, ...extraHosts];
    scanned = paragraphsOf(allHosts, texts);
    await scrollAndWait();

    const scrollCall = logger.debug.mock.calls.find((call) => call[0] === 'page.scroll');
    expect(scrollCall).toBeTruthy();
    expect(scrollCall[2]).toMatchObject({ added: 1 });
    const submitCalls = logger.info.mock.calls.filter((call) => call[0] === 'page.submit');
    expect(submitCalls).toHaveLength(2);
  });

  it('提交失败记录 page.error（warn），且不含原文', async () => {
    const logger = makeLogger();
    const hosts = mountTexts(['Secret paragraph text']);
    pageTask({
      scan: async () => paragraphsOf(hosts, ['Secret paragraph text']),
      submit: vi.fn(async () => ({
        ok: false,
        error: { code: ERROR_CODES.NETWORK, message: '网络不可用' },
      })),
      logger,
    });

    await task.start({ targetLang: 'zh', traceId: 't-fail' });

    const warnCall = logger.warn.mock.calls.find((call) => call[0] === 'page.error');
    expect(warnCall).toBeTruthy();
    expect(warnCall[2]).toMatchObject({ code: ERROR_CODES.NETWORK });
    expect(JSON.stringify(logger.warn.mock.calls)).not.toContain('Secret paragraph text');
  });

  it('扫描失败记录 page.error（warn）', async () => {
    const logger = makeLogger();
    pageTask({
      scan: async () => {
        throw new Error('boom');
      },
      logger,
    });

    await task.start({ targetLang: 'zh' });

    const warnCall = logger.warn.mock.calls.find((call) => call[0] === 'page.error');
    expect(warnCall).toBeTruthy();
    expect(warnCall[2]).toMatchObject({ code: ERROR_CODES.OTHER });
  });
});
