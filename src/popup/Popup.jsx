/**
 * B1 状态显示 / B2 命令下发
 *
 * 模块：工具栏弹窗（B）
 * 职责：显示当前标签页的翻译状态，并把用户操作转成命令；P3 起初始化日志并读取级别；
 *       P6.1 起提供最小入口「翻译整页 / 显示原文」，只发 `ST_ROUTE`，不直接调用引擎；
 *       P6.5 起提供「打开测试页」导航按钮，只打开扩展内页面，不发送 `ST_ROUTE`。
 * 依赖：E1 消息协议、E2 公开设置、E4 日志、B2 测试页打开助手。
 * 实现阶段：P3（日志初始化）；P6.1（最小整页入口）；P6.5（测试页入口）。
 *
 * P6.1 不显示进度、成功/失败数与当前引擎，也不读取任务状态镜像；状态化按钮与进度归 P7。
 */
import { useCallback, useEffect, useState } from 'react';
import './popup.css';
import { MESSAGE_TYPES } from '../shared/protocol.js';
import { getSettings } from '../shared/settings.js';
import { createLogger, getLogMeta, newTraceId, setLogLevel } from '../shared/log/logger.js';
import { openTestPage } from './open-test-page.js';

const log = createLogger('B2');

/** 两个命令的取值，与 `ST_ROUTE.payload.command` 一致。 */
const COMMAND = Object.freeze({ start: 'start', clear: 'clear' });

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
  const [busy, setBusy] = useState(null);
  const [openingTestPage, setOpeningTestPage] = useState(false);
  const [notice, setNotice] = useState('');
  const [error, setError] = useState('');

  useEffect(() => {
    let cancelled = false;
    getSettings()
      .then((settings) => {
        if (cancelled) return;
        setLogLevel(settings.logLevel);
        log.info('logger.ready', '日志已启动', getLogMeta());
      })
      .catch(() => {
        if (!cancelled) log.warn('settings.read', '读取设置失败，使用默认日志级别');
      });
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

  const disabled = busy !== null || openingTestPage;

  return (
    <main className="popup p-4 space-y-3">
      <h1 className="text-lg font-bold m-0">SimpleTrans</h1>

      <div className="flex flex-col gap-2">
        <button
          type="button"
          className="btn btn-primary w-full h-auto py-2 whitespace-normal break-words"
          onClick={() => run(COMMAND.start)}
          disabled={disabled}
        >
          {busy === COMMAND.start ? '正在提交…' : '翻译整页'}
        </button>
        <button
          type="button"
          className="btn btn-outline w-full h-auto py-2 whitespace-normal break-words"
          onClick={() => run(COMMAND.clear)}
          disabled={disabled}
        >
          {busy === COMMAND.clear ? '正在清除…' : '显示原文'}
        </button>
      </div>

      <div className="popup-test-page">
        <button
          type="button"
          className="btn btn-outline w-full h-auto py-2 whitespace-normal break-words"
          onClick={handleOpenTestPage}
          disabled={disabled}
        >
          {openingTestPage ? '正在打开…' : '打开测试页'}
        </button>
      </div>

      {notice && <p className="text-sm text-success break-words">{notice}</p>}
      {error && <p className="text-sm text-error break-words">{error}</p>}

      <p className="text-xs text-base-content/60">快捷键提交当前段落：Ctrl</p>
    </main>
  );
}
