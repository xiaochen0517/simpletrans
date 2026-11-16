// @vitest-environment jsdom
/**
 * D5 单段任务测试
 *
 * 用 jsdom + 假桥验证切换状态机、批次负载、增量合并、取消、失败与清除；
 * 不加载真实 chrome，不联网。
 */

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { ERROR_CODES, MESSAGE_TYPES } from '../../src/shared/protocol.js';
import { TRANSLATION_ATTR } from '../../src/content/dom/scanner.js';
import { createRenderer } from '../../src/content/dom/renderer.js';
import { createTask } from '../../src/content/task.js';

/** @type {{ batches: object[], cancels: string[], postBatch: Function, cancelBatch: Function }} */
let bridge;
/** @type {ReturnType<typeof createRenderer>} */
let renderer;
/** @type {ReturnType<typeof createTask>} */
let task;

function makeBridge() {
  return {
    batches: [],
    cancels: [],
    postBatch(payload) {
      this.batches.push(payload);
    },
    cancelBatch(requestId) {
      this.cancels.push(requestId);
    },
  };
}

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
 * @param {Element} host
 * @returns {Element | null}
 */
function translationOf(host) {
  return host.querySelector(`[${TRANSLATION_ATTR}]`);
}

beforeEach(() => {
  vi.useFakeTimers();
  document.body.innerHTML = '';
  bridge = makeBridge();
  renderer = createRenderer({ document });
  task = createTask({ bridge, renderer });
});

afterEach(() => {
  task.dispose();
  vi.useRealTimers();
});

describe('D5 首次翻译', () => {
  it('显示加载态并提交单段批次', () => {
    const p = mount('<p id="p">Hello world</p>');
    const result = task.toggle(p, 't-1');

    expect(result).toEqual({ ok: true, data: { action: 'translating' } });
    expect(renderer.getState(p)).toBe('loading');
    expect(translationOf(p).textContent).toBe('正在翻译…');
    expect(bridge.batches).toHaveLength(1);

    const batch = bridge.batches[0];
    expect(batch.requestId).toMatch(/^b-/);
    expect(batch.traceId).toBe('t-1');
    expect(batch.targetLang).toBeUndefined();
    expect(batch.items).toEqual([{ itemId: 'i0', text: 'Hello world' }]);
  });

  it('没有 traceId 时不带该字段', () => {
    const p = mount('<p id="p">Hello</p>');
    task.toggle(p);
    expect(bridge.batches[0]).not.toHaveProperty('traceId');
  });

  it('指针不在可译段落上时返回 no-target', () => {
    expect(task.toggle(null)).toEqual({ ok: true, data: { action: 'no-target' } });
    const num = mount('<p id="p">123</p>');
    expect(task.toggle(num)).toEqual({ ok: true, data: { action: 'no-target' } });
  });

  it('超长段落本地拦截，不发请求', () => {
    const p = mount(`<p id="p">${'a'.repeat(4001)}</p>`);
    expect(task.toggle(p)).toEqual({ ok: true, data: { action: 'too-long' } });
    expect(bridge.batches).toHaveLength(0);
    expect(translationOf(p).textContent).toContain('4000');
  });
});

