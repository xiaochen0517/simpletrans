/**
 * B1 状态显示 / B2 命令下发
 *
 * 模块：工具栏弹窗（B）
 * 职责：弹窗壳与默认页：按设置显示「默认 / 快速翻译」两个页面，查看当前翻译方式与基础信息、
 *       快捷切换翻译方式，并用一个按钮按当前页面整页会话状态执行「翻译整页 / 显示原文」；
 *       提供设置页与测试页两个图标导航入口。
 * 依赖：E1 消息协议、E2 公开设置（读设置、写 activeInstanceId）、E4 日志、E5 共享展示组件、
 *       E6 快捷键、B2 测试页打开助手、B3 快速翻译面板与 B 实例选项助手。
 * 实现阶段：P3（日志初始化）；P6.1（最小整页入口）；P6.5（测试页入口）；
 *           P7（固定宽度、基础信息、翻译方式切换、设置页入口）；UI 规范化（默认主题与共享组件）；
 *           P11（弹窗标签、初始页与快速翻译页）；P12（单按钮、页面状态查询与快捷键提示）。
 *
 * 只做信息展示与导航：不读取任务进度镜像，只查询一个「整页会话是否开启」的布尔值；
 * 不显示进度、成功/失败数，不做按钮状态轮询。
 */
import { useCallback, useEffect, useRef, useState } from 'react';
import {
  Eraser,
  FlaskConical,
  Globe,
  Keyboard,
  KeyRound,
  Languages,
  Play,
  Settings as SettingsIcon,
  Sparkles,
} from 'lucide-react';
import './popup.css';
import { MESSAGE_TYPES } from '../shared/protocol.js';
import { getSettings, saveSettings, resolveTheme } from '../shared/settings.js';
import { languageLabel } from '../shared/languages.js';
import {
  COMMAND_TRANSLATE_PAGE,
  isMacPlatform,
  readCommandShortcut,
  resolveHoverShortcut,
} from '../shared/shortcut.js';
import { createLogger, getLogMeta, newTraceId, setLogLevel } from '../shared/log/logger.js';
import Select from '../shared/ui/select.jsx';
import Notice from '../shared/ui/notice.jsx';
import Button from '../shared/ui/button.jsx';
import StatusBadge from '../shared/ui/status-badge.jsx';
import { openTestPage } from './open-test-page.js';
import { engineOptionsOf, usableInstances } from './instance-option.js';
import QuickTranslate from './quick-translate.jsx';

const log = createLogger('B2');

/** 两个命令的取值，与 `ST_ROUTE.payload.command` 一致；`status` 只查询页面会话状态。 */
const COMMAND = Object.freeze({ start: 'start', clear: 'clear', status: 'status' });

/** 页面会话处于这些阶段时，按钮显示「显示原文」。 */
const ACTIVE_PHASES = new Set(['scanning', 'submitting', 'submitted']);

/** 两个标签页的取值，与 `settings.popupDefaultTab` 一致。 */
const TAB = Object.freeze({ default: 'default', quick: 'quick' });

/** 设置页在扩展内的路径；与 vite 的 web 入口保持一致。 */
const OPTIONS_PAGE_PATH = 'options/index.html';

/**
 * 发一条路由命令；后台不可用时归一为 NETWORK。
 * @param {string} command
 * @returns {Promise<{ ok: true, data?: object } | { ok: false, error: object }>}
 */
async function sendRoute(command) {
  const traceId = newTraceId();
  if (!globalThis.chrome?.runtime?.sendMessage) {
    return { ok: false, error: { code: 'NETWORK', message: '扩展未就绪，请重新打开弹窗' } };
  }
  try {
    const response = await chrome.runtime.sendMessage({
      type: MESSAGE_TYPES.ROUTE,
      payload: { command, traceId },
    });
    return response ?? { ok: false, error: { code: 'OTHER', message: '后台没有返回结果' } };
  } catch {
    return { ok: false, error: { code: 'NETWORK', message: '无法连接后台，请稍后重试' } };
  }
}

/**
 * 读取引擎实例列表（公开字段：名称、模型、是否已配置密钥）；失败时抛出。
 * @returns {Promise<Array<Record<string, unknown>>>}
 */
