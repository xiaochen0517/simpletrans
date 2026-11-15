/**
 * B1/B2 弹窗挂载
 *
 * 模块：工具栏弹窗（B）
 * 职责：初始化 E4 日志，把 Popup 组件挂到页面 #root，并加载全局样式。
 * 实现阶段：P3（日志初始化）
 */
import { StrictMode } from 'react';
import { createRoot } from 'react-dom/client';
import '../shared/global.css';
import { initLogging } from '../shared/log/logger.js';
import Popup from './Popup.jsx';

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
  context: 'popup',
  version: extensionVersion(),
  captureErrors: true,
});

createRoot(document.getElementById('root')).render(
  <StrictMode>
    <Popup />
  </StrictMode>
);
