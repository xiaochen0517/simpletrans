/**
 * 前端样式契约测试（HyperUI 迁移）
 *
 * 锁定：
 * 1. 仓库不再依赖 daisyUI，源码不再出现其组件类或主题变量；
 * 2. 全局样式用 `data-theme="dark"` + Tailwind `dark` 变体，而不是主题插件；
 * 3. Neobrutalism 只出现在设置页「关于」分区；
 * 4. 共享层与关键页面使用 HyperUI/Tailwind 调色板类。
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

/** daisyUI 5 的组件类、主题变量与插件入口。 */
const BANNED = [
  /daisyui/i,
  /@plugin\s+["']daisyui/,
  /\bbtn(?:-[a-z0-9-]+)?\b/,
  /(?:^|[\s"'`])badge\s+badge-/,
  /\bbadge-(?:sm|xs|ghost|success|warning|error|primary)\b/,
  /\balert-(?:success|error|warning|info)\b/,
  /(?:^|[\s"'`])alert\s+alert-/,
  /\bmodal-(?:box|open|action)\b/,
  /(?:^|[\s"'`])modal\s+modal/,
  /\btabs-boxed\b|\btab-active\b|\btabs\s+tabs\b/,
  /\bmenu-active\b|\bmenu\s+menu-/,
  /\bdropdown-content\b|\bdropdown-top\b/,
  /\bcollapse-(?:title|arrow|content)\b/,
  /(?:^|[\s"'`])collapse\s+collapse/,
  /(?:^|[\s"'`])toggle\s+toggle-/,
  /(?:^|[\s"'`])input\s+input-/,
  /(?:^|[\s"'`])textarea\s+textarea-/,
  /(?:^|[\s"'`])select\s+select-/,
  /(?:^|[\s"'`])checkbox\s+checkbox-/,
  /(?:^|[\s"'`])radio\s+radio-/,
  /(?:^|[\s"'`])range\s+range-/,
  /(?:^|[\s"'`])skeleton(?=[\s"'`]|$)/,
  /\bloading\s+loading-/,
  /\bstatus\s+status-/,
  /\bkbd\s+kbd-/,
  /\btoast\s+toast-/,
  /\bbg-base-/,
  /\btext-base-content\b/,
  /\bborder-base-/,
  /\brounded-(?:box|field)\b/,
  /\bcard-border\b/,
  /--color-base-/,
];

/** @param {string} file */
async function readSrc(file) {
  return readFile(join(SRC, file), 'utf8');
}

describe('HyperUI 样式契约', () => {
  it('package.json 与 lockfile 不再包含 daisyui', async () => {
    const pkg = await readFile(join(ROOT, 'package.json'), 'utf8');
    const lock = await readFile(join(ROOT, 'package-lock.json'), 'utf8');
    expect(pkg).not.toContain('daisyui');
    expect(lock).not.toContain('daisyui');
  });

  it('src/ 不出现 daisyUI 组件类或主题变量', async () => {
    for (const file of files) {
      if (!/\.(jsx?|css|html)$/.test(file)) continue;
      const text = await readSrc(file);
      for (const pattern of BANNED) {
        const match = text.match(pattern);
        expect(
          match,
          `${file} 仍出现禁用样式 ${match?.[0]}（${pattern}）`
        ).toBeNull();
      }
    }
  });

  it('global.css 用 data-theme + Tailwind dark 变体，且不含主题插件', async () => {
    const css = await readSrc('shared/global.css');
    expect(css).toContain('@custom-variant dark');
    expect(css).toContain('[data-theme="dark"]');
    expect(css).toContain('bg-gray-50');
    expect(css).toContain('dark:bg-gray-950');
    expect(css).not.toContain('@plugin');
  });

  it('共享层与关于页使用 HyperUI 调色板', async () => {
    const button = await readSrc('shared/ui/button.jsx');
    const select = await readSrc('shared/ui/select.jsx');
    const about = await readSrc('options/sections/about.jsx');

    expect(button).toContain('bg-indigo-600');
    expect(button).toContain('border-gray-300');
    expect(select).toContain('border-gray-300');
    expect(select).toContain('data-slot="select-panel"');
    expect(about).toContain('shadow-[4px_4px_0_0]');
    expect(about).toContain('border-2 border-black');
  });

  it('Neobrutalism 只出现在关于页', async () => {
    for (const file of files) {
      if (file === 'options/sections/about.jsx') continue;
      const text = await readSrc(file);
      expect(text, `${file} 不应出现 Neobrutalism 硬阴影`).not.toContain(
        'shadow-[4px_4px_0_0]'
      );
      expect(text, `${file} 不应出现 Neobrutalism 粗黑边`).not.toContain(
        'border-2 border-black'
      );
    }
  });
});