async function fetchEngines() {
  if (!globalThis.chrome?.runtime?.sendMessage) throw new Error('扩展未就绪');
  const response = await chrome.runtime.sendMessage({ type: MESSAGE_TYPES.LIST_ENGINES });
  if (!response?.ok) throw new Error('读取引擎信息失败');
  return Array.isArray(response.data?.instances) ? response.data.instances : [];
}

/**
 * 打开扩展设置页：优先 `openOptionsPage`，不可用时回退到新标签页。
 * @returns {Promise<{ ok: true } | { ok: false, message: string }>}
 */
export async function openSettingsPage() {
  const runtime = globalThis.chrome?.runtime;
  const tabs = globalThis.chrome?.tabs;
  if (!runtime?.getURL) {
    return { ok: false, message: '扩展未就绪，请重新打开弹窗' };
  }

  try {
    if (typeof runtime.openOptionsPage === 'function') {
      await runtime.openOptionsPage();
      return { ok: true };
    }
    if (tabs?.create) {
      await tabs.create({ url: runtime.getURL(OPTIONS_PAGE_PATH) });
      return { ok: true };
    }
    return { ok: false, message: '扩展未就绪，请重新打开弹窗' };
  } catch {
    return { ok: false, message: '无法打开设置页，请重试' };
  }
}

/**
 * `ST_START` 响应转成一行提示；不显示进度与计数细节。
 * @param {object} data
 * @returns {string}
 */
function startMessage(data = {}) {
  if (data.phase === 'scanning' || data.phase === 'submitting') return '正在提交…';
  const total = Number(data.total) || 0;
  if (total === 0) return '视口附近没有可翻译的段落';
  return `已提交：${total} 段，滚动后自动提交新段落`;
}

/**
 * `ST_CLEAR` 响应转成一行提示。
 * @param {object} data
 * @returns {string}
 */
function clearMessage(data = {}) {
  const removed = Number(data.removed) || 0;
  return removed > 0 ? `已清除 ${removed} 处标记` : '没有可清除的标记';
}

