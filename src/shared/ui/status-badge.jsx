/**
 * E5 状态徽标
 *
 * 模块：公共模块（E）/ 共享展示组件
 * 职责：用「图标 + 文字」表达状态，不只依赖颜色；色调限定为 ok / warn / error / idle / primary。
 * 依赖：无（纯展示）；只输出 daisyUI `badge` 类。
 * 实现阶段：P8-3（设置页）；UI 规范化（迁入共享层）
 */

const TONE_CLASS = Object.freeze({
  ok: 'badge-success',
  warn: 'badge-warning',
  error: 'badge-error',
  idle: 'badge-ghost',
  primary: 'badge-primary',
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
    <span className={`badge badge-sm gap-1 ${TONE_CLASS[tone] ?? TONE_CLASS.idle}`} title={title}>
      {icon}
      <span>{children}</span>
    </span>
  );
}
