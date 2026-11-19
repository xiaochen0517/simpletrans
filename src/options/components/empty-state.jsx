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
    <div className="card items-center gap-2.5 bg-base-100 p-8 text-center">
      <span className="grid size-11 place-items-center rounded-box bg-base-200 text-primary" aria-hidden="true">
        {icon}
      </span>
      <p className="m-0 text-sm font-semibold">
        {title}
      </p>
      {description ? <p className="m-0 text-sm leading-relaxed text-base-content/70 break-words">{description}</p> : null}
      {children ? <div className="flex flex-wrap items-center justify-center gap-2">{children}</div> : null}
    </div>
  );
}
