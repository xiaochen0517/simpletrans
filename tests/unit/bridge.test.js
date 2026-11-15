/**
 * D4 页面通道测试
 *
 * 用 chrome stub 的 runtime.connect / Port 语义测试连接、心跳、重连、断线通知与关闭；
 * 时间相关用例用 fake timers。
 */

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { installChrome } from '../helpers/load.js';
import {
  ERROR_CODES,
  FAILURE_REASONS,
  MESSAGE_TYPES,
  PORT_NAME,
} from '../../src/shared/protocol.js';
import {
  HEARTBEAT_INTERVAL_MS,
  HEARTBEAT_TIMEOUT_MS,
  RECONNECT_DELAYS_MS,
} from '../../src/shared/constants.js';
import { BridgeError, createBridge } from '../../src/content/bridge.js';

let serverPorts;
let received;
let respondToPing;
let pingCount;

beforeEach(() => {
  installChrome();
  vi.useFakeTimers();
  vi.spyOn(console, 'debug').mockImplementation(() => {});
  vi.spyOn(console, 'info').mockImplementation(() => {});

  serverPorts = [];
  received = [];
  respondToPing = true;
  pingCount = 0;

  chrome.runtime.onConnect.addListener((port) => {
    serverPorts.push(port);
    port.onMessage.addListener((message) => {
      received.push(message);
      if (message.type === MESSAGE_TYPES.PING) {
        pingCount += 1;
        if (respondToPing) {
          port.postMessage({
            type: MESSAGE_TYPES.PONG,
            payload: { sentAt: message.payload?.sentAt ?? null, receivedAt: Date.now() },
          });
        }
      }
    });
  });
});

afterEach(() => {
  vi.useRealTimers();
  vi.restoreAllMocks();
});

describe('D4 页面通道：连接与心跳', () => {
  it('使用固定端口名连接，首帧 PING 成功后进入 connected', () => {
    const states = [];
    const bridge = createBridge({ onStateChange: (state) => states.push(state) });
    bridge.connect();

    expect(states).toEqual(['connecting', 'connected']);
    expect(bridge.getState()).toBe('connected');
    expect(serverPorts).toHaveLength(1);
    expect(serverPorts[0].name).toBe(PORT_NAME);
    expect(received[0].type).toBe(MESSAGE_TYPES.PING);

    bridge.close();
  });

  it('连接后每 20 秒发一次心跳，PONG 不转发给 onFrame', async () => {
    const frames = [];
    const bridge = createBridge({ onFrame: (frame) => frames.push(frame) });
    bridge.connect();

    expect(pingCount).toBe(1);
    expect(frames).toHaveLength(0);

    await vi.advanceTimersByTimeAsync(HEARTBEAT_INTERVAL_MS);
    expect(pingCount).toBe(2);
    expect(frames).toHaveLength(0);

    bridge.close();
  });

  it('心跳超时进入 reconnecting，并按 1 秒开始重连', async () => {
    respondToPing = false;
    const connectSpy = vi.spyOn(chrome.runtime, 'connect');
    const bridge = createBridge({});
    bridge.connect();

    await vi.advanceTimersByTimeAsync(HEARTBEAT_TIMEOUT_MS);
    expect(bridge.getState()).toBe('reconnecting');

    await vi.advanceTimersByTimeAsync(RECONNECT_DELAYS_MS[0]);
    expect(connectSpy).toHaveBeenCalledTimes(2);

    bridge.close();
  });

  it('连续失败时按 1/2/4 秒退避', async () => {
    respondToPing = false;
    const connectSpy = vi.spyOn(chrome.runtime, 'connect');
    const bridge = createBridge({});
    bridge.connect();

    await vi.advanceTimersByTimeAsync(HEARTBEAT_TIMEOUT_MS);
    await vi.advanceTimersByTimeAsync(RECONNECT_DELAYS_MS[0]);
    expect(connectSpy).toHaveBeenCalledTimes(2);

    await vi.advanceTimersByTimeAsync(HEARTBEAT_TIMEOUT_MS);
    await vi.advanceTimersByTimeAsync(RECONNECT_DELAYS_MS[1]);
    expect(connectSpy).toHaveBeenCalledTimes(3);

    await vi.advanceTimersByTimeAsync(HEARTBEAT_TIMEOUT_MS);
    await vi.advanceTimersByTimeAsync(RECONNECT_DELAYS_MS[2]);
    expect(connectSpy).toHaveBeenCalledTimes(4);

    bridge.close();
  });
});

