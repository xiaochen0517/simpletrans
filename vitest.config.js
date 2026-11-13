/**
 * Vitest 配置
 *
 * 默认 Node 环境：P0 只有结构测试，不需要 DOM。
 * 组件测试（jsdom + Testing Library）在 P6–P7 建立时按文件单独声明环境。
 */
import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    environment: 'node',
    include: ['tests/unit/**/*.test.js'],
  },
});
