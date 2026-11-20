// @vitest-environment jsdom
/**
 * 设置页「通用设置」分区的组件测试（P8-3）
 *
 * 覆盖：启用开关、语言、缓存开关与日志级别的即时保存；保存失败回滚与行内错误；
 *       密钥存放位置切换的确认、迁移结果与失败保留。
 */

import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import {
  chooseOption,
  click,
  createHarness,
  findButton,
  findSelect,
  mountOptions,
  readSettings,
  unmountOptions,
} from '../helpers/options.jsx';
import { createInstance, writeCredentials } from '../../src/shared/config/instances.js';
import { saveSettings } from '../../src/shared/settings.js';

/** @type {ReturnType<typeof createHarness>} */
let harness;
/** @type {Record<string, any>} */
let instance;

beforeEach(async () => {
  harness = createHarness();
  await saveSettings({ targetLang: 'zh', sourceLang: 'auto', logLevel: 'info' });
  instance = await createInstance({ type: 'openai', preset: 'deepseek', name: 'DeepSeek' });
  await writeCredentials(instance.id, { apiKey: 'sk-general' });
  await saveSettings({ activeInstanceId: instance.id });
});

afterEach(async () => {
  await unmountOptions(harness);
});

/** 取某个区块。 */
function block(container, label) {
  return container.querySelector(`section[aria-label="${label}"]`);
}

describe('即时保存', () => {
  it('语言下拉即时保存并显示当前语言', async () => {
    const container = await mountOptions(harness, '#/general');
    expect(container.textContent).toContain('当前：自动检测 → 中文');

    await chooseOption('目标语言', '日语', container);

    const settings = await readSettings(harness);
    expect(settings.targetLang).toBe('ja');
    expect(container.textContent).toContain('当前：自动检测 → 日语');
  });

  it('日志级别即时保存', async () => {
    const container = await mountOptions(harness, '#/general');
    await chooseOption('日志级别', '详细', container);

    const settings = await readSettings(harness);
    expect(settings.logLevel).toBe('debug');
    expect(container.textContent).toContain('已保存');
  });

  it('弹窗初始页即时保存', async () => {
    const container = await mountOptions(harness, '#/general');
    expect(container.querySelector('section[aria-label="弹窗"]')).toBeTruthy();
    expect(container.textContent).toContain('打开时显示');

    await chooseOption('弹窗打开时显示', '快速翻译页面', container);

    const settings = await readSettings(harness);
    expect(settings.popupDefaultTab).toBe('quick');
    expect(findSelect('弹窗打开时显示', container).textContent).toContain('快速翻译页面');
  });

  it('缓存开关即时保存', async () => {
    const container = await mountOptions(harness, '#/general');
    await click(container.querySelector('input[aria-label="启用译文缓存"]'));

    const settings = await readSettings(harness);
    expect(settings.cacheEnabled).toBe(false);
  });

  it('启用开关即时保存', async () => {
    const container = await mountOptions(harness, '#/general');
    await click(container.querySelector('input[aria-label="启用扩展"]'));

    const settings = await readSettings(harness);
    expect(settings.enabled).toBe(false);
  });

  it('保存失败时回滚到原值并显示行内错误', async () => {
    const container = await mountOptions(harness, '#/general');

    const originalSet = harness.chrome.storage.sync.set;
    harness.chrome.storage.sync.set = async () => {
      throw new Error('storage unavailable');
    };
    await chooseOption('目标语言', '韩语', container);
    harness.chrome.storage.sync.set = originalSet;

    expect(findSelect('目标语言', container)?.querySelector('summary').textContent).toContain('中文');
    expect(container.textContent).toContain('保存失败，已恢复原值；请重试。');
    expect((await readSettings(harness)).targetLang).toBe('zh');
  });
});

describe('快捷键', () => {
  it('悬停快捷键即时保存并提示刷新后生效', async () => {
    const container = await mountOptions(harness, '#/general');
    expect(block(container, '快捷键')).toBeTruthy();

    await chooseOption('悬停翻译快捷键', 'Alt', container);

    expect((await readSettings(harness)).hoverShortcut).toBe('alt');
    expect(container.textContent).toContain('已保存；刷新网页后生效');
  });

  it('显示整页当前快捷键并可打开浏览器快捷键设置页', async () => {
    const container = await mountOptions(harness, '#/general');
    expect(container.textContent).toContain('Ctrl+Shift+Y');

    await click(findButton('打开浏览器快捷键设置', container));

    expect(harness.chrome.tabs.__created).toContainEqual({
      url: 'chrome://extensions/shortcuts',
    });
  });

  it('整页快捷键未绑定时显示「未设置」', async () => {
    harness.chrome.commands.__shortcuts = [
      { name: 'translate-page', shortcut: '', description: '翻译整页' },
    ];
    const container = await mountOptions(harness, '#/general');

    expect(container.textContent).toContain('未设置');
  });

  it('读取整页快捷键失败时显示「读取失败」', async () => {
    harness.chrome.commands.__error = new Error('not available');
    const container = await mountOptions(harness, '#/general');

    expect(container.textContent).toContain('读取失败');
  });

  it('打开浏览器快捷键设置失败时显示行内提示', async () => {
    const container = await mountOptions(harness, '#/general');
    harness.chrome.tabs.create = async () => {
      throw new Error('cannot open');
    };

    await click(findButton('打开浏览器快捷键设置', container));

    expect(container.textContent).toContain('无法打开浏览器快捷键设置');
  });
});

describe('密钥存放位置', () => {
  it('切换前确认，确认后迁移凭据并更新设置', async () => {
    const container = await mountOptions(harness, '#/general');
    const syncOption = [...block(container, '密钥存放位置').querySelectorAll('button[aria-pressed]')].find(
      (card) => card.textContent.includes('跟随账号同步')
    );
    await click(syncOption);

    expect(container.textContent).toContain('将把全部实例的密钥迁移到账号同步存储');
    expect(container.textContent).toContain('密钥会随账号同步到其他设备');

    await click(findButton('开始迁移', container));

    const settings = await readSettings(harness);
    expect(settings.keyStorage).toBe('sync');
    const syncData = await harness.chrome.storage.sync.get(`engineKey:${instance.id}`);
    expect(syncData[`engineKey:${instance.id}`]).toEqual({ apiKey: 'sk-general' });
    const localData = await harness.chrome.storage.local.get(`engineKey:${instance.id}`);
    expect(localData[`engineKey:${instance.id}`]).toBeUndefined();
    expect(container.textContent).toContain('已切换密钥存放位置');
  });

  it('迁移失败时保留原数据与设置', async () => {
    const container = await mountOptions(harness, '#/general');
    const syncOption = [...block(container, '密钥存放位置').querySelectorAll('button[aria-pressed]')].find(
      (card) => card.textContent.includes('跟随账号同步')
    );
    await click(syncOption);

    const originalSet = harness.chrome.storage.sync.set;
    harness.chrome.storage.sync.set = async (values) => {
      if (values?.settings?.keyStorage) throw new Error('sync unavailable');
      return originalSet(values);
    };
    await click(findButton('开始迁移', container));
    harness.chrome.storage.sync.set = originalSet;

    expect(container.textContent).toContain('切换失败，已保留原来的数据与设置。');
    expect((await readSettings(harness)).keyStorage).toBe('local');
    const localData = await harness.chrome.storage.local.get(`engineKey:${instance.id}`);
    expect(localData[`engineKey:${instance.id}`]).toEqual({ apiKey: 'sk-general' });
  });
});
