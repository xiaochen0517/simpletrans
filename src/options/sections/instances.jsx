/**
 * C 翻译实例
 *
 * 模块：插件独立页面（C）/ 设置页分区
 * 职责：列出全部实例并支持筛选；提供新增、编辑、复制、启停、删除、测试、设为当前与域名授权入口；
 *       破坏性操作列出后果并二次确认。
 * 依赖：React、`lucide-react`、E3（instances 的启停/删除/复制/设为当前）、设置页共享工具、
 *       实例卡片与确认对话框组件。
 * 实现阶段：P8-3（设置页内容分类与 UI 规范化）
 */

import { useMemo, useState } from 'react';
import { AlertTriangle, Languages, Plus, Sparkles } from 'lucide-react';
import InstanceCard from '../components/instance-card.jsx';
import ConfirmDialog from '../components/confirm-dialog.jsx';
import EmptyState from '../components/empty-state.jsx';
import { requestOriginPermission, useApp } from '../lib.js';
import {
  duplicateInstance,
  removeInstance,
  setActiveInstance,
  setInstanceEnabled,
} from '../../shared/config/instances.js';
import { MAX_INSTANCES } from '../../shared/config/registry.js';

/** 筛选项。 */
const FILTERS = Object.freeze([
  { id: 'all', label: '全部' },
  { id: 'enabled', label: '已启用' },
  { id: 'missing-key', label: '未配置密钥' },
  { id: 'unsupported', label: '不支持' },
]);

/**
 * 按筛选条件过滤实例。
 * @param {Array<Record<string, any>>} instances
 * @param {string} filter
 * @returns {Array<Record<string, any>>}
 */
function filterInstances(instances, filter) {
  switch (filter) {
    case 'enabled':
      return instances.filter((instance) => instance.enabled !== false);
    case 'missing-key':
      return instances.filter(
        (instance) =>
          instance.kind !== 'unsupported' &&
          instance.requiresKey !== false &&
          instance.hasKey !== true
      );
    case 'unsupported':
      return instances.filter((instance) => instance.kind === 'unsupported');
    default:
      return instances;
  }
}

