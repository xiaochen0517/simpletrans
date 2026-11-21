/**
 * E5 状态徽标
 *
 * 模块：公共模块（E）/ 共享展示组件
 * 职责：用「图标 + 文字」表达状态，不只依赖颜色；色调限定为 ok / warn / error / idle / primary。
 * 依赖：无（纯展示）；只输出 HyperUI/Tailwind 类。
 */

const TONE_CLASS = Object.freeze({
  ok: 'bg-green-100 text-green-800 dark:bg-green-900/40 dark:text-green-200',
  warn: 'bg-amber-100 text-amber-800 dark:bg-amber-900/40 dark:text-amber-200',
  error: 'bg-red-100 text-red-800 dark:bg-red-900/40 dark:text-red-200',
  idle: 'bg-gray-100 text-gray-700 dark:bg-gray-800 dark:text-gray-300',
  primary: 'bg-indigo-100 text-indigo-700 dark:bg-indigo-900/40 dark:text-indigo-200',
});

/**
 * @param {{
 *   tone?: 'ok' | 'warn' | 'error' | 'idle' | 'primary',
 *   icon?: import('react').ReactNode,
 *   children: import('react').ReactNode,
 *   title?: string,
 * }} props
 */
export default function StatusBadge({ tone = 'idle', icon = null, children, title }) {
  return (
    <span
      data-slot="status-badge"
      data-tone={tone}
      className={`inline-flex items-center gap-1 rounded-full px-2 py-0.5 text-xs font-medium ${
        TONE_CLASS[tone] ?? TONE_CLASS.idle
      }`}
      title={title}
    >
      {icon}
      <span>{children}</span>
    </span>
  );
}
