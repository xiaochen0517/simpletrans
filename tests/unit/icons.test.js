/**
 * 扩展图标产物测试
 *
 * 校验：清单登记四档图标、文件存在且为方形 RGBA PNG、尺寸与文件名一致、许可说明随产物存在。
 */

import { readFile, stat } from 'node:fs/promises';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';

const ROOT = fileURLToPath(new URL('../../', import.meta.url));
const ICONS = join(ROOT, 'public', 'icons');

/**
 * 读取 PNG 的 IHDR。
 * @param {Buffer} png
 */
function readPng(png) {
  expect(png.subarray(0, 8).toString('hex')).toBe('89504e470d0a1a0a');
  return {
    width: png.readUInt32BE(16),
    height: png.readUInt32BE(20),
    bitDepth: png[24],
    colorType: png[25],
  };
}

describe('扩展图标', () => {
  it('清单登记 16/32/48/128 四档图标', async () => {
    const manifest = JSON.parse(await readFile(join(ROOT, 'public', 'manifest.json'), 'utf8'));
    expect(manifest.icons).toEqual({
      16: 'icons/icon16.png',
      32: 'icons/icon32.png',
      48: 'icons/icon48.png',
      128: 'icons/icon128.png',
    });
  });

  it('四档 PNG 存在、为方形 RGBA 且尺寸与文件名一致', async () => {
    for (const size of [16, 32, 48, 128]) {
      const file = join(ICONS, `icon${size}.png`);
      const info = await stat(file);
      expect(info.size).toBeGreaterThan(200);
      const png = readPng(await readFile(file));
      expect(png.width).toBe(size);
      expect(png.height).toBe(size);
      expect(png.bitDepth).toBe(8);
      expect(png.colorType).toBe(6);
    }
  });

  it('许可说明包含 Lucide ISC 许可并随图标目录分发', async () => {
    const notice = await readFile(join(ICONS, 'NOTICE.txt'), 'utf8');
    expect(notice).toContain('Lucide');
    expect(notice).toContain('ISC License');
    expect(notice).toContain('Copyright (c) 2026 Lucide Icons and Contributors');
  });

  it('图标源文件注明来源与许可', async () => {
    const source = await readFile(join(ROOT, 'scripts', 'icon-source.svg'), 'utf8');
    expect(source).toContain('lucide.dev/icons/languages');
    expect(source).toContain('ISC');
  });
});
