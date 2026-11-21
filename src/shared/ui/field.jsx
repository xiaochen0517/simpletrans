/**
 * E5 表单字段
 *
 * 模块：公共模块（E）/ 共享展示组件
 * 职责：统一「标签 + 控件 + 错误 + 帮助文字」的排版，并生成 `aria-describedby` 关联串。
 * 依赖：无（纯展示）；只输出 HyperUI/Tailwind 布局与文字类。
 */

/**
 * 组合错误与帮助文字的 `aria-describedby`；都没有时返回 undefined。
 * @param {string} id 控件 id
 * @param {{ help?: string, error?: string }} [options]
 * @returns {string | undefined}
 */
export function describedBy(id, { help, error } = {}) {
  const ids = [];
  if (error) ids.push(`${id}-error`);
  if (help) ids.push(`${id}-help`);
  return ids.length > 0 ? ids.join(' ') : undefined;
}

/**
 * 字段容器：标签在上、控件居中、错误与帮助在下；标签后可带状态徽标。
 * @param {{
 *   id: string,
 *   label: string,
 *   help?: string,
 *   error?: string,
 *   required?: boolean,
 *   badge?: import('react').ReactNode,
 *   children: import('react').ReactNode,
 * }} props
 */
export default function Field({ id, label, help, error, required = false, badge = null, children }) {
  return (
    <div className="flex min-w-0 flex-col gap-1" data-field={id}>
      <span className="flex flex-wrap items-center gap-1.5">
        <label className="text-xs font-semibold text-gray-700 dark:text-gray-300" htmlFor={id}>
          {label}
          {required ? <span aria-hidden="true"> *</span> : null}
        </label>
        {badge}
      </span>
      {children}
      {error ? (
        <span
          className="text-xs leading-relaxed text-red-600 dark:text-red-400"
          id={`${id}-error`}
          role="alert"
        >
          {error}
        </span>
      ) : null}
      {help ? (
        <span
          className="text-xs leading-relaxed break-words text-gray-500 dark:text-gray-400"
          id={`${id}-help`}
        >
          {help}
        </span>
      ) : null}
    </div>
  );
}
