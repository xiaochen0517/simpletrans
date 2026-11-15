/**
 * D4 与后台通信
 *
 * 模块：页面注入（D）/ D4
 * 职责：维持与后台的 st-gateway 长连接：连接与握手、心跳、断线退避重连、发送批次与取消、断线通知、主动关闭。
 * 依赖：E1 消息协议、constants.js（P2 起）。
 * 实现阶段：P2（后台网关与页面通道）
 *
 * 约束：不操作 DOM、不读写 storage、不引用 shared/config、shared/translate、shared/cache。
 */

import {
  ERROR_CODES,
  FAILURE_REASONS,
  MESSAGE_TYPES,
  PORT_NAME,
} from '../shared/protocol.js';
import {
  HEARTBEAT_INTERVAL_MS,
  HEARTBEAT_TIMEOUT_MS,
  RECONNECT_DELAYS_MS,
} from '../shared/constants.js';

/** 桥本地错误：形状与协议错误对象一致，便于上层统一处理。 */
export class BridgeError extends Error {
  /**
   * @param {string} code 统一错误码
   * @param {string} message 用户可见提示
   * @param {string} [reason] 机器可读原因
   */
  constructor(code, message, reason) {
    super(message);
    this.name = 'BridgeError';
    this.code = code;
    this.reason = reason;
  }
}

/**
 * 创建页面侧桥。
 * @param {{
 *   onFrame?: (frame: object) => void,
 *   onStateChange?: (state: string) => void,
 *   onDisconnect?: (pendingRequestIds: string[]) => void,
 * }} [options]
 */
