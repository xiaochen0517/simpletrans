/**
 * C1–C5 设置页壳层
 *
 * 模块：插件独立页面（C）/ 设置页
 * 职责：分区导航与哈希路由、全局数据加载（设置 / 实例公开字段 / 缓存占用）、写操作串行与刷新、
 *       全局保存状态与 toast、外部变更提示、实例编辑弹窗与新增对话框的挂载、未保存离开兜底。
 * 依赖：React、`lucide-react`、E1（protocol）、E2（settings）、E3（instances 公开字段）、
 *       E4（日志）、各分区与组件、设置页共享工具。
 * 实现阶段：P8-3（设置页内容分类与 UI 规范化）
 *
 * 设置页只读公开字段与 `credentialFields`（布尔），不读凭据明文；实例写入经 E3 后重新拉取
 * `ST_LIST_ENGINES`，不在本地合并可变对象。
 */

import { useCallback, useEffect, useRef, useState } from 'react';
import {
  Activity,
  Database,
  FlaskConical,
  Info,
  LayoutDashboard,
  LoaderCircle,
  Moon,
  Settings2,
  Sparkles,
  Sun,
} from 'lucide-react';
import { MESSAGE_TYPES } from '../shared/protocol.js';
import { STORAGE_KEYS } from '../shared/storage.js';
import { getSettings, resolveTheme, saveSettings } from '../shared/settings.js';
import { AppContext, DEFAULT_ROUTE, ROUTES, openTestPage, sendToBackground } from './lib.js';
import Toast from './components/toast.jsx';
import Button from '../shared/ui/button.jsx';
import CreateInstance from './components/create-instance.jsx';
import InstanceEditor from './components/instance-editor.jsx';
import Overview from './sections/overview.jsx';
import Instances from './sections/instances.jsx';
import General from './sections/general.jsx';
import TestTranslation from './sections/test-translation.jsx';
import DataManagement from './sections/data-management.jsx';
import About from './sections/about.jsx';

/** 分区图标。 */
const ROUTE_ICONS = Object.freeze({
  overview: LayoutDashboard,
  instances: Sparkles,
  general: Settings2,
  test: FlaskConical,
  data: Database,
  about: Info,
});

/** 分区组件。 */
const ROUTE_VIEWS = Object.freeze({
  overview: Overview,
  instances: Instances,
  general: General,
  test: TestTranslation,
  data: DataManagement,
  about: About,
});

/**
 * 读取当前哈希对应的分区 id；非法 hash 回退概览。
 * @returns {string}
 */
function routeFromHash() {
  const hash = typeof window !== 'undefined' ? window.location.hash : '';
  return ROUTES.find((route) => route.path === hash)?.id ?? DEFAULT_ROUTE;
}

/**
 * 读取扩展清单；不可用时返回空对象。
 * @returns {Record<string, any>}
 */
function readManifest() {
  try {
    return globalThis.chrome?.runtime?.getManifest?.() ?? {};
  } catch {
    return {};
  }
}

