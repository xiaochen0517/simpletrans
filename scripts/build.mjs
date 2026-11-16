#!/usr/bin/env node
/**
 * 构建编排
 *
 * 三种产物必须用不同的输出格式，Vite 的单次 build 无法按 entry 指定 format，
 * 因此这里分三次调用：
 *   web        → popup / options / testpage（HTML + ESM）
 *   background → Service Worker（ESM 单文件）
 *   content    → Content Script（IIFE 单文件 + content.css）
 *
 * 用法：
 *   node scripts/build.mjs            生产构建（先清空 dist）
 *   node scripts/build.mjs --watch    开发监听（并行 watch，不清理 dist）
 */

import { spawn } from 'node:child_process';
import { rm } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const projectRoot = dirname(dirname(fileURLToPath(import.meta.url)));
const viteBin = join(projectRoot, 'node_modules', 'vite', 'bin', 'vite.js');
const distDir = join(projectRoot, 'dist');
const watch = process.argv.includes('--watch');
const modes = ['web', 'background', 'content'];

/**
 * @param {string} mode
 * @param {{ detached?: boolean }} [options]
 */
function build(mode, options = {}) {
  const args = [viteBin, 'build', ...(watch ? ['--watch'] : [])];
  const child = spawn(process.execPath, args, {
    cwd: projectRoot,
    stdio: 'inherit',
    env: {
      ...process.env,
      ST_BUILD_MODE: mode,
      NODE_ENV: watch ? 'development' : 'production',
    },
  });

  if (options.detached) return child;

  return new Promise((resolve, reject) => {
    child.on('error', reject);
    child.on('exit', (code) => {
      if (code === 0) resolve();
      else reject(new Error(`vite build --mode ${mode} 失败，退出码 ${code}`));
    });
  });
}

if (watch) {
  console.info('[SimpleTrans] 监听构建中（web / background / content）…');
  const children = modes.map((mode) => build(mode, { detached: true }));
  const shutdown = () => {
    for (const child of children) child.kill();
    process.exit(0);
  };
  process.on('SIGINT', shutdown);
  process.on('SIGTERM', shutdown);
} else {
  try {
    await cleanDist();
    for (const mode of modes) {
      console.info(`[SimpleTrans] 构建 ${mode} …`);
      await build(mode);
    }
    console.info('[SimpleTrans] 构建完成 → dist/');
  } catch (error) {
    console.error(`[SimpleTrans] 构建失败：${error?.message ?? error}`);
    console.error('[SimpleTrans] dist 可能不完整，请修复后重新运行 npm run build。');
    process.exit(1);
  }
}

/**
 * 清空 dist。
 * 某些环境（例如 Windows 上被策略禁止删除的目录）不允许删除，此时退化为
 * “覆盖同名产物”：构建仍然成功，但旧的 hash 资源可能残留。
 */
async function cleanDist() {
  try {
    await rm(distDir, { recursive: true, force: true });
  } catch (error) {
    if (error?.code === 'EPERM' || error?.code === 'EBUSY' || error?.code === 'EACCES') {
      console.warn('[SimpleTrans] 无法清空 dist（文件系统禁止删除），将直接覆盖同名产物。');
      return;
    }
    throw error;
  }
}
