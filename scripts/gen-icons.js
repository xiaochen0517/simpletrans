/**
 * 生成扩展图标
 *
 * 职责：读取 scripts/icon-source.svg（Lucide `languages`，ISC），合成 daisyUI 默认 light 主题
 *       `primary` 纯色圆角底与白色图形，输出 16/32/48/128 四档 PNG。
 * 依赖：@resvg/resvg-js（仅开发期）；不联网、不进入扩展产物。
 *
 * 运行：npm run icons
 */
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { Resvg } from '@resvg/resvg-js';

const scriptsDir = dirname(fileURLToPath(import.meta.url));
const projectRoot = dirname(scriptsDir);
const outputDir = join(projectRoot, 'public', 'icons');
const outputPath = (size) => join(outputDir, `icon${size}.png`);

/** daisyUI 5.8.1 默认 light 主题的 primary（oklch(45% .24 277.023) 的 sRGB 近似值）。 */
const BACKGROUND = '#422ad5';
/** 图形占画布的比例；小图标适当放大，128px 留更多安全边距。 */
const GLYPH_SCALE = { 16: 0.74, 32: 0.7, 48: 0.67, 128: 0.64 };
/** 逐尺寸描边：小图标适当加粗，避免 16px 下细线消失。 */
const SIZES = [
  { size: 16, stroke: 3.2 },
  { size: 32, stroke: 2.8 },
  { size: 48, stroke: 2.4 },
  { size: 128, stroke: 2.1 },
];

/**
 * 读取 Lucide SVG 的内部图形；源文件只保留路径，颜色与描边由生成脚本统一注入。
 * @returns {string}
 */
function readGlyph() {
  const svg = readFileSync(join(scriptsDir, 'icon-source.svg'), 'utf8');
  const match = svg.match(/<svg[^>]*>([\s\S]*?)<\/svg>/i);
  if (!match || !match[1].trim()) {
    throw new Error('scripts/icon-source.svg 缺少 <svg> 图形内容');
  }
  return match[1].trim();
}

/**
 * 合成一张目标尺寸的 SVG：圆角纯色底 + 居中的白色图形。
 * @param {string} glyph
 * @param {number} size
 * @param {number} stroke
 * @returns {string}
 */
function buildSvg(glyph, size, stroke) {
  const glyphSize = size * GLYPH_SCALE[size];
  const scale = glyphSize / 24;
  const offset = (size - glyphSize) / 2;
  const radius = size * 0.22;
  return `<svg xmlns="http://www.w3.org/2000/svg" width="${size}" height="${size}" viewBox="0 0 ${size} ${size}">
  <rect width="${size}" height="${size}" rx="${radius.toFixed(2)}" fill="${BACKGROUND}" />
  <g transform="translate(${offset.toFixed(2)} ${offset.toFixed(2)}) scale(${scale.toFixed(5)})"
     fill="none" stroke="#ffffff" stroke-width="${stroke}"
     stroke-linecap="round" stroke-linejoin="round">${glyph}</g>
</svg>`;
}

/**
 * 读取 PNG 的 IHDR，返回宽、高与颜色类型；用于生成后自检。
 * @param {Buffer} png
 * @returns {{ width: number, height: number, colorType: number }}
 */
function readPngSize(png) {
  const signature = png.subarray(0, 8).toString('hex');
  if (signature !== '89504e470d0a1a0a') throw new Error('输出不是 PNG');
  return {
    width: png.readUInt32BE(16),
    height: png.readUInt32BE(20),
    colorType: png[25],
  };
}

mkdirSync(outputDir, { recursive: true });
const glyph = readGlyph();

for (const { size, stroke } of SIZES) {
  const svg = buildSvg(glyph, size, stroke);
  const png = new Resvg(svg, { fitTo: { mode: 'width', value: size } }).render().asPng();
  const { width, height } = readPngSize(png);
  if (width !== size || height !== size) {
    throw new Error(`icon${size}.png 尺寸错误：${width}×${height}`);
  }
  writeFileSync(outputPath(size), png);
  console.log(`icon${size}.png ${width}×${height} ${png.length} bytes`);
}

console.log('icons generated');
