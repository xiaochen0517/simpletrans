#!/usr/bin/env node
/**
 * 冒烟门禁：在没有 Chrome 的环境里验证 dist/ 的产物契约。
 *
 * 断言矩阵（与 P0 需求文档 3.5 一致）：
 *   S1  清单声明的入口文件齐全
 *   S2  HTML 引用的资源齐全
 *   S3  清单与 package.json 版本一致
 *   S4  产物格式：content 为 IIFE、background 可被 import
 *   S5  content 产物不含密钥、引擎与签名相关词
 *   S6  content 产物不出现 storage.sync / storage.local
 *   S7  清单文案中性（不写死引擎名）
 *   S8  入口注册契约：background 注册 onMessage/onConnect 与快捷键监听并含 ST_ROUTE / ST_PAGE_SUBMIT（P6.1），
 *       content 连接 st-gateway 并含 ST_START / ST_PAGE_SUBMIT（P6.1），且均含 ST_LOG_CONFIG（P3 起）
 *   S9  产物新鲜度：dist 不早于 src / public / scripts
 *   S10 dist 缺失或不完整时给出单条可操作提示
 *   S11 popup / options 页面骨架含 #root 与 module script；testpage 含 #test-page 与 module script
 *   S12 关键产物存在、非空（P4 起 content.css 也必须非空）
 *
 * 运行：node scripts/smoke.mjs（需先 npm run build）。只读，不构建。
 */

import { readFile, readdir, stat } from 'node:fs/promises';
import { dirname, join, relative, sep } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import assert from 'node:assert/strict';

const projectRoot = dirname(dirname(fileURLToPath(import.meta.url)));
const distDir = join(projectRoot, 'dist');
const manifestPath = join(distDir, 'manifest.json');

/** content 产物中不允许出现的词：密钥字段、鉴权头、服务商域名、SDK 函数名。 */
const FORBIDDEN_IN_CONTENT = [
  'apiKey',
  'api_key',
  'Authorization',
  'Bearer ',
  'x-api-key',
  'sk-',
  'api.deepseek.com',
  'api.openai.com',
  'api.deepl.com',
  'fanyi-api.baidu.com',
  'api.youdao.com',
  'tmt.tencentcloudapi.com',
  'mt.cn-hangzhou.aliyuncs.com',
  '@ai-sdk/',
  'generateText',
  'streamText',
];

/** S7：清单描述里不写死引擎。 */
const ENGINE_NAMES = ['deepseek', 'openai', 'deepl', 'google', 'baidu', 'youdao', 'tencent', 'alibaba'];

const failures = [];

/**
 * @param {string} name
 * @param {() => Promise<void> | void} fn
 */
async function test(name, fn) {
  try {
    await fn();
    console.info(`  ✓ ${name}`);
  } catch (error) {
    failures.push({ name, error });
    console.error(`  ✗ ${name}`);
    console.error(`    ${error?.message ?? error}`);
  }
}

async function listFiles(dir, base = dir) {
  const out = [];
  for (const entry of await readdir(dir, { withFileTypes: true })) {
    const full = join(dir, entry.name);
    if (entry.isDirectory()) out.push(...(await listFiles(full, base)));
    else out.push(relative(base, full).split(sep).join('/'));
  }
  return out;
}

async function exists(path) {
  try {
    await stat(path);
    return true;
  } catch {
    return false;
  }
}