describe('D5 增量与定稿', () => {
  it('增量按 80 毫秒合并刷新，定稿用最终文本', () => {
    const p = mount('<p id="p">Hello</p>');
    task.toggle(p);
    const requestId = bridge.batches[0].requestId;
    const update = vi.spyOn(renderer, 'update');

    task.onFrame({ type: MESSAGE_TYPES.ITEM_START, payload: { requestId, itemId: 'i0' } });
    task.onFrame({ type: MESSAGE_TYPES.ITEM_DELTA, payload: { requestId, itemId: 'i0', delta: '你' } });
    task.onFrame({ type: MESSAGE_TYPES.ITEM_DELTA, payload: { requestId, itemId: 'i0', delta: '好' } });

    expect(update).not.toHaveBeenCalled();
    vi.advanceTimersByTime(80);
    expect(update).toHaveBeenCalledTimes(1);
    expect(update.mock.calls[0][1]).toBe('你好');
    expect(renderer.getState(p)).toBe('streaming');

    task.onFrame({
      type: MESSAGE_TYPES.ITEM_DONE,
      payload: { requestId, itemId: 'i0', text: '你好世界', usage: null },
    });
    expect(renderer.getState(p)).toBe('done');
    expect(translationOf(p).textContent).toBe('你好世界');
  });

  it('空译文进入错误态', () => {
    const p = mount('<p id="p">Hello</p>');
    task.toggle(p);
    const requestId = bridge.batches[0].requestId;

    task.onFrame({ type: MESSAGE_TYPES.ITEM_DONE, payload: { requestId, itemId: 'i0', text: '  ' } });
    expect(renderer.getState(p)).toBe('error');
    expect(translationOf(p).textContent).toContain('空译文');
  });

  it('过期请求的帧被忽略', () => {
    const p = mount('<p id="p">Hello</p>');
    task.toggle(p);
    task.onFrame({
      type: MESSAGE_TYPES.ITEM_DONE,
      payload: { requestId: 'b-other', itemId: 'i0', text: '不应显示' },
    });
    expect(renderer.getState(p)).toBe('loading');
  });
});

describe('D5 隐藏、取消与重试', () => {
  it('隐藏后再次触发重新提交批次', () => {
    const p = mount('<p id="p">Hello</p>');
    task.toggle(p);
    const first = bridge.batches[0].requestId;
    task.onFrame({ type: MESSAGE_TYPES.ITEM_DONE, payload: { requestId: first, itemId: 'i0', text: '你好' } });

    expect(task.toggle(p)).toEqual({ ok: true, data: { action: 'hidden' } });
    expect(translationOf(p)).toBe(null);
    expect(p.textContent).toBe('Hello');

    expect(task.toggle(p)).toEqual({ ok: true, data: { action: 'translating' } });
    expect(bridge.batches).toHaveLength(2);
    expect(renderer.getState(p)).toBe('loading');
  });

  it('再次触发只提交原文，不把已有译文并入待译文本', () => {
    const p = mount('<p id="p">Hello</p>');
    task.toggle(p);
    const first = bridge.batches[0].requestId;
    task.onFrame({ type: MESSAGE_TYPES.ITEM_DONE, payload: { requestId: first, itemId: 'i0', text: '你好' } });

    task.toggle(p); // 隐藏并移除译文
    task.toggle(p); // 重新请求

    expect(bridge.batches).toHaveLength(2);
    expect(bridge.batches[1].items).toEqual([{ itemId: 'i0', text: 'Hello' }]);
  });

  it('加载中再次触发取消批次并移除显示', () => {
    const p = mount('<p id="p">Hello</p>');
    task.toggle(p);
    const requestId = bridge.batches[0].requestId;

    expect(task.toggle(p)).toEqual({ ok: true, data: { action: 'cancelled' } });
    expect(bridge.cancels).toContain(requestId);
    expect(translationOf(p)).toBe(null);

    task.onFrame({ type: MESSAGE_TYPES.ITEM_DONE, payload: { requestId, itemId: 'i0', text: '不应显示' } });
    expect(translationOf(p)).toBe(null);
  });

  it('错误态再次触发是重试', () => {
    const p = mount('<p id="p">Hello</p>');
    task.toggle(p);
    const first = bridge.batches[0].requestId;
    task.onFrame({
      type: MESSAGE_TYPES.ITEM_ERROR,
      payload: { requestId: first, itemId: 'i0', code: ERROR_CODES.AUTH, message: '密钥无效' },
    });
    expect(renderer.getState(p)).toBe('error');

    expect(task.toggle(p)).toEqual({ ok: true, data: { action: 'translating' } });
    expect(bridge.batches).toHaveLength(2);
    expect(renderer.getState(p)).toBe('loading');
  });
});

