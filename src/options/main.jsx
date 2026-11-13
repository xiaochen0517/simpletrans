/**
 * C1–C5 设置页挂载
 *
 * 模块：插件独立页面（C）
 * 职责：把 Options 组件挂到页面 #root，并加载全局样式。
 * 实现阶段：P7（设置页完整能力）
 */
import { StrictMode } from 'react';
import { createRoot } from 'react-dom/client';
import '../shared/global.css';
import Options from './Options.jsx';

createRoot(document.getElementById('root')).render(
  <StrictMode>
    <Options />
  </StrictMode>
);