export default function Popup() {
  const [tab, setTab] = useState(TAB.default);
  const [busy, setBusy] = useState(null);
  const [openingTestPage, setOpeningTestPage] = useState(false);
  const [openingSettings, setOpeningSettings] = useState(false);
  const [notice, setNotice] = useState('');
  const [error, setError] = useState('');
  const [switching, setSwitching] = useState(false);
  const [selectedId, setSelectedId] = useState('');
  const [pageActive, setPageActive] = useState(false);
  const [pageShortcut, setPageShortcut] = useState('');
  const [info, setInfo] = useState({
    loading: true,
    lang: '',
    settingsFailed: false,
    enginesFailed: false,
    instances: [],
    settings: null,
  });
  const tabTouched = useRef(false);
  const defaultTabRef = useRef(null);
  const quickTabRef = useRef(null);

  useEffect(() => {
    let cancelled = false;
    (async () => {
      const [settingsResult, enginesResult, statusResult, shortcutResult] = await Promise.allSettled([
        getSettings(),
        fetchEngines(),
        sendRoute(COMMAND.status),
        readCommandShortcut(COMMAND_TRANSLATE_PAGE),
      ]);
      if (cancelled) return;

      const pageSessionActive =
        statusResult.status === 'fulfilled' &&
        statusResult.value?.ok === true &&
        statusResult.value.data?.active === true;
      setPageActive(pageSessionActive);
      setPageShortcut(
        shortcutResult.status === 'fulfilled' && shortcutResult.value.ok
          ? shortcutResult.value.shortcut
          : ''
      );

      const settings = settingsResult.status === 'fulfilled' ? settingsResult.value : null;
      if (settings) {
        setLogLevel(settings.logLevel);
        log.info('logger.ready', '日志已启动', getLogMeta());
      } else {
        log.warn('settings.read', '读取设置失败，使用默认日志级别');
      }

      // 与设置页共用同一主题设置；system 时按系统偏好解析。
      const prefersDark = Boolean(
        globalThis.matchMedia?.('(prefers-color-scheme: dark)')?.matches
      );
      const theme = resolveTheme(settings?.theme, prefersDark);
      document.documentElement.dataset.theme = theme;
      document.documentElement.style.colorScheme = theme;

      const instances = enginesResult.status === 'fulfilled' ? enginesResult.value : [];
      const usable = usableInstances(instances);
      const preferred = typeof settings?.activeInstanceId === 'string' ? settings.activeInstanceId : '';
      const active = usable.find((instance) => instance.id === preferred) ?? usable[0] ?? null;
      const lang = typeof settings?.targetLang === 'string' ? settings.targetLang : '';
      const settingsFailed = settingsResult.status === 'rejected';
      const enginesFailed = enginesResult.status === 'rejected';
      const initialTab = settings?.popupDefaultTab === TAB.quick ? TAB.quick : TAB.default;

      setInfo({ loading: false, lang, settingsFailed, enginesFailed, instances, settings });
      setSelectedId(active ? String(active.id) : '');
      if (!tabTouched.current) setTab(initialTab);
      log.info('popup.info', '弹窗信息已读取', {
        ok: !settingsFailed && !enginesFailed,
        lang: lang || null,
        hasKey: Boolean(active?.hasKey),
        pageActive: pageSessionActive,
      });
      log.info('popup.tab', '弹窗已打开', { tab: initialTab });
    })();
    return () => {
      cancelled = true;
    };
  }, []);

  const selectTab = useCallback(
    (next, { focus = false } = {}) => {
      if (next !== TAB.default && next !== TAB.quick) return;
      tabTouched.current = true;
      setTab(next);
      if (focus) {
        const target = next === TAB.quick ? quickTabRef.current : defaultTabRef.current;
        target?.focus?.();
      }
      log.info('popup.tab', '切换弹窗页面', { tab: next });
    },
    []
  );

  const handleTabKeyDown = (event) => {
    let next = null;
    if (event.key === 'ArrowLeft' || event.key === 'ArrowRight') {
      next = tab === TAB.default ? TAB.quick : TAB.default;
    } else if (event.key === 'Home') {
      next = TAB.default;
    } else if (event.key === 'End') {
      next = TAB.quick;
    }
    if (!next) return;
    event.preventDefault();
    selectTab(next, { focus: true });
  };

  const runPage = useCallback(
    async () => {
      if (busy !== null) return;
      const command = pageActive ? COMMAND.clear : COMMAND.start;
      setBusy(command);
      setNotice('');
      setError('');

      const response = await sendRoute(command);
      setBusy(null);

      if (!response?.ok) {
        const message = response?.error?.message ?? '命令执行失败，请稍后重试';
        setError(String(message));
        log.warn('popup.command', '命令失败', {
          command,
          code: response?.error?.code ?? null,
        });
        return;
      }

      const data = response.data ?? {};
      if (command === COMMAND.start) {
        setPageActive(ACTIVE_PHASES.has(data.phase));
        setNotice(startMessage(data));
      } else {
        setPageActive(false);
        setNotice(clearMessage(data));
      }
      log.info('popup.command', '命令完成', {
        command,
        ok: true,
        phase: data.phase ?? null,
      });
    },
    [busy, pageActive]
  );

  const handleOpenTestPage = useCallback(async () => {
    if (openingTestPage || busy !== null) return;
    setOpeningTestPage(true);
    setNotice('');
    setError('');

    const result = await openTestPage();
    setOpeningTestPage(false);
    if (!result.ok) setError(result.message);
  }, [busy, openingTestPage]);

  const handleOpenSettings = useCallback(async () => {
    if (openingSettings) return;
    setOpeningSettings(true);
    setNotice('');
    setError('');

    const result = await openSettingsPage();
    setOpeningSettings(false);
    if (!result.ok) setError(result.message);
  }, [openingSettings]);

  /**
   * 切换翻译方式：先更新下拉显示，再把选择写入 `settings.activeInstanceId`；
   * 写入失败时回退到上一个选择并提示。
   */
  const handleSelectEngine = useCallback(
    async (nextId) => {
      const previousId = selectedId;
      if (!nextId || nextId === previousId) return;

      setSelectedId(nextId);
      setSwitching(true);
      setNotice('');
      setError('');

      try {
        await saveSettings({ activeInstanceId: nextId });
        log.info('popup.engine', '已切换翻译方式', { ok: true });
      } catch {
        setSelectedId(previousId);
        setError('切换翻译方式失败，请重试');
        log.warn('popup.engine', '切换翻译方式失败', { ok: false });
      } finally {
        setSwitching(false);
      }
    },
    [selectedId]
  );

  const disabled = busy !== null;
  const hoverShortcutText = resolveHoverShortcut(
    info.settings?.hoverShortcut,
    isMacPlatform()
  ).label;
  const usable = usableInstances(info.instances);
  const selected = usable.find((instance) => instance.id === selectedId) ?? null;
  const langLabel = info.settingsFailed ? '未知' : languageLabel(info.lang) || '未知';
  const configFailed = info.settingsFailed || info.enginesFailed;
  const selectedHasKey = Boolean(selected?.hasKey);
  const selectedRequiresKey = selected?.requiresKey !== false;
  const noUsableInstance = !configFailed && usable.length === 0;
  const keyTone = selectedRequiresKey ? (selectedHasKey ? 'ok' : 'warn') : 'idle';
  const keyLabel = selectedRequiresKey
    ? selectedHasKey
      ? '密钥已配置'
      : '密钥未配置'
    : '无需密钥';
  const engineOptions = engineOptionsOf(info.instances);

  return (
    <main className="flex max-h-[600px] w-full flex-col overflow-hidden bg-white text-gray-900 dark:bg-gray-900 dark:text-white">
      <header className="flex items-center justify-between gap-2 p-4 pb-2">
        <div className="flex min-w-0 items-center gap-2">
          <span className="grid size-7 shrink-0 place-items-center rounded-lg bg-indigo-600 text-white" aria-hidden="true">
            <Languages size={15} />
          </span>
          <h1 className="whitespace-nowrap text-base font-bold">SimpleTrans</h1>
        </div>
        <nav className="flex items-center gap-1" aria-label="扩展导航">
          <Button
            variant="ghost"
            size="xs"
            onClick={handleOpenTestPage}
            disabled={openingTestPage || busy !== null}
            title="打开翻译测试页"
          >
            <FlaskConical size={14} aria-hidden="true" />
            <span>{openingTestPage ? '正在打开…' : '测试页'}</span>
          </Button>
          <Button
            variant="ghost"
            size="xs"
            onClick={handleOpenSettings}
            disabled={openingSettings}
            title="打开设置页"
          >
            <SettingsIcon size={14} aria-hidden="true" />
            <span>{openingSettings ? '正在打开…' : '设置'}</span>
          </Button>
        </nav>
      </header>

      <div className="px-4">
        <div className="border-b border-gray-200 dark:border-gray-700">
          <div className="flex" role="tablist" aria-label="弹窗页面">
            <button
              type="button"
              id="popup-tab-default"
              role="tab"
              aria-selected={tab === TAB.default}
              aria-controls="popup-panel-default"
              tabIndex={tab === TAB.default ? 0 : -1}
              className={`flex-1 border-b-2 px-3 py-2 text-sm font-medium transition-colors ${
                tab === TAB.default
                  ? 'border-indigo-600 text-indigo-600 dark:border-indigo-400 dark:text-indigo-300'
                  : 'border-transparent text-gray-600 hover:text-gray-900 dark:text-gray-300 dark:hover:text-white'
              }`}
              onClick={() => selectTab(TAB.default)}
              onKeyDown={handleTabKeyDown}
              ref={defaultTabRef}
            >
              默认
            </button>
            <button
              type="button"
              id="popup-tab-quick"
              role="tab"
              aria-selected={tab === TAB.quick}
              aria-controls="popup-panel-quick"
              tabIndex={tab === TAB.quick ? 0 : -1}
              className={`flex-1 border-b-2 px-3 py-2 text-sm font-medium transition-colors ${
                tab === TAB.quick
                  ? 'border-indigo-600 text-indigo-600 dark:border-indigo-400 dark:text-indigo-300'
                  : 'border-transparent text-gray-600 hover:text-gray-900 dark:text-gray-300 dark:hover:text-white'
              }`}
              onClick={() => selectTab(TAB.quick)}
              onKeyDown={handleTabKeyDown}
              ref={quickTabRef}
            >
              快速翻译
            </button>
          </div>
        </div>
      </div>

      <div className="min-h-0 flex-1 overflow-y-auto p-4 pt-3">
        {info.loading ? (
          <div className="flex flex-col gap-2" aria-label="正在读取配置">
            <span className="h-3 w-1/3 animate-pulse rounded bg-gray-200 dark:bg-gray-800" />
            <span className="h-8 w-full animate-pulse rounded bg-gray-200 dark:bg-gray-800" />
            <span className="h-3 w-2/3 animate-pulse rounded bg-gray-200 dark:bg-gray-800" />
          </div>
        ) : (
          <>
            <div
              role="tabpanel"
              id="popup-panel-default"
              aria-labelledby="popup-tab-default"
              className={tab === TAB.default ? 'flex flex-col gap-3' : 'hidden'}
              hidden={tab !== TAB.default}
            >
              <section
                className="flex flex-col rounded-lg border border-gray-200 bg-gray-50 p-3 dark:border-gray-700 dark:bg-gray-800"
                aria-label="当前翻译配置"
              >
                <span className="flex items-center gap-1 text-xs font-semibold text-gray-700 dark:text-gray-200">
                  <Sparkles size={14} className="text-indigo-600 dark:text-indigo-400" aria-hidden="true" />
                  <span>翻译方式</span>
                </span>
                <div className="mt-1.5">
                  <Select
                    id="engine-select"
                    value={selectedId}
                    options={engineOptions}
                    onChange={handleSelectEngine}
                    placeholder="未配置翻译方式"
                    ariaLabel="翻译方式"
                    disabled={usable.length === 0}
                    loading={switching}
                  />
                </div>

                <div className="mt-2.5 flex flex-wrap gap-1.5">
                  <StatusBadge tone="idle" icon={<Globe size={12} aria-hidden="true" />}>
                    {langLabel}
                  </StatusBadge>
                  <StatusBadge tone={keyTone} icon={<KeyRound size={12} aria-hidden="true" />}>
                    {keyLabel}
                  </StatusBadge>
                </div>

                {noUsableInstance ? (
                  <Notice tone="warning" className="mt-2">
                    没有可用的翻译实例，请到设置页新增或启用
                  </Notice>
                ) : null}

                {configFailed ? (
                  <Notice tone="error" className="mt-2">
                    读取配置失败，请到设置页检查
                  </Notice>
                ) : null}
              </section>

              <Button
                variant="primary"
                className="w-full"
                onClick={() => void runPage()}
                disabled={disabled}
                busy={busy !== null}
                title={
                  pageActive
                    ? '显示原文（清除当前页面译文）'
                    : pageShortcut
                      ? `翻译整页（${pageShortcut}）`
                      : '翻译整页（未设置浏览器快捷键）'
                }
              >
                {busy === null ? (
                  pageActive ? (
                    <Eraser size={15} aria-hidden="true" />
                  ) : (
                    <Play size={15} aria-hidden="true" />
                  )
                ) : null}
                <span>
                  {busy === COMMAND.clear
                    ? '正在清除…'
                    : busy === COMMAND.start
                      ? '正在提交…'
                      : pageActive
                        ? '显示原文'
                        : '翻译整页'}
                </span>
                {!pageActive && busy === null ? (
                  <kbd
                    className={`max-w-[9rem] truncate rounded border border-white/40 bg-white/15 px-1.5 py-0.5 font-mono text-[10px] leading-none ${
                      pageShortcut ? 'text-white' : 'text-white/75'
                    }`}
                  >
                    {pageShortcut || '未设置'}
                  </kbd>
                ) : null}
              </Button>

              {notice ? <Notice tone="success">{notice}</Notice> : null}
              {error ? <Notice tone="error">{error}</Notice> : null}

              <p className="flex items-center gap-1 text-xs text-gray-500 dark:text-gray-400">
                <Keyboard size={13} aria-hidden="true" />
                <span>悬停翻译快捷键：</span>
                <kbd className="rounded border border-gray-300 bg-gray-100 px-1.5 py-0.5 font-mono text-[11px] text-gray-700 dark:border-gray-700 dark:bg-gray-800 dark:text-gray-200">
                  {hoverShortcutText}
                </kbd>
              </p>
            </div>

            <QuickTranslate
              settings={info.settings}
              instances={info.instances}
              settingsFailed={info.settingsFailed}
              enginesFailed={info.enginesFailed}
              active={tab === TAB.quick}
            />
          </>
        )}
      </div>
    </main>
  );
}
