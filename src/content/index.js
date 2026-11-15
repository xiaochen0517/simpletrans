/**
 * 页面注入入口
 *
 * 模块：页面注入（D）
 * 职责：建立并持有 D4 桥单例，接页面生命周期；P3 起把消息交给悬停、任务与渲染模块。
 * 依赖：D4 桥（bridge）、content.css（P2 起）。
 * 实现阶段：P2–P3
 *
 * 约束：不得引用 shared/config、shared/translate、shared/cache；
 *       不得直接读写同步存储与本地存储。
 */
import './content.css';
import { createBridge } from './bridge.js';

const bridge = createBridge({
  onStateChange: (state) => console.info(`[SimpleTrans] 通道状态：${state}`),
  onDisconnect: (pendingRequestIds) => {
    if (pendingRequestIds.length > 0) {
      console.debug('[SimpleTrans] 在途请求中断', pendingRequestIds);
    }
  },
});

bridge.connect();

// Node 单元测试没有 window；真实页面才接生命周期。
if (typeof window !== 'undefined') {
  window.addEventListener('pagehide', () => bridge.close());
  window.addEventListener('pageshow', (event) => {
    if (event.persisted) bridge.connect();
  });
}

/**
 * 供 P3/P5 复用同一个桥。
 * @returns {ReturnType<typeof createBridge>}
 */
export function getBridge() {
  return bridge;
}
