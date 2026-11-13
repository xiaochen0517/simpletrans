/**
 * B1 状态显示 / B2 命令下发（占位）
 *
 * 模块：工具栏弹窗（B）
 * 职责：显示当前标签页的翻译状态，并把用户操作转成命令。
 * 依赖：E1 消息协议、E2 公开设置（P6 起）。
 * 实现阶段：P6（弹窗命令与状态显示）
 *
 * P0 只渲染静态占位，不读取设置、不发消息、不调用引擎。
 */
import './popup.css';

export default function Popup() {
  return (
    <main className="popup p-4">
      <h1 className="text-lg font-bold m-0">SimpleTrans</h1>
      <p className="text-sm text-base-content/70 mt-2">弹窗骨架已就绪，状态与命令待接入（P6）。</p>
    </main>
  );
}
