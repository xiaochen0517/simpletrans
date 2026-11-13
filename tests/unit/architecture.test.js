/**
 * 架构一致性测试
 *
 * 解析 docs/项目架构.md 3.1 的目录树，与 src/ 实际文件逐项比对：
 * - 树里有的文件（未标「待建」）必须存在；
 * - 树里没有的文件必须删除或补进树；
 * - 树里标「待建」的条目不得已经存在（存在即说明文档该更新）。
 *
 * 这样「代码结构 = 架构」由门禁保证，而不是靠人工记。
 */

import { readFile, readdir, stat } from 'node:fs/promises';
import { join, relative, sep } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';

const ROOT = fileURLToPath(new URL('../../', import.meta.url));
const ARCH_DOC = join(ROOT, 'docs', '项目架构.md');
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

/**
 * 把 3.1 的缩进树解析成路径。每级缩进 2 个空格；目录以 `/` 结尾；
 * 注释里含「待建」的条目视为尚未创建。
 * @param {string} block
 */
function parseTree(block) {
  const entries = [];
  const stack = [];
  for (const raw of block.split(/\r?\n/)) {
    if (!raw.trim()) continue;
    const indent = raw.match(/^ */)[0].length;
    const trimmed = raw.trim();
    const match = trimmed.match(/^(\S+)\s*(.*)$/);
    if (!match) continue;
    const [, name, comment = ''] = match;

    stack.length = Math.floor(indent / 2);
    if (name.endsWith('/')) {
      const dir = [...stack, name.slice(0, -1)].join('/');
      if (comment.includes('待建')) entries.push({ path: dir, pending: true });
      else stack.push(name.slice(0, -1));
      continue;
    }
    entries.push({ path: [...stack, name].join('/'), pending: comment.includes('待建') });
  }
  return entries;
}

async function exists(path) {
  try {
    await stat(path);
    return true;
  } catch {
    return false;
  }
}

const markdown = await readFile(ARCH_DOC, 'utf8');
const start = markdown.indexOf('### 3.1 源码目录');
const end = markdown.indexOf('### 3.2 构建产物');
const section = start >= 0 && end > start ? markdown.slice(start, end) : '';
const blockMatch = section.match(/```text\r?\n([\s\S]*?)```/);
const tree = blockMatch ? parseTree(blockMatch[1]) : [];

const expected = tree.filter((entry) => entry.path.startsWith('src/')).map((entry) => entry.path.slice('src/'.length));
const pending = tree.filter((entry) => entry.pending);
const actual = await listFiles(SRC);

describe('架构 3.1 与代码结构', () => {
  it('能解析 3.1 的目录树', () => {
    expect(section.length).toBeGreaterThan(0);
    expect(blockMatch, '3.1 缺少 text 代码块').not.toBeNull();
    expect(expected.length).toBeGreaterThan(0);
  });

  it('src/ 文件与目录树完全一致', () => {
    const missing = expected.filter((file) => !actual.includes(file)).sort();
    const unexpected = actual.filter((file) => !expected.includes(file)).sort();
    expect(missing, `目录树里有、仓库里没有：${missing.join('、')}`).toEqual([]);
    expect(unexpected, `仓库里有、目录树没有：${unexpected.join('、')}`).toEqual([]);
  });

  it('标「待建」的条目尚未创建', async () => {
    for (const entry of pending) {
      expect(await exists(join(ROOT, entry.path)), `${entry.path} 已存在，请从 3.1 去掉「待建」`).toBe(false);
    }
  });
});
