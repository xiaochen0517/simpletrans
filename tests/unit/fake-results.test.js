// @vitest-environment jsdom
/**
 * D5 假数据源测试（P6.1 临时）
 *
 * 验证模拟结果的内容与帧序列、默认/慢速/失败三种模式、并发上限与取消；
 * 只调用注入的 onFrame，不接触 DOM、chrome 或网络。
 */

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { MESSAGE_TYPES } from '../../src/shared/protocol.js';
import { RESULT_MODES, createFakeResults } from '../../src/content/fake-results.js';

/** @type {Array<{ type: string, payload: object }>} */
let frames;
/** @type {ReturnType<typeof createFakeResults>} */
let results;

/**
 * 一次提交记录（D5 的形状）。
 * @param {Array<[string, string]>} pairs [段落 id, 原文]
 * @param {string} [requestId]
 * @returns {{ requestId: string, items: Map<string, { text: string }> }}
 */
function submissionOf(pairs, requestId = 's-1') {
  return {
    requestId,
    items: new Map(pairs.map(([itemId, text]) => [itemId, { text }])),
  };
}

/**
 * 按类型筛选帧。
 * @param {string} type
 * @returns {Array<object>}
 */
function framesOf(type) {
  return frames.filter((frame) => frame.type === type);
}

beforeEach(() => {
  vi.useFakeTimers();
  frames = [];
  results = createFakeResults({
    onFrame: (frame) => frames.push(frame),
  });
});

afterEach(() => {
  results?.cancelAll();
  vi.useRealTimers();
});

describe('P6.1 假数据：内容与序列', () => {
  it('短段落：先保留一个间隔，再 START → DONE，内容带段落 id 前缀', async () => {
    results.start(submissionOf([['h1-1', 'Hi']]));

    // 提交后先不投递，让「已提交」可见。
    expect(frames).toEqual([]);

    await vi.advanceTimersByTimeAsync(80);
    expect(framesOf(MESSAGE_TYPES.ITEM_START)).toEqual([
      { type: MESSAGE_TYPES.ITEM_START, payload: { requestId: 's-1', itemId: 'h1-1' } },
    ]);

    await vi.advanceTimersByTimeAsync(80);
    expect(framesOf(MESSAGE_TYPES.ITEM_DONE)).toEqual([
      {
        type: MESSAGE_TYPES.ITEM_DONE,
        payload: {
          requestId: 's-1',
          itemId: 'h1-1',
          text: '【模拟 h1-1】Hi',
          usage: null,
        },
      },
    ]);
    expect(framesOf(MESSAGE_TYPES.ITEM_DELTA)).toHaveLength(0);
  });

  it('长段落：START → 每片 20 字符的 DELTA → DONE', async () => {
    const text = 'A'.repeat(30);
    results.start(submissionOf([['h1-1', text]]));

    await vi.advanceTimersByTimeAsync(80);
    expect(framesOf(MESSAGE_TYPES.ITEM_START)).toHaveLength(1);

    await vi.advanceTimersByTimeAsync(80);
    const firstDeltas = framesOf(MESSAGE_TYPES.ITEM_DELTA);
    expect(firstDeltas).toHaveLength(1);
    expect(firstDeltas[0].payload.delta).toHaveLength(20);
    expect(firstDeltas[0].payload.delta).toBe(`【模拟 h1-1】${'A'.repeat(11)}`);

    await vi.advanceTimersByTimeAsync(80);
    const done = framesOf(MESSAGE_TYPES.ITEM_DONE);
    expect(done).toHaveLength(1);
    expect(done[0].payload.text).toBe(`【模拟 h1-1】${text}`);
    expect(framesOf(MESSAGE_TYPES.ITEM_START)).toHaveLength(1);
    expect(framesOf(MESSAGE_TYPES.ITEM_DELTA)).toHaveLength(1);
  });

  it('多段按提交内顺序开始，各自带自己的 itemId', async () => {
    results.start(submissionOf([['h1-1', 'One'], ['h1-2', 'Two']]));

    await vi.advanceTimersByTimeAsync(80);
    expect(framesOf(MESSAGE_TYPES.ITEM_START).map((frame) => frame.payload.itemId)).toEqual([
      'h1-1',
      'h1-2',
    ]);

    await vi.advanceTimersByTimeAsync(80);
    expect(framesOf(MESSAGE_TYPES.ITEM_DONE).map((frame) => frame.payload.itemId)).toEqual([
      'h1-1',
      'h1-2',
    ]);
  });

  it('空提交不产生任何帧', async () => {
    results.start(submissionOf([]));
    await vi.advanceTimersByTimeAsync(1000);
    expect(frames).toEqual([]);
  });
});

