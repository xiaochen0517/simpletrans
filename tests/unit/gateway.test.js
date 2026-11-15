/**
 * A2 请求网关测试
 *
 * 用 vi.mock 隔离 A3 上游；只测网关的校验、帧、并发、取消、断线与超时。
 */

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

vi.mock('../../src/shared/translate/adapter.js', () => {
  class TranslateError extends Error {
    constructor(code, message) {
      super(message);
      this.name = 'TranslateError';
      this.code = code;
    }
  }
  return {
    translate: vi.fn(),
    TranslateError,
    isSupportedTargetLang: (lang) => lang === 'zh',
    SUPPORTED_TARGET_LANGS: ['zh'],
  };
});

import { installChrome } from '../helpers/load.js';
import {
  ERROR_CODES,
  FAILURE_REASONS,
  MESSAGE_TYPES,
  PORT_NAME,
} from '../../src/shared/protocol.js';
import { DEFAULT_CONCURRENCY } from '../../src/shared/constants.js';
import { getOrCreateDefaultInstance, removeKey, writeKey } from '../../src/shared/config/instances.js';
import { handleConnect, normalizeConcurrency } from '../../src/background/gateway.js';
import { translate } from '../../src/shared/translate/adapter.js';

let clients = [];
let instance;
let currentConn;

function connectGateway() {
  const client = chrome.runtime.connect({ name: PORT_NAME });
  clients.push(client);
  const frames = [];
  client.onMessage.addListener((message) => frames.push(message));
  return { client, frames };
}

function makeDeferred() {
  let resolve;
  let reject;
  const promise = new Promise((res, rej) => {
    resolve = res;
    reject = rej;
  });
  return { promise, resolve, reject };
}

async function waitForBatchDone(frames) {
  await vi.waitFor(
    () => {
      expect(frames.some((frame) => frame.type === MESSAGE_TYPES.BATCH_DONE)).toBe(true);
    },
    { timeout: 1000 }
  );
  return frames.find((frame) => frame.type === MESSAGE_TYPES.BATCH_DONE);
}

function textItem(text, itemId = 'i0') {
  return { itemId, text };
}

/** 可被 AbortSignal 取消的待定上游；已取消时立即 reject。 */
function abortableTranslate({ signal }) {
  return new Promise((resolve, reject) => {
    const fail = () => reject(Object.assign(new Error('aborted'), { code: ERROR_CODES.CANCELLED }));
    if (signal?.aborted) {
      fail();
      return;
    }
    signal?.addEventListener('abort', fail, { once: true });
  });
}

beforeEach(async () => {
  installChrome();
  vi.spyOn(console, 'info').mockImplementation(() => {});
  clients = [];
  chrome.runtime.onConnect.addListener((port) => {
    if (port.name === PORT_NAME) currentConn = handleConnect(port);
  });

  translate.mockReset();
  translate.mockImplementation(async ({ text, onDelta }) => {
    onDelta?.(`[${text}]`);
    return { text: `译:${text}`, usage: { totalTokens: 1 } };
  });

  instance = await getOrCreateDefaultInstance();
  await writeKey(instance.id, 'sk-test');
});

afterEach(async () => {
  for (const client of clients) {
    try {
      client.disconnect();
    } catch {
      // 已断开。
    }
  }
  clients = [];
  // 让 cleanup 触发的 abort / 微任务跑完，避免把在途名额带到下一个用例。
  await new Promise((resolve) => setTimeout(resolve, 0));
  vi.restoreAllMocks();
});

