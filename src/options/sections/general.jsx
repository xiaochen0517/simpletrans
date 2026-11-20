/**
 * C 通用设置
 *
 * 模块：插件独立页面（C）/ 设置页分区
 * 职责：启用开关、源/目标语言、悬停快捷键、整页浏览器快捷键入口、密钥存放位置、缓存开关与日志级别；
 *       开关与下拉即时保存，失败回滚并给出行内错误；密钥存放位置切换前确认、期间显示进度、失败保留原数据。
 * 依赖：React、`lucide-react`、E2（getSettings/saveSettings）、E3（setKeyStorage）、
 *       E4（日志级别）、E6（快捷键）、语言目录与设置页共享工具。
 * 实现阶段：P8-3（设置页内容分类与 UI 规范化）；P11 增加弹窗初始页设置；P12 增加快捷键区块。
 *
 * 这里不做实例表单的显式保存；实例配置在「翻译实例」的编辑弹窗里保存。
 */

import { useCallback, useEffect, useRef, useState } from 'react';
import {
  ArrowLeftRight,
  Database,
  Globe2,
  KeyRound,
  Keyboard,
  PanelTop,
  ScrollText,
  Power,
} from 'lucide-react';
import ConfirmDialog from '../components/confirm-dialog.jsx';
import { openBrowserShortcutSettings, useApp } from '../lib.js';
import { saveSettings } from '../../shared/settings.js';
import { setKeyStorage } from '../../shared/config/instances.js';
import {
  COMMAND_TRANSLATE_PAGE,
  HOVER_SHORTCUTS,
  hoverShortcutLabel,
  isMacPlatform,
  readCommandShortcut,
  resolveHoverShortcut,
} from '../../shared/shortcut.js';
import {
  LANGUAGES,
  SOURCE_LANGS,
  TARGET_LANGS,
  languageLabel,
} from '../../shared/languages.js';
import { LOG_LEVEL_OPTIONS, normalizeLevel } from '../../shared/log/levels.js';
import { setLogLevel as setLoggerLevel } from '../../shared/log/logger.js';
import Select from '../../shared/ui/select.jsx';
import Toggle from '../../shared/ui/toggle.jsx';
import Button, { buttonClass } from '../../shared/ui/button.jsx';

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

