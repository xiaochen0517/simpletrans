/**
 * C 顶部提示
 *
 * 模块：插件独立页面（C）/ 设置页组件
 * 职责：展示壳层的全局成功/失败/说明提示，用 `aria-live` 让读屏可感知；
 *       失败提示不自动消失（由壳层控制停留时间）。
 * 依赖：React、`lucide-react`；使用 daisyUI `toast` + `alert`。
 * 实现阶段：P8-3（设置页内容分类与 UI 规范化）；UI 规范化（改用 daisyUI alert）
 */

import { CircleCheck, CircleX, Info, X } from 'lucide-react';

/** 按类型取图标与 daisyUI alert 色。 */
const TONES = {
  ok: { Icon: CircleCheck, alert: 'alert-success', role: 'status' },
  error: { Icon: CircleX, alert: 'alert-error', role: 'alert' },
  info: { Icon: Info, alert: 'alert-info', role: 'status' },
};

/**
 * @param {{
 *   toast: { id: number, tone: 'ok' | 'error' | 'info', text: string } | null,
 *   onClose?: () => void,
 * }} props
 */
export default function Toast({ toast, onClose }) {
  if (!toast) return null;
  const { Icon, alert, role } = TONES[toast.tone] ?? TONES.info;
  return (
    <div className="toast toast-top toast-center z-[1000]">
      <div
        className={`alert ${alert}`}
        role={role}
        aria-live={toast.tone === 'error' ? 'assertive' : 'polite'}
      >
        <Icon size={15} aria-hidden="true" />
        <span className="break-words">{toast.text}</span>
        {onClose ? (
          <button
            type="button"
            className="btn btn-xs btn-ghost"
            onClick={onClose}
            aria-label="关闭提示"
          >
            <X size={13} aria-hidden="true" />
          </button>
        ) : null}
      </div>
    </div>
  );
}
