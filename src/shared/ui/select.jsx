/**
 * E5 单选下拉
 *
 * 模块：公共模块（E）/ 共享展示组件
 * 职责：用 `details` + `summary` + 单选列表实现产品内下拉：触发器与面板使用 HyperUI 表单/面板样式；
 *       处理展开、关闭、键盘导航、焦点返回与单选 ARIA。
 * 依赖：React、`lucide-react`；只输出 Tailwind 类，不携带自定义 CSS。
 *
 * 选项结构：{ value, label, detail?, disabled? }。label 为第一行，detail 为第二行。
 */

import { useCallback, useEffect, useId, useRef, useState } from 'react';
import { Check, ChevronDown, LoaderCircle } from 'lucide-react';

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
      data-slot="select"
      data-open={open ? 'true' : 'false'}
      className={`relative w-full ${className}`.trim()}
      onToggle={handleToggle}
      onKeyDown={handleKeyDown}
      onBlur={handleBlur}
    >
      <summary
        ref={summaryRef}
        data-slot="select-trigger"
        className={`flex w-full list-none items-center justify-between gap-2 rounded-lg border border-gray-300 bg-white px-3 py-2 text-sm text-gray-900 shadow-sm transition-colors [&::-webkit-details-marker]:hidden focus-visible:ring-2 focus-visible:ring-indigo-500 focus-visible:ring-offset-2 focus-visible:outline-none dark:border-gray-700 dark:bg-gray-900 dark:text-white dark:focus-visible:ring-offset-gray-950 ${
          locked ? 'pointer-events-none opacity-60' : 'cursor-pointer hover:bg-gray-50 dark:hover:bg-gray-800'
        }`}
        aria-label={ariaLabel}
        aria-describedby={ariaDescribedBy}
        aria-haspopup="true"
        aria-expanded={open}
        aria-disabled={locked || undefined}
        title={current ? current.label : placeholder}
        onClick={handleSummaryClick}
        onKeyDown={handleSummaryKeyDown}
      >
        <span
          className={`block min-w-0 flex-1 truncate ${
            current ? '' : 'text-gray-500 dark:text-gray-400'
          }`}
        >
          {current ? current.label : placeholder}
        </span>
        {loading ? (
          <LoaderCircle className="size-4 shrink-0 animate-spin text-gray-500" aria-hidden="true" />
        ) : (
          <ChevronDown
            className={`size-4 shrink-0 text-gray-500 transition-transform dark:text-gray-400 ${
              open ? 'rotate-180' : ''
            }`}
            aria-hidden="true"
          />
        )}
      </summary>
      <ul
        ref={listRef}
        role="radiogroup"
        aria-label={ariaLabel}
        data-slot="select-panel"
        className={`absolute left-0 z-30 max-h-72 w-full overflow-y-auto rounded-lg border border-gray-200 bg-white p-1 shadow-lg dark:border-gray-700 dark:bg-gray-900 ${
          dropTop ? 'bottom-full mb-1' : 'top-full mt-1'
        }`}
      >
        {options.length === 0 ? (
          <li role="none">
            <span className="block px-2 py-1.5 text-sm text-gray-500 dark:text-gray-400">
              {placeholder}
            </span>
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
                  data-slot="select-option"
                  disabled={option.disabled}
                  className={`flex w-full items-start justify-between gap-2 rounded-md px-2 py-1.5 text-left transition-colors disabled:cursor-not-allowed disabled:opacity-50 ${
                    selected
                      ? 'bg-indigo-50 text-indigo-700 dark:bg-indigo-950/40 dark:text-indigo-200'
                      : 'text-gray-700 hover:bg-gray-100 dark:text-gray-200 dark:hover:bg-gray-800'
                  }`}
                  onClick={() => choose(option)}
                >
                  <span className="min-w-0 flex-1">
                    <span className="block truncate text-sm">{option.label}</span>
                    {option.detail ? (
                      <span className="block truncate text-xs text-gray-500 dark:text-gray-400">
                        {option.detail}
                      </span>
                    ) : null}
                  </span>
                  {selected ? <Check size={14} className="mt-0.5 shrink-0" aria-hidden="true" /> : null}
                </button>
              </li>
            );
          })
        )}
      </ul>
    </details>
  );
}