/** 弹窗打开时先显示的页面。 */
const POPUP_TAB_OPTIONS = Object.freeze([
  { value: 'default', label: '默认页面' },
  { value: 'quick', label: '快速翻译页面' },
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
  const [commandShortcut, setCommandShortcut] = useState({ status: 'loading', shortcut: '' });
  const [shortcutOpenError, setShortcutOpenError] = useState(null);
  const [openingShortcuts, setOpeningShortcuts] = useState(false);
  const clearTimer = useRef(null);

  useEffect(
    () => () => {
      if (clearTimer.current) clearTimeout(clearTimer.current);
    },
    []
  );

  /** 读取整页命令的当前浏览器快捷键；失败时保留可重试的读取状态。 */
  const refreshCommandShortcut = useCallback(async () => {
    const result = await readCommandShortcut(COMMAND_TRANSLATE_PAGE);
    setCommandShortcut(
      result.ok
        ? { status: 'ok', shortcut: result.shortcut }
        : { status: 'error', shortcut: '' }
    );
  }, []);

  useEffect(() => {
    void refreshCommandShortcut();
    const onFocus = () => void refreshCommandShortcut();
    window.addEventListener('focus', onFocus);
    return () => {
      window.removeEventListener('focus', onFocus);
    };
  }, [refreshCommandShortcut]);

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

  /**
   * 打开 Chrome 的扩展快捷键设置页；失败时在区块内提示手动地址。
   */
  async function openShortcuts() {
    if (openingShortcuts) return;
    setOpeningShortcuts(true);
    setShortcutOpenError(null);
    const result = await openBrowserShortcutSettings();
    setOpeningShortcuts(false);
    if (!result.ok) setShortcutOpenError(result.message ?? '无法打开浏览器快捷键设置');
  }

  const sourceLang = settings?.sourceLang ?? 'auto';
  const targetLang = settings?.targetLang ?? 'zh';
  const logLevel = normalizeLevel(settings?.logLevel);
  const isMac = isMacPlatform();
  const hoverShortcut = resolveHoverShortcut(settings?.hoverShortcut, isMac).shortcut;
  const hoverShortcutOptions = HOVER_SHORTCUTS.filter(
    (value) => value !== 'command' || isMac
  ).map((value) => ({ value, label: hoverShortcutLabel(value) }));
  const commandShortcutText =
    commandShortcut.status === 'loading'
      ? '读取中…'
      : commandShortcut.status === 'error'
        ? '读取失败'
        : commandShortcut.shortcut || '未设置';
  const commandShortcutHint =
    settings?.hoverShortcut === 'command' && !isMac
      ? 'Command 仅在 macOS 可用，本机按 Ctrl 生效。'
      : null;

  return (
    <div className="flex flex-col gap-4">
      <div className="flex flex-wrap items-start justify-between gap-3">
        <div>
          <h2 className="flex items-center gap-2 text-base font-bold">
            <Globe2 size={15} aria-hidden="true" />
            通用设置
          </h2>
          <p className="text-sm leading-relaxed text-gray-600 dark:text-gray-300 break-words">开关与下拉改动会立即保存；实例配置在「翻译实例」的编辑弹窗里单独保存。</p>
        </div>
      </div>

      <section className="flex flex-col gap-2 rounded-lg border border-gray-200 bg-white shadow-sm dark:border-gray-700 dark:bg-gray-900 p-4" aria-label="扩展">
        <div className="flex flex-wrap items-center justify-between gap-3">
          <span className="inline-flex items-center gap-1.5 text-xs font-semibold text-gray-600 dark:text-gray-300">
            <Power size={13} aria-hidden="true" />
            扩展启用
          </span>
          <div className="inline-flex items-center gap-2 text-sm">
            <Toggle
              checked={settings?.enabled !== false}
              onChange={(value) => saveField('enabled', value, '已保存')}
              disabled={savingField === 'enabled'}
              ariaLabel="启用扩展"
            />
            <span>{settings?.enabled === false ? '已停用' : '已启用'}</span>
          </div>
        </div>
        <p className="text-sm leading-relaxed text-gray-600 dark:text-gray-300 break-words">
          关闭后页面翻译与测试返回「扩展已停用」，设置仍可修改。
        </p>
        {savingField === 'enabled' ? <span className="text-xs leading-relaxed text-gray-500 dark:text-gray-400 break-words">保存中…</span> : null}
        {notice?.field === 'enabled' ? <span className="text-xs leading-relaxed text-gray-500 dark:text-gray-400 break-words">{notice.text}</span> : null}
        {error?.field === 'enabled' ? <span className="text-xs leading-relaxed text-red-600 dark:text-red-400" role="alert">{error.text}</span> : null}
      </section>

      <section className="flex flex-col gap-2 rounded-lg border border-gray-200 bg-white shadow-sm dark:border-gray-700 dark:bg-gray-900 p-4" aria-label="语言">
        <span className="inline-flex items-center gap-1.5 text-xs font-semibold text-gray-600 dark:text-gray-300">
          <ArrowLeftRight size={13} aria-hidden="true" />
          语言
        </span>
        <div className="grid gap-3 sm:grid-cols-2">
          <div className="flex flex-col gap-1">
            <span className="text-xs font-semibold">源语言</span>
            <Select
              value={sourceLang}
              options={SOURCE_LANGS.map((lang) => ({ value: lang, label: LANGUAGES[lang] ?? lang }))}
              onChange={(next) => saveField('sourceLang', next, '已保存')}
              ariaLabel="源语言"
              disabled={savingField === 'sourceLang'}
            />
          </div>
          <div className="flex flex-col gap-1">
            <span className="text-xs font-semibold">目标语言</span>
            <Select
              value={targetLang}
              options={TARGET_LANGS.map((lang) => ({ value: lang, label: LANGUAGES[lang] ?? lang }))}
              onChange={(next) => saveField('targetLang', next, '已保存')}
              ariaLabel="目标语言"
              disabled={savingField === 'targetLang'}
            />
          </div>
        </div>
        <p className="text-sm leading-relaxed text-gray-600 dark:text-gray-300 break-words">
          当前：{languageLabel(sourceLang) || sourceLang} → {languageLabel(targetLang) || targetLang}。
          语言进入缓存 key，切换后不会串用旧译文。
        </p>
        {notice?.field === 'sourceLang' || notice?.field === 'targetLang' ? (
          <span className="text-xs leading-relaxed text-gray-500 dark:text-gray-400 break-words">{notice.text}</span>
        ) : null}
        {error?.field === 'sourceLang' || error?.field === 'targetLang' ? (
          <span className="text-xs leading-relaxed text-red-600 dark:text-red-400" role="alert">{error.text}</span>
        ) : null}
      </section>

      <section className="flex flex-col gap-2 rounded-lg border border-gray-200 bg-white shadow-sm dark:border-gray-700 dark:bg-gray-900 p-4" aria-label="快捷键">
        <span className="inline-flex items-center gap-1.5 text-xs font-semibold text-gray-600 dark:text-gray-300">
          <Keyboard size={13} aria-hidden="true" />
          快捷键
        </span>

        <div className="flex flex-col gap-1">
          <span className="text-xs font-semibold">悬停翻译</span>
          <Select
            id="general-hover-shortcut"
            value={hoverShortcut}
            options={hoverShortcutOptions}
            onChange={(next) => saveField('hoverShortcut', next, '已保存；刷新网页后生效')}
            ariaLabel="悬停翻译快捷键"
            disabled={savingField === 'hoverShortcut'}
          />
        </div>
        <p className="text-sm leading-relaxed text-gray-600 dark:text-gray-300 break-words">
          鼠标停在段落上，按下并松开所选按键即可翻译该段；已有译文时则隐藏。修改后需要刷新网页才生效。
          Alt 在部分 Windows 环境可能被系统或浏览器占用，如无效请换一个。
          {commandShortcutHint ? ` ${commandShortcutHint}` : ''}
        </p>
        {savingField === 'hoverShortcut' ? (
          <span className="text-xs leading-relaxed text-gray-500 dark:text-gray-400 break-words">保存中…</span>
        ) : null}
        {notice?.field === 'hoverShortcut' ? (
          <span className="text-xs leading-relaxed text-gray-500 dark:text-gray-400 break-words">{notice.text}</span>
        ) : null}
        {error?.field === 'hoverShortcut' ? (
          <span className="text-xs leading-relaxed text-red-600 dark:text-red-400" role="alert">{error.text}</span>
        ) : null}

        <div className="mt-1 border-t border-gray-200 pt-3 dark:border-gray-700">
          <div className="flex flex-col gap-1">
            <span className="text-xs font-semibold">整页翻译</span>
            <p className="text-sm leading-relaxed text-gray-600 dark:text-gray-300 break-words">
              当前快捷键：
              <span className="font-mono text-xs font-semibold text-gray-900 dark:text-gray-100">
                {commandShortcutText}
              </span>
            </p>
          </div>
          <div className="mt-2">
            <Button
              variant="secondary"
              onClick={() => void openShortcuts()}
              disabled={openingShortcuts}
              busy={openingShortcuts}
            >
              <Keyboard size={14} aria-hidden="true" />
              <span>{openingShortcuts ? '正在打开…' : '打开浏览器快捷键设置'}</span>
            </Button>
          </div>
          <p className="mt-2 text-sm leading-relaxed text-gray-600 dark:text-gray-300 break-words">
            整页翻译由 Chrome 扩展快捷键触发，在浏览器快捷键页面修改后立即生效。若显示「未设置」，请为「SimpleTrans」的「翻译整页」命令绑定快捷键。
          </p>
          {shortcutOpenError ? (
            <p className="mt-1 text-xs leading-relaxed text-red-600 dark:text-red-400" role="alert">
              {shortcutOpenError}
            </p>
          ) : null}
        </div>
      </section>

      <section className="flex flex-col gap-2 rounded-lg border border-gray-200 bg-white shadow-sm dark:border-gray-700 dark:bg-gray-900 p-4" aria-label="弹窗">
        <span className="inline-flex items-center gap-1.5 text-xs font-semibold text-gray-600 dark:text-gray-300">
          <PanelTop size={13} aria-hidden="true" />
          弹窗
        </span>
        <div className="flex flex-col gap-1">
          <span className="text-xs font-semibold">打开时显示</span>
          <Select
            id="general-popup-tab"
            value={settings?.popupDefaultTab ?? 'default'}
            options={POPUP_TAB_OPTIONS.map((option) => ({
              value: option.value,
              label: option.label,
            }))}
            onChange={(next) => saveField('popupDefaultTab', next, '已保存')}
            ariaLabel="弹窗打开时显示"
            disabled={savingField === 'popupDefaultTab'}
          />
        </div>
        <p className="text-sm leading-relaxed text-gray-600 dark:text-gray-300 break-words">
          只决定打开弹窗时先显示哪一页；在弹窗内切换标签不会改变该设置。
        </p>
        {notice?.field === 'popupDefaultTab' ? (
          <span className="text-xs leading-relaxed text-gray-500 dark:text-gray-400 break-words">{notice.text}</span>
        ) : null}
        {error?.field === 'popupDefaultTab' ? (
          <span className="text-xs leading-relaxed text-red-600 dark:text-red-400" role="alert">{error.text}</span>
        ) : null}
      </section>

      <section className="flex flex-col gap-2 rounded-lg border border-gray-200 bg-white shadow-sm dark:border-gray-700 dark:bg-gray-900 p-4" aria-label="密钥存放位置">
        <span className="inline-flex items-center gap-1.5 text-xs font-semibold text-gray-600 dark:text-gray-300">
          <KeyRound size={13} aria-hidden="true" />
          密钥存放位置
        </span>
        <div className="grid gap-2.5">
          {KEY_STORAGE_OPTIONS.map((option) => {
            const selected = (settings?.keyStorage ?? 'local') === option.value;
            return (
              <button
                key={option.value}
                type="button"
                className={`${buttonClass({ variant: 'secondary', className: 'h-auto justify-start' })} aria-pressed:border-indigo-600 aria-pressed:bg-indigo-50 aria-pressed:text-indigo-700 aria-pressed:hover:bg-indigo-100 dark:aria-pressed:border-indigo-400 dark:aria-pressed:bg-indigo-950/40 dark:aria-pressed:text-indigo-200 dark:aria-pressed:hover:bg-indigo-900/60`}
                aria-pressed={selected}
                onClick={() => {
                  if (selected || migrating) return;
                  setConfirmStorage(option.value);
                }}
                disabled={migrating}
              >
                <KeyRound size={15} aria-hidden="true" />
                <span>
                  <span className="flex items-center gap-1.5 text-sm font-semibold">
                    {option.label}
                    {selected ? '（当前）' : ''}
                  </span>
                  <span className="text-xs leading-relaxed text-gray-500 dark:text-gray-400 break-words">{option.help}</span>
                </span>
              </button>
            );
          })}
        </div>
        <p className="text-sm leading-relaxed text-gray-600 dark:text-gray-300 break-words">
          切换会把全部实例的凭据迁移到目标位置；失败时保留原数据。只迁移密钥，不改设置与缓存。
        </p>
        {migrating ? <span className="text-xs leading-relaxed text-gray-500 dark:text-gray-400 break-words">正在迁移密钥…</span> : null}
        {notice?.field === 'keyStorage' ? <span className="text-xs leading-relaxed text-gray-500 dark:text-gray-400 break-words">{notice.text}</span> : null}
        {error?.field === 'keyStorage' ? <span className="text-xs leading-relaxed text-red-600 dark:text-red-400" role="alert">{error.text}</span> : null}
      </section>

      <section className="flex flex-col gap-2 rounded-lg border border-gray-200 bg-white shadow-sm dark:border-gray-700 dark:bg-gray-900 p-4" aria-label="译文缓存">
        <div className="flex flex-wrap items-center justify-between gap-3">
          <span className="inline-flex items-center gap-1.5 text-xs font-semibold text-gray-600 dark:text-gray-300">
            <Database size={13} aria-hidden="true" />
            译文缓存
          </span>
          <div className="inline-flex items-center gap-2 text-sm">
            <Toggle
              checked={settings?.cacheEnabled !== false}
              onChange={(value) => saveField('cacheEnabled', value, '已保存')}
              disabled={savingField === 'cacheEnabled'}
              ariaLabel="启用译文缓存"
            />
            <span>{settings?.cacheEnabled === false ? '已关闭' : '已开启'}</span>
          </div>
        </div>
        <p className="text-sm leading-relaxed text-gray-600 dark:text-gray-300 break-words">
          关闭后不再读写缓存，已有缓存不会自动删除；占用与清空在「数据管理」。
        </p>
        {notice?.field === 'cacheEnabled' ? <span className="text-xs leading-relaxed text-gray-500 dark:text-gray-400 break-words">{notice.text}</span> : null}
        {error?.field === 'cacheEnabled' ? <span className="text-xs leading-relaxed text-red-600 dark:text-red-400" role="alert">{error.text}</span> : null}
      </section>

      <section className="flex flex-col gap-2 rounded-lg border border-gray-200 bg-white shadow-sm dark:border-gray-700 dark:bg-gray-900 p-4" aria-label="日志">
        <div className="flex flex-col gap-1">
          <span className="inline-flex items-center gap-1.5 text-xs font-semibold text-gray-600 dark:text-gray-300">
            <ScrollText size={13} aria-hidden="true" />
            日志级别
          </span>
          <Select
            value={logLevel}
            options={LOG_LEVEL_OPTIONS.map((option) => ({ value: option.value, label: option.label }))}
            onChange={(next) => {
              const level = normalizeLevel(next);
              setLoggerLevel(level);
              void saveField('logLevel', level, '已保存；已打开的网页刷新或重连后生效');
            }}
            ariaLabel="日志级别"
            disabled={savingField === 'logLevel'}
          />
        </div>
        <p className="text-sm leading-relaxed text-gray-600 dark:text-gray-300 break-words">
          日志只输出浏览器控制台，不上传、不保存；调整后已打开的网页需刷新或重连才生效。
        </p>
        {notice?.field === 'logLevel' ? <span className="text-xs leading-relaxed text-gray-500 dark:text-gray-400 break-words">{notice.text}</span> : null}
        {error?.field === 'logLevel' ? <span className="text-xs leading-relaxed text-red-600 dark:text-red-400" role="alert">{error.text}</span> : null}
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
            <p className="text-sm leading-relaxed text-gray-600 dark:text-gray-300 break-words">密钥会随账号同步到其他设备，请只在信任的设备上使用。</p>
          ) : (
            <p className="text-sm leading-relaxed text-gray-600 dark:text-gray-300 break-words">迁移后密钥只保存在这台设备，不再随账号同步。</p>
          )}
        </ConfirmDialog>
      ) : null}
    </div>
  );
}
