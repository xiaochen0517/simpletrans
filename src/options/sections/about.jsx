/**
 * C 关于
 *
 * 模块：插件独立页面（C）/ 设置页分区
 * 职责：显示扩展名称与版本、配置版本、缓存数据库版本、声明权限与主机权限用途、隐私说明，
 *       并提供「复制诊断信息」（不含密钥、APPID、提示词、原文/译文或完整 URL）。
 * 依赖：React、`lucide-react`、E2（设置中的 `configVersion`）、`constants.js`（缓存库版本）、设置页共享工具。
 * 实现阶段：P8-3（设置页内容分类与 UI 规范化）
 */

import { useState } from 'react';
import { ClipboardCopy, Info, ShieldCheck } from 'lucide-react';
import { formatBytes, formatCount, typeBadgeLabel, useApp } from '../lib.js';
import { CACHE_DB_VERSION } from '../../shared/constants.js';
import { normalizeLevel, LOG_LEVEL_OPTIONS } from '../../shared/log/levels.js';

/** 权限用途说明。 */
const PERMISSION_INFO = Object.freeze({
  storage: '保存设置、实例与凭据（凭据按设置存本机或同步）。',
  unlimitedStorage: '解除译文缓存配额，缓存只在本机 IndexedDB。',
  activeTab: '在当前标签页注入翻译脚本。',
  scripting: '页面注入与翻译，以及弹窗命令转发。',
  contextMenus: '提供右键菜单入口。',
});

/**
 * 主机权限用途说明。
 * @param {string} pattern
 * @param {boolean} optional
 * @returns {string}
 */
function hostPurpose(pattern, optional) {
  if (pattern.includes('api.deepseek.com')) return 'DeepSeek API（必选主机权限）';
  if (pattern.includes('fanyi-api.baidu.com')) return '百度翻译 API（必选主机权限）';
  if (optional) return '自定义 OpenAI 兼容 endpoint（可选，按实例域名授权）';
  return '页面注入所需的主机权限';
}

/**
 * 取清单信息；不可用时返回空对象。
 * @returns {Record<string, any>}
 */
function readManifest() {
  try {
    return globalThis.chrome?.runtime?.getManifest?.() ?? {};
  } catch {
    return {};
  }
}

