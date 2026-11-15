/**
 * B1 状态显示 / B2 命令下发（占位）
 *
 * 模块：工具栏弹窗（B）
 * 职责：显示当前标签页的翻译状态，并把用户操作转成命令；P3 起初始化日志并读取级别。
 * 依赖：E1 消息协议、E2 公开设置、E4 日志（P3 起）。
 * 实现阶段：P3（日志初始化，界面仍为占位）
 *
 * P0 只渲染静态占位，不读取设置、不发消息、不调用引擎；P3 只增加日志与级别读取。
 */
import { useEffect } from 'react';
import './popup.css';
import { getSettings } from '../shared/settings.js';
import { createLogger, getLogMeta, setLogLevel } from '../shared/log/logger.js';

const log = createLogger('B1');

export default function Popup() {
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

  return (
    <main className="popup p-4">
      <h1 className="text-lg font-bold m-0">SimpleTrans</h1>
      <p className="text-sm text-base-content/70 mt-2">弹窗骨架已就绪，状态与命令待接入（P7）。</p>
    </main>
  );
}
