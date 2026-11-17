/**
 * C 概览
 *
 * 模块：插件独立页面（C）/ 设置页分区
 * 职责：默认落地页：一句状态摘要 + 六张状态卡片（当前翻译方式、语言、缓存、密钥与存储、日志、
 *       实例健康）+ 警告区 + 快捷操作 + 会话内最近操作。
 * 依赖：React、`lucide-react`、设置页共享工具（lib.js）、状态徽标组件。
 * 实现阶段：P8-3（设置页内容分类与 UI 规范化）
 *
 * 只展示决策所需信息与入口，细节配置进入其它分区；不展示密钥、APPID、提示词或完整 URL。
 */

import {
  Activity,
  AlertTriangle,
  CheckCircle2,
  Database,
  FlaskConical,
  KeyRound,
  Languages,
  Plus,
  ScrollText,
  Sparkles,
  Trash2,
  ExternalLink,
} from 'lucide-react';
import StatusBadge from '../components/status-badge.jsx';
import {
  activeUsability,
  credentialState,
  formatBytes,
  formatCount,
  instanceDetail,
  openTestPage,
  overviewSummary,
  overviewWarnings,
  permissionState,
  typeBadgeLabel,
  useApp,
} from '../lib.js';
import { languageLabel } from '../../shared/languages.js';
import { LOG_LEVEL_OPTIONS, normalizeLevel } from '../../shared/log/levels.js';

/** 日志级别显示名。 */
function logLevelLabel(level) {
  const value = normalizeLevel(level);
  return LOG_LEVEL_OPTIONS.find((option) => option.value === value)?.label ?? value;
}

/**
 * 状态卡片外壳。
 * @param {{ title: string, icon: import('react').ReactNode, children: import('react').ReactNode, action?: import('react').ReactNode }} props
 */
function Card({ title, icon, children, action }) {
  return (
    <div className="op-card">
      <div className="op-card-head">
        <span className="op-card-title">
          {icon}
          {title}
        </span>
        {action}
      </div>
      {children}
    </div>
  );
}

