// @vitest-environment jsdom
/**
 * 设置页壳层、概览、数据管理与关于的组件测试（P8-3）
 *
 * 覆盖：默认进入概览、导航与哈希回退、状态卡片与警告、空状态、缓存统计与清空、
 *       关于页版本/配置版本/权限/诊断信息，以及窄屏与动效降级的样式契约。
 * 用 jsdom + react-dom/client + React act 渲染，不引入 Testing Library；
 * chrome API 由 tests/helpers/chrome.js，消息由 tests/helpers/options.jsx 应答。
 */

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { readFile } from 'node:fs/promises';
import { join } from 'node:path';
import {
  buttonTexts,
  click,
  createHarness,
  DEFAULT_CACHE_STATS,
  findButton,
  flush,
  mountOptions,
  setValue,
  unmountOptions,
} from '../helpers/options.jsx';
import { createInstance } from '../../src/shared/config/instances.js';
import { saveSettings } from '../../src/shared/settings.js';

/** @type {ReturnType<typeof createHarness>} */
let harness;

beforeEach(async () => {
  harness = createHarness();
  await saveSettings({ targetLang: 'zh', sourceLang: 'auto', logLevel: 'info' });
  const openai = await createInstance({
    type: 'openai',
    preset: 'deepseek',
    name: 'DeepSeek',
  });
  await harness.chrome.storage.local.set({ [`engineKey:${openai.id}`]: { apiKey: 'sk-test' } });
  await saveSettings({ activeInstanceId: openai.id });
});

afterEach(async () => {
  await unmountOptions(harness);
});

describe('设置页壳层与概览', () => {
  it('默认进入概览，显示当前翻译方式、语言、缓存、密钥、日志与实例健康', async () => {
    const container = await mountOptions(harness);

    expect(window.location.hash).toBe('#/overview');
    const text = container.textContent;
    expect(text).toContain('当前翻译方式');
    expect(text).toContain('DeepSeek');
    expect(text).toContain('自动检测 → 中文');
    expect(text).toContain('已配置 1 / 1 个实例');
    expect(text).toContain('仅本机');
    expect(text).toContain('实例健康');
    expect(text).toContain(`2.0 KB`);
    expect(text).toContain('12 条');
    expect(text).not.toContain('sk-test');
    expect(container.querySelector('nav[aria-label="设置分类"]')).toBeTruthy();
    expect(container.querySelector('[aria-current="page"]')?.textContent).toContain('概览');
  });

  it('导航切换分区并更新哈希，非法哈希回退概览', async () => {
    const container = await mountOptions(harness);

    await click(findButton('翻译实例', container));
    expect(window.location.hash).toBe('#/instances');
    expect(container.textContent).toContain('管理大模型与传统翻译实例');

    await click(findButton('通用设置', container));
    expect(window.location.hash).toBe('#/general');
    expect(container.textContent).toContain('开关与下拉改动会立即保存');

    window.location.hash = '#/nope';
    await flush();
    expect(window.location.hash).toBe('#/nope');
    expect(container.textContent).toContain('当前翻译方式');
  });

  it('没有实例时显示概览警告与空状态入口', async () => {
    await harness.chrome.storage.sync.set({ engineInstances: [] });
    await saveSettings({ activeInstanceId: null });
    const container = await mountOptions(harness);

    expect(container.textContent).toContain('还没有翻译实例');
    expect(container.textContent).toContain('新增翻译实例');
    await click(findButton('翻译实例', container));
    expect(container.textContent).toContain('还没有翻译实例');
    expect(buttonTexts(container).some((label) => label.includes('OpenAI 兼容（DeepSeek）'))).toBe(true);
    expect(buttonTexts(container).some((label) => label.includes('百度翻译'))).toBe(true);
  });

  it('当前实例缺密钥时显示警告与不可用状态', async () => {
    const data = await harness.chrome.storage.sync.get('engineInstances');
    await harness.chrome.storage.local.remove(`engineKey:${data.engineInstances[0].id}`);
    const container = await mountOptions(harness);

    expect(container.textContent).toContain('当前翻译方式缺少密钥');
    expect(container.textContent).toContain('不可用');
  });

  it('窄屏导航同时提供完整与短标签', async () => {
    const container = await mountOptions(harness);
    expect(container.querySelectorAll('.op-nav-full').length).toBe(6);
    expect(container.querySelectorAll('.op-nav-short').length).toBe(6);
  });
});

