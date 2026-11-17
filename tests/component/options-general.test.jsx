// @vitest-environment jsdom
/**
 * 设置页「通用设置」分区的组件测试（P8-3）
 *
 * 覆盖：启用开关、语言、缓存开关与日志级别的即时保存；保存失败回滚与行内错误；
 *       密钥存放位置切换的确认、迁移结果与失败保留。
 */

import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import {
  click,
  createHarness,
  findButton,
  mountOptions,
  readSettings,
  setValue,
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

    const selects = block(container, '语言').querySelectorAll('select');
    await setValue(selects[1], 'ja');

    const settings = await readSettings(harness);
    expect(settings.targetLang).toBe('ja');
    expect(container.textContent).toContain('当前：自动检测 → 日语');
  });

  it('日志级别即时保存', async () => {
    const container = await mountOptions(harness, '#/general');
    await setValue(block(container, '日志').querySelector('select'), 'debug');

    const settings = await readSettings(harness);
    expect(settings.logLevel).toBe('debug');
    expect(container.textContent).toContain('已保存');
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
    const targetSelect = block(container, '语言').querySelectorAll('select')[1];

    const originalSet = harness.chrome.storage.sync.set;
    harness.chrome.storage.sync.set = async () => {
      throw new Error('storage unavailable');
    };
    await setValue(targetSelect, 'ko');
    harness.chrome.storage.sync.set = originalSet;

    expect(targetSelect.value).toBe('zh');
    expect(container.textContent).toContain('保存失败，已恢复原值；请重试。');
    expect((await readSettings(harness)).targetLang).toBe('zh');
  });
});

describe('密钥存放位置', () => {
  it('切换前确认，确认后迁移凭据并更新设置', async () => {
    const container = await mountOptions(harness, '#/general');
    const syncOption = [...block(container, '密钥存放位置').querySelectorAll('.op-option-card')].find(
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
    const syncOption = [...block(container, '密钥存放位置').querySelectorAll('.op-option-card')].find(
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