export default function Overview() {
  const app = useApp();
  const { settings, instances, cacheStats, cacheError, cacheLoading, loading, lastAction } = app;
  const summary = overviewSummary({ instances, settings });
  const warnings = overviewWarnings({ instances, settings });
  const active = instances.find((instance) => instance.id === settings?.activeInstanceId) ?? null;
  const usability = activeUsability(active);
  const configuredCount = instances.filter(
    (instance) => instance.requiresKey === false || instance.hasKey === true
  ).length;
  const unauthorized = instances.filter(
    (instance) => instance.type === 'openai' && instance.permission !== 'granted'
  ).length;
  const unsupported = instances.filter((instance) => instance.kind === 'unsupported').length;
  const enabledCount = instances.filter((instance) => instance.enabled !== false).length;
  const missingKey = instances.filter(
    (instance) => instance.kind !== 'unsupported' && instance.requiresKey !== false && instance.hasKey !== true
  ).length;

  if (loading) {
    return (
      <div className="op-stack" aria-busy="true" aria-live="polite">
        <div className="op-card">
          <div className="op-skeleton" aria-label="正在读取设置">
            <span className="op-skeleton-line" style={{ width: '40%' }} />
            <span className="op-skeleton-line" style={{ width: '70%' }} />
          </div>
        </div>
        <div className="op-grid op-grid-3">
          {[0, 1, 2, 3, 4, 5].map((index) => (
            <div className="op-card" key={index}>
              <div className="op-skeleton">
                <span className="op-skeleton-line" style={{ width: '45%' }} />
                <span className="op-skeleton-line" style={{ width: '80%' }} />
              </div>
            </div>
          ))}
        </div>
      </div>
    );
  }

  const credentials = credentialState(active);
  const permission = permissionState(active);

  return (
    <div className="op-stack">
      <section className={`op-warning${summary.tone === 'warn' ? ' is-warn' : ''}`} aria-live="polite">
        {summary.tone === 'warn' ? (
          <AlertTriangle size={16} aria-hidden="true" />
        ) : (
          <CheckCircle2 size={16} aria-hidden="true" />
        )}
        <span className="op-warning-text">{summary.text}</span>
        {summary.action ? (
          <span className="op-warning-action">
            <button
              type="button"
              className="btn btn-xs btn-primary"
              onClick={() =>
                summary.action.route === '#/instances' && summary.action.label === '新增翻译实例'
                  ? app.openCreate(null)
                  : app.navigate(summary.action.route)
              }
            >
              {summary.action.label}
            </button>
          </span>
        ) : null}
      </section>

      {warnings.length > 0 ? (
        <section className="op-section" aria-label="待办与警告">
          <div className="op-stack" style={{ gap: 8 }}>
            {warnings.map((warning) => (
              <div key={warning.id} className={`op-warning${warning.tone === 'warn' ? ' is-warn' : ''}`}>
                <AlertTriangle size={15} aria-hidden="true" />
                <span className="op-warning-text">{warning.text}</span>
                {warning.action ? (
                  <span className="op-warning-action">
                    <button
                      type="button"
                      className="btn btn-xs"
                      onClick={() => app.navigate(warning.action.route)}
                    >
                      {warning.action.label}
                    </button>
                  </span>
                ) : null}
              </div>
            ))}
          </div>
        </section>
      ) : null}

      <section className="op-grid op-grid-3" aria-label="当前状态">
        <Card
          title="当前翻译方式"
          icon={<Sparkles size={13} aria-hidden="true" />}
          action={
            <button type="button" className="btn btn-xs" onClick={() => app.navigate('#/instances')}>
              切换
            </button>
          }
        >
          {active ? (
            <>
              <span className="op-card-value">{active.name}</span>
              <div className="op-badge-row">
                <StatusBadge tone="primary">{typeBadgeLabel(active)}</StatusBadge>
                <StatusBadge tone={usability.usable ? 'ok' : 'warn'}>
                  {usability.usable ? '可用' : '不可用'}
                </StatusBadge>
              </div>
              <span className="op-card-meta">{instanceDetail(active)}</span>
              <div className="op-badge-row">
                <StatusBadge tone={credentials.key === 'ok' || credentials.key === 'none' ? 'ok' : 'warn'}>
                  {credentials.label}
                </StatusBadge>
                {permission ? <StatusBadge tone={permission.key === 'ok' ? 'ok' : 'warn'}>{permission.label}</StatusBadge> : null}
                {active.enabled === false ? <StatusBadge tone="idle">已停用</StatusBadge> : null}
              </div>
              {!usability.usable ? <span className="op-card-meta">{usability.reason}</span> : null}
            </>
          ) : (
            <>
              <span className="op-card-value">未选择翻译方式</span>
              <span className="op-card-meta">新增或启用一个实例后即可翻译。</span>
            </>
          )}
        </Card>

        <Card
          title="语言"
          icon={<Languages size={13} aria-hidden="true" />}
          action={
            <button type="button" className="btn btn-xs" onClick={() => app.navigate('#/general')}>
              修改
            </button>
          }
        >
          <span className="op-card-value">
            {languageLabel(settings?.sourceLang) || '未知'} → {languageLabel(settings?.targetLang) || '未知'}
          </span>
          <span className="op-card-meta">语言进入缓存 key，切换后不会串用旧缓存。</span>
        </Card>

        <Card
          title="译文缓存"
          icon={<Database size={13} aria-hidden="true" />}
          action={
            <button type="button" className="btn btn-xs" onClick={() => app.navigate('#/data')}>
              管理
            </button>
          }
        >
          <div className="op-badge-row">
            <StatusBadge tone={settings?.cacheEnabled === false ? 'idle' : 'ok'}>
              {settings?.cacheEnabled === false ? '已关闭' : '已开启'}
            </StatusBadge>
            {cacheError ? <StatusBadge tone="warn">占用不可用</StatusBadge> : null}
          </div>
          <span className="op-card-value">
            {cacheLoading
              ? '正在读取…'
              : cacheStats
                ? `${formatBytes(cacheStats.bytes)} / ${formatBytes(cacheStats.maxBytes)}`
                : cacheError
                  ? '占用信息暂不可用'
                  : '—'}
          </span>
          <span className="op-card-meta">
            {cacheStats ? `${formatCount(cacheStats.entries)} 条` : '只保存在本机 IndexedDB'}
          </span>
        </Card>

        <Card
          title="密钥与存储"
          icon={<KeyRound size={13} aria-hidden="true" />}
          action={
            <button type="button" className="btn btn-xs" onClick={() => app.navigate('#/general')}>
              管理
            </button>
          }
        >
          <span className="op-card-value">
            {settings?.keyStorage === 'sync' ? '跟随账号同步' : '仅本机'}
          </span>
          <span className="op-card-meta">
            已配置 {configuredCount} / {instances.length} 个实例；每个实例独立保存自己的密钥。
          </span>
          {settings?.keyStorage === 'sync' ? (
            <StatusBadge tone="warn">密钥会经过账号云端</StatusBadge>
          ) : null}
        </Card>

        <Card
          title="日志"
          icon={<ScrollText size={13} aria-hidden="true" />}
          action={
            <button type="button" className="btn btn-xs" onClick={() => app.navigate('#/general')}>
              调整
            </button>
          }
        >
          <span className="op-card-value">{logLevelLabel(settings?.logLevel)}</span>
          <span className="op-card-meta">只输出浏览器控制台，不保存、不上传。</span>
        </Card>

        <Card
          title="实例健康"
          icon={<Activity size={13} aria-hidden="true" />}
          action={
            <button type="button" className="btn btn-xs" onClick={() => app.navigate('#/instances')}>
              查看
            </button>
          }
        >
          <span className="op-card-value">
            {instances.length} 个实例
            {unsupported > 0 ? <StatusBadge tone="warn">含不支持</StatusBadge> : null}
          </span>
          <span className="op-card-meta">
            已启用 {enabledCount} · 未配置密钥 {missingKey} · 未授权 {unauthorized}
            {unsupported > 0 ? ` · 不支持 ${unsupported}` : ''}
          </span>
        </Card>
      </section>

      <section className="op-section">
        <h2 className="op-h2">
          <Plus size={15} aria-hidden="true" />
          快捷操作
        </h2>
        <div className="op-inline">
          <button type="button" className="btn btn-sm btn-primary" onClick={() => app.openCreate(null)}>
            <Plus size={14} aria-hidden="true" />
            新增翻译实例
          </button>
          <button
            type="button"
            className="btn btn-sm"
            onClick={() => {
              if (active) app.setTestInstanceId(active.id);
              app.navigate('#/test');
            }}
            disabled={instances.length === 0}
          >
            <FlaskConical size={14} aria-hidden="true" />
            测试当前实例
          </button>
          <button type="button" className="btn btn-sm" onClick={() => app.requestClearCache()}>
            <Trash2 size={14} aria-hidden="true" />
            清空缓存
          </button>
          <button
            type="button"
            className="btn btn-sm btn-outline"
            onClick={async () => {
              const result = await openTestPage();
              app.notify(result.ok ? 'ok' : 'error', result.ok ? '已打开翻译测试页' : result.message);
            }}
          >
            <ExternalLink size={14} aria-hidden="true" />
            打开翻译测试页
          </button>
        </div>
      </section>

      <section className="op-section">
        <h2 className="op-h2">最近操作</h2>
        <p className="op-sub">
          {lastAction
            ? `${lastAction.text} · ${new Date(lastAction.at).toLocaleTimeString('zh-CN')}`
            : '本次打开设置页后还没有保存或测试操作。'}
        </p>
      </section>
    </div>
  );
}
