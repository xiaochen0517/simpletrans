/**
 * E2 设置测试（P8-2 schema v2）
 *
 * 覆盖默认值、枚举归一、未知字段保留、configVersion、keyStorage 与语言目录。
 */

import { beforeEach, describe, expect, it } from 'vitest';
import { installChrome } from '../helpers/load.js';
import {
  CONFIG_VERSION,
  DEFAULT_SETTINGS,
  getSettings,
  keyArea,
  normalizeKeyStorage,
  normalizeSettings,
  saveSettings,
} from '../../src/shared/settings.js';

beforeEach(() => {
  installChrome();
});

describe('E2 设置 schema v2', () => {
  it('默认设置包含 configVersion，且不含 concurrency', () => {
    expect(DEFAULT_SETTINGS.configVersion).toBe(CONFIG_VERSION);
    expect(CONFIG_VERSION).toBe(2);
    expect(DEFAULT_SETTINGS).not.toHaveProperty('concurrency');
    expect(DEFAULT_SETTINGS.sourceLang).toBe('auto');
    expect(DEFAULT_SETTINGS.targetLang).toBe('zh');
    expect(DEFAULT_SETTINGS.keyStorage).toBe('local');
    expect(DEFAULT_SETTINGS.activeInstanceId).toBeNull();
  });

  it('默认值合并：缺字段补默认，不丢未知字段', async () => {
    await chrome.storage.sync.set({ settings: { targetLang: 'ja', extra: 'keep', concurrency: 5 } });
    const settings = await getSettings();
    expect(settings.targetLang).toBe('ja');
    expect(settings.extra).toBe('keep');
    expect(settings.concurrency).toBe(5);
    expect(settings.configVersion).toBe(CONFIG_VERSION);
    expect(settings.cacheEnabled).toBe(true);
  });

  it('非法枚举与类型归一：语言、开关、keyStorage、activeInstanceId', () => {
    const settings = normalizeSettings({
      sourceLang: 'ko',
      targetLang: 'fr',
      enabled: 'false',
      cacheEnabled: 0,
      keyStorage: 'cloud',
      activeInstanceId: '  ',
      configVersion: 'x',
      logLevel: '',
    });
    expect(settings.sourceLang).toBe('auto');
    expect(settings.targetLang).toBe('zh');
    expect(settings.enabled).toBe(false);
    expect(settings.cacheEnabled).toBe(true);
    expect(settings.keyStorage).toBe('local');
    expect(settings.activeInstanceId).toBeNull();
    expect(settings.configVersion).toBe(CONFIG_VERSION);
    expect(settings.logLevel).toBe('info');
  });

  it('四目标语言与两源语言都保留', () => {
    for (const targetLang of ['zh', 'en', 'ja', 'ko']) {
      expect(normalizeSettings({ targetLang }).targetLang).toBe(targetLang);
    }
    for (const sourceLang of ['auto', 'en']) {
      expect(normalizeSettings({ sourceLang }).sourceLang).toBe(sourceLang);
    }
  });

  it('saveSettings 合并写回并返回完整设置', async () => {
    await saveSettings({ targetLang: 'en' });
    const settings = await getSettings();
    expect(settings.targetLang).toBe('en');
    expect(settings.logLevel).toBe('info');
    expect(settings.configVersion).toBe(CONFIG_VERSION);
  });

  it('keyStorage 归一：只认 sync，其余一律 local', () => {
    expect(normalizeKeyStorage('sync')).toBe('sync');
    expect(normalizeKeyStorage('local')).toBe('local');
    expect(normalizeKeyStorage('cloud')).toBe('local');
    expect(normalizeKeyStorage(undefined)).toBe('local');
  });

  it('keyArea 按 keyStorage 归一返回分区', async () => {
    expect(await keyArea()).toBe('local');
    await saveSettings({ keyStorage: 'sync' });
    expect(await keyArea()).toBe('sync');
    await saveSettings({ keyStorage: 'nope' });
    expect(await keyArea()).toBe('local');
  });
});
