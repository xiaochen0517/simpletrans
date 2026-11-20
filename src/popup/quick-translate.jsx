/**
 * B3 快速翻译页
 *
 * 模块：工具栏弹窗（B）/ B3
 * 职责：在弹窗内输入或读取当前网页选中文字，用临时选择的实例与目标语言翻译，展示纯文本结果并复制。
 * 依赖：React、`lucide-react`、E1 消息协议、E2 公开设置（语言目录）、E4 日志、E5 共享展示组件、
 *       公共数值（单段上限）与 B 弹窗实例选项助手。
 * 实现阶段：P11（弹窗快速翻译）
 *
 * 实例、目标语言、输入与结果都是弹窗会话状态：不写存储、不写页面、不使用译文缓存。
 */

import { useCallback, useEffect, useRef, useState } from 'react';
import { ClipboardCopy, Languages, ScanText, Sparkles } from 'lucide-react';
import { MAX_SEGMENT_CHARS } from '../shared/constants.js';
import { MESSAGE_TYPES } from '../shared/protocol.js';
import { TARGET_LANGS, languageLabel } from '../shared/languages.js';
import { createLogger, newTraceId } from '../shared/log/logger.js';
import Select from '../shared/ui/select.jsx';
import Notice from '../shared/ui/notice.jsx';
import Button from '../shared/ui/button.jsx';
import StatusBadge from '../shared/ui/status-badge.jsx';
import { engineOptionsOf, usableInstances } from './instance-option.js';

const log = createLogger('B3');

/**
 * 发送一次性消息；扩展未就绪或后台失败时返回错误结果。
 * @param {object} message
 * @returns {Promise<{ ok: true, data?: object } | { ok: false, error: object }>}
 */
async function sendMessage(message) {
  if (!globalThis.chrome?.runtime?.sendMessage) {
    return { ok: false, error: { code: 'NETWORK', message: '扩展未就绪，请重新打开弹窗' } };
  }
  try {
    const response = await chrome.runtime.sendMessage(message);
    return response ?? { ok: false, error: { code: 'OTHER', message: '后台没有返回结果' } };
  } catch {
    return { ok: false, error: { code: 'NETWORK', message: '无法连接后台，请稍后重试' } };
  }
}

/**
 * 读取当前活动标签页的选中文字；失败时返回空文本，不向用户报错。
 * @returns {Promise<{ text: string, truncated: boolean }>}
 */
async function fetchSelection() {
  const response = await sendMessage({
    type: MESSAGE_TYPES.GET_SELECTION,
    payload: { traceId: newTraceId() },
  });
  if (!response?.ok) return { text: '', truncated: false };
  return {
    text: String(response.data?.text ?? ''),
    truncated: Boolean(response.data?.truncated),
  };
}

/**
 * 快速翻译面板。
 * @param {{
 *   settings: Record<string, unknown> | null,
 *   instances: Array<Record<string, unknown>>,
 *   settingsFailed: boolean,
 *   enginesFailed: boolean,
 *   active?: boolean,
 * }} props
 */