describe('D4 页面通道：发帧、断线与关闭', () => {
  it('未连接时 send/postBatch 抛 NOT_CONNECTED', () => {
    const bridge = createBridge({});
    expect(() => bridge.send({ type: 'x' })).toThrow(BridgeError);
    try {
      bridge.postBatch({ requestId: 'r1', items: [] });
    } catch (error) {
      expect(error).toBeInstanceOf(BridgeError);
      expect(error.code).toBe(ERROR_CODES.NETWORK);
      expect(error.reason).toBe(FAILURE_REASONS.NOT_CONNECTED);
    }
  });

  it('postBatch 记录在途 requestId，断线时交给 onDisconnect', () => {
    let pending = null;
    const bridge = createBridge({ onDisconnect: (ids) => (pending = ids) });
    bridge.connect();

    bridge.postBatch({ requestId: 'r1', items: [{ itemId: 'i0', text: 'hi' }] });
    serverPorts[0].disconnect();

    expect(pending).toEqual(['r1']);
    expect(bridge.getState()).toBe('reconnecting');
  });

  it('收到 BATCH_DONE 后不再把该 requestId 当作在途', () => {
    let pending = null;
    const bridge = createBridge({ onDisconnect: (ids) => (pending = ids) });
    bridge.connect();

    bridge.postBatch({ requestId: 'r1', items: [{ itemId: 'i0', text: 'hi' }] });
    serverPorts[0].postMessage({
      type: MESSAGE_TYPES.BATCH_DONE,
      payload: { requestId: 'r1', ok: true, done: 1, failed: 0, cancelled: 0 },
    });
    serverPorts[0].disconnect();

    expect(pending).toEqual([]);
  });

  it('onFrame 转发业务帧，PONG 由桥内部消费', () => {
    const frames = [];
    const bridge = createBridge({ onFrame: (frame) => frames.push(frame) });
    bridge.connect();

    serverPorts[0].postMessage({
      type: MESSAGE_TYPES.ITEM_DONE,
      payload: { requestId: 'r1', itemId: 'i0', text: '你好', usage: null },
    });

    expect(frames).toHaveLength(1);
    expect(frames[0].type).toBe(MESSAGE_TYPES.ITEM_DONE);

    bridge.close();
  });

  it('cancelBatch / cancelItem 发送取消帧', () => {
    const bridge = createBridge({});
    bridge.connect();

    bridge.cancelBatch('r1');
    bridge.cancelItem('r1', 'i0');

    expect(received.map((frame) => frame.type)).toEqual([
      MESSAGE_TYPES.PING,
      MESSAGE_TYPES.CANCEL_BATCH,
      MESSAGE_TYPES.CANCEL_ITEM,
    ]);
    expect(received[1].payload).toEqual({ requestId: 'r1' });
    expect(received[2].payload).toEqual({ requestId: 'r1', itemId: 'i0' });

    bridge.close();
  });

  it('close 发送 ST_CLOSE 并停止重连', async () => {
    const connectSpy = vi.spyOn(chrome.runtime, 'connect');
    const bridge = createBridge({});
    bridge.connect();
    bridge.close();

    expect(bridge.getState()).toBe('closed');
    expect(received.some((frame) => frame.type === MESSAGE_TYPES.CLOSE)).toBe(true);

    await vi.advanceTimersByTimeAsync(10_000);
    expect(connectSpy).toHaveBeenCalledTimes(1);
  });

  it('扩展上下文失效时进入 closed，不再重连', () => {
    delete chrome.runtime.id;
    const connectSpy = vi.spyOn(chrome.runtime, 'connect');
    const bridge = createBridge({});
    bridge.connect();

    expect(bridge.getState()).toBe('closed');
    expect(connectSpy).not.toHaveBeenCalled();
  });
});
