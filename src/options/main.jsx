/**
 * C1–C5 设置页挂载
 *
 * 模块：插件独立页面（C）
 * 职责：初始化 E4 日志，把 Options 组件挂到页面 #root，并加载全局样式。
 */
import { StrictMode } from 'react';
import { createRoot } from 'react-dom/client';
import '../shared/global.css';
import { initLogging } from '../shared/log/logger.js';
import Options from './Options.jsx';

/**
 * 安全读取扩展版本；清单不可用时返回 undefined。
 * @returns {string | undefined}
 */
function extensionVersion() {
  try {
    return chrome.runtime.getManifest?.().version;
  } catch {
    return undefined;
  }
}

initLogging({
  context: 'options',
  version: extensionVersion(),
  captureErrors: true,
});

createRoot(document.getElementById('root')).render(
  <StrictMode>
    <Options />
  </StrictMode>
);