export default function QuickTranslate({
  settings,
  instances,
  settingsFailed,
  enginesFailed,
  active = true,
}) {
  const [instanceId, setInstanceId] = useState('');
  const [targetLang, setTargetLang] = useState(() =>
    TARGET_LANGS.includes(settings?.targetLang) ? settings.targetLang : TARGET_LANGS[0]
  );
  const [input, setInput] = useState('');
  const [result, setResult] = useState(null);
  const [error, setError] = useState('');
  const [notice, setNotice] = useState('');
  const [busy, setBusy] = useState(false);
  const selectionFetched = useRef(false);

  const engineOptions = engineOptionsOf(instances);
  const usable = usableInstances(instances);
  const configFailed = settingsFailed || enginesFailed;

  // 实例：默认当前实例；当前不在可用列表时用第一个可用实例；只在本次会话内生效。
  useEffect(() => {
    const preferred =
      typeof settings?.activeInstanceId === 'string' ? settings.activeInstanceId : '';
    setInstanceId((previous) => {
      if (usable.some((instance) => instance.id === previous)) return previous;
      return usable.find((instance) => instance.id === preferred)?.id ?? usable[0]?.id ?? '';
    });
  }, [instances, settings?.activeInstanceId]);

  // 目标语言：默认全局目标语言；本页可临时切换，不写设置。
  useEffect(() => {
    const fallback = TARGET_LANGS.includes(settings?.targetLang)
      ? settings.targetLang
      : TARGET_LANGS[0];
    setTargetLang((previous) => (TARGET_LANGS.includes(previous) ? previous : fallback));
  }, [settings?.targetLang]);

  /**
   * 读取选区；`replace` 为 true 时覆盖输入（手动按钮），否则只在输入为空时填入。
   * @param {boolean} replace
   */
  const loadSelection = useCallback(async (replace) => {
    const selection = await fetchSelection();
    if (selection.text === '') {
      if (replace) setNotice('未读取到选中文字');
      return;
    }
    setInput((previous) =>
      replace || previous.trim() === '' ? selection.text : previous
    );
    if (selection.truncated) {
      setNotice(`选区超过 ${MAX_SEGMENT_CHARS} 字符，已截取前 ${MAX_SEGMENT_CHARS} 字符`);
    } else if (replace) {
      setNotice('已填入页面选中文字');
    }
  }, []);

  // 首次进入快速页时读取一次选区，输入为空才填入；离开再回来不重复读取。
  useEffect(() => {
    if (!active || selectionFetched.current) return;
    selectionFetched.current = true;
    void loadSelection(false);
  }, [active, loadSelection]);

  const translate = useCallback(async () => {
    if (busy) return;
    const text = input.trim();
    if (text === '') {
      setError('请输入要翻译的内容');
      return;
    }
    if (!instanceId) {
      setError('没有可用的翻译实例，请到设置页新增或启用');
      return;
    }

    setBusy(true);
    setError('');
    setNotice('');
    setResult(null);
    const traceId = newTraceId();
    log.info('popup.quick', '提交快速翻译', {
      textLength: text.length,
      targetLang,
      instanceId,
    });

    const response = await sendMessage({
      type: MESSAGE_TYPES.QUICK_TRANSLATE,
      payload: { text, targetLang, instanceId, traceId },
    });

    setBusy(false);
    if (!response?.ok) {
      setError(String(response?.error?.message ?? '翻译失败，请稍后重试'));
      log.warn('popup.quick', '快速翻译失败', {
        code: response?.error?.code ?? null,
      });
      return;
    }

    setResult(response.data ?? null);
    log.info('popup.quick', '快速翻译完成', {
      instanceId,
      chars: response.data?.chars ?? null,
      cached: false,
    });
  }, [busy, input, instanceId, targetLang]);

  const copyResult = useCallback(async () => {
    const text = String(result?.text ?? '');
    if (text === '') return;
    try {
      await navigator.clipboard.writeText(text);
      setNotice('已复制');
    } catch {
      setError('复制失败，请手动选择文本复制');
    }
  }, [result]);

  const handleKeyDown = (event) => {
    if (event.key === 'Enter' && (event.ctrlKey || event.metaKey)) {
      event.preventDefault();
      void translate();
    }
  };

  const langOptions = TARGET_LANGS.map((lang) => ({
    value: lang,
    label: languageLabel(lang) || lang,
  }));
  const resultLang = result?.targetLang ?? targetLang;
  const targetLabel = languageLabel(resultLang) || resultLang;

  return (
    <div
      className={active ? 'flex flex-col gap-3' : 'hidden'}
      role="tabpanel"
      id="popup-panel-quick"
      aria-labelledby="popup-tab-quick"
      hidden={!active}
    >
      <section
        className="flex flex-col gap-2 rounded-lg border border-gray-200 bg-gray-50 p-3 dark:border-gray-700 dark:bg-gray-800"
        aria-label="快速翻译设置"
      >
        <div className="flex flex-col gap-1">
          <span className="flex items-center gap-1 text-xs font-semibold text-gray-700 dark:text-gray-200">
            <Sparkles size={14} className="text-indigo-600 dark:text-indigo-400" aria-hidden="true" />
            <span>翻译实例</span>
          </span>
          <Select
            id="quick-engine-select"
            value={instanceId}
            options={engineOptions}
            onChange={setInstanceId}
            placeholder="没有可用的翻译实例"
            ariaLabel="快速翻译实例"
            disabled={engineOptions.length === 0 || busy}
          />
        </div>
        <div className="flex flex-col gap-1">
          <span className="flex items-center gap-1 text-xs font-semibold text-gray-700 dark:text-gray-200">
            <Languages size={14} className="text-indigo-600 dark:text-indigo-400" aria-hidden="true" />
            <span>目标语言</span>
          </span>
          <Select
            id="quick-lang-select"
            value={targetLang}
            options={langOptions}
            onChange={setTargetLang}
            ariaLabel="快速翻译目标语言"
            disabled={busy}
          />
        </div>
        {engineOptions.length === 0 && !configFailed ? (
          <Notice tone="warning">没有可用的翻译实例，请到设置页新增或启用</Notice>
        ) : null}
        {configFailed ? <Notice tone="error">读取配置失败，请到设置页检查</Notice> : null}
      </section>

      <section
        className="flex flex-col gap-2 rounded-lg border border-gray-200 bg-gray-50 p-3 dark:border-gray-700 dark:bg-gray-800"
        aria-label="待翻译内容"
      >
        <textarea
          id="quick-input"
          className="w-full resize-y rounded-lg border border-gray-300 bg-white px-3 py-2 text-sm text-gray-900 shadow-sm placeholder:text-gray-400 focus:border-indigo-500 focus:ring-2 focus:ring-indigo-200 focus:outline-none disabled:cursor-not-allowed disabled:opacity-60 dark:border-gray-700 dark:bg-gray-900 dark:text-white dark:placeholder:text-gray-500 dark:focus:border-indigo-400 dark:focus:ring-indigo-900"
          rows={4}
          maxLength={MAX_SEGMENT_CHARS}
          value={input}
          onChange={(event) => setInput(event.target.value)}
          onKeyDown={handleKeyDown}
          placeholder="输入或粘贴要翻译的单词、句子或段落"
          aria-label="快速翻译输入"
          spellCheck={false}
          disabled={busy}
        />
        <div className="flex flex-wrap items-center gap-2">
          <span className="text-xs text-gray-500 dark:text-gray-400">
            {input.length} / {MAX_SEGMENT_CHARS}
          </span>
          <Button
            variant="ghost"
            size="xs"
            onClick={() => void loadSelection(true)}
            disabled={busy}
          >
            <ScanText size={13} aria-hidden="true" />
            读取选区
          </Button>
          <span className="ml-auto" />
          <Button
            variant="primary"
            onClick={() => void translate()}
            disabled={busy || input.trim() === '' || engineOptions.length === 0}
            busy={busy}
          >
            <span>{busy ? '翻译中…' : '翻译'}</span>
          </Button>
        </div>
        <p className="flex items-center gap-1 text-xs text-gray-500 dark:text-gray-400">
          <kbd className="rounded border border-gray-300 bg-gray-100 px-1.5 py-0.5 font-mono text-[11px] text-gray-700 dark:border-gray-700 dark:bg-gray-800 dark:text-gray-200">
            Ctrl
          </kbd>
          <span>+</span>
          <kbd className="rounded border border-gray-300 bg-gray-100 px-1.5 py-0.5 font-mono text-[11px] text-gray-700 dark:border-gray-700 dark:bg-gray-800 dark:text-gray-200">
            Enter
          </kbd>
          <span>快速翻译</span>
        </p>
      </section>

      {notice ? <Notice tone="success">{notice}</Notice> : null}
      {error ? <Notice tone="error">{error}</Notice> : null}

      {result ? (
        <section
          className="flex flex-col gap-2 rounded-lg border border-gray-200 bg-gray-50 p-3 dark:border-gray-700 dark:bg-gray-800"
          aria-label="快速翻译结果"
          aria-live="polite"
        >
          <div className="flex flex-wrap items-center gap-1.5">
            <span className="text-xs font-semibold text-gray-700 dark:text-gray-200">译文</span>
            <StatusBadge tone="idle">
              {String(result.engine?.name ?? '')} · {targetLabel}
            </StatusBadge>
            <span className="ml-auto" />
            <Button variant="ghost" size="xs" onClick={() => void copyResult()}>
              <ClipboardCopy size={13} aria-hidden="true" />
              复制
            </Button>
          </div>
          <p className="whitespace-pre-wrap break-words text-sm leading-relaxed">
            {String(result.text ?? '')}
          </p>
        </section>
      ) : null}
    </div>
  );
}
