/**
 * Vitest 配置
 *
 * 默认 Node 环境：单元测试不依赖 DOM。
 * 组件测试（tests/component）按文件声明 jsdom 环境，用 react-dom/client 渲染。
 */
import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    environment: 'node',
    include: ['tests/unit/**/*.test.js', 'tests/component/**/*.test.jsx'],
  },
});