describe('D5 失败与断线', () => {
  it('整批拒绝显示后台错误信息', () => {
    const p = mount('<p id="p">Hello</p>');
    task.toggle(p);
    const requestId = bridge.batches[0].requestId;

    task.onFrame({
      type: MESSAGE_TYPES.BATCH_DONE,
      payload: {
        requestId,
        ok: false,
        done: 0,
        failed: 0,
        cancelled: 0,
        error: { code: ERROR_CODES.CONFIG, message: '缺少密钥，请先在设置页保存密钥' },
      },
    });
    expect(renderer.getState(p)).toBe('error');
    expect(translationOf(p).textContent).toContain('缺少密钥');
  });

  it('段错误显示统一提示', () => {
    const p = mount('<p id="p">Hello</p>');
    task.toggle(p);
    const requestId = bridge.batches[0].requestId;
    task.onFrame({
      type: MESSAGE_TYPES.ITEM_ERROR,
      payload: { requestId, itemId: 'i0', code: ERROR_CODES.RATE_LIMIT, message: '请求过于频繁' },
    });
    expect(translationOf(p).textContent).toBe('翻译失败：请求过于频繁');
  });

  it('断线把在途段落置为失败态', () => {
    const p = mount('<p id="p">Hello</p>');
    task.toggle(p);
    const requestId = bridge.batches[0].requestId;

    task.onDisconnect([requestId]);
    expect(renderer.getState(p)).toBe('error');
    expect(translationOf(p).textContent).toContain('连接已断开');
  });

  it('提交批次失败时返回错误并显示失败态', () => {
    bridge.postBatch = () => {
      throw Object.assign(new Error('请求参数无效'), {
        code: ERROR_CODES.OTHER,
        reason: 'INVALID_MESSAGE',
      });
    };
    const p = mount('<p id="p">Hello</p>');

    const result = task.toggle(p);
    expect(result.ok).toBe(false);
    expect(result.error.code).toBe(ERROR_CODES.OTHER);
    expect(renderer.getState(p)).toBe('error');
  });
});

describe('D5 连接就绪前排队', () => {
  /**
   * 让桥在未连接时拒绝批次。
   * @returns {{ connected: boolean }}
   */
  function makeFlakyBridge() {
    const state = { connected: false };
    bridge.postBatch = function postBatch(payload) {
      if (!state.connected) {
        throw Object.assign(new Error('尚未连接后台'), {
          code: ERROR_CODES.NETWORK,
          reason: 'NOT_CONNECTED',
        });
      }
      this.batches.push(payload);
    };
    return state;
  }

  it('桥未连接时保持加载，连接后自动提交', () => {
    const state = makeFlakyBridge();
    const p = mount('<p id="p">Hello</p>');

    expect(task.toggle(p)).toEqual({ ok: true, data: { action: 'translating' } });
    expect(bridge.batches).toHaveLength(0);
    expect(renderer.getState(p)).toBe('loading');

    state.connected = true;
    task.onBridgeState('connected');

    expect(bridge.batches).toHaveLength(1);
    expect(renderer.getState(p)).toBe('loading');
  });

  it('等待连接超时后显示失败', () => {
    makeFlakyBridge();
    const p = mount('<p id="p">Hello</p>');
    task.toggle(p);

    vi.advanceTimersByTime(5000);

    expect(renderer.getState(p)).toBe('error');
    expect(translationOf(p).textContent).toContain('超时');
  });

  it('连接永久关闭时结束等待并提示刷新', () => {
    makeFlakyBridge();
    const p = mount('<p id="p">Hello</p>');
    task.toggle(p);

    task.onBridgeState('closed');

    expect(renderer.getState(p)).toBe('error');
    expect(translationOf(p).textContent).toContain('重新加载');
  });
});

describe('D5 清除全部', () => {
  it('取消在途批次并移除全部译文', () => {
    document.body.innerHTML = '<p id="a">First</p><p id="b">Second</p>';
    const a = document.getElementById('a');
    const b = document.getElementById('b');
    task.toggle(a);
    task.toggle(b);
    const ids = bridge.batches.map((batch) => batch.requestId);

    const result = task.clearAll();
    expect(result).toEqual({ ok: true, data: { removed: 2, cancelled: 2 } });
    expect(bridge.cancels).toEqual(expect.arrayContaining(ids));
    expect(document.querySelector(`[${TRANSLATION_ATTR}]`)).toBe(null);
    expect(renderer.getState(a)).toBe(null);
    expect(renderer.getState(b)).toBe(null);
  });
});
