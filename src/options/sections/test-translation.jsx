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
import StatusBadge from '../components/status-badge.jsx';
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
      <div className="op-stack">
        <div className="op-warning is-warn">
          <FlaskConical size={16} aria-hidden="true" />
          <span className="op-warning-text">还没有翻译实例，先到「翻译实例」新增一个再测试。</span>
          <span className="op-warning-action">
            <button type="button" className="btn btn-xs btn-primary" onClick={() => app.openCreate(null)}>
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
    <div className="op-stack">
      <div className="op-section-head">
        <div>
          <h2 className="op-h2">
            <FlaskConical size={15} aria-hidden="true" />
            测试翻译
          </h2>
          <p className="op-sub">使用已保存的实例参数与密钥；修改配置后请先保存再测试。</p>
        </div>
      </div>

      <section className="op-card" aria-label="测试输入">
        <label className="op-field">
          <span className="op-label">翻译实例</span>
          <select
            className="select select-bordered select-sm w-full"
            value={selectedId}
            onChange={(event) => app.setTestInstanceId(event.target.value)}
            disabled={busy}
          >
            {instances.map((instance) => {
              const state = credentialState(instance);
              const permissionText =
                instance.type === 'openai' && instance.permission !== 'granted' ? ' · 未授权' : '';
              const unsupportedText = instance.kind === 'unsupported' ? ' · 类型不支持' : '';
              return (
                <option
                  key={instance.id}
                  value={instance.id}
                  disabled={instance.kind === 'unsupported'}
                >
                  {`${instance.name} · ${typeBadgeLabel(instance)} · ${instance.type === 'baidu' ? '通用文本翻译' : instance.model ?? '模型'} · ${state.label}${permissionText}${unsupportedText}`}
                </option>
              );
            })}
          </select>
        </label>

        <div className="op-inline">
          <span className="op-help">
            语言：{languageLabel(settings?.sourceLang) || '未知'} → {languageLabel(settings?.targetLang) || '未知'}
          </span>
          <button type="button" className="btn btn-xs" onClick={() => app.navigate('#/general')}>
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
          <div className="op-warning is-warn">
            <ShieldAlert size={15} aria-hidden="true" />
            <span className="op-warning-text">{eligibility.reason}</span>
            {selected?.type === 'openai' && selected.permission !== 'granted' ? (
              <span className="op-warning-action">
                <button
                  type="button"
                  className="btn btn-xs btn-warning"
                  onClick={authorize}
                  disabled={authorizing}
                >
                  {authorizing ? '申请中…' : '去授权'}
                </button>
              </span>
            ) : null}
          </div>
        ) : null}

        <label className="op-field">
          <span className="op-label">待翻译文本</span>
          <textarea
            className="textarea textarea-bordered w-full"
            rows={4}
            value={text}
            onChange={(event) => setText(event.target.value)}
            disabled={busy}
            aria-describedby="test-text-count"
          />
        </label>
        <div className="op-inline" style={{ justifyContent: 'space-between' }}>
          <span className="op-help" id="test-text-count">
            {text.length} / {TEST_TEXT_MAX_CHARS} 字符
          </span>
          <span className="op-help">测试只使用已保存的实例；未保存的草稿不参与。</span>
        </div>
        {tooLong ? <span className="op-error" role="alert">文本超过 {TEST_TEXT_MAX_CHARS} 字符上限，请缩短后重试。</span> : null}

        <div className="op-inline">
          <button
            type="button"
            className="btn btn-sm btn-primary"
            onClick={runTest}
            disabled={busy || tooLong || !selected}
          >
            <FlaskConical size={14} aria-hidden="true" />
            {busy ? '翻译中…' : '测试翻译'}
          </button>
          <button
            type="button"
            className="btn btn-sm"
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

      <section className="op-section" aria-live="polite" aria-label="测试结果">
        <h2 className="op-h2">结果</h2>
        {busy ? (
          <div className="op-result" aria-busy="true">
            <div className="op-skeleton" aria-label="正在测试翻译">
              <span className="op-skeleton-line" style={{ width: '35%' }} />
              <span className="op-skeleton-line" style={{ width: '85%' }} />
              <span className="op-skeleton-line" style={{ width: '60%' }} />
            </div>
          </div>
        ) : !result ? (
          <p className="op-sub">选择实例并输入文本后测试。</p>
        ) : result.status === 'success' ? (
          <div className="op-result is-ok">
            <div className="op-inline" style={{ justifyContent: 'space-between' }}>
              <StatusBadge tone="ok">测试成功</StatusBadge>
              <button type="button" className="btn btn-xs" onClick={copyResult}>
                <ClipboardCopy size={12} aria-hidden="true" />
                复制译文
              </button>
            </div>
            <p className="op-result-text">{result.text}</p>
            <p className="op-result-meta">
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
          <div className="op-result is-error" role="alert">
            <div className="op-inline">
              <StatusBadge tone="error">测试失败</StatusBadge>
              {result.code ? <span className="op-help">错误码 {result.code}</span> : null}
            </div>
            <p className="op-result-text">{result.message}</p>
            <p className="op-result-meta">{nextStep(result.code, String(result.message))}</p>
          </div>
        )}
      </section>
    </div>
  );
}
