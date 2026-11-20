/**
 * C 测试翻译
 *
 * 模块：插件独立页面（C）/ 设置页分区
 * 职责：选择任一已保存实例试翻一段文本（上限 4000 字符），显示译文、实例信息、耗时与用量/字符数；
 *       失败显示统一错误码与下一步建议；结果只保留本次会话最后一次，不写存储。
 * 依赖：React、`lucide-react`、E1（protocol 的 `ST_TEST_ENGINE`）、E4（traceId）、
 *       设置页共享工具与状态徽标组件。
 * 实现阶段：P8-3（设置页内容分类与 UI 规范化）
 *
 * 草稿不参与测试：测试只使用已保存的实例参数与凭据；不读取密钥明文。
 */

import { useMemo, useState } from 'react';
import { ClipboardCopy, FlaskConical, RotateCcw, ShieldAlert } from 'lucide-react';
import StatusBadge from '../../shared/ui/status-badge.jsx';
import Select from '../../shared/ui/select.jsx';
import { buttonClass } from '../../shared/ui/button.jsx';
import {
  credentialState,
  formatCount,
  permissionState,
  requestOriginPermission,
  sendToBackground,
  testInstanceEligibility,
  typeBadgeLabel,
  useApp,
  TEST_TEXT_MAX_CHARS,
} from '../lib.js';
import { MESSAGE_TYPES } from '../../shared/protocol.js';
import { languageLabel } from '../../shared/languages.js';
import { newTraceId } from '../../shared/log/logger.js';

/**
 * 错误码对应的下一步建议。
 * @param {string | undefined} code
 * @param {string} message
 * @returns {string}
 */
function nextStep(code, message) {
  if (code === 'AUTH') return '请检查该实例的 API Key / APPID 与密钥是否正确，再重新测试。';
  if (code === 'RATE_LIMIT') return '上游限流，请稍后重试或降低并发数。';
  if (code === 'NETWORK') return '请检查网络与该接口地址是否可访问，然后重试。';
  if (code === 'CONFIG') {
    if (String(message).includes('未授权')) return '请先授权该实例的接口域名，再重新测试。';
    if (String(message).includes('密钥')) return '请在「翻译实例」里为该实例配置凭据后重试。';
    if (String(message).includes('参数')) return '请关闭模型不支持的参数后重试。';
    return '请检查实例的连接、认证与模型配置，或换一个实例重试。';
  }
  return '请检查密钥、域名授权与参数，或换一个实例重试。';
}

/** 捕获的生成参数摘要；只显示已启用的项。 */
function paramsSummary(instance) {
  if (!instance || instance.type !== 'openai') return '';
  const params = instance.params ?? {};
  const parts = [];
  if (params.temperature?.enabled) parts.push(`temperature ${params.temperature.value}`);
  if (params.topP?.enabled) parts.push(`top_p ${params.topP.value}`);
  if (params.maxTokens?.enabled) {
    parts.push(`${params.maxTokens.field} ${params.maxTokens.value}`);
  }
  const reasoning = params.reasoning;
  if (reasoning?.mode === 'effort' && reasoning.value && reasoning.value !== 'off') {
    parts.push(`思考强度 ${reasoning.value}`);
  }
  if (reasoning?.mode === 'budget') parts.push(`思考预算 ${reasoning.budget}`);
  if (reasoning?.mode === 'toggle') parts.push('思考开关开启');
  return parts.length > 0 ? ` · ${parts.join(' · ')}` : '';
}

