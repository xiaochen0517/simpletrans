/**
 * E5 单选下拉
 *
 * 模块：公共模块（E）/ 共享展示组件
 * 职责：用 daisyUI 的 Dropdown 组件提供单选下拉：触发器使用 `select` 表单类，面板使用
 *       `menu` / `dropdown-content`；处理展开、关闭、键盘导航、焦点返回与单选 ARIA。
 * 依赖：React、`lucide-react`；只输出 daisyUI 类与 Tailwind 布局类，不携带自定义 CSS。
 * 实现阶段：P10（UI 规范化）
 *
 * 选项结构：{ value, label, detail?, disabled? }。label 为第一行，detail 为第二行。
 */

import { useCallback, useEffect, useId, useRef, useState } from 'react';
import { Check } from 'lucide-react';

/**
 * @param {{
 *   id?: string,
 *   value: string,
 *   options: Array<{ value: string, label: string, detail?: string, disabled?: boolean }>,
 *   onChange: (value: string) => void,
 *   placeholder?: string,
 *   ariaLabel: string,
 *   ariaDescribedBy?: string,
 *   disabled?: boolean,
 *   loading?: boolean,
 *   className?: string,
 * }} props
 */
export default function Select({
  id,
  value,
  options,
  onChange,
  placeholder = '请选择',
  ariaLabel,
  ariaDescribedBy,
  disabled = false,
  loading = false,
  className = '',
}) {
  const detailsRef = useRef(null);
  const summaryRef = useRef(null);
  const listRef = useRef(null);
  const [open, setOpen] = useState(false);
  const [dropTop, setDropTop] = useState(false);
  const fallbackId = useId();
  const selectId = id ?? fallbackId;
  const current = options.find((option) => String(option.value) === String(value)) ?? null;
  const locked = disabled || loading;

  const close = useCallback((focusSummary = false) => {
    const details = detailsRef.current;
    if (details) details.open = false;
    setOpen(false);
    if (focusSummary) summaryRef.current?.focus();
  }, []);

  const openMenu = useCallback(() => {
    const details = detailsRef.current;
    if (!details || locked) return;
    const rect = details.getBoundingClientRect?.();
    const estimated = 304;
    setDropTop(Boolean(rect && rect.bottom + estimated > window.innerHeight));
    details.open = true;
    setOpen(true);
  }, [locked]);

  // 展开后聚焦当前项；点击外部关闭。
  useEffect(() => {
    if (!open) return undefined;
    const active = listRef.current?.querySelector('button[data-active="true"]');
    active?.focus?.();

    const onPointerDown = (event) => {
      if (!detailsRef.current?.contains(event.target)) close(false);
    };
    document.addEventListener('pointerdown', onPointerDown);
    return () => document.removeEventListener('pointerdown', onPointerDown);
  }, [close, open]);

  /** 方向键 / Home / End 在可用选项间移动焦点。 */
  const moveFocus = useCallback((key) => {
    const buttons = Array.from(
      listRef.current?.querySelectorAll('button[role="radio"]:not([disabled])') ?? []
    );
    if (buttons.length === 0) return;
    const index = buttons.indexOf(document.activeElement);
    let next = index;
    if (key === 'ArrowDown') next = index < 0 || index === buttons.length - 1 ? 0 : index + 1;
    if (key === 'ArrowUp') next = index <= 0 ? buttons.length - 1 : index - 1;
    if (key === 'Home') next = 0;
    if (key === 'End') next = buttons.length - 1;
    buttons[next]?.focus();
  }, []);

  const choose = (option) => {
    if (option.disabled) return;
    onChange(String(option.value));
    close(true);
  };

  const handleSummaryKeyDown = (event) => {
    if (locked && (event.key === 'Enter' || event.key === ' ')) {
      event.preventDefault();
      return;
    }
    if (event.key === 'ArrowDown' || event.key === 'ArrowUp') {
      event.preventDefault();
      if (locked) return;
      if (!open) openMenu();
    }
  };

  const handleSummaryClick = (event) => {
    if (locked) event.preventDefault();
  };

  const handleToggle = (event) => {
    if (locked) {
      event.currentTarget.open = false;
      setOpen(false);
      return;
    }
    setOpen(event.currentTarget.open);
  };

  const handleKeyDown = (event) => {
    if (event.key === 'Escape') {
      event.preventDefault();
      close(true);
      return;
    }
    if (open && ['ArrowDown', 'ArrowUp', 'Home', 'End'].includes(event.key)) {
      event.preventDefault();
      moveFocus(event.key);
      return;
    }
    if (event.key === 'Tab' && open) close(false);
  };

  const handleBlur = (event) => {
    if (open && !event.currentTarget.contains(event.relatedTarget)) close(false);
  };

  return (
    <details
      ref={detailsRef}
      id={selectId}
      className={`dropdown w-full ${dropTop ? 'dropdown-top' : ''} ${className}`.trim()}
      onToggle={handleToggle}
      onKeyDown={handleKeyDown}
      onBlur={handleBlur}
    >
      <summary
        ref={summaryRef}
        className={`select select-sm w-full ${locked ? 'pointer-events-none opacity-60' : ''}`.trim()}
        aria-label={ariaLabel}
        aria-describedby={ariaDescribedBy}
        aria-haspopup="true"
        aria-expanded={open}
        aria-disabled={locked || undefined}
        title={current ? current.label : placeholder}
        onClick={handleSummaryClick}
        onKeyDown={handleSummaryKeyDown}
      >
        <span className={`block min-w-0 flex-1 truncate ${current ? '' : 'text-base-content/60'}`}>
          {current ? current.label : placeholder}
        </span>
        {loading ? <span className="loading loading-spinner loading-xs" aria-hidden="true" /> : null}
      </summary>
      <ul
        ref={listRef}
        role="radiogroup"
        aria-label={ariaLabel}
        className="menu dropdown-content mt-1 max-h-72 w-full overflow-y-auto rounded-box bg-base-100 p-2 shadow-sm"
      >
        {options.length === 0 ? (
          <li role="none">
            <span className="text-sm opacity-60">{placeholder}</span>
          </li>
        ) : (
          options.map((option) => {
            const selected = String(option.value) === String(value);
            return (
              <li role="none" key={option.value}>
                <button
                  type="button"
                  role="radio"
                  aria-checked={selected}
                  data-value={option.value}
                  data-active={selected ? 'true' : 'false'}
                  disabled={option.disabled}
                  className={selected ? 'menu-active' : undefined}
                  onClick={() => choose(option)}
                >
                  <span className="min-w-0 flex-1">
                    <span className="block truncate text-sm">{option.label}</span>
                    {option.detail ? (
                      <span className="block truncate text-xs opacity-60">{option.detail}</span>
                    ) : null}
                  </span>
                  {selected ? <Check size={14} aria-hidden="true" /> : null}
                </button>
              </li>
            );
          })
        )}
      </ul>
    </details>
  );
}
