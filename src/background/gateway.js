/**
 * 数据面流式网关
 *
 * 职责：端口生命周期、鉴权、模型调用、增量转发、并发闸门、缓存、错误归一。
 * 原则：**不持有跨段任务状态**。这里的全部状态都是「端口 → 在途请求」，端口
 * 断开即释放；Service Worker 被回收也不会留下需要恢复的任务队列。
 *
 * P0 只实现连通性（PING/PONG）；流式转发在 P3 接入
 * `shared/translate/deepseek.js#translateSegmentStream`。
 */

import { ST } from '../shared/protocol.js';
import { PORT_NAME } from '../shared/constants.js';

/**
 * @typedef {Object} PortSlot
 * @property {chrome.runtime.Port} port
 * @property {Map<string, AbortController>} requests
 */

/** @type {Map<string, PortSlot>} */
const ports = new Map();

/**
 * @param {PortSlot} slot
 */
function abortAll(slot) {
  for (const controller of slot.requests.values()) {
    controller.abort();
  }
  slot.requests.clear();
}

/** 注册端口监听。必须在 Service Worker 顶层同步调用。 */
export function registerGateway() {
  chrome.runtime.onConnect.addListener((port) => {
    if (port.name !== PORT_NAME) return;

    /** @type {PortSlot} */
    const slot = { port, requests: new Map() };
    ports.set(port.id, slot);

    port.onDisconnect.addListener(() => {
      abortAll(slot);
      ports.delete(port.id);
    });

    port.onMessage.addListener((message) => {
      if (!message || typeof message !== 'object') return;

      switch (message.type) {
        case ST.PING:
          port.postMessage({ type: ST.PONG, t: Date.now() });
          break;
        case ST.CLOSE:
          abortAll(slot);
          break;
        case ST.CANCEL_SEGMENT: {
          const controller = slot.requests.get(message.requestId);
          if (controller) controller.abort();
          break;
        }
        default:
          // TODO(P3): ST.TRANSLATE_SEGMENT → 流式翻译并转发 ST.SEG_DELTA / SEG_DONE / SEG_ERROR
          break;
      }
    });
  });
}

/** 仅供调试：当前活跃端口数。 */
export function activePortCount() {
  return ports.size;
}
