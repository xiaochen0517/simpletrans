/**
 * E5 提示条
 *
 * 模块：公共模块（E）/ 共享展示组件
 * 职责：用 daisyUI `alert` 表达成功 / 失败 / 警告 / 信息四种提示，并带可访问性语义。
 * 依赖：React、`lucide-react`；只输出 daisyUI 类，不携带自定义 CSS。
 * 实现阶段：P10（UI 规范化）
 */

import { CircleCheck, CircleX, Info, TriangleAlert } from 'lucide-react';

const TONES = Object.freeze({
  success: { className: 'alert-success', Icon: CircleCheck, role: 'status' },
  error: { className: 'alert-error', Icon: CircleX, role: 'alert' },
  warning: { className: 'alert-warning', Icon: TriangleAlert, role: 'status' },
  info: { className: 'alert-info', Icon: Info, role: 'status' },
});

/**
 * @param {{
 *   tone?: 'success' | 'error' | 'warning' | 'info',
 *   children: import('react').ReactNode,
 *   icon?: import('react').ReactNode,
 *   className?: string,
 * }} props
 */
export default function Notice({ tone = 'info', children, icon = null, className = '' }) {
  const config = TONES[tone] ?? TONES.info;
  const Icon = config.Icon;

  return (
    <div
      className={`alert text-sm ${config.className} ${className}`.trim()}
      role={config.role}
      aria-live="polite"
    >
      {icon ?? <Icon size={16} aria-hidden="true" />}
      <span className="min-w-0 break-words">{children}</span>
    </div>
  );
}