export default function About() {
  const app = useApp();
  const [copied, setCopied] = useState(null);
  const manifest = readManifest();
  const permissions = Array.isArray(manifest.permissions) ? manifest.permissions : [];
  const hostPermissions = Array.isArray(manifest.host_permissions) ? manifest.host_permissions : [];
  const optionalHosts = Array.isArray(manifest.optional_host_permissions)
    ? manifest.optional_host_permissions
    : [];

  const active =
    app.instances.find((instance) => instance.id === app.settings?.activeInstanceId) ?? null;
  const logLevel =
    LOG_LEVEL_OPTIONS.find((option) => option.value === normalizeLevel(app.settings?.logLevel))?.label ??
    normalizeLevel(app.settings?.logLevel);

  /**
   * 组装诊断信息：只含版本、计数、日志级别与当前实例类型，不含敏感内容。
   * @returns {string}
   */
  function diagnosticsText() {
    const lines = [
      'SimpleTrans 诊断信息',
      `扩展版本：${manifest.version ?? '未知'}`,
      `配置版本：${app.settings?.configVersion ?? '未知'}`,
      `缓存库版本：${CACHE_DB_VERSION}`,
      `实例数：${app.instances.length}（已启用 ${
        app.instances.filter((instance) => instance.enabled !== false).length
      }）`,
      `当前实例：${active ? `${typeBadgeLabel(active)} · 启用 ${active.enabled !== false}` : '无'}`,
      `缓存占用：${
        app.cacheStats
          ? `${formatBytes(app.cacheStats.bytes)} / ${formatBytes(app.cacheStats.maxBytes)} · ${formatCount(
              app.cacheStats.entries
            )} 条`
          : '不可用'
      }`,
      `日志级别：${logLevel}`,
    ];
    return lines.join('\n');
  }

  /** 复制诊断信息。 */
  async function copyDiagnostics() {
    const text = diagnosticsText();
    try {
      if (navigator.clipboard?.writeText) {
        await navigator.clipboard.writeText(text);
        setCopied('ok');
        app.notify('ok', '已复制诊断信息');
        return;
      }
    } catch {
      // 继续按失败提示。
    }
    setCopied('error');
    app.notify('error', '复制失败，请手动选择');
  }

  return (
    <div className="op-stack">
      <div className="op-section-head">
        <div>
          <h2 className="op-h2">
            <Info size={15} aria-hidden="true" />
            关于
          </h2>
          <p className="op-sub">版本、权限与数据处理说明；反馈问题时请附上诊断信息。</p>
        </div>
      </div>

      <section className="op-card" aria-label="基本信息">
        <span className="op-card-title">基本信息</span>
        <dl className="op-kv">
          <dt>名称</dt>
          <dd>{manifest.name ?? 'SimpleTrans'}</dd>
        </dl>
        <dl className="op-kv">
          <dt>版本</dt>
          <dd>{manifest.version ?? '未知'}</dd>
        </dl>
        <dl className="op-kv">
          <dt>配置版本</dt>
          <dd>{app.settings?.configVersion ?? '未知'}</dd>
        </dl>
        <dl className="op-kv">
          <dt>缓存数据库版本</dt>
          <dd>{CACHE_DB_VERSION}</dd>
        </dl>
      </section>

      <section className="op-card" aria-label="权限">
        <span className="op-card-title">
          <ShieldCheck size={13} aria-hidden="true" />
          权限
        </span>
        {permissions.length > 0 ? (
          <ul className="op-list">
            {permissions.map((permission) => (
              <li key={permission}>
                <span className="op-mono">{permission}</span>：
                {PERMISSION_INFO[permission] ?? '其它扩展能力。'}
              </li>
            ))}
          </ul>
        ) : (
          <p className="op-sub">没有读取到清单权限信息。</p>
        )}

        <span className="op-label">静态主机权限</span>
        {hostPermissions.length > 0 ? (
          <ul className="op-list">
            {hostPermissions.map((pattern) => (
              <li key={pattern}>
                <span className="op-mono">{pattern}</span>：{hostPurpose(pattern, false)}
              </li>
            ))}
          </ul>
        ) : (
          <p className="op-sub">没有静态主机权限。</p>
        )}

        <span className="op-label">可选主机权限</span>
        {optionalHosts.length > 0 ? (
          <ul className="op-list">
            {optionalHosts.map((pattern) => (
              <li key={pattern}>
                <span className="op-mono">{pattern}</span>：{hostPurpose(pattern, true)}
              </li>
            ))}
          </ul>
        ) : (
          <p className="op-sub">没有可选主机权限。</p>
        )}
      </section>

      <section className="op-card" aria-label="隐私说明">
        <span className="op-card-title">隐私与数据</span>
        <ul className="op-list">
          <li>每个实例的密钥独立保存，只有后台读取；设置页只显示是否已配置。</li>
          <li>自定义 endpoint 会收到该实例的密钥；只在你信任并授权的域名上使用。</li>
          <li>译文缓存只在本机，不上传。</li>
          <li>日志只输出浏览器控制台，不持久化、不上报。</li>
          <li>使用「跟随账号同步」时密钥会经过账号云同步。</li>
          <li>system 提示词只保存在本机，不随账号同步。</li>
        </ul>
      </section>

      <section className="op-card" aria-label="诊断信息">
        <span className="op-card-title">诊断信息</span>
        <p className="op-sub">
          复制的内容只含版本、实例数、缓存占用、日志级别与当前实例类型/启用状态；不含密钥、APPID、提示词与原文/译文。
        </p>
        <div className="op-inline">
          <button type="button" className="btn btn-sm" onClick={copyDiagnostics}>
            <ClipboardCopy size={13} aria-hidden="true" />
            复制诊断信息
          </button>
          {copied === 'ok' ? <span className="op-help">已复制</span> : null}
          {copied === 'error' ? (
            <span className="op-error" role="alert">
              复制失败，请手动选择文本
            </span>
          ) : null}
        </div>
        <pre className="op-result-text op-mono" style={{ margin: 0 }}>
          {diagnosticsText()}
        </pre>
      </section>
    </div>
  );
}
