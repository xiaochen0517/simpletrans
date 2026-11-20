/**
 * C 实例卡片
 *
 * 模块：插件独立页面（C）/ 设置页组件
 * 职责：展示单个实例的类型/预设、名称、模型或 endpoint、启用开关、凭据与权限徽标、当前标记，
 *       以及编辑、复制、启停、测试、删除、设为当前、授权入口。
 * 依赖：React、`lucide-react`、设置页共享工具（lib.js）、状态徽标组件。
 * 实现阶段：P8-3（设置页内容分类与 UI 规范化）
 *
 * 卡片只使用 `ST_LIST_ENGINES` 的公开字段：不展示密钥长度、APPID 值、请求头/体或提示词正文。
 */

import {
  AlertTriangle,
  CircleCheck,
  Copy,
  FlaskConical,
  KeyRound,
  Languages,
  Pencil,
  ShieldAlert,
  ShieldCheck,
  Sparkles,
  Star,
  Trash2,
} from 'lucide-react';
import StatusBadge from '../../shared/ui/status-badge.jsx';
import Toggle from '../../shared/ui/toggle.jsx';
import { buttonClass } from '../../shared/ui/button.jsx';
import {
  credentialState,
  instanceDetail,
  instanceEligibility,
  permissionState,
  typeBadgeLabel,
} from '../lib.js';

/**
 * @param {{
 *   instance: Record<string, any>,
 *   active: boolean,
 *   busy?: boolean,
 *   authorizing?: boolean,
 *   onEdit: () => void,
 *   onDuplicate: () => void,
 *   onToggle: (enabled: boolean) => void,
 *   onDelete: () => void,
 *   onSetActive: () => void,
 *   onTest: () => void,
 *   onAuthorize: () => void,
 * }} props
 */
export default function InstanceCard({
  instance,
  active,
  busy = false,
  authorizing = false,
  onEdit,
  onDuplicate,
  onToggle,
  onDelete,
  onSetActive,
  onTest,
  onAuthorize,
}) {
  const unsupported = instance.kind === 'unsupported';
  const credentials = credentialState(instance);
  const permission = permissionState(instance);
  const eligibility = instanceEligibility(instance);
  const Icon = unsupported ? AlertTriangle : instance.type === 'baidu' ? Languages : Sparkles;
  const currentUnusable = active && !eligibility.ok;

  return (
    <article
      data-current={active ? 'true' : 'false'}
      className={`flex flex-col gap-2 rounded-lg border bg-white p-3.5 shadow-sm dark:bg-gray-900 ${
        active
          ? 'border-indigo-600 dark:border-indigo-400'
          : 'border-gray-200 dark:border-gray-700'
      }${unsupported ? ' opacity-70' : ''}`}
      aria-label={`翻译实例 ${instance.name}`}
    >
      <div className="flex items-start gap-2">
        <span className="grid size-7 shrink-0 place-items-center rounded-lg bg-gray-200 dark:bg-gray-700 text-indigo-600 dark:text-indigo-400" aria-hidden="true">
          <Icon size={15} />
        </span>
        <div className="min-w-0 flex-1">
          <div className="flex items-center gap-1.5 text-sm font-semibold break-words">
            <span>{instance.name}</span>
            {active ? (
              <StatusBadge tone="primary" icon={<Star size={11} aria-hidden="true" />}>
                当前
              </StatusBadge>
            ) : null}
            {currentUnusable ? (
              <StatusBadge tone="error" icon={<AlertTriangle size={11} aria-hidden="true" />}>
                不可用
              </StatusBadge>
            ) : null}
          </div>
          <div className="text-xs leading-relaxed text-gray-500 dark:text-gray-400 break-words">{typeBadgeLabel(instance)}</div>
          <div className="text-xs leading-relaxed text-gray-500 dark:text-gray-400 break-words">{instanceDetail(instance)}</div>
        </div>
      </div>

      <div className="flex flex-wrap items-center gap-1.5">
        {unsupported ? (
          <StatusBadge tone="warn" icon={<AlertTriangle size={11} aria-hidden="true" />}>
            类型不受支持
          </StatusBadge>
        ) : (
          <>
            <StatusBadge
              tone={credentials.key === 'ok' || credentials.key === 'none' ? 'ok' : credentials.key === 'partial' ? 'warn' : 'idle'}
              icon={<KeyRound size={11} aria-hidden="true" />}
            >
              {credentials.label}
            </StatusBadge>
            {permission ? (
              <StatusBadge
                tone={permission.key === 'ok' ? 'ok' : 'warn'}
                icon={
                  permission.key === 'ok' ? (
                    <ShieldCheck size={11} aria-hidden="true" />
                  ) : (
                    <ShieldAlert size={11} aria-hidden="true" />
                  )
                }
              >
                {permission.label}
              </StatusBadge>
            ) : null}
            <StatusBadge tone={instance.enabled ? 'ok' : 'idle'}>
              {instance.enabled ? '已启用' : '已停用'}
            </StatusBadge>
          </>
        )}
      </div>

      {!unsupported ? (
        <div className="inline-flex items-center gap-2 text-sm">
          <Toggle
            checked={instance.enabled !== false}
            onChange={(value) => onToggle(value)}
            disabled={busy}
            ariaLabel={`启用 ${instance.name}`}
          />
          <span>{instance.enabled ? '已启用，可用于翻译' : '已停用，不参与翻译'}</span>
        </div>
      ) : null}

      {permission && permission.key !== 'ok' ? (
        <div className="flex flex-wrap items-center gap-2">
          <span className="text-xs leading-relaxed text-gray-500 dark:text-gray-400 break-words">接口域名未授权，测试与翻译会失败。</span>
          <button
            type="button"
            className={buttonClass({ variant: 'warning', size: 'xs' })}
            onClick={onAuthorize}
            disabled={busy || authorizing}
          >
            {authorizing ? '申请中…' : '授权访问'}
          </button>
        </div>
      ) : null}

      <div className="flex flex-wrap gap-1.5 pt-0.5">
        {!unsupported ? (
          <>
            <button type="button" className={buttonClass({ size: 'xs' })} onClick={onEdit} disabled={busy}>
              <Pencil size={12} aria-hidden="true" />
              编辑
            </button>
            <button type="button" className={buttonClass({ size: 'xs' })} onClick={onDuplicate} disabled={busy}>
              <Copy size={12} aria-hidden="true" />
              复制
            </button>
            <button type="button" className={buttonClass({ size: 'xs' })} onClick={onTest} disabled={busy}>
              <FlaskConical size={12} aria-hidden="true" />
              测试
            </button>
          </>
        ) : null}
        {!active && !unsupported ? (
          <button
            type="button"
            className={buttonClass({ variant: 'primary', size: 'xs' })}
            onClick={onSetActive}
            disabled={busy || !eligibility.ok}
            title={eligibility.ok ? '设为当前翻译方式' : eligibility.reason ?? undefined}
          >
            <CircleCheck size={12} aria-hidden="true" />
            设为当前
          </button>
        ) : null}
        <button
          type="button"
          className={buttonClass({ variant: 'danger', size: 'xs' })}
          onClick={onDelete}
          disabled={busy}
        >
          <Trash2 size={12} aria-hidden="true" />
          删除
        </button>
      </div>
    </article>
  );
}