describe('A2 请求网关：连接与心跳', () => {
  it('非 st-gateway 端口或发送方不符时直接断开', () => {
    const wrongNameDisconnect = vi.fn();
    const wrongName = {
      name: 'other',
      sender: { id: chrome.runtime.id },
      disconnect: wrongNameDisconnect,
      onMessage: { addListener: vi.fn() },
      onDisconnect: { addListener: vi.fn() },
    };
    expect(handleConnect(wrongName)).toBeNull();
    expect(wrongNameDisconnect).toHaveBeenCalled();

    const wrongSenderDisconnect = vi.fn();
    const wrongSender = {
      name: PORT_NAME,
      sender: { id: 'other-extension' },
      disconnect: wrongSenderDisconnect,
      onMessage: { addListener: vi.fn() },
      onDisconnect: { addListener: vi.fn() },
    };
    expect(handleConnect(wrongSender)).toBeNull();
    expect(wrongSenderDisconnect).toHaveBeenCalled();
  });

  it('ST_PING 立即回 ST_PONG，随后下发一次 ST_LOG_CONFIG', async () => {
    const { client, frames } = connectGateway();
    client.postMessage({ type: MESSAGE_TYPES.PING, payload: { sentAt: 42 } });

    expect(frames[0].type).toBe(MESSAGE_TYPES.PONG);
    expect(frames[0].payload.sentAt).toBe(42);
    expect(typeof frames[0].payload.receivedAt).toBe('number');

    await vi.waitFor(() => {
      expect(frames.some((frame) => frame.type === MESSAGE_TYPES.LOG_CONFIG)).toBe(true);
    });
    const config = frames.find((frame) => frame.type === MESSAGE_TYPES.LOG_CONFIG);
    expect(config.payload.level).toBe('info');
  });

  it('同一连接只下发一次 ST_LOG_CONFIG', async () => {
    const { client, frames } = connectGateway();
    client.postMessage({ type: MESSAGE_TYPES.PING, payload: { sentAt: 1 } });
    client.postMessage({ type: MESSAGE_TYPES.PING, payload: { sentAt: 2 } });

    await vi.waitFor(() => {
      expect(frames.filter((frame) => frame.type === MESSAGE_TYPES.LOG_CONFIG)).toHaveLength(1);
    });
    await new Promise((resolve) => setTimeout(resolve, 0));
    expect(frames.filter((frame) => frame.type === MESSAGE_TYPES.LOG_CONFIG)).toHaveLength(1);
  });

  it('日志级别非法时归一为 info', async () => {
    await chrome.storage.sync.set({ settings: { logLevel: 'nope' } });
    const { client, frames } = connectGateway();
    client.postMessage({ type: MESSAGE_TYPES.PING, payload: { sentAt: 3 } });

    await vi.waitFor(() => {
      expect(frames.some((frame) => frame.type === MESSAGE_TYPES.LOG_CONFIG)).toBe(true);
    });
    const config = frames.find((frame) => frame.type === MESSAGE_TYPES.LOG_CONFIG);
    expect(config.payload.level).toBe('info');
  });
});

