/**
 * C 空状态
 *
 * 模块：插件独立页面（C）/ 设置页组件
 * 职责：无实例等空场景的统一展示：图标、标题、说明与主/次操作。
 * 依赖：无（纯展示）。
 * 实现阶段：P8-3（设置页内容分类与 UI 规范化）
 */

/**
 * @param {{
 *   icon: import('react').ReactNode,
 *   title: string,
 *   description?: string,
 *   children?: import('react').ReactNode,
 * }} props
 */
export default function EmptyState({ icon, title, description, children }) {
  return (
    <div className="op-empty">
      <span className="op-empty-icon" aria-hidden="true">
        {icon}
      </span>
      <p className="op-empty-title" style={{ margin: 0 }}>
        {title}
      </p>
      {description ? <p className="op-sub">{description}</p> : null}
      {children ? <div className="op-inline" style={{ justifyContent: 'center' }}>{children}</div> : null}
    </div>
  );
}
