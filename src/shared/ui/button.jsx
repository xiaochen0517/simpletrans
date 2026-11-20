/**
 * E5 按钮
 *
 * 模块：公共模块（E）/ 共享展示组件
 * 职责：用 HyperUI 的主/次/幽灵/危险/警告按钮样式提供统一按钮，支持尺寸、图标按钮与加载态；
 *       只输出 Tailwind 类，不携带自定义 CSS。
 * 依赖：React、`lucide-react`。
 * 实现阶段：P10（UI 规范化）；HyperUI 迁移（改为 Tailwind 调色板与 dark 变体）
 */

import { LoaderCircle } from 'lucide-react';

const BASE =
  'inline-flex items-center justify-center gap-1.5 rounded-lg font-medium transition-colors focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-indigo-500 focus-visible:ring-offset-2 disabled:cursor-not-allowed disabled:opacity-50 dark:focus-visible:ring-offset-gray-950';

const VARIANTS = Object.freeze({
  primary:
    'bg-indigo-600 text-white hover:bg-indigo-700 dark:bg-indigo-500 dark:hover:bg-indigo-400',
  secondary:
    'border border-gray-300 bg-white text-gray-700 hover:bg-gray-50 dark:border-gray-700 dark:bg-gray-900 dark:text-gray-200 dark:hover:bg-gray-800',
  ghost:
    'text-gray-600 hover:bg-gray-100 hover:text-gray-900 dark:text-gray-300 dark:hover:bg-gray-800 dark:hover:text-white',
  danger: 'bg-red-600 text-white hover:bg-red-700 dark:bg-red-500 dark:hover:bg-red-400',
  warning: 'bg-amber-500 text-gray-900 hover:bg-amber-400',
});

const SIZES = Object.freeze({
  xs: 'px-2.5 py-1 text-xs',
  sm: 'px-3 py-1.5 text-sm',
  md: 'px-4 py-2 text-sm',
});

const ICON_SIZES = Object.freeze({
  xs: 'p-1',
  sm: 'p-1.5',
  md: 'p-2',
});

/**
 * 组合按钮类名；供 `Button` 与少量保留原生 `<button>` 的表单/列表操作复用。
 * @param {{ variant?: string, size?: string, iconOnly?: boolean, className?: string }} [options]
 * @returns {string}
 */
export function buttonClass({
  variant = 'secondary',
  size = 'sm',
  iconOnly = false,
  className = '',
} = {}) {
  return [
    BASE,
    VARIANTS[variant] ?? VARIANTS.secondary,
    iconOnly ? ICON_SIZES[size] ?? ICON_SIZES.sm : SIZES[size] ?? SIZES.sm,
    className,
  ]
    .filter(Boolean)
    .join(' ');
}

/**
 * @param {{
 *   variant?: 'primary' | 'secondary' | 'ghost' | 'danger' | 'warning',
 *   size?: 'xs' | 'sm' | 'md',
 *   busy?: boolean,
 *   iconOnly?: boolean,
 *   type?: 'button' | 'submit' | 'reset',
 *   className?: string,
 *   disabled?: boolean,
 *   children?: import('react').ReactNode,
 * } & import('react').ButtonHTMLAttributes<HTMLButtonElement>} props
 */
export default function Button({
  variant = 'secondary',
  size = 'sm',
  busy = false,
  iconOnly = false,
  type = 'button',
  className = '',
  disabled = false,
  children,
  ...rest
}) {
  const classes = buttonClass({ variant, size, iconOnly, className });

  return (
    <button
      {...rest}
      type={type}
      className={classes}
      disabled={disabled || busy}
      aria-busy={busy || undefined}
    >
      {busy ? <LoaderCircle className="size-4 animate-spin" aria-hidden="true" /> : null}
      {children}
    </button>
  );
}
