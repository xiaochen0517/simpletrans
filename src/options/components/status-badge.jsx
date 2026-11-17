/**
 * C 状态徽标
 *
 * 模块：插件独立页面（C）/ 设置页组件
 * 职责：用「图标 + 文字」表达状态，不只依赖颜色；色调限定为 ok / warn / error / idle / primary。
 * 依赖：无（纯展示）。
 * 实现阶段：P8-3（设置页内容分类与 UI 规范化）
 */

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
    <span className={`op-badge is-${tone}`} title={title}>
      {icon}
      <span>{children}</span>
    </span>
  );
}