describe('P6.1 假数据：模式', () => {
  it('慢速模式每片 4 字符、间隔 400ms', async () => {
    results.setMode(RESULT_MODES.slow);
    results.start(submissionOf([['h1-1', 'A'.repeat(10)]]));

    await vi.advanceTimersByTimeAsync(399);
    expect(frames).toEqual([]);

    await vi.advanceTimersByTimeAsync(1);
    expect(framesOf(MESSAGE_TYPES.ITEM_START)).toHaveLength(1);

    await vi.advanceTimersByTimeAsync(400);
    const deltas = framesOf(MESSAGE_TYPES.ITEM_DELTA);
    expect(deltas).toHaveLength(1);
    expect(deltas[0].payload.delta).toBe('【模拟 ');

    // 总长 19：4×4 + 3，共 4 片增量后定稿。
    await vi.advanceTimersByTimeAsync(400 * 4);
    expect(framesOf(MESSAGE_TYPES.ITEM_DELTA)).toHaveLength(4);
    expect(framesOf(MESSAGE_TYPES.ITEM_DONE)).toHaveLength(1);
  });

  it('失败模式在开始帧后直接发 ITEM_ERROR，不发增量', async () => {
    results.setMode(RESULT_MODES.fail);
    results.start(submissionOf([['h1-1', 'Hello']]));

    await vi.advanceTimersByTimeAsync(80);
    expect(framesOf(MESSAGE_TYPES.ITEM_START)).toHaveLength(1);
    expect(framesOf(MESSAGE_TYPES.ITEM_ERROR)).toEqual([
      {
        type: MESSAGE_TYPES.ITEM_ERROR,
        payload: {
          requestId: 's-1',
          itemId: 'h1-1',
          code: 'NETWORK',
          message: '模拟失败',
        },
      },
    ]);
    expect(framesOf(MESSAGE_TYPES.ITEM_DELTA)).toHaveLength(0);
    expect(framesOf(MESSAGE_TYPES.ITEM_DONE)).toHaveLength(0);
  });

  it('setMode 只影响之后的提交；非法模式被忽略', async () => {
    results.setMode('bogus');
    expect(results.getMode()).toBe(RESULT_MODES.normal);

    results.setMode(RESULT_MODES.fail);
    expect(results.getMode()).toBe(RESULT_MODES.fail);
  });
});

describe('P6.1 假数据：并发与取消', () => {
  it('同时最多 8 段在流式，其余排队等待', async () => {
    const pairs = Array.from({ length: 10 }, (_, index) => [`h1-${index}`, 'Text']);
    results.start(submissionOf(pairs));

    await vi.advanceTimersByTimeAsync(80);
    expect(framesOf(MESSAGE_TYPES.ITEM_START)).toHaveLength(8);

    await vi.advanceTimersByTimeAsync(80);
    expect(framesOf(MESSAGE_TYPES.ITEM_DONE)).toHaveLength(8);
    expect(framesOf(MESSAGE_TYPES.ITEM_START)).toHaveLength(10);

    await vi.advanceTimersByTimeAsync(80);
    expect(framesOf(MESSAGE_TYPES.ITEM_DONE)).toHaveLength(10);
  });

  it('cancelAll 停止待开始、排队与在途的段', async () => {
    const pairs = Array.from({ length: 10 }, (_, index) => [`h1-${index}`, 'Text']);
    results.start(submissionOf(pairs));
    await vi.advanceTimersByTimeAsync(80);
    expect(framesOf(MESSAGE_TYPES.ITEM_START)).toHaveLength(8);

    results.cancelAll();
    await vi.advanceTimersByTimeAsync(1000);

    expect(framesOf(MESSAGE_TYPES.ITEM_DONE)).toHaveLength(0);
    expect(framesOf(MESSAGE_TYPES.ITEM_START)).toHaveLength(8);
  });

  it('在开始帧之前取消则完全不投递', async () => {
    results.start(submissionOf([['h1-1', 'Hello']]));
    results.cancelAll();
    await vi.advanceTimersByTimeAsync(1000);
    expect(frames).toEqual([]);
  });
});
