/**
 * B1/B2 弹窗挂载
 *
 * 模块：工具栏弹窗（B）
 * 职责：把 Popup 组件挂到页面 #root，并加载全局样式。
 * 实现阶段：P6（弹窗命令与状态显示）
 */
import { StrictMode } from 'react';
import { createRoot } from 'react-dom/client';
import '../shared/global.css';
import Popup from './Popup.jsx';

createRoot(document.getElementById('root')).render(
  <StrictMode>
    <Popup />
  </StrictMode>
);
