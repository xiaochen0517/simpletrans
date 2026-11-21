/**
 * C 数据管理
 *
 * 模块：插件独立页面（C）/ 设置页分区
 * 职责：显示缓存开关、已用字节 / 上限 / 条数，提供刷新与清空（二次确认），
 *       并列出缓存、密钥、提示词与日志的存放位置。
 * 依赖：React、`lucide-react`、E1（`ST_CACHE_STATS` / `ST_CLEAR_CACHE`）、设置页共享工具。
 *
 * 缓存占用只在打开页面、窗口聚焦、刷新与清空后读取，不轮询。
 */

import { useEffect, useState } from 'react';
import { Database, HardDrive, RefreshCw, Trash2 } from 'lucide-react';
import ConfirmDialog from '../components/confirm-dialog.jsx';
import StatusBadge from '../../shared/ui/status-badge.jsx';
import { buttonClass } from '../../shared/ui/button.jsx';
import { formatBytes, formatCount, sendToBackground, useApp } from '../lib.js';
import { MESSAGE_TYPES } from '../../shared/protocol.js';

export default function DataManagement() {
  const app = useApp();
  const { cacheStats, cacheError, cacheLoading, settings, clearCacheRequest } = app;
  const [confirmOpen, setConfirmOpen] = useState(false);
  const [clearing, setClearing] = useState(false);
  const [notice, setNotice] = useState(null);
  const [error, setError] = useState(null);
  const [refreshing, setRefreshing] = useState(false);

  useEffect(() => {
    if (!clearCacheRequest) return;
    setConfirmOpen(true);
    app.consumeClearCacheRequest();
  }, [app, clearCacheRequest]);

  /** 重新读取缓存占用。 */
  async function refresh() {
    setRefreshing(true);
    await app.refreshCacheStats();
    setRefreshing(false);
  }

  /** 清空译文缓存。 */
  async function clearCache() {
    setClearing(true);
    setNotice(null);
    setError(null);
    const response = await sendToBackground(MESSAGE_TYPES.CLEAR_CACHE);
    setClearing(false);
    if (!response.ok) {
      setError(response.error?.message ?? '清空缓存失败，请重试');
      return;
    }
    const cleared = Number(response.data?.cleared) || 0;
    setConfirmOpen(false);
    setNotice(cleared > 0 ? `已清空 ${formatCount(cleared)} 条缓存` : '缓存已经是空的');
    app.notify('ok', cleared > 0 ? `已清空 ${formatCount(cleared)} 条缓存` : '缓存已经是空的');
    app.recordAction('清空译文缓存');
    await app.refreshCacheStats();
  }

  const entries = cacheStats ? formatCount(cacheStats.entries) : '—';
  const used = cacheStats ? formatBytes(cacheStats.bytes) : '—';
  const limit = cacheStats ? formatBytes(cacheStats.maxBytes) : '—';

  return (
    <div className="flex flex-col gap-4">
      <div className="flex flex-wrap items-start justify-between gap-3">
        <div>
          <h2 className="flex items-center gap-2 text-base font-bold">
            <Database size={15} aria-hidden="true" />
            数据管理
          </h2>
          <p className="text-sm leading-relaxed text-gray-600 dark:text-gray-300 break-words">这里只管理译文缓存；密钥、设置与实例配置不受影响。</p>
        </div>
      </div>

      <section className="flex flex-col gap-2 rounded-lg border border-gray-200 bg-white shadow-sm dark:border-gray-700 dark:bg-gray-900 p-4" aria-label="译文缓存">
        <div className="flex flex-wrap items-center justify-between gap-2">
          <span className="inline-flex items-center gap-1.5 text-xs font-semibold text-gray-600 dark:text-gray-300">
            <HardDrive size={13} aria-hidden="true" />
            译文缓存
          </span>
          <StatusBadge tone={settings?.cacheEnabled === false ? 'idle' : 'ok'}>
            {settings?.cacheEnabled === false ? '已关闭（不读不写）' : '已开启'}
          </StatusBadge>
        </div>

        {cacheError ? (
          <div className="flex flex-wrap items-center gap-2 rounded-lg border border-amber-500 bg-amber-50 p-3 text-sm text-amber-800 dark:border-amber-700 dark:bg-amber-950/40 dark:text-amber-200">
            <span className="min-w-0 break-words">缓存占用暂不可用，请重试；其他设置不受影响。</span>
            <span className="ml-auto shrink-0">
              <button type="button" className={buttonClass({ size: 'xs' })} onClick={refresh} disabled={refreshing}>
                重试
              </button>
            </span>
          </div>
        ) : (
          <div className="grid gap-3 sm:grid-cols-2 xl:grid-cols-3">
            <div>
              <span className="text-xs leading-relaxed text-gray-500 dark:text-gray-400 break-words">已用</span>
              <div className="text-base font-semibold break-words">{cacheLoading ? '读取中…' : used}</div>
            </div>
            <div>
              <span className="text-xs leading-relaxed text-gray-500 dark:text-gray-400 break-words">上限</span>
              <div className="text-base font-semibold break-words">{cacheLoading ? '读取中…' : limit}</div>
            </div>
            <div>
              <span className="text-xs leading-relaxed text-gray-500 dark:text-gray-400 break-words">条数</span>
              <div className="text-base font-semibold break-words">{cacheLoading ? '读取中…' : entries}</div>
            </div>
          </div>
        )}

        <div className="flex flex-wrap items-center gap-2">
          <button type="button" className={buttonClass({ size: 'sm' })} onClick={refresh} disabled={refreshing || cacheLoading}>
            <RefreshCw size={13} aria-hidden="true" />
            {refreshing ? '刷新中…' : '刷新'}
          </button>
          <button
            type="button"
            className={buttonClass({ variant: 'danger' })}
            onClick={() => setConfirmOpen(true)}
            disabled={clearing}
          >
            <Trash2 size={13} aria-hidden="true" />
            清空缓存
          </button>
        </div>
        <p className="text-sm leading-relaxed text-gray-600 dark:text-gray-300 break-words">
          缓存只保存在本机 IndexedDB，跨标签页共享；关闭缓存不会删除已有条目。
        </p>
        {notice ? <span className="text-xs leading-relaxed text-gray-500 dark:text-gray-400 break-words">{notice}</span> : null}
        {error ? (
          <span className="text-xs leading-relaxed text-red-600 dark:text-red-400" role="alert">
            {error}
          </span>
        ) : null}
      </section>

      <section className="flex flex-col gap-2 rounded-lg border border-gray-200 bg-white shadow-sm dark:border-gray-700 dark:bg-gray-900 p-4" aria-label="存储位置说明">
        <span className="inline-flex items-center gap-1.5 text-xs font-semibold text-gray-600 dark:text-gray-300">存储位置</span>
        <ul className="flex list-disc flex-col gap-1.5 pl-5 text-sm leading-relaxed text-gray-700 dark:text-gray-200">
          <li>缓存：本机 IndexedDB，跨标签页共享，不随账号同步。</li>
          <li>
            密钥：{settings?.keyStorage === 'sync' ? '跟随账号同步（会经过账号云端）' : '仅本机'}；每个实例独立保存。
          </li>
          <li>默认与快速翻译提示词：本机 storage.local，不随账号同步。</li>
          <li>日志：只在浏览器控制台，不持久化、不上传。</li>
          <li>导入导出配置：本轮不提供。</li>
        </ul>
      </section>

      {confirmOpen ? (
        <ConfirmDialog
          title="清空全部译文缓存？"
          description="将删除全部译文缓存，不影响密钥、设置与实例配置。此操作不可撤销。"
          confirmLabel="清空缓存"
          tone="error"
          busy={clearing}
          onConfirm={clearCache}
          onCancel={() => setConfirmOpen(false)}
        >
          <p className="text-sm leading-relaxed text-gray-600 dark:text-gray-300 break-words">清空后再次翻译会重新请求引擎；已在页面上的译文不会被移除。</p>
        </ConfirmDialog>
      ) : null}
    </div>
  );
}
