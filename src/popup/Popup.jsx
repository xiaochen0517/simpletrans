/**
 * B1 状态显示 / B2 命令下发
 *
 * 模块：工具栏弹窗（B）
 * 职责：显示当前翻译方式与基础信息，并把用户操作转成命令；
 *       提供「翻译方式」下拉快捷切换、设置页与测试页两个图标导航入口。
 * 依赖：E1 消息协议、E2 公开设置（读设置、写 activeInstanceId）、E4 日志、B2 测试页打开助手。
 * 实现阶段：P3（日志初始化）；P6.1（最小整页入口）；P6.5（测试页入口）；
 *           P7（固定宽度、基础信息、绿色主题、图标与动效、翻译方式切换、设置页入口）。
 *
 * P7 只做信息展示与导航：不读取任务状态镜像，不显示进度、成功/失败数，
 * 不做按钮状态切换（归后续需求）。
 */
import { useCallback, useEffect, useState } from 'react';
import {
  ChevronDown,
  CircleCheck,
  CircleX,
  Eraser,
  FlaskConical,
  Globe,
  Keyboard,
  KeyRound,
  Languages,
  LoaderCircle,
  Play,
  Settings as SettingsIcon,
  Sparkles,
} from 'lucide-react';
import './popup.css';
import { MESSAGE_TYPES } from '../shared/protocol.js';
import { getSettings, saveSettings } from '../shared/settings.js';
import { languageLabel } from '../shared/languages.js';
import { createLogger, getLogMeta, newTraceId, setLogLevel } from '../shared/log/logger.js';
import { openTestPage } from './open-test-page.js';

const log = createLogger('B2');

/** 两个命令的取值，与 `ST_ROUTE.payload.command` 一致。 */
const COMMAND = Object.freeze({ start: 'start', clear: 'clear' });

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

/**
 * 引擎下拉的显示名：`名称 · 类型/预设 · 模型`；缺字段时退化。
 * @param {Record<string, unknown>} instance
 * @returns {string}
 */
function engineOptionLabel(instance) {
  const name = String(instance.name ?? '').trim() || '未命名实例';
  const typeLabel = String(instance.typeLabel ?? '').trim();
  const preset = String(instance.preset ?? '').trim();
  const model = String(instance.model ?? '').trim();
  const kind = typeLabel && preset ? `${typeLabel}/${preset}` : typeLabel;
  return [name, kind, model].filter(Boolean).join(' · ');
}

/**
 * 判断实例是否可在弹窗中选用：已启用且凭据完整（无认证实例 `hasKey` 为 true）。
 * @param {Record<string, unknown>} instance
 * @returns {boolean}
 */
function isUsableInstance(instance) {
  return instance?.enabled !== false && instance?.hasKey === true;
}

