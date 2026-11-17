/**
 * C 通用设置
 *
 * 模块：插件独立页面（C）/ 设置页分区
 * 职责：启用开关、源/目标语言、密钥存放位置、缓存开关与日志级别；开关与下拉即时保存，
 *       失败回滚并给出行内错误；密钥存放位置切换前确认、期间显示进度、失败保留原数据。
 * 依赖：React、`lucide-react`、E2（getSettings/saveSettings）、E3（setKeyStorage）、
 *       E4（日志级别）、语言目录与设置页共享工具。
 * 实现阶段：P8-3（设置页内容分类与 UI 规范化）
 *
 * 这里不做实例表单的显式保存；实例配置在「翻译实例」的编辑抽屉里保存。
 */

import { useCallback, useEffect, useRef, useState } from 'react';
import { ArrowLeftRight, Database, Globe2, KeyRound, ScrollText, Power } from 'lucide-react';
import ConfirmDialog from '../components/confirm-dialog.jsx';
import { useApp } from '../lib.js';
import { saveSettings } from '../../shared/settings.js';
import { setKeyStorage } from '../../shared/config/instances.js';
import {
  LANGUAGES,
  SOURCE_LANGS,
  TARGET_LANGS,
  languageLabel,
} from '../../shared/languages.js';
import { LOG_LEVEL_OPTIONS, normalizeLevel } from '../../shared/log/levels.js';
import { setLogLevel as setLoggerLevel } from '../../shared/log/logger.js';

/** 密钥存放位置选项。 */
const KEY_STORAGE_OPTIONS = Object.freeze([
  {
    value: 'local',
    label: '仅本机',
    help: '密钥只保存在这台设备，不随账号同步。',
  },
  {
    value: 'sync',
    label: '跟随账号同步',
    help: '密钥会经过账号云端同步到其他设备，请只在信任的设备上使用。',
  },
]);

/**
 * 通用设置分区。
 */