export default function Options() {
  const [route, setRoute] = useState(routeFromHash);
  const [loading, setLoading] = useState(true);
  const [loadError, setLoadError] = useState(null);
  const [enginesError, setEnginesError] = useState(null);
  const [settings, setSettings] = useState(null);
  const [instances, setInstances] = useState([]);
  const [cacheStats, setCacheStats] = useState(null);
  const [cacheError, setCacheError] = useState(false);
  const [cacheLoading, setCacheLoading] = useState(true);
  const [toast, setToast] = useState(null);
  const [savingCount, setSavingCount] = useState(0);
  const [saveError, setSaveError] = useState(null);
  const [lastAction, setLastAction] = useState(null);
  const [editorId, setEditorId] = useState(null);
  const [editorDirty, setEditorDirty] = useState(false);
  const [externalChange, setExternalChange] = useState(false);
  const [createOpen, setCreateOpen] = useState(false);
  const [createHint, setCreateHint] = useState(null);
  const [testState, setTestState] = useState({
    instanceId: null,
    text: 'Hello world',
    result: null,
    busy: false,
  });
  const [clearCacheRequest, setClearCacheRequest] = useState(false);
  const [systemDark, setSystemDark] = useState(() =>
    Boolean(globalThis.matchMedia?.('(prefers-color-scheme: dark)')?.matches)
  );

  const resolvedTheme = resolveTheme(settings?.theme, systemDark);

  const writeDepth = useRef(0);
  const writeChain = useRef(Promise.resolve());
  const toastTimer = useRef(null);
  const editorIdRef = useRef(null);
  const editorStampRef = useRef(null);
  const instancesRef = useRef([]);

  const manifest = readManifest();
  const version = String(manifest.version ?? '');

  useEffect(() => {
    editorIdRef.current = editorId;
  }, [editorId]);

  useEffect(() => {
    instancesRef.current = instances;
  }, [instances]);

  // ---------------------------------------------------------------- 数据读取
  /** 读取设置；失败时抛出，由调用方决定是否降级。 */
  const fetchSettings = useCallback(async () => {
    const next = await getSettings();
    setSettings(next);
    return next;
  }, []);

  /** 读取实例公开字段；失败时抛出。 */
  const fetchInstances = useCallback(async () => {
    const response = await sendToBackground(MESSAGE_TYPES.LIST_ENGINES);
    if (!response.ok) {
      const message = response.error?.message ?? '无法读取引擎配置';
      setEnginesError(message);
      throw new Error(message);
    }
    const list = Array.isArray(response.data?.instances) ? response.data.instances : [];
    setInstances(list);
    setEnginesError(null);
    return list;
  }, []);

  /** 重新读取缓存占用；打开页面、窗口聚焦、刷新与清空后调用。 */
  const refreshCacheStats = useCallback(async () => {
    setCacheLoading(true);
    const response = await sendToBackground(MESSAGE_TYPES.CACHE_STATS);
    if (response.ok && response.data) {
      setCacheStats({
        entries: Number(response.data.entries) || 0,
        bytes: Number(response.data.bytes) || 0,
        maxBytes: Number(response.data.maxBytes) || 0,
        maxEntries: Number(response.data.maxEntries) || 0,
      });
      setCacheError(false);
    } else {
      setCacheError(true);
    }
    setCacheLoading(false);
  }, []);

  const refreshSettings = useCallback(async () => {
    try {
      await fetchSettings();
    } catch {
      setLoadError('读取设置失败，请重试');
    }
  }, [fetchSettings]);

  const refreshInstances = useCallback(async () => {
    try {
      await fetchInstances();
    } catch {
      // 错误已写入 enginesError。
    }
  }, [fetchInstances]);

  /** 首次加载：设置与实例分开降级，缓存占用随后读取。 */
  const loadAll = useCallback(async () => {
    setLoading(true);
    setLoadError(null);
    const [settingsResult] = await Promise.allSettled([fetchSettings(), fetchInstances()]);
    if (settingsResult.status === 'rejected') {
      setLoadError('读取设置失败，请重试');
    }
    setLoading(false);
    void refreshCacheStats();
  }, [fetchInstances, fetchSettings, refreshCacheStats]);

  useEffect(() => {
    void loadAll();
  }, [loadAll]);

  // 跟随系统暗色只在 theme=system 时生效；显式主题不受系统变化影响。
  useEffect(() => {
    const query = globalThis.matchMedia?.('(prefers-color-scheme: dark)');
    if (!query?.addEventListener) return undefined;
    const onChange = (event) => setSystemDark(event.matches);
    query.addEventListener('change', onChange);
    return () => {
      query.removeEventListener('change', onChange);
    };
  }, []);

  // 把实际主题写到根节点，Tailwind dark 变体与原生控件共用同一 color-scheme。
  useEffect(() => {
    const root = document.documentElement;
    root.dataset.theme = resolvedTheme;
    root.style.colorScheme = resolvedTheme;
  }, [resolvedTheme]);

  useEffect(() => {
    const onFocus = () => {
      void refreshCacheStats();
    };
    window.addEventListener('focus', onFocus);
    return () => {
      window.removeEventListener('focus', onFocus);
    };
  }, [refreshCacheStats]);

  // ------------------------------------------------------------------ 路由
  useEffect(() => {
    const onHashChange = () => setRoute(routeFromHash());
    window.addEventListener('hashchange', onHashChange);
    const known = ROUTES.some((item) => item.path === window.location.hash);
    if (!known) {
      try {
        window.history.replaceState(null, '', `#/${DEFAULT_ROUTE}`);
      } catch {
        window.location.hash = `#/${DEFAULT_ROUTE}`;
      }
    }
    return () => {
      window.removeEventListener('hashchange', onHashChange);
    };
  }, []);

  /** 切换分区。 */
  const navigate = useCallback((path) => {
    if (window.location.hash === path) {
      setRoute(routeFromHash());
      return;
    }
    window.location.hash = path;
  }, []);

  // -------------------------------------------------------------- 提示与状态
  const notify = useCallback((tone, text) => {
    if (toastTimer.current) clearTimeout(toastTimer.current);
    setToast({ id: Date.now(), tone, text });
    if (tone !== 'error') {
      toastTimer.current = setTimeout(() => setToast(null), 3000);
    }
  }, []);

  const dismissToast = useCallback(() => {
    if (toastTimer.current) clearTimeout(toastTimer.current);
    setToast(null);
  }, []);

  useEffect(
    () => () => {
      if (toastTimer.current) clearTimeout(toastTimer.current);
    },
    []
  );

  const recordAction = useCallback((text) => {
    setLastAction({ text, at: Date.now() });
  }, []);

  /** 写入成功后的局部设置更新（即时保存的乐观显示）。 */
  const updateSettingsLocal = useCallback((partial) => {
    setSettings((current) => (current ? { ...current, ...partial } : current));
  }, []);

  /**
   * 串行执行一次写操作：写期间屏蔽外部变更提示，写后重新拉取设置与实例。
   * 失败时抛出原错误，由调用方决定提示方式；同时记录顶部「保存失败」。
   * @template T
   * @param {() => Promise<T>} action
   * @returns {Promise<T>}
   */
  const mutate = useCallback(
    (action) => {
      const run = writeChain.current.then(async () => {
        writeDepth.current += 1;
        setSavingCount((count) => count + 1);
        setSaveError(null);
        try {
          const result = await action();
          await Promise.all([refreshSettings(), refreshInstances()]);
          return result;
        } catch (error) {
          setSaveError(error?.message ?? '保存失败，请重试');
          throw error;
        } finally {
          writeDepth.current -= 1;
          setSavingCount((count) => Math.max(0, count - 1));
        }
      });
      writeChain.current = run.then(
        () => undefined,
        () => undefined
      );
      return run;
    },
    [refreshInstances, refreshSettings]
  );

  /** 在 light / dark 之间切换并写入设置；失败由壳层显示保存失败。 */
  const toggleTheme = useCallback(async () => {
    const next = resolvedTheme === 'dark' ? 'light' : 'dark';
    try {
      await mutate(() => saveSettings({ theme: next }));
      notify('ok', next === 'dark' ? '已切换为深色主题' : '已切换为浅色主题');
    } catch {
      notify('error', '切换主题失败，请重试');
    }
  }, [mutate, notify, resolvedTheme]);

  // ------------------------------------------------------------ 外部变更同步
  useEffect(() => {    const onChanged = (changes, area) => {
      if (area !== 'sync') return;
      const keys = Object.keys(changes ?? {});
      if (!keys.includes(STORAGE_KEYS.settings) && !keys.includes(STORAGE_KEYS.instances)) return;
      if (writeDepth.current > 0) return;

      void (async () => {
        try {
          const [fresh] = await Promise.all([fetchInstances(), fetchSettings()]);
          const id = editorIdRef.current;
          if (!id) return;
          const target = fresh.find((instance) => instance.id === id) ?? null;
          if (!target) {
            setEditorId(null);
            setEditorDirty(false);
            return;
          }
          if ((target.updatedAt ?? null) !== editorStampRef.current) setExternalChange(true);
        } catch {
          // 读取失败时保留现有界面，等待用户手动重试。
        }
      })();
    };
    const listener = globalThis.chrome?.storage?.onChanged;
    listener?.addListener?.(onChanged);
    return () => {
      listener?.removeListener?.(onChanged);
    };
  }, [fetchInstances, fetchSettings]);

  // ---------------------------------------------------------- 弹窗与对话框
  /** 打开实例编辑弹窗，并记录当前 updatedAt 作为外部变更基线。 */
  const openEditor = useCallback((id) => {
    const target = instancesRef.current.find((instance) => instance.id === id);
    editorStampRef.current = target?.updatedAt ?? null;
    setExternalChange(false);
    setEditorDirty(false);
    setEditorId(id);
  }, []);

  const closeEditor = useCallback(() => {
    setEditorId(null);
    setEditorDirty(false);
    setExternalChange(false);
  }, []);

  const openCreate = useCallback((hint = null) => {
    setCreateHint(hint);
    setCreateOpen(true);
  }, []);

  const closeCreate = useCallback(() => {
    setCreateOpen(false);
    setCreateHint(null);
  }, []);

  /** 更新测试分区的会话状态（输入、选中实例、执行中与结果）。 */
  const updateTestState = useCallback((patch) => {
    setTestState((current) => ({ ...current, ...patch }));
  }, []);

  /** 预选测试实例；从概览或实例卡片进入测试分区时使用。 */
  const setTestInstanceId = useCallback(
    (instanceId) => {
      updateTestState({ instanceId });
    },
    [updateTestState]
  );

  /** 概览快捷操作：跳到数据管理并请求打开清空确认（由数据管理消费一次）。 */
  const requestClearCache = useCallback(() => {
    setClearCacheRequest(true);
    navigate('#/data');
  }, [navigate]);

  const consumeClearCacheRequest = useCallback(() => {
    setClearCacheRequest(false);
  }, []);

  // -------------------------------------------------------------- 未保存兜底
  useEffect(() => {
    if (!editorDirty) return undefined;
    const onBeforeUnload = (event) => {
      event.preventDefault();
      event.returnValue = '';
      return '';
    };
    window.addEventListener('beforeunload', onBeforeUnload);
    return () => {
      window.removeEventListener('beforeunload', onBeforeUnload);
    };
  }, [editorDirty]);

  // 实例被外部删除时关闭弹窗。
  useEffect(() => {
    if (!editorId || loading) return;
    if (!instances.some((instance) => instance.id === editorId)) {
      setEditorId(null);
      setEditorDirty(false);
    }
  }, [editorId, instances, loading]);

  const editorInstance = instances.find((instance) => instance.id === editorId) ?? null;
  const currentRoute = ROUTES.find((item) => item.id === route) ?? ROUTES[0];
  const View = ROUTE_VIEWS[route] ?? Overview;

  const needsAttention = instances.some(
    (instance) =>
      instance.kind === 'unsupported' ||
      instance.permission === 'missing' ||
      (instance.requiresKey !== false && instance.hasKey !== true)
  );

  const statusText = savingCount > 0
    ? '保存中…'
    : saveError
      ? '保存失败'
      : editorDirty
        ? '有未保存更改'
        : loading
          ? '读取中…'
          : '已保存';

  const appValue = {
    route,
    navigate,
    loading,
    loadError,
    enginesError,
    settings,
    instances,
    cacheStats,
    cacheError,
    cacheLoading,
    saving: savingCount > 0,
    saveError,
    lastAction,
    notify,
    recordAction,
    updateSettingsLocal,
    refreshAll: loadAll,
    refreshSettings,
    refreshInstances,
    refreshCacheStats,
    mutate,
    openEditor,
    closeEditor,
    openCreate,
    createOpen,
    createHint,
    editorId,
    editorDirty,
    externalChange,
    setTestInstanceId,
    testState,
    updateTestState,
    clearCacheRequest,
    requestClearCache,
    consumeClearCacheRequest,
  };

  return (
    <AppContext.Provider value={appValue}>
      <div className="min-h-screen bg-gray-50 text-gray-900 dark:bg-gray-950 dark:text-gray-100">
        <div className="mx-auto grid min-h-screen w-full max-w-[1440px] grid-cols-1 bg-gray-50 dark:bg-gray-950 lg:grid-cols-[14rem_minmax(0,1fr)]">
          <aside className="sticky top-0 z-20 flex flex-col gap-2 border-b border-gray-200 bg-white p-3 dark:border-gray-800 dark:bg-gray-900 lg:h-screen lg:gap-3.5 lg:border-b-0 lg:border-r lg:p-4">
            <div className="flex items-center gap-2 px-1">
              <span className="grid size-8 shrink-0 place-items-center rounded-lg bg-indigo-600 text-white" aria-hidden="true">
                <Sparkles size={16} />
              </span>
              <div>
                <h1 className="m-0 whitespace-nowrap text-base font-bold">SimpleTrans</h1>
                <span className="block text-xs text-gray-500 dark:text-gray-400">网页双语对照翻译</span>
              </div>
            </div>

            <nav aria-label="设置分类">
              <ul className="flex flex-row gap-1 overflow-x-auto p-0 lg:flex-col">
                {ROUTES.map((item) => {
                  const Icon = ROUTE_ICONS[item.id] ?? Activity;
                  const active = route === item.id;
                  return (
                    <li key={item.id}>
                      <button
                        type="button"
                        className={`flex items-center gap-2 rounded-lg px-3 py-2 text-left text-sm font-medium transition-colors lg:w-full ${
                          active
                            ? 'bg-gray-100 text-gray-900 dark:bg-gray-800 dark:text-white'
                            : 'text-gray-600 hover:bg-gray-100 hover:text-gray-900 dark:text-gray-300 dark:hover:bg-gray-800 dark:hover:text-white'
                        }`}
                        aria-current={active ? 'page' : undefined}
                        onClick={() => navigate(item.path)}
                      >
                        <Icon size={15} aria-hidden="true" />
                        <span className="min-w-0 truncate">
                          <span className="hidden lg:inline">{item.label}</span>
                          <span className="lg:hidden">{item.short}</span>
                        </span>
                        {item.id === 'instances' && instances.length > 0 ? (
                          needsAttention ? (
                            <span
                              className="ml-auto size-2 shrink-0 rounded-full bg-amber-500"
                              aria-label="有实例需要处理"
                            />
                          ) : (
                            <span className="ml-auto rounded-full bg-gray-200 px-1.5 py-0.5 text-[10px] font-semibold text-gray-700 dark:bg-gray-700 dark:text-gray-200">
                              {instances.length}
                            </span>
                          )
                        ) : null}
                      </button>
                    </li>
                  );
                })}
              </ul>
            </nav>

            {version ? (
              <div className="mt-auto px-1.5 text-xs text-gray-500 dark:text-gray-400">v{version}</div>
            ) : null}
          </aside>

          <div className="flex min-w-0 flex-col">
            <header className="z-10 flex flex-wrap items-center gap-3 border-b border-gray-200 bg-white px-4 py-3 dark:border-gray-800 dark:bg-gray-900 sm:px-6 lg:sticky lg:top-0">
              <h2 className="m-0 text-xl font-bold">{currentRoute.label}</h2>
              <div className="ml-auto flex flex-wrap items-center gap-2">
                <span
                  className={`inline-flex min-h-5 items-center gap-1 text-xs ${
                    saveError
                      ? 'text-red-600 dark:text-red-400'
                      : savingCount > 0
                        ? 'text-gray-500 dark:text-gray-400'
                        : 'text-green-600 dark:text-green-400'
                  }`}
                  aria-live="polite"
                  title={saveError ?? undefined}
                >
                  {savingCount > 0 ? (
                    <LoaderCircle className="size-3.5 animate-spin" aria-hidden="true" />
                  ) : null}
                  {statusText}
                </span>
                {version ? (
                  <span className="rounded-full bg-gray-100 px-2 py-0.5 text-xs font-medium text-gray-600 dark:bg-gray-800 dark:text-gray-300">
                    v{version}
                  </span>
                ) : null}
                <Button
                  variant="ghost"
                  iconOnly
                  aria-label={resolvedTheme === 'dark' ? '切换为浅色主题' : '切换为深色主题'}
                  title={resolvedTheme === 'dark' ? '切换为浅色主题' : '切换为深色主题'}
                  onClick={() => void toggleTheme()}
                  disabled={savingCount > 0}
                >
                  {resolvedTheme === 'dark' ? (
                    <Sun size={15} aria-hidden="true" />
                  ) : (
                    <Moon size={15} aria-hidden="true" />
                  )}
                </Button>
                <Button
                  variant="ghost"
                  iconOnly
                  aria-label="打开翻译测试页"
                  title="打开翻译测试页"
                  onClick={async () => {
                    const result = await openTestPage();
                    notify(result.ok ? 'ok' : 'error', result.ok ? '已打开翻译测试页' : result.message);
                  }}
                >
                  <FlaskConical size={15} aria-hidden="true" />
                </Button>
              </div>
            </header>

            <div className="w-full px-4 py-5 pb-16 sm:px-6">
              {loadError && !settings ? (
                <div className="flex flex-wrap items-center gap-2 rounded-lg border border-amber-500 bg-amber-50 p-3 text-sm text-amber-800 dark:border-amber-700 dark:bg-amber-950/40 dark:text-amber-200">
                  <span className="min-w-0 break-words">{loadError}</span>
                  <span className="ml-auto shrink-0">
                    <Button size="xs" variant="secondary" onClick={() => void loadAll()}>
                      重试
                    </Button>
                  </span>
                </div>
              ) : (
                <div className="flex flex-col gap-4">
                  {enginesError ? (
                    <div className="flex flex-wrap items-center gap-2 rounded-lg border border-amber-500 bg-amber-50 p-3 text-sm text-amber-800 dark:border-amber-700 dark:bg-amber-950/40 dark:text-amber-200">
                      <span className="min-w-0 break-words">读取实例列表失败：{enginesError}</span>
                      <span className="ml-auto shrink-0">
                        <Button size="xs" variant="secondary" onClick={() => void refreshInstances()}>
                          重试
                        </Button>
                      </span>
                    </div>
                  ) : null}
                  <View />
                </div>
              )}
            </div>
          </div>
        </div>
      </div>

      {createOpen ? <CreateInstance hint={createHint} onClose={closeCreate} /> : null}

      {editorInstance ? (
        <InstanceEditor
          key={editorInstance.id}
          instance={editorInstance}
          active={editorInstance.id === settings?.activeInstanceId}
          externalChange={externalChange}
          onClose={closeEditor}
          onDirtyChange={setEditorDirty}
        />
      ) : null}

      <Toast toast={toast} onClose={dismissToast} />
    </AppContext.Provider>
  );
}