export default function Popup() {
  const [busy, setBusy] = useState(null);
  const [openingTestPage, setOpeningTestPage] = useState(false);
  const [openingSettings, setOpeningSettings] = useState(false);
  const [notice, setNotice] = useState('');
  const [error, setError] = useState('');
  const [switching, setSwitching] = useState(false);
  const [selectedId, setSelectedId] = useState('');
  const [info, setInfo] = useState({
    loading: true,
    lang: '',
    settingsFailed: false,
    enginesFailed: false,
    instances: [],
  });

  useEffect(() => {
    let cancelled = false;
    (async () => {
      const [settingsResult, enginesResult] = await Promise.allSettled([
        getSettings(),
        fetchEngines(),
      ]);
      if (cancelled) return;

      const settings = settingsResult.status === 'fulfilled' ? settingsResult.value : null;
      if (settings) {
        setLogLevel(settings.logLevel);
        log.info('logger.ready', '日志已启动', getLogMeta());
      } else {
        log.warn('settings.read', '读取设置失败，使用默认日志级别');
      }

      const instances = enginesResult.status === 'fulfilled' ? enginesResult.value : [];
      const usable = instances.filter(isUsableInstance);
      const preferred = typeof settings?.activeInstanceId === 'string' ? settings.activeInstanceId : '';
      const active = usable.find((instance) => instance.id === preferred) ?? usable[0] ?? null;
      const lang = typeof settings?.targetLang === 'string' ? settings.targetLang : '';
      const settingsFailed = settingsResult.status === 'rejected';
      const enginesFailed = enginesResult.status === 'rejected';

      setInfo({ loading: false, lang, settingsFailed, enginesFailed, instances });
      setSelectedId(active ? String(active.id) : '');
      log.info('popup.info', '弹窗信息已读取', {
        ok: !settingsFailed && !enginesFailed,
        lang: lang || null,
        hasKey: Boolean(active?.hasKey),
      });
    })();
    return () => {
      cancelled = true;
    };
  }, []);

  const run = useCallback(
    async (command) => {
      if (busy !== null) return;
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
      setNotice(command === COMMAND.start ? startMessage(data) : clearMessage(data));
      log.info('popup.command', '命令完成', {
        command,
        ok: true,
        phase: data.phase ?? null,
      });
    },
    [busy]
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
    async (event) => {
      const nextId = event.target.value;
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
  const usableInstances = info.instances.filter(isUsableInstance);
  const selected = usableInstances.find((instance) => instance.id === selectedId) ?? null;
  const langLabel = info.settingsFailed ? '未知' : languageLabel(info.lang) || '未知';
  const configFailed = info.settingsFailed || info.enginesFailed;
  const selectedHasKey = Boolean(selected?.hasKey);
  const selectedRequiresKey = selected?.requiresKey !== false;
  const noUsableInstance = !configFailed && usableInstances.length === 0;

  return (
    <main className="popup bg-base-100 text-base-content p-4 space-y-3">
      <header className="st-header">
        <div className="st-brand">
          <span className="st-brand-mark" aria-hidden="true">
            <Languages size={15} />
          </span>
          <h1 className="st-title">SimpleTrans</h1>
        </div>
        <nav className="st-nav" aria-label="扩展导航">
          <button
            type="button"
            className="st-link"
            onClick={handleOpenTestPage}
            disabled={openingTestPage || busy !== null}
            title="打开翻译测试页"
          >
            <FlaskConical size={14} aria-hidden="true" />
            <span>{openingTestPage ? '正在打开…' : '测试页'}</span>
          </button>
          <button
            type="button"
            className="st-link"
            onClick={handleOpenSettings}
            disabled={openingSettings}
            title="打开设置页"
          >
            <SettingsIcon size={14} aria-hidden="true" />
            <span>{openingSettings ? '正在打开…' : '设置'}</span>
          </button>
        </nav>
      </header>

      <section className="st-card" aria-label="当前翻译配置">
        {info.loading ? (
          <div className="st-skeleton" aria-label="正在读取配置">
            <span className="st-skeleton-line w-1/3" />
            <span className="st-skeleton-line w-full" />
            <span className="st-skeleton-line w-2/3" />
          </div>
        ) : (
          <>
            <label className="st-label" htmlFor="engine-select">
              <Sparkles size={14} aria-hidden="true" />
              <span>翻译方式</span>
            </label>
            <div className="st-select-wrap">
              <select
                id="engine-select"
                className="st-select"
                value={selectedId}
                onChange={handleSelectEngine}
                disabled={switching || usableInstances.length === 0}
                title={selected ? engineOptionLabel(selected) : '未配置翻译方式'}
              >
                {usableInstances.length === 0 ? (
                  <option value="">未配置翻译方式</option>
                ) : (
                  usableInstances.map((instance) => (
                    <option key={String(instance.id)} value={String(instance.id)}>
                      {engineOptionLabel(instance)}
                    </option>
                  ))
                )}
              </select>
              {switching ? (
                <LoaderCircle className="st-spin" size={14} aria-hidden="true" />
              ) : (
                <ChevronDown className="st-select-icon" size={14} aria-hidden="true" />
              )}
            </div>

            <div className="st-chips">
              <span className="st-chip">
                <Globe size={12} aria-hidden="true" />
                {langLabel}
              </span>
              <span className={`st-chip ${selectedHasKey ? 'is-ok' : 'is-idle'}`}>
                <span className="st-dot" aria-hidden="true" />
                <KeyRound size={12} aria-hidden="true" />
                {selectedRequiresKey
                  ? selectedHasKey
                    ? '密钥已配置'
                    : '密钥未配置'
                  : '无需密钥'}
              </span>
            </div>

            {noUsableInstance && (
              <p className="st-hint">
                <CircleX size={13} aria-hidden="true" />
                <span>没有可用的翻译实例，请到设置页新增或启用</span>
              </p>
            )}

            {configFailed && (
              <p className="st-hint">
                <CircleX size={13} aria-hidden="true" />
                <span>读取配置失败，请到设置页检查</span>
              </p>
            )}
          </>
        )}
      </section>

      <div className="st-actions">
        <button
          type="button"
          className="btn btn-primary st-btn st-btn-primary"
          onClick={() => run(COMMAND.start)}
          disabled={disabled}
        >
          {busy === COMMAND.start ? (
            <LoaderCircle className="st-spin-inline" size={15} aria-hidden="true" />
          ) : (
            <Play size={15} aria-hidden="true" />
          )}
          <span>{busy === COMMAND.start ? '正在提交…' : '翻译整页'}</span>
        </button>
        <button
          type="button"
          className="btn btn-outline st-btn"
          onClick={() => run(COMMAND.clear)}
          disabled={disabled}
        >
          {busy === COMMAND.clear ? (
            <LoaderCircle className="st-spin-inline" size={15} aria-hidden="true" />
          ) : (
            <Eraser size={15} aria-hidden="true" />
          )}
          <span>{busy === COMMAND.clear ? '正在清除…' : '显示原文'}</span>
        </button>
      </div>

      {notice && (
        <p className="st-notice is-ok">
          <CircleCheck size={14} aria-hidden="true" />
          <span>{notice}</span>
        </p>
      )}
      {error && (
        <p className="st-notice is-error">
          <CircleX size={14} aria-hidden="true" />
          <span>{error}</span>
        </p>
      )}

      <p className="st-footer">
        <Keyboard size={13} aria-hidden="true" />
        <span>快捷键提交当前段落：</span>
        <kbd className="st-kbd">Ctrl</kbd>
      </p>
    </main>
  );
}
