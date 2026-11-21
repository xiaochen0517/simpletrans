/**
 * 测试加载助手
 *
 * 模块：测试基建（tests/helpers）
 * 职责：安装 chrome stub、清模块缓存、动态导入被测模块。
 *
 * 主要用于依赖 chrome 的 E2/E3 模块；入口模块（background/content 顶层注册监听器）
 * 必须用这里的「先装 stub 再动态导入」顺序。
 */

import { vi } from 'vitest';
import { createChrome } from './chrome.js';

/**
 * 安装 chrome stub 到全局。
 * @returns {object} 安装的 stub。
 */
export function installChrome() {
  const stub = createChrome();
  globalThis.chrome = stub;
  return stub;
}

/**
 * 重装 stub、清模块缓存，再动态导入指定模块。
 * 用于顶层访问 chrome 的模块，确保导入前 stub 已就绪。
 * @param {string} specifier
 * @returns {Promise<unknown>}
 */
export async function importFresh(specifier) {
  installChrome();
  vi.resetModules();
  return import(specifier);
}
