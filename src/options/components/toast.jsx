/**
 * C 顶部提示
 *
 * 模块：插件独立页面（C）/ 设置页组件
 * 职责：展示壳层的全局成功/失败/说明提示，用 `aria-live` 让读屏可感知；
 *       失败提示不自动消失（由壳层控制停留时间）。
 * 依赖：React、`lucide-react`；使用 HyperUI 顶部 callout + 关闭按钮。
 */

import { CircleCheck, CircleX, Info, X } from 'lucide-react';
import { buttonClass } from '../../shared/ui/button.jsx';

/** 按类型取图标与提示色。 */
const TONES = {
  ok: {
    Icon: CircleCheck,
    className:
      'border-green-500 bg-green-50 text-green-800 dark:border-green-700 dark:bg-green-950/40 dark:text-green-200',
    role: 'status',
  },
  error: {
    Icon: CircleX,
    className:
      'border-red-500 bg-red-50 text-red-800 dark:border-red-700 dark:bg-red-950/40 dark:text-red-200',
    role: 'alert',
  },
  info: {
    Icon: Info,
    className:
      'border-blue-500 bg-blue-50 text-blue-800 dark:border-blue-700 dark:bg-blue-950/40 dark:text-blue-200',
    role: 'status',
  },
};

/**
 * @param {{
 *   toast: { id: number, tone: 'ok' | 'error' | 'info', text: string } | null,
 *   onClose?: () => void,
 * }} props
 */
export default function Toast({ toast, onClose }) {
  if (!toast) return null;
  const { Icon, className, role } = TONES[toast.tone] ?? TONES.info;
  return (
    <div className="pointer-events-none fixed inset-x-0 top-4 z-[1000] flex justify-center px-4">
      <div
        data-slot="toast"
        className={`pointer-events-auto flex w-full max-w-md items-start gap-2 rounded-lg border p-3 text-sm shadow-lg ${className}`}
        role={role}
        aria-live={toast.tone === 'error' ? 'assertive' : 'polite'}
      >
        <span className="mt-0.5 shrink-0">
          <Icon size={15} aria-hidden="true" />
        </span>
        <span className="min-w-0 flex-1 break-words">{toast.text}</span>
        {onClose ? (
          <button
            type="button"
            className={buttonClass({ variant: 'ghost', size: 'xs', iconOnly: true, className: '-m-1 shrink-0' })}
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
