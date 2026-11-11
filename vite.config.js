/**
 * 构建配置：一份配置，三种产物
 *
 * 为什么必须拆：
 * - Content Script 不是 ES Module，产物必须是**自包含单文件**（IIFE），
 *   否则一旦 import 了 shared/，浏览器会拿到无法执行的 `import` 语句；
 * - Background 是 `type: module`，可以保留 ESM；
 * - Popup / Options 是 HTML 页面，需要 React + Tailwind。
 *
 * 由 `scripts/build.mjs` 依次以 `--mode web|background|content` 调用。
 */

import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';
import tailwindcss from '@tailwindcss/vite';
import { resolve } from 'node:path';

const r = (p) => resolve(import.meta.dirname, p);
const dev = process.env.NODE_ENV === 'development';

/** 三个产物共用的构建选项。`emptyOutDir` 由 scripts/build.mjs 统一清理。 */
const sharedBuild = {
  outDir: r('dist'),
  emptyOutDir: false,
  target: 'chrome116',
  sourcemap: dev ? 'inline' : false,
  minify: !dev,
};

/** Content 模式的资源命名：CSS 必须是固定名，供 manifest / insertCSS 引用。 */
function contentAssetFileNames(assetInfo) {
  const name = assetInfo.names?.[0] ?? assetInfo.name ?? '';
  if (name.endsWith('.css')) return 'content.css';
  return 'assets/[name]-[hash][extname]';
}

export default defineConfig(() => {
  const mode = process.env.ST_BUILD_MODE ?? 'web';

  if (mode === 'content') {
    return {
      root: 'src',
      publicDir: r('public'),
      plugins: [],
      build: {
        ...sharedBuild,
        cssCodeSplit: false,
        rollupOptions: {
          input: r('src/content/index.js'),
          output: {
            format: 'iife',
            inlineDynamicImports: true,
            entryFileNames: 'content.js',
            assetFileNames: contentAssetFileNames,
          },
        },
      },
    };
  }

  if (mode === 'background') {
    return {
      root: 'src',
      publicDir: r('public'),
      plugins: [],
      build: {
        ...sharedBuild,
        rollupOptions: {
          input: r('src/background/index.js'),
          output: {
            format: 'es',
            inlineDynamicImports: true,
            entryFileNames: 'background.js',
            chunkFileNames: 'assets/[name]-[hash].js',
          },
        },
      },
    };
  }

  // mode === 'web'
  return {
    root: 'src',
    publicDir: r('public'),
    plugins: [tailwindcss(), react()],
    build: {
      ...sharedBuild,
      rollupOptions: {
        input: {
          popup: r('src/popup/index.html'),
          options: r('src/options/index.html'),
        },
        output: {
          entryFileNames: 'assets/[name]-[hash].js',
          chunkFileNames: 'assets/[name]-[hash].js',
          assetFileNames: 'assets/[name]-[hash][extname]',
        },
      },
    },
  };
});
