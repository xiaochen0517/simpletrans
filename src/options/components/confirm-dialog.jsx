/**
 * C 通用对话框
 *
 * 模块：插件独立页面（C）/ 设置页组件
 * 职责：确认弹窗与表单对话框的统一外壳：`role="dialog"` + `aria-modal`、焦点进入、
 *       Tab 焦点循环、Esc 关闭、关闭后焦点回到触发元素；危险操作默认焦点在「取消」。
 * 依赖：React。
 */

import { useCallback, useEffect, useId, useRef } from 'react';
import { buttonClass } from '../../shared/ui/button.jsx';

/** 可获得焦点的元素选择器。 */
const FOCUSABLE = [
  'a[href]',
  'button:not(:disabled)',
  'input:not(:disabled)',
  'select:not(:disabled)',
  'textarea:not(:disabled)',
  '[tabindex]:not([tabindex="-1"])',
].join(',');

/**
 * @param {{
 *   title: string,
 *   description?: string,
 *   children?: import('react').ReactNode,
 *   confirmLabel?: string,
 *   cancelLabel?: string,
 *   tone?: 'primary' | 'error',
 *   busy?: boolean,
 *   confirmDisabled?: boolean,
 *   onConfirm: () => void,
 *   onCancel: () => void,
 * }} props
 */
export default function ConfirmDialog({
  title,
  description,
  children,
  confirmLabel = '确认',
  cancelLabel = '取消',
  tone = 'primary',
  busy = false,
  confirmDisabled = false,
  onConfirm,
  onCancel,
}) {
  const titleId = useId();
  const dialogRef = useRef(null);
  const cancelRef = useRef(null);

  const cancel = useCallback(() => {
    if (!busy) onCancel();
  }, [busy, onCancel]);

  useEffect(() => {
    const previous = typeof document !== 'undefined' ? document.activeElement : null;
    const target = cancelRef.current ?? dialogRef.current;
    if (target && typeof target.focus === 'function') target.focus();
    return () => {
      if (previous && typeof previous.focus === 'function' && previous.isConnected !== false) {
        try {
          previous.focus();
        } catch {
          // 触发元素已移除时忽略。
        }
      }
    };
  }, []);

  useEffect(() => {
    const onKeyDown = (event) => {
      if (event.key === 'Escape') {
        event.stopPropagation();
        cancel();
        return;
      }
      if (event.key !== 'Tab' || !dialogRef.current) return;
      const items = [...dialogRef.current.querySelectorAll(FOCUSABLE)];
      if (items.length === 0) return;
      const first = items[0];
      const last = items[items.length - 1];
      if (event.shiftKey && document.activeElement === first) {
        event.preventDefault();
        last.focus();
      } else if (!event.shiftKey && document.activeElement === last) {
        event.preventDefault();
        first.focus();
      }
    };
    document.addEventListener('keydown', onKeyDown);
    return () => {
      document.removeEventListener('keydown', onKeyDown);
    };
  }, [cancel]);

  return (
    <div
      className="fixed inset-0 z-50 flex items-center justify-center bg-black/50 p-4 dark:bg-black/70"
      data-slot="dialog-overlay"
      onMouseDown={(event) => {
        if (event.target === event.currentTarget) cancel();
      }}
    >
      <div
        className="flex max-h-[calc(100vh-2rem)] w-full max-w-xl flex-col gap-3 overflow-auto rounded-lg bg-white p-6 shadow-lg dark:bg-gray-900"
        data-slot="dialog-panel"
        role="dialog"
        aria-modal="true"
        aria-labelledby={titleId}
        ref={dialogRef}
      >
        <h2 className="m-0 text-base font-bold break-words text-gray-900 dark:text-white" id={titleId}>
          {title}
        </h2>
        {description ? (
          <p className="text-sm leading-relaxed break-words text-gray-600 dark:text-gray-300">
            {description}
          </p>
        ) : null}
        {children}
        <div className="flex flex-wrap justify-end gap-2">
          <button type="button" className={buttonClass({ size: 'sm' })} onClick={cancel} ref={cancelRef} disabled={busy}>
            {cancelLabel}
          </button>
          <button
            type="button"
            className={buttonClass({ variant: tone === 'error' ? 'danger' : 'primary', size: 'sm' })}
            onClick={onConfirm}
            disabled={busy || confirmDisabled}
          >
            {busy ? '处理中…' : confirmLabel}
          </button>
        </div>
      </div>
    </div>
  );
}
