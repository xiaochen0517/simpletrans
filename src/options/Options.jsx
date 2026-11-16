/**
 * C1–C5 设置页（P2 最小测试表单，经后台执行；P3 增加日志级别；P5 增加译文缓存区块；P6.2 增加翻译实例参数）
 *
 * 模块：插件独立页面（C）
 * 职责：提供「密钥配置 + 翻译实例参数 + 单段测试翻译」最小表单；增加日志级别、缓存开关/占用/清空。
 *       实例参数经 E3 `updateInstance` 写入 storage.sync；测试翻译经 ST_TEST_ENGINE 交给后台；
 *       缓存占用与清空经 ST_CACHE_STATS / ST_CLEAR_CACHE 交给后台。
 * 依赖：E1（protocol）、E2（settings）、E3（instances.writeKey / updateInstance、registry 校验）、E4（日志）、constants.js。
 * 实现阶段：P2（后台网关与页面通道）、P3（日志模块与调试输出）、P5（译文缓存）、P6.2（翻译实例参数配置）
 *
 * 与 P1 的差异：不再直接调用 A3、不再读取密钥明文；hasKey 由 ST_LIST_ENGINES 返回。
 * 设置页不 import 缓存模块、不直接打开缓存数据库；不 import A3 提示词模块，提示词校验用 E3 的规则。
 * 完整实例管理由 P8 落地。
 */

import { useCallback, useEffect, useRef, useState } from 'react';
import { MESSAGE_TYPES } from '../shared/protocol.js';
import { updateInstance, writeKey } from '../shared/config/instances.js';
import {
  DEFAULT_SYSTEM_PROMPT,
  isDefaultPrompt,
  MAX_MODEL_CHARS,
  MAX_PROMPT_CHARS,
  MIN_BATCH_SIZE,
  REASONING_EFFORTS,
  validatePromptTemplate,
} from '../shared/config/registry.js';
import { MAX_SEGMENT_CHARS } from '../shared/constants.js';
import { getSettings, saveSettings } from '../shared/settings.js';
import { LOG_LEVEL_OPTIONS, normalizeLevel } from '../shared/log/levels.js';
import {
  createLogger,
  getLogMeta,
  newTraceId,
  setLogLevel as setLoggerLevel,
} from '../shared/log/logger.js';

/** C1 日志入口。 */
const log = createLogger('C1');

/** 思考强度显示文案。 */
const REASONING_EFFORT_LABELS = Object.freeze({
  off: '关闭',
  low: '低',
  medium: '中',
  high: '高',
  max: '最高',
});

/** 翻译实例参数的保存字段（用于 `settings.save` 日志）。 */
const ENGINE_PARAM_FIELDS = Object.freeze([
  'model',
  'reasoningEffort',
  'batchSize',
  'batchMaxChars',
  'maxConcurrency',
  'systemPrompt',
]);

/**
 * 字节数格式化为可读单位；非数字按 0 处理。
 * @param {unknown} value
 * @returns {string}
 */
function formatBytes(value) {
  const n = Number.isFinite(value) ? Math.max(0, Number(value)) : 0;
  if (n < 1024) return `${n} B`;
  if (n < 1024 ** 2) return `${(n / 1024).toFixed(1)} KB`;
  if (n < 1024 ** 3) return `${(n / 1024 ** 2).toFixed(1)} MB`;
  return `${(n / 1024 ** 3).toFixed(1)} GB`;
}

/**
 * 条数加千分位；非数字按 0 处理。
 * @param {unknown} value
 * @returns {string}
 */
function formatCount(value) {
  const n = Number.isFinite(value) ? Math.max(0, Number(value)) : 0;
  return n.toLocaleString('zh-CN');
}

/**
 * 缓存占用文字；上限未知时只显示已用量。
 * @param {{ entries?: number, bytes?: number, maxBytes?: number } | null} stats
 * @returns {string | null}
 */
