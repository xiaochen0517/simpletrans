/**
 * C 空状态
 *
 * 模块：插件独立页面（C）/ 设置页组件
 * 职责：无实例等空场景的统一展示：图标、标题、说明与主/次操作。
 * 依赖：无（纯展示）。
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
    <div className="flex flex-col items-center gap-2 rounded-lg border border-gray-200 bg-white p-8 text-center shadow-sm dark:border-gray-700 dark:bg-gray-900">
      <span
        className="grid size-14 place-items-center rounded-full bg-gray-100 text-gray-400 dark:bg-gray-800 dark:text-gray-500"
        aria-hidden="true"
      >
        {icon}
      </span>
      <p className="m-0 text-sm font-semibold text-gray-900 dark:text-white">{title}</p>
      {description ? <p className="m-0 text-sm leading-relaxed text-gray-600 dark:text-gray-300 break-words">{description}</p> : null}
      {children ? <div className="flex flex-wrap items-center justify-center gap-2">{children}</div> : null}
    </div>
  );
}
