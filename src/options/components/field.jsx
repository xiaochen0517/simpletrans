/**
 * C 表单字段
 *
 * 模块：插件独立页面（C）/ 设置页组件
 * 职责：统一「标签 + 控件 + 错误 + 帮助文字」的排版，并生成 `aria-describedby` 关联串。
 * 依赖：无（纯展示）。
 * 实现阶段：P8-3（设置页内容分类与 UI 规范化）
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
    <div className="op-field">
      <span className="op-inline" style={{ gap: 6 }}>
        <label className="op-label" htmlFor={id}>
          {label}
          {required ? <span aria-hidden="true"> *</span> : null}
        </label>
        {badge}
      </span>
      {children}
      {error ? (
        <span className="op-error" id={`${id}-error`} role="alert">
          {error}
        </span>
      ) : null}
      {help ? (
        <span className="op-help" id={`${id}-help`}>
          {help}
        </span>
      ) : null}
    </div>
  );
}