/** 把 HTML 里的引用解析为 dist 内的绝对路径；外链返回 null。 */
function resolveAsset(htmlPath, url) {
  if (/^(https?:|data:|#)/.test(url)) return null;
  const clean = url.split('?')[0].split('#')[0];
  if (!clean) return null;
  return clean.startsWith('/') ? join(distDir, clean) : join(dirname(htmlPath), clean);
}

function readHtmlAssets(html) {
  const assets = [];
  for (const match of html.matchAll(/<script[^>]+src="([^"]+)"/g)) assets.push(match[1]);
  for (const match of html.matchAll(/<link[^>]+href="([^"]+)"/g)) assets.push(match[1]);
  return assets;
}

// ------------------------------------------------------------------ 前置（S10）
if (!(await exists(distDir)) || !(await exists(manifestPath))) {
  console.error('请先构建：dist 缺失或不完整（缺少 dist/ 或 dist/manifest.json）。');
  console.error('修复：npm run build');
  process.exit(1);
}

const manifest = JSON.parse(await readFile(manifestPath, 'utf8'));
const packageJson = JSON.parse(await readFile(join(projectRoot, 'package.json'), 'utf8'));

// ------------------------------------------------------------------- S1 入口
await test('S1 清单声明的入口文件齐全', async () => {
  const declared = [
    manifest.action?.default_popup,
    manifest.options_page,
    manifest.background?.service_worker,
    ...(manifest.content_scripts ?? []).flatMap((item) => [...(item.js ?? []), ...(item.css ?? [])]),
    ...Object.values(manifest.icons ?? {}),
  ].filter(Boolean);

  const missing = [];
  for (const path of declared) {
    if (!(await exists(join(distDir, path)))) missing.push(path);
  }
  assert.deepEqual(missing, [], `缺少产物 ${missing.join('、')}，请检查构建`);
});

// --------------------------------------------------------------- S2 HTML 引用
await test('S2 HTML 引用的资源齐全', async () => {
  const pages = ['popup/index.html', 'options/index.html', 'testpage/index.html'];
  const missing = [];
  for (const page of pages) {
    const htmlPath = join(distDir, page);
    const html = await readFile(htmlPath, 'utf8');
    for (const url of readHtmlAssets(html)) {
      const target = resolveAsset(htmlPath, url);
      if (target && !(await exists(target))) missing.push(`${page} → ${url}`);
    }
  }
  assert.deepEqual(missing, [], `缺少 ${missing.join('、')}，页面可能白屏`);
});

// ---------------------------------------------------------------- S3 版本一致
await test('S3 清单与 package.json 版本一致', () => {
  assert.equal(manifest.version, packageJson.version, '清单与 package.json 版本不一致，请同步 version');
});

// ---------------------------------------------------------------- S4 产物格式
await test('S4 产物格式正确（content 为 IIFE，background 可 import）', async () => {
  const contentCode = await readFile(join(distDir, 'content.js'), 'utf8');
  // content 必须是 IIFE 单文件（无 ESM 语句）。
  if (contentCode.trim() !== '') {
    assert.match(contentCode.trimStart(), /^\(function/, 'content.js 不是 IIFE');
    assert.equal(/^\s*(import|export)\s/m.test(contentCode), false, 'content.js 含 ESM 语句，页面会无法执行');
  }

  // 后台顶层会注册监听器，导入前必须先装 chrome stub。
  const { installChrome } = await import(
    pathToFileURL(join(projectRoot, 'tests', 'helpers', 'chrome.js')).href
  );
  installChrome();
  // 入口会初始化日志并输出 logger.ready；冒烟只验证产物契约，临时静音。
  const muted = {
    debug: console.debug,
    info: console.info,
    warn: console.warn,
    error: console.error,
  };
  console.debug = () => {};
  console.info = () => {};
  console.warn = () => {};
  console.error = () => {};
  try {
    await import(pathToFileURL(join(distDir, 'background.js')).href);
    // 让 getSettings().finally 的 logger.ready 在静音窗口内跑完。
    await new Promise((resolve) => setTimeout(resolve, 0));
  } finally {
    Object.assign(console, muted);
  }
});

// -------------------------------------------------------------- S5 敏感信息
await test('S5 content 产物不含密钥、引擎与签名相关词', async () => {
  const code = await readFile(join(distDir, 'content.js'), 'utf8');
  const css = await readFile(join(distDir, 'content.css'), 'utf8');
  for (const word of FORBIDDEN_IN_CONTENT) {
    assert.equal(code.includes(word), false, `content.js 出现 ${word}`);
    assert.equal(css.includes(word), false, `content.css 出现 ${word}`);
  }
});

// ---------------------------------------------------------------- S6 存储边界
await test('S6 content 产物不直接读写 storage.sync / storage.local', async () => {
  const code = await readFile(join(distDir, 'content.js'), 'utf8');
  const css = await readFile(join(distDir, 'content.css'), 'utf8');
  assert.equal(/storage\.(sync|local)/.test(code), false, 'content.js 出现 storage.sync/local 字面量');
  assert.equal(/storage\.(sync|local)/.test(css), false, 'content.css 出现 storage.sync/local 字面量');
});

// ---------------------------------------------------------------- S7 文案中性
await test('S7 清单描述不写死引擎', () => {
  const text = String(manifest.description ?? '').toLowerCase();
  for (const name of ENGINE_NAMES) {
    assert.equal(text.includes(name), false, `description 含引擎名 ${name}`);
  }
});

// ------------------------------------------------------------ S8 入口注册
await test('S8 入口注册：background 注册 onMessage/onConnect/commands，content 连接 st-gateway', async () => {
  const background = await readFile(join(distDir, 'background.js'), 'utf8');
  const content = await readFile(join(distDir, 'content.js'), 'utf8');

  for (const token of [
    'chrome.runtime.onMessage',
    'chrome.runtime.onConnect',
    'chrome.commands.onCommand',
    'st-gateway',
    'ST_TRANSLATE_BATCH',
    'ST_TOGGLE',
    'ST_ROUTE',
    'ST_PAGE_SUBMIT',
    'ST_LOG_CONFIG',
  ]) {
    assert.equal(background.includes(token), true, `background.js 缺少入口注册 ${token}`);
  }
  for (const token of [
    'st-gateway',
    'ST_PING',
    'ST_TRANSLATE_BATCH',
    'ST_TOGGLE',
    'ST_START',
    'ST_PAGE_SUBMIT',
    'ST_LOG_CONFIG',
    'data-st-translation',
  ]) {
    assert.equal(content.includes(token), true, `content.js 缺少页面通道 ${token}`);
  }
});

// ------------------------------------------------------------ S9 产物新鲜度
await test('S9 产物不早于源码', async () => {
  // 只比较 Vite 生成的产物：icons/ 与 manifest.json 是从 public/ 复制的，
  // 复制会保留源文件的修改时间，不能用来判断构建是否过期。
  const builtFiles = (await listFiles(distDir)).filter(
    (file) => !file.startsWith('icons/') && file !== 'manifest.json'
  );
  const builtTimes = [];
  for (const file of builtFiles) {
    builtTimes.push((await stat(join(distDir, file))).mtimeMs);
  }

  const watched = ['src', 'public'];
  const srcTimes = [];
  for (const dir of watched) {
    for (const file of await listFiles(join(projectRoot, dir))) {
      srcTimes.push((await stat(join(projectRoot, dir, file))).mtimeMs);
    }
  }
  for (const file of ['vite.config.js', 'vitest.config.js', 'scripts/build.mjs']) {
    if (await exists(join(projectRoot, file))) srcTimes.push((await stat(join(projectRoot, file))).mtimeMs);
  }

  const newestSrc = Math.max(...srcTimes);
  const oldestBuilt = Math.min(...builtTimes);
  assert.ok(oldestBuilt + 1000 >= newestSrc, '产物早于源码，请先 npm run build');

  const distManifest = (await stat(manifestPath)).mtimeMs;
  const srcManifest = (await stat(join(projectRoot, 'public', 'manifest.json'))).mtimeMs;
  assert.ok(distManifest + 1000 >= srcManifest, 'dist/manifest.json 早于 public/manifest.json，请先 npm run build');
});

// ---------------------------------------------------------- S11 页面骨架
await test('S11 popup / options / testpage 页面骨架完整', async () => {
  const pages = [
    { path: 'popup/index.html', root: 'id="root"', label: '#root 挂载点' },
    { path: 'options/index.html', root: 'id="root"', label: '#root 挂载点' },
    { path: 'testpage/index.html', root: 'id="test-page"', label: '#test-page 夹具容器' },
  ];
  for (const page of pages) {
    const html = await readFile(join(distDir, page.path), 'utf8');
    assert.equal(html.includes(page.root), true, `${page.path} 缺少 ${page.label}`);
    assert.match(
      html,
      /<script[^>]+type="module"[^>]+src=/,
      `${page.path} 缺少 module script`
    );
  }
});

// ---------------------------------------------------------------- S12 非空
await test('S12 入口产物与 CSS 存在且非空', async () => {
  for (const file of ['background.js', 'content.js', 'content.css']) {
    const info = await stat(join(distDir, file));
    assert.ok(info.isFile(), `${file} 不是文件`);
    assert.ok(info.size > 0, `${file} 为空，P4 起入口与译文样式必须有内容`);
  }
});

// ------------------------------------------------------------------------ 汇总
console.info('');
if (failures.length > 0) {
  console.error(`冒烟测试失败：${failures.length} 项`);
  process.exitCode = 1;
} else {
  console.info('冒烟测试通过（11 项）');
}
