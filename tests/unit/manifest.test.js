/**
 * 清单契约测试
 *
 * 覆盖跨 frame 翻译依赖的清单声明：页面注入必须覆盖标签页内所有 frame。
 * 清单是产物的一部分，不从源码模块导入，因此单独校验。
 */

import { readFile } from 'node:fs/promises';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';

const ROOT = fileURLToPath(new URL('../../', import.meta.url));
const MANIFEST = join(ROOT, 'public', 'manifest.json');

describe('清单：跨 frame 注入（P13）', () => {
  it('content_scripts 匹配所有 URL 且覆盖所有 frame', async () => {
    const manifest = JSON.parse(await readFile(MANIFEST, 'utf8'));
    const scripts = Array.isArray(manifest.content_scripts) ? manifest.content_scripts : [];

    expect(scripts.length).toBeGreaterThan(0);
    for (const script of scripts) {
      expect(script.matches).toContain('<all_urls>');
      expect(script.all_frames).toBe(true);
    }
  });

  it('页面注入仍按 document_idle 注入脚本与样式', async () => {
    const manifest = JSON.parse(await readFile(MANIFEST, 'utf8'));
    const script = manifest.content_scripts[0];

    expect(script.run_at).toBe('document_idle');
    expect(script.js).toContain('content.js');
    expect(script.css).toContain('content.css');
  });
});