function statsText(stats) {
  if (!stats) return null;
  const used = `已用约 ${formatBytes(stats.bytes)}`;
  const limit = Number.isFinite(stats.maxBytes) ? ` / ${formatBytes(stats.maxBytes)}` : '';
  return `${used}${limit} · ${formatCount(stats.entries)} 条`;
}

/**
 * 发一条一次性消息；后台不可用时归一为 NETWORK。
 * @param {string} type
 * @param {object} [payload]
 */
async function sendToBackground(type, payload) {
  try {
    const response = await chrome.runtime.sendMessage({ type, payload });
    return response ?? { ok: false, error: { code: 'OTHER', message: '后台没有返回结果' } };
  } catch {
    return {
      ok: false,
      error: { code: 'NETWORK', message: '无法连接后台，请稍后重试' },
    };
  }
}

export default function Options() {
  const [instance, setInstance] = useState(null);
  const [configured, setConfigured] = useState(false);
  const [loading, setLoading] = useState(true);
  const [loadError, setLoadError] = useState(null);
  const [keyInput, setKeyInput] = useState('');
  const [text, setText] = useState('Hello world');
  const [result, setResult] = useState(null);
  const [busy, setBusy] = useState(false);
  const [saving, setSaving] = useState(false);
  const [logLevel, setLogLevel] = useState('info');
  const [logSaving, setLogSaving] = useState(false);
  const [logNotice, setLogNotice] = useState(null);
  const [logError, setLogError] = useState(null);
  const [cacheEnabled, setCacheEnabled] = useState(true);
  const [cacheStats, setCacheStats] = useState(null);
  const [cacheLoading, setCacheLoading] = useState(true);
  const [cacheSaving, setCacheSaving] = useState(false);
  const [cacheClearing, setCacheClearing] = useState(false);
  const [cacheNotice, setCacheNotice] = useState(null);
  const [cacheError, setCacheError] = useState(null);
  const [modelInput, setModelInput] = useState('');
  const [reasoningEffort, setReasoningEffort] = useState('off');
  const [batchSizeInput, setBatchSizeInput] = useState('8');
  const [batchMaxCharsInput, setBatchMaxCharsInput] = useState('1000');
  const [maxConcurrencyInput, setMaxConcurrencyInput] = useState('4');
  const [systemPrompt, setSystemPrompt] = useState(DEFAULT_SYSTEM_PROMPT);
  const [engineSaving, setEngineSaving] = useState(false);
  const [engineNotice, setEngineNotice] = useState(null);
  const [engineError, setEngineError] = useState(null);
  const [engineFieldErrors, setEngineFieldErrors] = useState({});
  const promptRef = useRef(null);

  /**
   * 用实例里的已保存参数填充表单状态。
   * @param {Record<string, unknown> | null} next
   */
  const applyInstance = useCallback((next) => {
    if (!next) return;
    setModelInput(String(next.model ?? ''));
    setReasoningEffort(String(next.reasoningEffort ?? 'off'));
    setBatchSizeInput(String(next.batchSize ?? 8));
    setBatchMaxCharsInput(String(next.batchMaxChars ?? 1000));
    setMaxConcurrencyInput(String(next.maxConcurrency ?? 4));
    setSystemPrompt(String(next.systemPrompt ?? DEFAULT_SYSTEM_PROMPT));
  }, []);

  useEffect(() => {
    let cancelled = false;
    (async () => {
      try {
        const settings = await getSettings();
        if (cancelled) return;
        const level = normalizeLevel(settings.logLevel);
        setLogLevel(level);
        setCacheEnabled(settings.cacheEnabled !== false);
        setLoggerLevel(level);
        log.info('logger.ready', '日志已启动', getLogMeta());
      } catch {
        if (!cancelled) log.warn('settings.read', '读取设置失败，使用默认日志级别');
      }
    })();
    return () => {
      cancelled = true;
    };
  }, []);

  /** 读取缓存占用；打开设置页、窗口重新获得焦点与清空成功后调用，不做轮询。 */
  const refreshCacheStats = useCallback(async () => {
    const response = await sendToBackground(MESSAGE_TYPES.CACHE_STATS);
    if (response.ok && response.data) {
      setCacheStats({
        entries: response.data.entries,
        bytes: response.data.bytes,
        maxBytes: response.data.maxBytes,
        maxEntries: response.data.maxEntries,
      });
      setCacheError((current) => (current === '占用信息暂不可用' ? null : current));
    } else {
      setCacheError('占用信息暂不可用');
    }
    setCacheLoading(false);
  }, []);

  useEffect(() => {
    void refreshCacheStats();
    const onFocus = () => {
      void refreshCacheStats();
    };
    window.addEventListener('focus', onFocus);
    return () => {
      window.removeEventListener('focus', onFocus);
    };
  }, [refreshCacheStats]);

  useEffect(() => {
    let cancelled = false;
    (async () => {
      const response = await sendToBackground(MESSAGE_TYPES.LIST_ENGINES);
      if (cancelled) return;
      if (response.ok) {
        const first = response.data?.instances?.[0] ?? null;
        setInstance(first);
        applyInstance(first);
        setConfigured(Boolean(first?.hasKey));
        setLoadError(first ? null : '没有可用的引擎实例，请稍后重试');
      } else {
        setLoadError(response.error?.message ?? '无法读取引擎配置');
      }
      setLoading(false);
    })();
    return () => {
      cancelled = true;
    };
  }, [applyInstance]);

  async function onChangeLogLevel(event) {
    const next = normalizeLevel(event.target.value);
    setLogSaving(true);
    setLogNotice(null);
    setLogError(null);
    try {
      await saveSettings({ logLevel: next });
      setLogLevel(next);
      setLoggerLevel(next);
      log.info('settings.save', '日志级别已保存', { level: next });
      setLogNotice('已保存；已打开的网页刷新或重连后生效。');
    } catch {
      setLogError('保存日志级别失败，请重试');
    } finally {
      setLogSaving(false);
    }
  }

  async function onChangeCacheEnabled(event) {
    const next = event.target.checked === true;
    setCacheSaving(true);
    setCacheNotice(null);
    setCacheError(null);
    try {
      await saveSettings({ cacheEnabled: next });
      setCacheEnabled(next);
      setCacheNotice('已保存；下一次翻译即生效。');
      log.info('settings.save', '缓存开关已保存', { cacheEnabled: next });
    } catch {
      setCacheError('保存缓存开关失败，请重试');
    } finally {
      setCacheSaving(false);
    }
  }

  async function onClearCache() {
    setCacheClearing(true);
    setCacheNotice(null);
    setCacheError(null);
    try {
      const response = await sendToBackground(MESSAGE_TYPES.CLEAR_CACHE);
      if (!response.ok) {
        setCacheError(response.error?.message ?? '清空缓存失败，请重试');
        return;
      }
      const cleared = Number(response.data?.cleared) || 0;
      setCacheStats((current) => ({
        entries: 0,
        bytes: 0,
        maxBytes: current?.maxBytes,
        maxEntries: current?.maxEntries,
      }));
      setCacheNotice(cleared > 0 ? `已清空 ${formatCount(cleared)} 条缓存` : '缓存已经是空的');
      log.info('settings.save', '已清空译文缓存', { cleared });
    } catch {
      setCacheError('清空缓存失败，请重试');
    } finally {
      setCacheClearing(false);
    }
  }

  async function onSaveKey() {
    const key = keyInput.trim();
    if (!instance || !key) return;
    setSaving(true);
    try {
      await writeKey(instance.id, key);
      setKeyInput('');
      setConfigured(true);
      setLoadError(null);
    } catch {
      setResult({ status: 'error', message: '保存密钥失败，请重试' });
    } finally {
      setSaving(false);
    }
  }

  /**
   * 在提示词光标处插入占位符；插入后把光标放到占位符之后。
   * @param {string} token
   */
  function insertPromptToken(token) {
    const element = promptRef.current;
    const start = Number.isInteger(element?.selectionStart) ? element.selectionStart : systemPrompt.length;
    const end = Number.isInteger(element?.selectionEnd) ? element.selectionEnd : start;
    setSystemPrompt(`${systemPrompt.slice(0, start)}${token}${systemPrompt.slice(end)}`);
    setEngineFieldErrors((current) => ({ ...current, systemPrompt: undefined }));

    const placeCursor = () => {
      const target = promptRef.current;
      if (!target) return;
      target.focus();
      try {
        target.setSelectionRange(start + token.length, start + token.length);
      } catch {
        // 控件不可选中时忽略。
      }
    };
    if (typeof requestAnimationFrame === 'function') requestAnimationFrame(placeCursor);
    else setTimeout(placeCursor, 0);
  }

  /** 恢复默认提示词只改文本框，仍需点击「保存参数」才写入。 */
  function onRestoreDefaultPrompt() {
    setSystemPrompt(DEFAULT_SYSTEM_PROMPT);
    setEngineFieldErrors((current) => ({ ...current, systemPrompt: undefined }));
  }

  /** 保存前在本地校验六个字段；不合法时不发请求，只显示字段错误。 */
  async function onSaveEngineParams() {
    if (!instance) return;

    const errors = {};
    const model = modelInput.trim();
    if (model === '') errors.model = '请填写模型名称';
    else if (model.length > MAX_MODEL_CHARS) {
      errors.model = `模型名称不能超过 ${MAX_MODEL_CHARS} 字符`;
    }

    const batchSize = Number(batchSizeInput);
    if (!Number.isInteger(batchSize) || batchSize < MIN_BATCH_SIZE) {
      errors.batchSize = '单批段数必须是正整数';
    }

    const batchMaxChars = Number(batchMaxCharsInput);
    if (!Number.isInteger(batchMaxChars) || batchMaxChars < 1) {
      errors.batchMaxChars = '批次最大字符数必须是正整数';
    }

    const maxConcurrency = Number(maxConcurrencyInput);
    if (!Number.isInteger(maxConcurrency) || maxConcurrency < 1) {
      errors.maxConcurrency = '最大并发数必须是正整数';
    }

    const promptCheck = validatePromptTemplate(systemPrompt);
    if (!promptCheck.ok) {
      errors.systemPrompt = promptCheck.error;
      log.warn('prompt.error', '提示词校验失败', { reason: promptCheck.error });
    }

    setEngineFieldErrors(errors);
    setEngineNotice(null);
    setEngineError(null);
    if (Object.keys(errors).length > 0) return;

    const prompt = systemPrompt.trim();
    setEngineSaving(true);
    try {
      const next = await updateInstance(instance.id, {
        model,
        reasoningEffort,
        batchSize,
        batchMaxChars,
        maxConcurrency,
        systemPrompt: prompt,
      });
      setInstance(next);
      applyInstance(next);
      setEngineNotice('已保存；下一次测试翻译或整页翻译生效');
      log.info('settings.save', '翻译实例参数已保存', {
        fields: ENGINE_PARAM_FIELDS,
        model: next.model,
        reasoningEffort: next.reasoningEffort,
        batchSize: next.batchSize,
        batchMaxChars: next.batchMaxChars,
        maxConcurrency: next.maxConcurrency,
        systemPromptLength: next.systemPrompt.length,
        promptDefault: isDefaultPrompt(next.systemPrompt),
      });
    } catch (error) {
      setEngineError('保存翻译实例参数失败，请重试');
      log.warn('settings.save', '翻译实例参数保存失败', {
        reason: error?.message ? String(error.message).slice(0, 120) : 'Error',
      });
    } finally {
      setEngineSaving(false);
    }
  }

  async function onTest() {
    const t = text.trim();
    if (!t) {
      setResult({ status: 'error', message: '请输入待翻译文本' });
      return;
    }
    if (t.length > MAX_SEGMENT_CHARS) {
      setResult({ status: 'error', message: `文本超过 ${MAX_SEGMENT_CHARS} 字符上限` });
      return;
    }
    if (!instance) return;

    const traceId = newTraceId();
    const testLog = log.withTrace(traceId);
    const startedAt = Date.now();

    setBusy(true);
    setResult(null);
    testLog.info('engine.test.start', '开始测试翻译', { textLength: t.length });
    const response = await sendToBackground(MESSAGE_TYPES.TEST_ENGINE, { text: t, traceId });
    const elapsedMs = Date.now() - startedAt;
    if (response.ok) {
      setResult({
        status: 'success',
        text: response.data?.text ?? '',
        elapsedMs: response.data?.elapsedMs ?? elapsedMs,
        usage: response.data?.usage ?? null,
      });
      testLog.info('engine.test.done', '测试翻译完成', {
        ok: true,
        elapsedMs,
        totalTokens: response.data?.usage?.totalTokens ?? null,
      });
    } else {
      setResult({
        status: 'error',
        code: response.error?.code,
        message: response.error?.message ?? '翻译失败',
      });
      testLog.warn('engine.test.done', '测试翻译失败', {
        ok: false,
        code: response.error?.code,
        ...(response.error?.reason ? { reason: response.error.reason } : {}),
        elapsedMs,
      });
    }
    setBusy(false);
  }

  return (
    <main className="max-w-xl mx-auto my-10 px-4 space-y-6">
      <header>
        <h1 className="text-2xl font-bold mb-1">SimpleTrans 设置</h1>
        <p className="text-sm text-base-content/70">
          测试翻译经后台执行；完整设置页待接入（P8）。
        </p>
      </header>

      {loading && <p className="text-sm text-base-content/70">正在读取引擎配置…</p>}

      {loadError && (
        <div className="rounded-box bg-error/10 text-error p-3 text-sm">{loadError}</div>
      )}

      <section className="space-y-2">
        <h2 className="text-base font-semibold">
          DeepSeek 密钥
          {instance?.name ? <span className="text-base-content/60"> · {instance.name}</span> : null}
        </h2>
        <div className="flex gap-2 items-center">
          <input
            type="password"
            value={keyInput}
            onChange={(e) => setKeyInput(e.target.value)}
            placeholder="sk-..."
            className="input input-bordered flex-1"
            autoComplete="off"
            disabled={!instance || saving}
          />
          <button
            className="btn btn-primary"
            onClick={onSaveKey}
            disabled={saving || !instance || !keyInput.trim()}
          >
            保存密钥
          </button>
        </div>
        <p className="text-sm">
          状态：
          {configured ? (
            <span className="text-success font-medium">已配置</span>
          ) : (
            <span className="text-warning font-medium">未配置</span>
          )}
        </p>
      </section>

      <section className="space-y-3">
        <h2 className="text-base font-semibold">翻译实例（大模型翻译）</h2>
        <p className="text-sm text-base-content/70">
          模型、思考强度、批次与提示词保存在当前实例；保存后下一次测试翻译或整页翻译生效。
        </p>

        <label className="flex flex-col gap-1 text-sm">
          <span>模型名称</span>
          <input
            type="text"
            className="input input-bordered w-full"
            value={modelInput}
            onChange={(e) => setModelInput(e.target.value)}
            placeholder="deepseek-chat"
            autoComplete="off"
            disabled={!instance || engineSaving}
          />
          <span className="text-xs text-base-content/60">
            自由输入，不做模型白名单；是否支持思考模式由上游决定。
          </span>
          {engineFieldErrors.model && (
            <span className="text-sm text-error">{engineFieldErrors.model}</span>
          )}
        </label>

        <label className="flex flex-col gap-1 text-sm">
          <span>思考强度</span>
          <select
            className="select select-bordered w-full"
            value={reasoningEffort}
            onChange={(e) => setReasoningEffort(e.target.value)}
            disabled={!instance || engineSaving}
          >
            {REASONING_EFFORTS.map((effort) => (
              <option key={effort} value={effort}>
                {REASONING_EFFORT_LABELS[effort] ?? effort}
              </option>
            ))}
          </select>
          <span className="text-xs text-base-content/60">
            关闭时不开启思考模式，速度与成本最低；其余档位开启思考并传递对应强度。
          </span>
        </label>

        <div className="grid gap-3 sm:grid-cols-3">
          <label className="flex flex-col gap-1 text-sm">
            <span>单批段数</span>
            <input
              type="number"
              className="input input-bordered w-full"
              value={batchSizeInput}
              onChange={(e) => setBatchSizeInput(e.target.value)}
              min={MIN_BATCH_SIZE}
              step={1}
              disabled={!instance || engineSaving}
            />
            <span className="text-xs text-base-content/60">
              每批最多多少段；与批次最大字符数同时生效，先到先切；不设业务上限。
            </span>
            {engineFieldErrors.batchSize && (
              <span className="text-sm text-error">{engineFieldErrors.batchSize}</span>
            )}
          </label>

          <label className="flex flex-col gap-1 text-sm">
            <span>批次最大字符数</span>
            <input
              type="number"
              className="input input-bordered w-full"
              value={batchMaxCharsInput}
              onChange={(e) => setBatchMaxCharsInput(e.target.value)}
              min={1}
              step={1}
              disabled={!instance || engineSaving}
            />
            <span className="text-xs text-base-content/60">
              按原文累计字符切批，不拆分单段；不设固定上限。
            </span>
            {engineFieldErrors.batchMaxChars && (
              <span className="text-sm text-error">{engineFieldErrors.batchMaxChars}</span>
            )}
          </label>

          <label className="flex flex-col gap-1 text-sm">
            <span>最大并发数</span>
            <input
              type="number"
              className="input input-bordered w-full"
              value={maxConcurrencyInput}
              onChange={(e) => setMaxConcurrencyInput(e.target.value)}
              min={1}
              step={1}
              disabled={!instance || engineSaving}
            />
            <span className="text-xs text-base-content/60">
              同时在途的批次数；不设固定上限，设置过高可能触发上游限流。
            </span>
            {engineFieldErrors.maxConcurrency && (
              <span className="text-sm text-error">{engineFieldErrors.maxConcurrency}</span>
            )}
          </label>
        </div>

        <div className="flex flex-col gap-2 text-sm">
          <span>翻译 system 提示词</span>
          <textarea
            ref={promptRef}
            value={systemPrompt}
            onChange={(e) => {
              setSystemPrompt(e.target.value);
              setEngineFieldErrors((current) => ({ ...current, systemPrompt: undefined }));
            }}
            rows={10}
            className="textarea textarea-bordered w-full font-mono text-xs"
            spellCheck={false}
            disabled={!instance || engineSaving}
          />
          <div className="flex flex-wrap gap-2">
            <button
              type="button"
              className="btn btn-xs btn-outline"
              onClick={() => insertPromptToken('{{targetLang}}')}
              disabled={!instance || engineSaving}
            >
              插入目标语言
            </button>
            <button
              type="button"
              className="btn btn-xs btn-outline"
              onClick={() => insertPromptToken('{{outputFormat}}')}
              disabled={!instance || engineSaving}
            >
              插入输出格式
            </button>
            <button
              type="button"
              className="btn btn-xs btn-outline"
              onClick={onRestoreDefaultPrompt}
              disabled={!instance || engineSaving}
            >
              恢复默认提示词
            </button>
          </div>
          <div className="flex flex-wrap items-center justify-between gap-2 text-xs text-base-content/60">
            <span>{'{{targetLang}}'} 与 {'{{outputFormat}}'} 必须保留，且不能出现其它 {'{{...}}'} 占位符。</span>
            <span>
              {systemPrompt.length} / {MAX_PROMPT_CHARS}
            </span>
          </div>
          <p className="text-xs text-base-content/60">
            {'{{targetLang}}'} 会替换为「中文」等目标语言显示名；{'{{outputFormat}}'} 由程序按单段/批量替换为对应输出规则。
            默认模板包含防注入与逐段独立翻译要求，删除后防注入能力由用户自行负责。
          </p>
          {engineFieldErrors.systemPrompt && (
            <span className="text-sm text-error">{engineFieldErrors.systemPrompt}</span>
          )}
        </div>

        <div className="flex flex-wrap items-center gap-3">
          <button
            className="btn btn-primary"
            onClick={onSaveEngineParams}
            disabled={engineSaving || !instance}
          >
            {engineSaving ? '保存中…' : '保存参数'}
          </button>
          <span className="text-sm text-base-content/60">
            保存只更新当前实例的这些字段，不改密钥与地址。
          </span>
        </div>
        {engineNotice && <p className="text-sm text-success">{engineNotice}</p>}
        {engineError && <p className="text-sm text-error">{engineError}</p>}
      </section>

      <section className="space-y-2">
        <h2 className="text-base font-semibold">测试翻译</h2>
        <p className="text-sm text-base-content/70">
          先保存参数，再测试翻译；测试翻译使用已保存的模型、思考强度与提示词。
        </p>
        <textarea
          value={text}
          onChange={(e) => setText(e.target.value)}
          rows={2}
          className="textarea textarea-bordered w-full"
          placeholder="输入一句英文…"
        />
        <button className="btn btn-primary" onClick={onTest} disabled={busy || !instance}>
          {busy ? '翻译中…' : '测试翻译'}
        </button>
      </section>

      {result && (
        <section className="space-y-1 text-sm">
          {result.status === 'success' && (
            <div className="rounded-box bg-base-200 p-3">
              <p className="whitespace-pre-wrap">{result.text}</p>
              <p className="text-base-content/60 mt-2">
                耗时 {result.elapsedMs} ms
                {result.usage?.totalTokens != null ? ` · ${result.usage.totalTokens} tokens` : ''}
              </p>
            </div>
          )}
          {result.status === 'error' && (
            <div className="rounded-box bg-error/10 text-error p-3">
              {result.message}
              {result.code && <span className="text-base-content/50">（{result.code}）</span>}
            </div>
          )}
        </section>
      )}

      <section className="space-y-2">
        <h2 className="text-base font-semibold">译文缓存</h2>
        <label className="flex items-center gap-2 text-sm">
          <input
            type="checkbox"
            className="checkbox checkbox-sm"
            checked={cacheEnabled}
            onChange={onChangeCacheEnabled}
            disabled={cacheSaving}
          />
          <span>启用译文缓存</span>
        </label>
        <p className="text-sm text-base-content/70">
          缓存只保存在本机 IndexedDB、跨标签页共享；关闭后不再读写缓存，已有缓存不会自动删除；
          清空只影响译文缓存，不影响密钥与设置。
        </p>
        <p className="text-sm">
          {cacheLoading
            ? '正在读取缓存占用…'
            : statsText(cacheStats) ?? '占用信息暂不可用'}
        </p>
        <button className="btn btn-outline" onClick={onClearCache} disabled={cacheClearing}>
          {cacheClearing ? '清空中…' : '清空缓存'}
        </button>
        {cacheNotice && <p className="text-sm text-success">{cacheNotice}</p>}
        {cacheError && <p className="text-sm text-error">{cacheError}</p>}
      </section>

      <section className="space-y-2">
        <h2 className="text-base font-semibold">日志</h2>
        <label className="flex flex-col gap-1 text-sm">
          <span>日志级别</span>
          <select
            className="select select-bordered w-full"
            value={logLevel}
            onChange={onChangeLogLevel}
            disabled={logSaving}
          >
            {LOG_LEVEL_OPTIONS.map((option) => (
              <option key={option.value} value={option.value}>
                {option.label}
              </option>
            ))}
          </select>
        </label>
        <p className="text-sm text-base-content/70">
          日志只输出到浏览器控制台，不保存、不上传；调整后已打开的网页需刷新或重连才生效。
        </p>
        {logNotice && <p className="text-sm text-success">{logNotice}</p>}
        {logError && <p className="text-sm text-error">{logError}</p>}
      </section>
    </main>
  );
}