export function createBridge({ onFrame, onStateChange, onDisconnect } = {}) {
  let state = 'idle';
  let port = null;
  let heartbeatTimer = null;
  let pongTimer = null;
  let reconnectTimer = null;
  let reconnectIndex = 0;
  let pingCount = 0;
  let explicitlyClosed = false;
  let invalidated = false;
  const pendingRequestIds = new Set();

  function setState(next) {
    if (state === next) return;
    state = next;
    try {
      onStateChange?.(state);
    } catch {
      // 观察者异常不影响通道。
    }
  }

  function clearTimers() {
    if (heartbeatTimer) clearInterval(heartbeatTimer);
    heartbeatTimer = null;
    if (pongTimer) clearTimeout(pongTimer);
    pongTimer = null;
    if (reconnectTimer) clearTimeout(reconnectTimer);
    reconnectTimer = null;
  }

  function isInvalidated(error) {
    if (!globalThis.chrome?.runtime?.id) return true;
    return /Extension context invalidated|message port closed/i.test(String(error?.message ?? ''));
  }

  function handleInvalidated() {
    if (invalidated) return;
    invalidated = true;
    explicitlyClosed = true;
    clearTimers();
    const old = port;
    port = null;
    if (old) {
      try {
        old.disconnect();
      } catch {
        // 已断开，忽略。
      }
    }
    pendingRequestIds.clear();
    setState('closed');
    console.info('[SimpleTrans] 扩展已重新加载，请刷新页面');
  }

  function scheduleReconnect() {
    if (invalidated || explicitlyClosed || reconnectTimer) return;
    const delay =
      RECONNECT_DELAYS_MS[Math.min(reconnectIndex, RECONNECT_DELAYS_MS.length - 1)];
    reconnectIndex += 1;
    console.debug(`[SimpleTrans] ${delay}ms 后重连后台`);
    reconnectTimer = setTimeout(() => {
      reconnectTimer = null;
      connect();
    }, delay);
  }

  function handlePortDisconnect(disconnectedPort) {
    if (disconnectedPort !== port) return;
    port = null;
    handleDisconnect();
  }

  function handleDisconnect() {
    if (state === 'closed') return;
    clearTimers();

    const old = port;
    port = null;
    if (old) {
      try {
        old.disconnect();
      } catch {
        // 已断开，忽略。
      }
    }

    const ids = [...pendingRequestIds];
    pendingRequestIds.clear();
    try {
      onDisconnect?.(ids);
    } catch {
      // 观察者异常不影响重连。
    }

    setState('reconnecting');
    scheduleReconnect();
  }

  function sendPing() {
    if (!port) return;
    const activePort = port;
    const sentAt = Date.now();

    pingCount += 1;
    if (pongTimer) clearTimeout(pongTimer);
    pongTimer = setTimeout(() => {
      pongTimer = null;
      if (activePort !== port) return;
      console.info('[SimpleTrans] 心跳超时，准备重连');
      handleDisconnect();
    }, HEARTBEAT_TIMEOUT_MS);

    try {
      activePort.postMessage({ type: MESSAGE_TYPES.PING, payload: { sentAt } });
    } catch (error) {
      if (isInvalidated(error)) {
        handleInvalidated();
        return;
      }
      handleDisconnect();
    }
  }

  function handlePong(payload) {
    if (!port) return;
    if (pongTimer) {
      clearTimeout(pongTimer);
      pongTimer = null;
    }
    if (typeof payload?.sentAt === 'number') {
      console.debug('[SimpleTrans] 心跳正常', {
        count: pingCount,
        rtt: Date.now() - payload.sentAt,
      });
    }
    if (state !== 'connected') {
      reconnectIndex = 0;
      setState('connected');
    }
    if (!heartbeatTimer) {
      heartbeatTimer = setInterval(sendPing, HEARTBEAT_INTERVAL_MS);
    }
  }

  function handleMessage(message) {
    if (!message || typeof message !== 'object') return;
    if (message.type === MESSAGE_TYPES.PONG) {
      handlePong(message.payload);
      return;
    }
    if (message.type === MESSAGE_TYPES.BATCH_DONE) {
      const requestId = message.payload?.requestId;
      if (requestId) pendingRequestIds.delete(requestId);
    }
    try {
      onFrame?.(message);
    } catch {
      // 观察者异常不影响通道。
    }
  }

  function connect() {
    if (invalidated) return;
    if (state === 'connected' || state === 'connecting') return;
    if (!globalThis.chrome?.runtime?.id) {
      handleInvalidated();
      return;
    }

    explicitlyClosed = false;
    if (reconnectTimer) {
      clearTimeout(reconnectTimer);
      reconnectTimer = null;
    }
    setState('connecting');

    let nextPort;
    try {
      nextPort = globalThis.chrome.runtime.connect({ name: PORT_NAME });
    } catch (error) {
      if (isInvalidated(error)) {
        handleInvalidated();
        return;
      }
      setState('reconnecting');
      scheduleReconnect();
      return;
    }

    port = nextPort;
    nextPort.onMessage.addListener(handleMessage);
    nextPort.onDisconnect.addListener(() => handlePortDisconnect(nextPort));
    sendPing();
  }

  function close() {
    explicitlyClosed = true;
    clearTimers();
    pendingRequestIds.clear();

    const old = port;
    port = null;
    if (old) {
      try {
        old.postMessage({ type: MESSAGE_TYPES.CLOSE, payload: {} });
      } catch {
        // 端口已断开，忽略。
      }
      try {
        old.disconnect();
      } catch {
        // 已断开，忽略。
      }
    }
    setState('closed');
  }

  function send(frame) {
    if (state !== 'connected' || !port) {
      throw new BridgeError(ERROR_CODES.NETWORK, '尚未连接后台', FAILURE_REASONS.NOT_CONNECTED);
    }
    try {
      port.postMessage(frame);
    } catch (error) {
      if (isInvalidated(error)) {
        handleInvalidated();
        throw new BridgeError(
          ERROR_CODES.OTHER,
          '扩展已重新加载，请刷新页面',
          FAILURE_REASONS.EXTENSION_INVALIDATED
        );
      }
      handleDisconnect();
      throw new BridgeError(
        ERROR_CODES.NETWORK,
        '与后台的连接已断开',
        FAILURE_REASONS.DISCONNECTED
      );
    }
  }

  return {
    connect,
    close,
    getState: () => state,
    send,
    /**
     * @param {{ requestId: string, targetLang?: string, context?: string, items: object[] }} payload
     */
    postBatch(payload) {
      const requestId = payload?.requestId;
      if (requestId) pendingRequestIds.add(requestId);
      try {
        send({ type: MESSAGE_TYPES.TRANSLATE_BATCH, payload });
      } catch (error) {
        if (requestId) pendingRequestIds.delete(requestId);
        throw error;
      }
    },
    cancelBatch(requestId) {
      send({ type: MESSAGE_TYPES.CANCEL_BATCH, payload: { requestId } });
    },
    cancelItem(requestId, itemId) {
      send({ type: MESSAGE_TYPES.CANCEL_ITEM, payload: { requestId, itemId } });
    },
  };
}
