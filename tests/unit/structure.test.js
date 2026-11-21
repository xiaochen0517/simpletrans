/**
 * 骨架结构测试
 *
 * 锁定的是结构不变量，不是行为：
 * 1. src/ 下每个文件都有模块头（模块 + 职责）；
 * 2. src/ 不引用 tests/；
 * 3. 页面注入不引用配置、引擎与缓存模块。
 *
 * 行为测试按模块补在 tests/unit/ 下。
 */

import { readFile, readdir } from 'node:fs/promises';
import { join, relative, sep } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';

const ROOT = fileURLToPath(new URL('../../', import.meta.url));
const SRC = join(ROOT, 'src');

/** @param {string} dir @param {string} base */
async function listFiles(dir, base = dir) {
  const out = [];
  for (const entry of await readdir(dir, { withFileTypes: true })) {
    const full = join(dir, entry.name);
    if (entry.isDirectory()) out.push(...(await listFiles(full, base)));
    else out.push(relative(base, full).split(sep).join('/'));
  }
  return out;
}

const files = await listFiles(SRC);

describe('骨架结构', () => {
  it('src/ 下有源码文件', () => {
    expect(files.length).toBeGreaterThan(0);
  });

  it('每个文件都有模块头', async () => {
    for (const file of files) {
      const text = await readFile(join(SRC, file), 'utf8');
      expect(text, `${file} 缺少「模块：」`).toContain('模块：');
      expect(text, `${file} 缺少「职责：」`).toContain('职责：');
      expect(text, `${file} 含有实现阶段`).not.toContain('实现阶段');
    }
  });

  it('src/ 不引用 tests/', async () => {
    for (const file of files) {
      const text = await readFile(join(SRC, file), 'utf8');
      expect(text, `${file} 引用了 tests/`).not.toMatch(/from\s+['"][^'"]*tests\//);
    }
  });

  it('页面注入不引用配置、引擎与缓存模块', async () => {
    const contentFiles = files.filter((file) => file.startsWith('content/'));
    expect(contentFiles.length).toBeGreaterThan(0);
    for (const file of contentFiles) {
      const text = await readFile(join(SRC, file), 'utf8');
      expect(text, `${file} 引用了受限模块`).not.toMatch(/from\s+['"][^'"]*shared\/(config|translate|cache)\//);
    }
  });

  it('设置页与弹窗不引用引擎、缓存模块或 SDK', async () => {
    const pageFiles = files.filter(
      (file) => file.startsWith('options/') || file.startsWith('popup/')
    );
    expect(pageFiles.length).toBeGreaterThan(0);
    for (const file of pageFiles) {
      const text = await readFile(join(SRC, file), 'utf8');
      expect(text, `${file} 引用了 A3/A4`).not.toMatch(
        /from\s+['"][^'"]*shared\/(translate|cache)\//
      );
      expect(text, `${file} 直接引用了 SDK`).not.toMatch(/from\s+['"](ai|@ai-sdk\/)/);
    }
  });

  it('除 E4 logger 外不直接使用 console', async () => {
    expect(files).toContain('shared/log/logger.js');
    for (const file of files) {
      if (file === 'shared/log/logger.js') continue;
      const text = await readFile(join(SRC, file), 'utf8');
      expect(text, `${file} 直接使用了 console`).not.toMatch(/\bconsole\s*[.?]/);
    }
  });

  it('E4 日志模块不依赖存储与设置', async () => {
    const logFiles = files.filter((file) => file.startsWith('shared/log/'));
    expect([...logFiles].sort()).toEqual([
      'shared/log/levels.js',
      'shared/log/logger.js',
      'shared/log/record.js',
    ]);
    for (const file of logFiles) {
      const text = await readFile(join(SRC, file), 'utf8');
      expect(text, `${file} 引用了存储`).not.toMatch(/chrome\.storage/);
      expect(text, `${file} 引用了设置模块`).not.toMatch(
        /from\s+['"][^'"]*(?:settings|storage)\.js/
      );
    }
  });
});