describe('A2 请求网关：批次执行', () => {
  it('单段成功：START → DELTA → DONE → BATCH_DONE', async () => {
    const { client, frames } = connectGateway();
    client.postMessage({
      type: MESSAGE_TYPES.TRANSLATE_BATCH,
      payload: { requestId: 'ok-1', items: [textItem('hello')] },
    });

    const done = await waitForBatchDone(frames);
    expect(frames.map((frame) => frame.type)).toEqual([
      MESSAGE_TYPES.ITEM_START,
      MESSAGE_TYPES.ITEM_DELTA,
      MESSAGE_TYPES.ITEM_DONE,
      MESSAGE_TYPES.BATCH_DONE,
    ]);
    expect(frames[1].payload.delta).toBe('[hello]');
    expect(frames[2].payload.text).toBe('译:hello');
    expect(done.payload).toMatchObject({ ok: true, done: 1, failed: 0, cancelled: 0 });
  });

  it('多段按顺序逐段执行，帧按 requestId/itemId 归属', async () => {
    translate.mockImplementation(async ({ text }) => ({ text: `t:${text}`, usage: null }));
    const { client, frames } = connectGateway();
    client.postMessage({
      type: MESSAGE_TYPES.TRANSLATE_BATCH,
      payload: {
        requestId: 'multi',
        items: [textItem('a', 'i0'), textItem('b', 'i1')],
      },
    });

    const done = await waitForBatchDone(frames);
    expect(done.payload).toMatchObject({ ok: true, done: 2 });
    expect(translate.mock.calls.map(([params]) => params.text)).toEqual(['a', 'b']);
    expect(
      frames.filter((frame) => frame.type === MESSAGE_TYPES.ITEM_START).map((frame) => frame.payload.itemId)
    ).toEqual(['i0', 'i1']);
  });

  it('校验失败整批拒绝且不调用上游', async () => {
    async function reject(payload, reason, code = ERROR_CODES.OTHER) {
      const { client, frames } = connectGateway();
      client.postMessage({ type: MESSAGE_TYPES.TRANSLATE_BATCH, payload });
      const done = await waitForBatchDone(frames);
      expect(done.payload.ok).toBe(false);
      expect(done.payload.error.reason).toBe(reason);
      expect(done.payload.error.code).toBe(code);
    }

    await reject({}, FAILURE_REASONS.INVALID_REQUEST_ID);
    await reject({ requestId: 'r', items: [] }, FAILURE_REASONS.INVALID_ITEMS);
    await reject(
      { requestId: 'r', items: Array.from({ length: 13 }, (_, i) => textItem('x', `i${i}`)) },
      FAILURE_REASONS.INVALID_ITEMS
    );
    await reject(
      { requestId: 'r', items: [textItem('a', 'same'), textItem('b', 'same')] },
      FAILURE_REASONS.DUPLICATE_ITEM_ID
    );
    await reject({ requestId: 'r', items: [textItem('   ')] }, FAILURE_REASONS.EMPTY_TEXT);
    await reject({ requestId: 'r', items: [textItem('x'.repeat(4001))] }, FAILURE_REASONS.TEXT_TOO_LONG);
    await reject(
      {
        requestId: 'r',
        items: [
          textItem('x'.repeat(4000), 'i0'),
          textItem('x'.repeat(4000), 'i1'),
          textItem('x'.repeat(4000), 'i2'),
          textItem('x', 'i3'),
        ],
      },
      FAILURE_REASONS.BATCH_TOO_LARGE
    );
    await reject(
      { requestId: 'r', items: [{ itemId: 'i0', text: 'hi', context: 'x'.repeat(401) }] },
      FAILURE_REASONS.CONTEXT_TOO_LONG
    );
    await reject(
      {
        requestId: 'r',
        context: 'x',
        items: [
          { itemId: 'i0', text: 'a', context: 'x'.repeat(400) },
          { itemId: 'i1', text: 'b', context: 'x'.repeat(400) },
          { itemId: 'i2', text: 'c', context: 'x'.repeat(400) },
        ],
      },
      FAILURE_REASONS.CONTEXT_TOO_LONG
    );
    await reject(
      { requestId: 'r', items: [textItem('hi')], apiKey: 'sk-x' },
      FAILURE_REASONS.FORBIDDEN_FIELD
    );
    await reject(
      { requestId: 'r', items: [textItem('hi')], targetLang: 'ja' },
      FAILURE_REASONS.UNSUPPORTED_LANG
    );

    expect(translate).not.toHaveBeenCalled();
  });

  it('缺密钥整批以 CONFIG 拒绝，不调用上游', async () => {
    await removeKey(instance.id);
    const { client, frames } = connectGateway();
    client.postMessage({
      type: MESSAGE_TYPES.TRANSLATE_BATCH,
      payload: { requestId: 'no-key', items: [textItem('hi')] },
    });

    const done = await waitForBatchDone(frames);
    expect(done.payload.ok).toBe(false);
    expect(done.payload.error.code).toBe(ERROR_CODES.CONFIG);
    expect(translate).not.toHaveBeenCalled();
  });

  it('没有实例时整批 CONFIG，且网关不创建实例、不写 storage', async () => {
    await chrome.storage.sync.remove('engineInstances');
    const syncSet = vi.spyOn(chrome.storage.sync, 'set');

    const { client, frames } = connectGateway();
    client.postMessage({
      type: MESSAGE_TYPES.TRANSLATE_BATCH,
      payload: { requestId: 'no-instance', items: [textItem('hi')] },
    });

    const done = await waitForBatchDone(frames);
    expect(done.payload.ok).toBe(false);
    expect(done.payload.error.code).toBe(ERROR_CODES.CONFIG);
    expect(syncSet).not.toHaveBeenCalled();
    expect(translate).not.toHaveBeenCalled();
  });

  it('同端口在途批次重名被拒绝', async () => {
    const deferred = makeDeferred();
    translate.mockImplementation(() => deferred.promise);
    const { client, frames } = connectGateway();
    const payload = { requestId: 'dup', items: [textItem('hi')] };

    client.postMessage({ type: MESSAGE_TYPES.TRANSLATE_BATCH, payload });
    await vi.waitFor(() => expect(translate).toHaveBeenCalledTimes(1));
    client.postMessage({ type: MESSAGE_TYPES.TRANSLATE_BATCH, payload });

    await vi.waitFor(() => {
      expect(
        frames.some(
          (frame) =>
            frame.type === MESSAGE_TYPES.BATCH_DONE &&
            frame.payload.error?.reason === FAILURE_REASONS.DUPLICATE_REQUEST
        )
      ).toBe(true);
    });

    deferred.resolve({ text: 'ok', usage: null });
    await vi.waitFor(() => {
      expect(frames.filter((frame) => frame.type === MESSAGE_TYPES.BATCH_DONE)).toHaveLength(2);
    });
  });

  it('每端口在途批次超过 4 时立即拒绝', async () => {
    translate.mockImplementation(abortableTranslate);

    const { client, frames } = connectGateway();
    const conn = currentConn;
    for (let i = 0; i < 4; i += 1) {
      client.postMessage({
        type: MESSAGE_TYPES.TRANSLATE_BATCH,
        payload: { requestId: `batch-${i}`, items: [textItem('hi', `i${i}`)] },
      });
    }
    await vi.waitFor(() => expect(conn.batches.size).toBe(4));
    await vi.waitFor(() => expect(translate).toHaveBeenCalled());

    client.postMessage({
      type: MESSAGE_TYPES.TRANSLATE_BATCH,
      payload: { requestId: 'batch-4', items: [textItem('hi', 'i4')] },
    });
    await vi.waitFor(() => {
      expect(
        frames.some(
          (frame) =>
            frame.type === MESSAGE_TYPES.BATCH_DONE &&
            frame.payload.error?.reason === FAILURE_REASONS.TOO_MANY_INFLIGHT
        )
      ).toBe(true);
    });
  });

  it('全局并发不超过用户设置（默认 3）', async () => {
    translate.mockImplementation(abortableTranslate);

    const ports = Array.from({ length: 4 }, () => connectGateway());
    for (let i = 0; i < 4; i += 1) {
      ports[i].client.postMessage({
        type: MESSAGE_TYPES.TRANSLATE_BATCH,
        payload: { requestId: `limit-${i}`, items: [textItem('hi', `i${i}`)] },
      });
    }

    await vi.waitFor(() => expect(translate).toHaveBeenCalledTimes(3));
    await new Promise((resolve) => setTimeout(resolve, 20));
    expect(translate).toHaveBeenCalledTimes(3);
  });
});