export default function TestTranslation() {
  const app = useApp();
  const { instances, settings, testState } = app;
  const activeId = settings?.activeInstanceId ?? null;
  const storedId = testState?.instanceId ?? null;
  const initialId = useMemo(() => {
    if (storedId && instances.some((instance) => instance.id === storedId)) return storedId;
    if (activeId && instances.some((instance) => instance.id === activeId)) return activeId;
    return instances.find((instance) => instance.kind !== 'unsupported')?.id ?? '';
  }, [activeId, instances, storedId]);

  const selectedId = initialId;
  const selected = instances.find((instance) => instance.id === selectedId) ?? null;
  const text = testState?.text ?? 'Hello world';
  const result = testState?.result ?? null;
  const busy = testState?.busy === true;
  const tooLong = text.length > TEST_TEXT_MAX_CHARS;
  const permission = permissionState(selected);
  const [authorizing, setAuthorizing] = useState(false);

  /** 更新输入文本（存到壳层，切换分区不丢）。 */
  function setText(value) {
    app.updateTestState({ text: value });
  }

  /** 执行一次测试翻译；执行中离开分区也不丢结果（状态在壳层）。 */
  async function runTest() {
    if (busy) return;
    const source = text.trim();
    if (source === '') {
      app.updateTestState({ result: { status: 'error', message: '请先输入待翻译文本', code: undefined } });
      return;
    }
    if (text.length > TEST_TEXT_MAX_CHARS) {
      app.updateTestState({
        result: {
          status: 'error',
          message: `文本超过 ${TEST_TEXT_MAX_CHARS} 字符上限`,
          code: undefined,
        },
      });
      return;
    }
    if (!selected) {
      app.updateTestState({ result: { status: 'error', message: '请选择一个翻译实例', code: undefined } });
      return;
    }

    app.updateTestState({ busy: true, result: null });
    const traceId = newTraceId();
    const response = await sendToBackground(MESSAGE_TYPES.TEST_ENGINE, {
      text: source,
      instanceId: selected.id,
      traceId,
    });

    if (response.ok) {
      const data = response.data ?? {};
      app.updateTestState({
        busy: false,
        result: {
          status: 'success',
          text: data.text ?? '',
          elapsedMs: data.elapsedMs ?? 0,
          usage: data.usage ?? null,
          chars: data.chars ?? source.length,
          engine: data.engine ?? null,
        },
      });
      app.recordAction(`测试翻译「${selected.name}」成功`);
    } else {
      app.updateTestState({
        busy: false,
        result: {
          status: 'error',
          message: response.error?.message ?? '测试翻译失败',
          code: response.error?.code,
        },
      });
      app.recordAction(`测试翻译「${selected.name}」失败`);
    }
  }

  /** 授权当前 endpoint 域名。 */
  async function authorize() {
    setAuthorizing(true);
    const outcome = await requestOriginPermission(selected?.endpoint?.baseUrl);
    setAuthorizing(false);
    if (outcome.ok) {
      await app.refreshInstances();
      app.notify('ok', '已获得接口域名授权');
    } else {
      app.notify('error', outcome.message ?? '未获得域名授权');
    }
  }

  /** 复制译文；剪贴板不可用时提示手动选择。 */
  async function copyResult() {
    if (!result?.text) return;
    try {
      if (navigator.clipboard?.writeText) {
        await navigator.clipboard.writeText(result.text);
        app.notify('ok', '已复制译文');
        return;
      }
    } catch {
      // 忽略，进入手动提示。
    }
    app.notify('error', '复制失败，请手动选择译文');
  }

  if (instances.length === 0) {
    return (
      <div className="flex flex-col gap-4">
        <div className="flex flex-wrap items-center gap-2 rounded-lg border border-amber-500 bg-amber-50 p-3 text-sm text-amber-800 dark:border-amber-700 dark:bg-amber-950/40 dark:text-amber-200">
          <FlaskConical size={16} aria-hidden="true" />
          <span className="min-w-0 break-words">还没有翻译实例，先到「翻译实例」新增一个再测试。</span>
          <span className="ml-auto shrink-0">
            <button type="button" className={buttonClass({ variant: 'primary', size: 'xs' })} onClick={() => app.openCreate(null)}>
              新增翻译实例
            </button>
          </span>
        </div>
      </div>
    );
  }

  const credential = credentialState(selected);
  const eligibility = testInstanceEligibility(selected);

  return (
    <div className="flex flex-col gap-4">
      <div className="flex flex-wrap items-start justify-between gap-3">
        <div>
          <h2 className="flex items-center gap-2 text-base font-bold">
            <FlaskConical size={15} aria-hidden="true" />
            测试翻译
          </h2>
          <p className="text-sm leading-relaxed text-gray-600 dark:text-gray-300 break-words">使用已保存的实例参数与密钥；修改配置后请先保存再测试。</p>
        </div>
      </div>

      <section className="flex flex-col gap-2 rounded-lg border border-gray-200 bg-white shadow-sm dark:border-gray-700 dark:bg-gray-900 p-4" aria-label="测试输入">
        <div className="flex flex-col gap-1">
          <span className="text-xs font-semibold">翻译实例</span>
          <Select
            value={selectedId}
            options={instances.map((instance) => {
              const state = credentialState(instance);
              const permissionText =
                instance.type === 'openai' && instance.permission !== 'granted' ? ' · 未授权' : '';
              const unsupportedText = instance.kind === 'unsupported' ? ' · 类型不支持' : '';
              return {
                value: instance.id,
                label: instance.name,
                detail: `${typeBadgeLabel(instance)} · ${instance.type === 'baidu' ? '通用文本翻译' : instance.model ?? '模型'} · ${state.label}${permissionText}${unsupportedText}`,
                disabled: instance.kind === 'unsupported',
              };
            })}
            onChange={(next) => app.setTestInstanceId(next)}
            ariaLabel="翻译实例"
            disabled={busy}
          />
        </div>

        <div className="flex flex-wrap items-center gap-2">
          <span className="text-xs leading-relaxed text-gray-500 dark:text-gray-400 break-words">
            语言：{languageLabel(settings?.sourceLang) || '未知'} → {languageLabel(settings?.targetLang) || '未知'}
          </span>
          <button type="button" className={buttonClass({ size: 'xs' })} onClick={() => app.navigate('#/general')}>
            去修改
          </button>
          {selected ? (
            <>
              <StatusBadge tone={credential.key === 'ok' || credential.key === 'none' ? 'ok' : 'warn'}>
                {credential.label}
              </StatusBadge>
              {permission ? <StatusBadge tone={permission.key === 'ok' ? 'ok' : 'warn'}>{permission.label}</StatusBadge> : null}
            </>
          ) : null}
        </div>

        {!eligibility.ok && selected?.kind !== 'unsupported' ? (
          <div className="flex flex-wrap items-center gap-2 rounded-lg border border-amber-500 bg-amber-50 p-3 text-sm text-amber-800 dark:border-amber-700 dark:bg-amber-950/40 dark:text-amber-200">
            <ShieldAlert size={15} aria-hidden="true" />
            <span className="min-w-0 break-words">{eligibility.reason}</span>
            {selected?.type === 'openai' && selected.permission !== 'granted' ? (
              <span className="ml-auto shrink-0">
                <button
                  type="button"
                  className={buttonClass({ variant: 'warning', size: 'xs' })}
                  onClick={authorize}
                  disabled={authorizing}
                >
                  {authorizing ? '申请中…' : '去授权'}
                </button>
              </span>
            ) : null}
          </div>
        ) : null}

        <label className="flex flex-col gap-1">
          <span className="text-xs font-semibold">待翻译文本</span>
          <textarea
            className="w-full rounded-lg border border-gray-300 bg-white px-3 py-2 text-sm text-gray-900 shadow-sm placeholder:text-gray-400 focus:border-indigo-500 focus:ring-2 focus:ring-indigo-200 focus:outline-none disabled:cursor-not-allowed disabled:opacity-60 dark:border-gray-700 dark:bg-gray-900 dark:text-white dark:placeholder:text-gray-500 dark:focus:border-indigo-400 dark:focus:ring-indigo-900"
            rows={4}
            value={text}
            onChange={(event) => setText(event.target.value)}
            disabled={busy}
            aria-describedby="test-text-count"
          />
        </label>
        <div className="flex flex-wrap items-center justify-between gap-2">
          <span className="text-xs leading-relaxed text-gray-500 dark:text-gray-400 break-words" id="test-text-count">
            {text.length} / {TEST_TEXT_MAX_CHARS} 字符
          </span>
          <span className="text-xs leading-relaxed text-gray-500 dark:text-gray-400 break-words">测试只使用已保存的实例；未保存的草稿不参与。</span>
        </div>
        {tooLong ? <span className="text-xs leading-relaxed text-red-600 dark:text-red-400" role="alert">文本超过 {TEST_TEXT_MAX_CHARS} 字符上限，请缩短后重试。</span> : null}

        <div className="flex flex-wrap items-center gap-2">
          <button
            type="button"
            className={buttonClass({ variant: 'primary' })}
            onClick={runTest}
            disabled={busy || tooLong || !selected}
          >
            <FlaskConical size={14} aria-hidden="true" />
            {busy ? '翻译中…' : '测试翻译'}
          </button>
          <button
            type="button"
            className={buttonClass({ size: 'sm' })}
            onClick={() => {
              setText('');
              app.updateTestState({ result: null });
            }}
            disabled={busy}
          >
            <RotateCcw size={14} aria-hidden="true" />
            清空
          </button>
        </div>
      </section>

      <section className="flex flex-col gap-3" aria-live="polite" aria-label="测试结果">
        <h2 className="flex items-center gap-2 text-base font-bold">结果</h2>
        {busy ? (
          <div className="flex flex-col gap-2 rounded-lg border border-gray-200 bg-white shadow-sm dark:border-gray-700 dark:bg-gray-900 p-4" aria-busy="true">
            <div className="grid gap-2.5" aria-label="正在测试翻译">
              <span className="h-3 w-[35%] block animate-pulse rounded bg-gray-200 dark:bg-gray-800" />
              <span className="h-3 w-[85%] block animate-pulse rounded bg-gray-200 dark:bg-gray-800" />
              <span className="h-3 w-[60%] block animate-pulse rounded bg-gray-200 dark:bg-gray-800" />
            </div>
          </div>
        ) : !result ? (
          <p className="text-sm leading-relaxed text-gray-600 dark:text-gray-300 break-words">选择实例并输入文本后测试。</p>
        ) : result.status === 'success' ? (
          <div className="flex flex-col gap-2 rounded-lg border border-gray-200 bg-white shadow-sm dark:border-gray-700 dark:bg-gray-900 p-4">
            <div className="flex flex-wrap items-center justify-between gap-2">
              <StatusBadge tone="ok">测试成功</StatusBadge>
              <button type="button" className={buttonClass({ size: 'xs' })} onClick={copyResult}>
                <ClipboardCopy size={12} aria-hidden="true" />
                复制译文
              </button>
            </div>
            <p className="max-h-80 overflow-auto whitespace-pre-wrap break-words text-sm leading-relaxed">{result.text}</p>
            <p className="text-xs leading-relaxed text-gray-500 dark:text-gray-400 break-words">
              {result.engine?.name ?? selected?.name ?? '实例'} ·{' '}
              {result.engine?.type === 'openai'
                ? `${result.engine?.preset === 'deepseek' ? 'OpenAI 兼容 · DeepSeek' : 'OpenAI 兼容 · 自定义'}`
                : typeBadgeLabel(selected)}{' '}
              · {result.engine?.model ?? selected?.model ?? '通用'} · 耗时 {formatCount(result.elapsedMs)} ms ·{' '}
              {result.usage?.totalTokens != null
                ? `${formatCount(result.usage.totalTokens)} tokens`
                : `${formatCount(result.chars)} 字符`}
              {paramsSummary(selected)}
            </p>
          </div>
        ) : (
          <div className="flex flex-col gap-2 rounded-lg border border-gray-200 bg-white shadow-sm dark:border-gray-700 dark:bg-gray-900 p-4" role="alert">
            <div className="flex flex-wrap items-center gap-2">
              <StatusBadge tone="error">测试失败</StatusBadge>
              {result.code ? <span className="text-xs leading-relaxed text-gray-500 dark:text-gray-400 break-words">错误码 {result.code}</span> : null}
            </div>
            <p className="max-h-80 overflow-auto whitespace-pre-wrap break-words text-sm leading-relaxed">{result.message}</p>
            <p className="text-xs leading-relaxed text-gray-500 dark:text-gray-400 break-words">{nextStep(result.code, String(result.message))}</p>
          </div>
        )}
      </section>
    </div>
  );
}