export default function General() {
  const app = useApp();
  const { settings } = app;
  const [savingField, setSavingField] = useState(null);
  const [notice, setNotice] = useState(null);
  const [error, setError] = useState(null);
  const [confirmStorage, setConfirmStorage] = useState(null);
  const [migrating, setMigrating] = useState(false);
  const clearTimer = useRef(null);

  useEffect(
    () => () => {
      if (clearTimer.current) clearTimeout(clearTimer.current);
    },
    []
  );

  /**
   * 即时保存一个设置字段：先乐观更新，失败回滚并给出行内错误。
   * @param {string} field
   * @param {unknown} value
   * @param {string} [successText]
   */
  const saveField = useCallback(
    async (field, value, successText = '已保存') => {
      if (savingField) return;
      const previous = settings?.[field];
      if (previous === value) return;
      if (clearTimer.current) clearTimeout(clearTimer.current);
      setSavingField(field);
      setNotice(null);
      setError(null);
      app.updateSettingsLocal({ [field]: value });
      try {
        await app.mutate(() => saveSettings({ [field]: value }));
        setNotice({ field, text: successText });
        clearTimer.current = setTimeout(() => setNotice(null), 3000);
      } catch {
        app.updateSettingsLocal({ [field]: previous });
        if (field === 'logLevel') setLoggerLevel(normalizeLevel(previous));
        setError({ field, text: '保存失败，已恢复原值；请重试。' });
      } finally {
        setSavingField(null);
      }
    },
    [app, savingField, settings]
  );

  /** 切换密钥存放位置（带确认与迁移进度）。 */
  async function switchStorage() {
    const target = confirmStorage;
    if (!target) return;
    setMigrating(true);
    setNotice(null);
    setError(null);
    try {
      await app.mutate(() => setKeyStorage(target));
      setNotice({ field: 'keyStorage', text: '已切换密钥存放位置' });
      app.notify('ok', '已切换密钥存放位置');
      app.recordAction(`切换密钥存放位置为「${target === 'sync' ? '跟随账号同步' : '仅本机'}」`);
      setConfirmStorage(null);
    } catch {
      setError({ field: 'keyStorage', text: '切换失败，已保留原来的数据与设置。' });
    } finally {
      setMigrating(false);
    }
  }

  const sourceLang = settings?.sourceLang ?? 'auto';
  const targetLang = settings?.targetLang ?? 'zh';
  const logLevel = normalizeLevel(settings?.logLevel);

  return (
    <div className="op-stack">
      <div className="op-section-head">
        <div>
          <h2 className="op-h2">
            <Globe2 size={15} aria-hidden="true" />
            通用设置
          </h2>
          <p className="op-sub">开关与下拉改动会立即保存；实例配置在「翻译实例」里单独保存。</p>
        </div>
      </div>

      <section className="op-card" aria-label="扩展">
        <div className="op-switch-row">
          <span className="op-card-title">
            <Power size={13} aria-hidden="true" />
            扩展启用
          </span>
          <label className="op-check">
            <input
              type="checkbox"
              className="toggle toggle-sm"
              checked={settings?.enabled !== false}
              onChange={(event) => saveField('enabled', event.target.checked, '已保存')}
              disabled={savingField === 'enabled'}
              aria-label="启用扩展"
            />
            <span>{settings?.enabled === false ? '已停用' : '已启用'}</span>
          </label>
        </div>
        <p className="op-sub">
          关闭后页面翻译与测试返回「扩展已停用」，设置仍可修改。
        </p>
        {savingField === 'enabled' ? <span className="op-help">保存中…</span> : null}
        {notice?.field === 'enabled' ? <span className="op-help">{notice.text}</span> : null}
        {error?.field === 'enabled' ? <span className="op-error" role="alert">{error.text}</span> : null}
      </section>

      <section className="op-card" aria-label="语言">
        <span className="op-card-title">
          <ArrowLeftRight size={13} aria-hidden="true" />
          语言
        </span>
        <div className="op-row">
          <label className="op-field">
            <span className="op-label">源语言</span>
            <select
              className="select select-bordered select-sm w-full"
              value={sourceLang}
              onChange={(event) => saveField('sourceLang', event.target.value, '已保存')}
              disabled={savingField === 'sourceLang'}
            >
              {SOURCE_LANGS.map((lang) => (
                <option key={lang} value={lang}>
                  {LANGUAGES[lang] ?? lang}
                </option>
              ))}
            </select>
          </label>
          <label className="op-field">
            <span className="op-label">目标语言</span>
            <select
              className="select select-bordered select-sm w-full"
              value={targetLang}
              onChange={(event) => saveField('targetLang', event.target.value, '已保存')}
              disabled={savingField === 'targetLang'}
            >
              {TARGET_LANGS.map((lang) => (
                <option key={lang} value={lang}>
                  {LANGUAGES[lang] ?? lang}
                </option>
              ))}
            </select>
          </label>
        </div>
        <p className="op-sub">
          当前：{languageLabel(sourceLang) || sourceLang} → {languageLabel(targetLang) || targetLang}。
          语言进入缓存 key，切换后不会串用旧译文。
        </p>
        {notice?.field === 'sourceLang' || notice?.field === 'targetLang' ? (
          <span className="op-help">{notice.text}</span>
        ) : null}
        {error?.field === 'sourceLang' || error?.field === 'targetLang' ? (
          <span className="op-error" role="alert">{error.text}</span>
        ) : null}
      </section>

      <section className="op-card" aria-label="密钥存放位置">
        <span className="op-card-title">
          <KeyRound size={13} aria-hidden="true" />
          密钥存放位置
        </span>
        <div className="op-option-cards">
          {KEY_STORAGE_OPTIONS.map((option) => {
            const selected = (settings?.keyStorage ?? 'local') === option.value;
            return (
              <button
                key={option.value}
                type="button"
                className="op-option-card"
                aria-pressed={selected}
                onClick={() => {
                  if (selected || migrating) return;
                  setConfirmStorage(option.value);
                }}
                disabled={migrating}
              >
                <KeyRound size={15} aria-hidden="true" />
                <span>
                  <span className="op-option-title">
                    {option.label}
                    {selected ? '（当前）' : ''}
                  </span>
                  <span className="op-help">{option.help}</span>
                </span>
              </button>
            );
          })}
        </div>
        <p className="op-sub">
          切换会把全部实例的凭据迁移到目标位置；失败时保留原数据。只迁移密钥，不改设置与缓存。
        </p>
        {migrating ? <span className="op-help">正在迁移密钥…</span> : null}
        {notice?.field === 'keyStorage' ? <span className="op-help">{notice.text}</span> : null}
        {error?.field === 'keyStorage' ? <span className="op-error" role="alert">{error.text}</span> : null}
      </section>

      <section className="op-card" aria-label="译文缓存">
        <div className="op-switch-row">
          <span className="op-card-title">
            <Database size={13} aria-hidden="true" />
            译文缓存
          </span>
          <label className="op-check">
            <input
              type="checkbox"
              className="toggle toggle-sm"
              checked={settings?.cacheEnabled !== false}
              onChange={(event) => saveField('cacheEnabled', event.target.checked, '已保存')}
              disabled={savingField === 'cacheEnabled'}
              aria-label="启用译文缓存"
            />
            <span>{settings?.cacheEnabled === false ? '已关闭' : '已开启'}</span>
          </label>
        </div>
        <p className="op-sub">
          关闭后不再读写缓存，已有缓存不会自动删除；占用与清空在「数据管理」。
        </p>
        {notice?.field === 'cacheEnabled' ? <span className="op-help">{notice.text}</span> : null}
        {error?.field === 'cacheEnabled' ? <span className="op-error" role="alert">{error.text}</span> : null}
      </section>

      <section className="op-card" aria-label="日志">
        <label className="op-field">
          <span className="op-card-title">
            <ScrollText size={13} aria-hidden="true" />
            日志级别
          </span>
          <select
            className="select select-bordered select-sm w-full"
            value={logLevel}
            onChange={(event) => {
              const next = normalizeLevel(event.target.value);
              setLoggerLevel(next);
              void saveField('logLevel', next, '已保存；已打开的网页刷新或重连后生效');
            }}
            disabled={savingField === 'logLevel'}
          >
            {LOG_LEVEL_OPTIONS.map((option) => (
              <option key={option.value} value={option.value}>
                {option.label}
              </option>
            ))}
          </select>
        </label>
        <p className="op-sub">
          日志只输出浏览器控制台，不上传、不保存；调整后已打开的网页需刷新或重连才生效。
        </p>
        {notice?.field === 'logLevel' ? <span className="op-help">{notice.text}</span> : null}
        {error?.field === 'logLevel' ? <span className="op-error" role="alert">{error.text}</span> : null}
      </section>

      {confirmStorage ? (
        <ConfirmDialog
          title={`切换密钥存放位置到「${confirmStorage === 'sync' ? '跟随账号同步' : '仅本机'}」？`}
          description={`将把全部实例的密钥迁移到${
            confirmStorage === 'sync' ? '账号同步存储，密钥会经过账号云端' : '本机存储'
          }。迁移失败会保留原数据。`}
          confirmLabel={migrating ? '迁移中…' : '开始迁移'}
          busy={migrating}
          onConfirm={switchStorage}
          onCancel={() => setConfirmStorage(null)}
        >
          {confirmStorage === 'sync' ? (
            <p className="op-sub">密钥会随账号同步到其他设备，请只在信任的设备上使用。</p>
          ) : (
            <p className="op-sub">迁移后密钥只保存在这台设备，不再随账号同步。</p>
          )}
        </ConfirmDialog>
      ) : null}
    </div>
  );
}
