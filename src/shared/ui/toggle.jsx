/**
 * E5 开关
 *
 * 模块：公共模块（E）/ 共享展示组件
 * 职责：用 HyperUI 的轨道 + 滑块开关呈现布尔状态；保留 checkbox 语义、可访问名称与禁用态。
 * 依赖：React。
 */

const TRACK = Object.freeze({
  sm: 'h-6 w-11',
  md: 'h-7 w-12',
});

const THUMB = Object.freeze({
  sm: 'size-4',
  md: 'size-5',
});

/**
 * @param {{
 *   checked: boolean,
 *   onChange: (checked: boolean) => void,
 *   disabled?: boolean,
 *   ariaLabel?: string,
 *   ariaDescribedBy?: string,
 *   size?: 'sm' | 'md',
 *   className?: string,
 * }} props
 */
export default function Toggle({
  checked,
  onChange,
  disabled = false,
  ariaLabel,
  ariaDescribedBy,
  size = 'sm',
  className = '',
}) {
  const track = TRACK[size] ?? TRACK.sm;
  const thumb = THUMB[size] ?? THUMB.sm;

  return (
    <label
      data-slot="toggle"
      data-checked={checked ? 'true' : 'false'}
      className={`relative inline-flex shrink-0 items-center rounded-full transition-colors focus-within:ring-2 focus-within:ring-indigo-500 focus-within:ring-offset-2 dark:focus-within:ring-offset-gray-950 ${
        checked ? 'bg-indigo-600 dark:bg-indigo-500' : 'bg-gray-300 dark:bg-gray-700'
      } ${disabled ? 'cursor-not-allowed opacity-50' : 'cursor-pointer'} ${track} ${className}`.trim()}
    >
      <input
        type="checkbox"
        className="peer sr-only"
        checked={checked}
        onChange={(event) => onChange?.(event.target.checked)}
        disabled={disabled}
        aria-label={ariaLabel}
        aria-describedby={ariaDescribedBy}
      />
      <span
        aria-hidden="true"
        className={`pointer-events-none absolute left-1 top-1/2 -translate-y-1/2 rounded-full bg-white shadow-sm transition-transform ${thumb} ${
          checked ? 'translate-x-5' : 'translate-x-0'
        }`}
      />
    </label>
  );
}
