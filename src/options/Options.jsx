/**
 * C1–C5 设置页（P2 最小测试表单，经后台执行；P3 增加日志级别）
 *
 * 模块：插件独立页面（C）
 * 职责：P2 提供「密钥配置 + 单段测试翻译」最小表单；P3 增加日志级别设置；
 *       测试翻译经 ST_TEST_ENGINE 交给后台。
 * 依赖：E1（protocol）、E2（settings）、E3（instances.writeKey）、E4（日志）、constants.js。
 * 实现阶段：P2（后台网关与页面通道）、P3（日志模块与调试输出）
 *
 * 与 P1 的差异：不再直接调用 A3、不再读取密钥明文；hasKey 由 ST_LIST_ENGINES 返回。
 * 完整设置页由 P8 落地。
 */

import { useEffect, useState } from 'react';
import { MESSAGE_TYPES } from '../shared/protocol.js';
import { writeKey } from '../shared/config/instances.js';
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

  useEffect(() => {
    let cancelled = false;
    (async () => {
      try {
        const settings = await getSettings();
        if (cancelled) return;
        const level = normalizeLevel(settings.logLevel);
        setLogLevel(level);
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

  useEffect(() => {
    let cancelled = false;
    (async () => {
      const response = await sendToBackground(MESSAGE_TYPES.LIST_ENGINES);
      if (cancelled) return;
      if (response.ok) {
        const first = response.data?.instances?.[0] ?? null;
        setInstance(first);
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
  }, []);

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

      <section className="space-y-2">
        <h2 className="text-base font-semibold">测试翻译</h2>
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
