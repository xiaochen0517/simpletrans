/**
 * C1–C5 设置页（P1 最小测试表单）
 *
 * 模块：插件独立页面（C）
 * 职责：P1 只提供「密钥配置 + 单段测试翻译」最小表单；完整设置页由 P7 落地。
 * 依赖：E2（settings）、E3（instances）、A3（adapter，P1 临时直连，P2 移除）。
 * 实现阶段：P1（引擎层与密钥配置）
 *
 * P1 为做演示测试，设置页临时直接调用 A3 适配器（需求文档 P1-5 已确认的临时偏离）；
 * P2 改为经后台执行后，移除本页对 A3 与 `@ai-sdk/deepseek` 的依赖。
 */

import { useEffect, useState } from 'react';
import { getSettings } from '../shared/settings.js';
import { getOrCreateDefaultInstance, getKey, hasKey, writeKey } from '../shared/config/instances.js';
import { translate, TranslateError } from '../shared/translate/adapter.js';
import { MAX_SEGMENT_CHARS } from '../shared/constants.js';

export default function Options() {
  const [instance, setInstance] = useState(null);
  const [configured, setConfigured] = useState(false);
  const [keyInput, setKeyInput] = useState('');
  const [text, setText] = useState('Hello world');
  const [result, setResult] = useState(null);
  const [busy, setBusy] = useState(false);
  const [saving, setSaving] = useState(false);

  useEffect(() => {
    let cancelled = false;
    (async () => {
      const inst = await getOrCreateDefaultInstance();
      if (cancelled) return;
      setInstance(inst);
      setConfigured(await hasKey(inst.id));
    })();
    return () => {
      cancelled = true;
    };
  }, []);

  async function onSaveKey() {
    const key = keyInput.trim();
    if (!instance || !key) return;
    setSaving(true);
    try {
      await writeKey(instance.id, key);
      setKeyInput('');
      setConfigured(true);
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

    setBusy(true);
    setResult(null);
    const started = performance.now();
    try {
      const key = await getKey(instance.id);
      if (!key) {
        setResult({ status: 'error', code: 'CONFIG', message: '缺少密钥，请先保存密钥' });
        return;
      }
      const settings = await getSettings();
      const r = await translate({
        text: t,
        targetLang: settings.targetLang,
        instance: { ...instance, apiKey: key },
      });
      setResult({
        status: 'success',
        text: r.text,
        elapsedMs: Math.round(performance.now() - started),
        usage: r.usage,
      });
    } catch (error) {
      if (error instanceof TranslateError) {
        setResult({ status: 'error', code: error.code, message: error.message });
      } else {
        setResult({ status: 'error', code: 'OTHER', message: error?.message ?? '未知错误' });
      }
    } finally {
      setBusy(false);
    }
  }

  return (
    <main className="max-w-xl mx-auto my-10 px-4 space-y-6">
      <header>
        <h1 className="text-2xl font-bold mb-1">SimpleTrans 设置</h1>
        <p className="text-sm text-base-content/70">P1 最小测试表单，完整设置页待接入（P7）。</p>
      </header>

      <section className="space-y-2">
        <h2 className="text-base font-semibold">DeepSeek 密钥</h2>
        <div className="flex gap-2 items-center">
          <input
            type="password"
            value={keyInput}
            onChange={(e) => setKeyInput(e.target.value)}
            placeholder="sk-..."
            className="input input-bordered flex-1"
            autoComplete="off"
          />
          <button className="btn btn-primary" onClick={onSaveKey} disabled={saving || !keyInput.trim()}>
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
            <div className="rounded-box bg-error/10 text-error p-3">{result.message}</div>
          )}
        </section>
      )}
    </main>
  );
}