describe('数据管理', () => {
  it('显示缓存占用并可刷新', async () => {
    const container = await mountOptions(harness, '#/data');
    expect(container.textContent).toContain('2.0 KB');
    expect(container.textContent).toContain('1.0 GB');
    expect(container.textContent).toContain('12');

    const before = harness.calls.filter((type) => type === 'ST_CACHE_STATS').length;
    await click(findButton('刷新', container));
    const after = harness.calls.filter((type) => type === 'ST_CACHE_STATS').length;
    expect(after).toBeGreaterThan(before);
  });

  it('清空缓存需确认，成功后显示已清空条数', async () => {
    const container = await mountOptions(harness, '#/data');

    await click(findButton('清空缓存', container));
    expect(container.textContent).toContain('将删除全部译文缓存，不影响密钥、设置与实例配置');
    expect(container.textContent).toContain('此操作不可撤销');

    const confirm = [...container.querySelectorAll('.op-dialog button')].find(
      (button) => button.textContent.trim() === '清空缓存'
    );
    await click(confirm);

    expect(harness.calls).toContain('ST_CLEAR_CACHE');
    expect(container.textContent).toContain('已清空 12 条缓存');
  });

  it('缓存读取失败时显示不可用并可重试', async () => {
    harness.replies.cacheStats = { ok: false, error: { code: 'OTHER', message: '读取失败' } };
    const container = await mountOptions(harness, '#/data');
    expect(container.textContent).toContain('缓存占用暂不可用，请重试');

    harness.replies.cacheStats = { ok: true, data: DEFAULT_CACHE_STATS };
    await click(findButton('重试', container));
    expect(container.textContent).toContain('2.0 KB');
  });

  it('从概览快捷操作进入数据管理并打开清空确认，之后不再自动弹出', async () => {
    const container = await mountOptions(harness, '#/overview');
    await click(findButton('清空缓存', container));

    expect(window.location.hash).toBe('#/data');
    expect(container.textContent).toContain('清空全部译文缓存？');

    await click(findButton('取消', container));
    await click(findButton('概览', container));
    await click(findButton('数据管理', container));
    expect(container.textContent).not.toContain('清空全部译文缓存？');
  });
});

describe('关于', () => {
  it('显示版本、配置版本、权限与隐私说明', async () => {
    const container = await mountOptions(harness, '#/about');
    const text = container.textContent;

    expect(text).toContain('SimpleTrans');
    expect(text).toContain('0.1.0');
    expect(text).toContain('配置版本');
    expect(text).toContain('缓存数据库版本');
    expect(text).toContain('storage');
    expect(text).toContain('https://api.deepseek.com/*');
    expect(text).toContain('可选主机权限');
    expect(text).toContain('译文缓存只在本机，不上传');
  });

  it('复制诊断信息只含版本、计数与日志级别，不含密钥', async () => {
    const writeText = vi.fn().mockResolvedValue(undefined);
    Object.defineProperty(navigator, 'clipboard', {
      configurable: true,
      value: { writeText },
    });

    const container = await mountOptions(harness, '#/about');
    await click(findButton('复制诊断信息', container));

    expect(writeText).toHaveBeenCalledTimes(1);
    const copied = writeText.mock.calls[0][0];
    expect(copied).toContain('SimpleTrans 诊断信息');
    expect(copied).toContain('配置版本');
    expect(copied).toContain('实例数：1');
    expect(copied).toContain('日志级别');
    expect(copied).not.toContain('sk-test');
    expect(copied).not.toContain('https://api.deepseek.com');
    expect(container.textContent).toContain('已复制');
    delete navigator.clipboard;
  });

  it('诊断信息展示在页面内，便于手动复制', async () => {
    const container = await mountOptions(harness, '#/about');
    const pre = container.querySelector('pre');
    expect(pre?.textContent).toContain('SimpleTrans 诊断信息');
    expect(pre?.textContent).not.toContain('sk-test');
  });
});

describe('设置页样式契约', () => {
  it('窄屏断点、无固定宽度、允许长文本换行', async () => {
    const css = await readFile(join(process.cwd(), 'src/options/options.css'), 'utf8');

    expect(css).toMatch(/@media \(max-width: 899px\)/);
    expect(css).toMatch(/@media \(max-width: 599px\)/);
    expect(css).toMatch(/grid-template-columns: 220px minmax\(0, 1fr\)/);
    expect(css).toContain('overflow-wrap: anywhere');
    expect(css).toContain('min-width: 0');
    expect(css).not.toMatch(/width:\s*\d{3,}px;\s*\n\s*min-width:\s*\d{3,}px/);
  });

  it('提供减少动态效果降级与主题语义色', async () => {
    const css = await readFile(join(process.cwd(), 'src/options/options.css'), 'utf8');
    expect(css).toContain('@media (prefers-reduced-motion: reduce)');
    expect(css).toContain('var(--color-primary)');
    expect(css).not.toMatch(/color:\s*#(?:000|fff)\b/);
  });

  it('设置页挂载全局与页面样式', async () => {
    const main = await readFile(join(process.cwd(), 'src/options/main.jsx'), 'utf8');
    const shell = await readFile(join(process.cwd(), 'src/options/Options.jsx'), 'utf8');
    expect(main).toContain("import '../shared/global.css'");
    expect(shell).toContain("import './options.css'");
  });
});

describe('顶部保存状态', () => {
  it('有未保存的实例草稿时显示「有未保存更改」', async () => {
    const container = await mountOptions(harness, '#/instances');
    await click(findButton('编辑', container));
    const nameInput = container.querySelector('#ed-name');
    expect(nameInput).toBeTruthy();

    await setValue(nameInput, 'DeepSeek 改名');
    expect(container.textContent).toContain('有未保存更改');
  });
});