export default function Instances() {
  const app = useApp();
  const { instances, settings, loading } = app;
  const [filter, setFilter] = useState('all');
  const [busyId, setBusyId] = useState(null);
  const [authorizingId, setAuthorizingId] = useState(null);
  const [confirm, setConfirm] = useState(null);

  const activeId = settings?.activeInstanceId ?? null;
  const counts = useMemo(
    () => ({
      all: instances.length,
      enabled: instances.filter((instance) => instance.enabled !== false).length,
      'missing-key': instances.filter(
        (instance) =>
          instance.kind !== 'unsupported' &&
          instance.requiresKey !== false &&
          instance.hasKey !== true
      ).length,
      unsupported: instances.filter((instance) => instance.kind === 'unsupported').length,
    }),
    [instances]
  );
  const visible = useMemo(() => filterInstances(instances, filter), [instances, filter]);
  const atLimit = instances.length >= MAX_INSTANCES;

  /** 执行一次实例写操作并统一提示。 */
  async function runWrite(id, action, successText) {
    setBusyId(id);
    try {
      await action();
      app.notify('ok', successText);
      app.recordAction(successText);
    } catch (error) {
      app.notify('error', error?.message ?? '操作失败，请重试');
    } finally {
      setBusyId(null);
    }
  }

  /** 执行一次启停写入。 */
  async function applyToggle(instance, enabled) {
    await runWrite(
      instance.id,
      () => app.mutate(() => setInstanceEnabled(instance.id, enabled)),
      enabled ? `已启用「${instance.name}」` : `已停用「${instance.name}」`
    );
  }

  /** 启用/停用；停用当前实例先确认。 */
  async function toggle(instance, enabled) {
    if (!enabled && instance.id === activeId) {
      setConfirm({ kind: 'disable', instance });
      return;
    }
    await applyToggle(instance, enabled);
  }

  /** 复制实例；成功后打开编辑弹窗提示补授权。 */
  async function duplicate(instance) {
    setBusyId(instance.id);
    try {
      const copy = await app.mutate(() => duplicateInstance(instance.id));
      app.notify('ok', `已复制为「${copy.name}」，请确认认证与域名授权后启用`);
      app.recordAction(`复制实例「${instance.name}」`);
      if (copy?.id) app.openEditor(copy.id);
    } catch (error) {
      app.notify('error', error?.message ?? '复制实例失败，请重试');
    } finally {
      setBusyId(null);
    }
  }

  /** 设为当前。 */
  async function makeActive(instance) {
    await runWrite(
      instance.id,
      () => app.mutate(() => setActiveInstance(instance.id)),
      `已切换当前实例为「${instance.name}」；只影响之后提交的段落`
    );
  }

  /** 测试：跳到测试分区并预选实例。 */
  function test(instance) {
    app.setTestInstanceId(instance.id);
    app.navigate('#/test');
  }

  /** 申请 endpoint 域名权限。 */
  async function authorize(instance) {
    setAuthorizingId(instance.id);
    const result = await requestOriginPermission(instance.endpoint?.baseUrl);
    setAuthorizingId(null);
    if (result.ok) {
      await app.refreshInstances();
      app.notify('ok', '已获得接口域名授权');
      app.recordAction(`授权接口域名（${instance.name}）`);
    } else {
      app.notify('error', result.message ?? '未获得域名授权');
    }
  }

  /** 确认弹窗的实际执行。 */
  async function confirmAction() {
    const target = confirm;
    if (!target) return;
    if (target.kind === 'disable') {
      setConfirm(null);
      await applyToggle(target.instance, false);
      return;
    }
    if (target.kind === 'delete') {
      setBusyId(target.instance.id);
      try {
        await app.mutate(() => removeInstance(target.instance.id));
        app.notify('ok', `已删除「${target.instance.name}」`);
        app.recordAction(`删除实例「${target.instance.name}」`);
        setConfirm(null);
      } catch (error) {
        app.notify('error', error?.message ?? '删除实例失败，请重试');
      } finally {
        setBusyId(null);
      }
    }
  }

  if (loading) {
    return (
      <div className="flex flex-col gap-4" aria-busy="true">
        <div className="card gap-2 bg-base-100 p-4">
          <div className="grid gap-2.5" aria-label="正在读取实例">
            <span className="skeleton block h-3 w-[35%]" />
            <span className="skeleton block h-3 w-[65%]" />
            <span className="skeleton block h-3 w-[50%]" />
          </div>
        </div>
      </div>
    );
  }

  return (
    <div className="flex flex-col gap-4">
      <div className="flex flex-wrap items-start justify-between gap-3">
        <div>
          <h2 className="flex items-center gap-2 text-base font-bold">
            <Sparkles size={15} aria-hidden="true" />
            翻译实例
          </h2>
          <p className="text-sm leading-relaxed text-base-content/70 break-words">管理大模型与传统翻译实例；当前实例用于所有页面翻译。</p>
        </div>
        <button
          type="button"
          className="btn btn-sm btn-primary"
          onClick={() => app.openCreate(null)}
          disabled={atLimit}
          title={atLimit ? `最多只能保存 ${MAX_INSTANCES} 个翻译实例` : undefined}
        >
          <Plus size={14} aria-hidden="true" />
          新增翻译实例
        </button>
      </div>

      {atLimit ? (
        <div className="alert alert-warning">
          <AlertTriangle size={15} aria-hidden="true" />
          <span className="min-w-0 break-words">已达上限（{MAX_INSTANCES} 个），删除不需要的实例后才能新增。</span>
        </div>
      ) : null}

      {instances.length > 0 ? (
        <div className="tabs tabs-boxed w-fit" role="group" aria-label="筛选实例">
          {FILTERS.map((item) => (
            <button
              key={item.id}
              type="button"
              className={`tab${filter === item.id ? ' tab-active' : ''}`}
              aria-pressed={filter === item.id}
              onClick={() => setFilter(item.id)}
              disabled={counts[item.id] === 0 && item.id !== 'all'}
            >
              {item.label} {counts[item.id]}
            </button>
          ))}
        </div>
      ) : null}

      {instances.length === 0 ? (
        <EmptyState
          icon={<Sparkles size={20} />}
          title="还没有翻译实例"
          description="添加一个 OpenAI 兼容或百度翻译实例后即可开始翻译。"
        >
          <button
            type="button"
            className="btn btn-sm btn-primary"
            onClick={() => app.openCreate({ type: 'openai', preset: 'deepseek' })}
          >
            OpenAI 兼容（DeepSeek）
          </button>
          <button
            type="button"
            className="btn btn-sm"
            onClick={() => app.openCreate({ type: 'openai', preset: 'custom' })}
          >
            OpenAI 兼容（自定义）
          </button>
          <button
            type="button"
            className="btn btn-sm"
            onClick={() => app.openCreate({ type: 'baidu' })}
          >
            <Languages size={13} aria-hidden="true" />
            百度翻译
          </button>
        </EmptyState>
      ) : visible.length === 0 ? (
        <div className="card gap-2 bg-base-100 p-4">
          <p className="text-sm leading-relaxed text-base-content/70 break-words">当前筛选下没有实例。</p>
        </div>
      ) : (
        <div className="grid gap-3 sm:grid-cols-2">
          {visible.map((instance) => (
            <InstanceCard
              key={instance.id}
              instance={instance}
              active={instance.id === activeId}
              busy={busyId === instance.id}
              authorizing={authorizingId === instance.id}
              onEdit={() => app.openEditor(instance.id)}
              onDuplicate={() => duplicate(instance)}
              onToggle={(enabled) => toggle(instance, enabled)}
              onDelete={() => setConfirm({ kind: 'delete', instance })}
              onSetActive={() => makeActive(instance)}
              onTest={() => test(instance)}
              onAuthorize={() => authorize(instance)}
            />
          ))}
        </div>
      )}

      {confirm?.kind === 'disable' ? (
        <ConfirmDialog
          title="停用当前翻译实例？"
          description={`停用后，当前翻译方式会改选为下一个可用实例；若没有可用实例，页面翻译将不可用。实例「${confirm.instance.name}」不会被删除。`}
          confirmLabel="停用"
          busy={busyId === confirm.instance.id}
          onConfirm={confirmAction}
          onCancel={() => setConfirm(null)}
        >
          <p className="text-sm leading-relaxed text-base-content/70 break-words">已提交的段落不会重新翻译；新提交的段落会使用改选后的实例。</p>
        </ConfirmDialog>
      ) : null}

      {confirm?.kind === 'delete' ? (
        <ConfirmDialog
          title={`删除「${confirm.instance.name}」？`}
          description="此操作不可撤销。删除后将发生以下变化："
          confirmLabel="删除实例"
          tone="error"
          busy={busyId === confirm.instance.id}
          onConfirm={confirmAction}
          onCancel={() => setConfirm(null)}
        >
          <ul className="flex list-disc flex-col gap-1.5 pl-5 text-sm leading-relaxed text-base-content/80">
            <li>删除该实例的配置、凭据与本地提示词。</li>
            <li>若为当前实例，会先改选为下一个可用实例。</li>
            <li>主机权限是扩展级授权，不随实例删除自动撤销。</li>
            <li>译文缓存不会删除，可能仍占用空间，可在「数据管理」清空。</li>
          </ul>
        </ConfirmDialog>
      ) : null}
    </div>
  );
}