describe('A2 请求网关：取消、断线与超时', () => {
  it('ST_CANCEL_BATCH 中止在途段并结束整批', async () => {
    translate.mockImplementation(abortableTranslate);
    const { client, frames } = connectGateway();
    client.postMessage({
      type: MESSAGE_TYPES.TRANSLATE_BATCH,
      payload: { requestId: 'cancel', items: [textItem('long text')] },
    });
    await vi.waitFor(() => expect(translate).toHaveBeenCalledTimes(1));

    client.postMessage({ type: MESSAGE_TYPES.CANCEL_BATCH, payload: { requestId: 'cancel' } });
    const done = await waitForBatchDone(frames);

    expect(done.payload).toMatchObject({ ok: false, done: 0, failed: 0, cancelled: 1 });
    expect(frames.filter((frame) => frame.type === MESSAGE_TYPES.ITEM_ERROR)).toHaveLength(1);
    expect(frames.find((frame) => frame.type === MESSAGE_TYPES.ITEM_ERROR).payload.code).toBe(
      ERROR_CODES.CANCELLED
    );
  });

  it('取消排队中的段不发帧，剩余段继续执行', async () => {
    const deferred = makeDeferred();
    translate.mockImplementation(({ text }) =>
      text === 'first' ? deferred.promise : Promise.resolve({ text: 'second-done', usage: null })
    );
    const { client, frames } = connectGateway();
    client.postMessage({
      type: MESSAGE_TYPES.TRANSLATE_BATCH,
      payload: {
        requestId: 'cancel-item',
        items: [textItem('first', 'i0'), textItem('second', 'i1')],
      },
    });
    await vi.waitFor(() => expect(translate).toHaveBeenCalledTimes(1));

    client.postMessage({
      type: MESSAGE_TYPES.CANCEL_ITEM,
      payload: { requestId: 'cancel-item', itemId: 'i1' },
    });
    deferred.resolve({ text: 'first-done', usage: null });

    const done = await waitForBatchDone(frames);
    expect(done.payload).toMatchObject({ ok: false, done: 1, cancelled: 1 });
    expect(
      frames.some(
        (frame) => frame.type === MESSAGE_TYPES.ITEM_START && frame.payload.itemId === 'i1'
      )
    ).toBe(false);
  });

  it('端口断开时中止在途请求并清空批次', async () => {
    let capturedSignal;
    translate.mockImplementation((params) => {
      capturedSignal = params.signal;
      return abortableTranslate(params);
    });
    const { client } = connectGateway();
    client.postMessage({
      type: MESSAGE_TYPES.TRANSLATE_BATCH,
      payload: { requestId: 'disconnect', items: [textItem('hi')] },
    });
    await vi.waitFor(() => expect(translate).toHaveBeenCalledTimes(1));

    client.disconnect();
    await vi.waitFor(() => expect(capturedSignal.aborted).toBe(true));
    await new Promise((resolve) => setTimeout(resolve, 0));
  });

  it('批总时长超过 180 秒时剩余段以 NETWORK/BATCH_TIMEOUT 结算', async () => {
    vi.useFakeTimers();
    try {
      translate.mockImplementation(abortableTranslate);
      const { client, frames } = connectGateway();
      client.postMessage({
        type: MESSAGE_TYPES.TRANSLATE_BATCH,
        payload: {
          requestId: 'timeout',
          items: [textItem('a', 'i0'), textItem('b', 'i1')],
        },
      });

      // 先让 beginBatch 的异步读取与首段启动跑完，再推进批超时。
      await vi.advanceTimersByTimeAsync(0);
      expect(translate).toHaveBeenCalledTimes(1);
      await vi.advanceTimersByTimeAsync(180_000);
      await vi.waitFor(() => {
        expect(
          frames.filter((frame) => frame.type === MESSAGE_TYPES.ITEM_ERROR).length
        ).toBeGreaterThan(0);
      });

      const done = frames.find((frame) => frame.type === MESSAGE_TYPES.BATCH_DONE);
      expect(done.payload.ok).toBe(false);
      expect(done.payload.failed).toBeGreaterThan(0);
      const firstError = frames.find((frame) => frame.type === MESSAGE_TYPES.ITEM_ERROR);
      expect(firstError.payload.code).toBe(ERROR_CODES.NETWORK);
      expect(firstError.payload.reason).toBe(FAILURE_REASONS.BATCH_TIMEOUT);
    } finally {
      vi.useRealTimers();
    }
  });
});

describe('A2 请求网关：边界与并发入口', () => {
  it('网关执行批次期间不写 storage', async () => {
    const syncSet = vi.spyOn(chrome.storage.sync, 'set');
    const localSet = vi.spyOn(chrome.storage.local, 'set');
    const sessionSet = vi.spyOn(chrome.storage.session, 'set');

    const { client, frames } = connectGateway();
    client.postMessage({
      type: MESSAGE_TYPES.TRANSLATE_BATCH,
      payload: { requestId: 'no-write', items: [textItem('hi')] },
    });
    await waitForBatchDone(frames);

    expect(syncSet).not.toHaveBeenCalled();
    expect(localSet).not.toHaveBeenCalled();
    expect(sessionSet).not.toHaveBeenCalled();
  });

  it('normalizeConcurrency 归一 1–4，非法值回退默认', () => {
    expect(normalizeConcurrency(0)).toBe(DEFAULT_CONCURRENCY);
    expect(normalizeConcurrency('nope')).toBe(DEFAULT_CONCURRENCY);
    expect(normalizeConcurrency(2)).toBe(2);
    expect(normalizeConcurrency(9)).toBe(4);
  });
});
