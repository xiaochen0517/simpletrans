/**
 * E5 提示条
 *
 * 模块：公共模块（E）/ 共享展示组件
 * 职责：用 HyperUI 的带边框 callout 表达成功 / 失败 / 警告 / 信息四种提示，并带可访问性语义。
 * 依赖：React、`lucide-react`；只输出 Tailwind 类，不携带自定义 CSS。
 * 实现阶段：P10（UI 规范化）；HyperUI 迁移（alert → 带边框 callout）
 */

import { CircleCheck, CircleX, Info, TriangleAlert } from 'lucide-react';

const TONES = Object.freeze({
  success: {
    className: 'border-green-500 bg-green-50 text-green-800 dark:border-green-700 dark:bg-green-950/40 dark:text-green-200',
    Icon: CircleCheck,
    role: 'status',
  },
  error: {
    className: 'border-red-500 bg-red-50 text-red-800 dark:border-red-700 dark:bg-red-950/40 dark:text-red-200',
    Icon: CircleX,
    role: 'alert',
  },
  warning: {
    className: 'border-amber-500 bg-amber-50 text-amber-800 dark:border-amber-700 dark:bg-amber-950/40 dark:text-amber-200',
    Icon: TriangleAlert,
    role: 'status',
  },
  info: {
    className: 'border-blue-500 bg-blue-50 text-blue-800 dark:border-blue-700 dark:bg-blue-950/40 dark:text-blue-200',
    Icon: Info,
    role: 'status',
  },
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
      data-slot="notice"
      data-tone={tone}
      className={`flex items-start gap-2 rounded-lg border p-3 text-sm ${config.className} ${className}`.trim()}
      role={config.role}
      aria-live="polite"
    >
      <span className="mt-0.5 shrink-0">
        {icon ?? <Icon size={16} aria-hidden="true" />}
      </span>
      <span className="min-w-0 break-words">{children}</span>
    </div>
  );
}
