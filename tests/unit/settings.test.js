/**
 * E2 设置与密钥存放位置测试
 */

import { beforeEach, describe, expect, it } from 'vitest';
import { installChrome } from '../helpers/load.js';
import { DEFAULT_SETTINGS, getSettings, keyArea, normalizeKeyStorage, saveSettings } from '../../src/shared/settings.js';

describe('E2 设置', () => {
  beforeEach(() => installChrome());

  it('默认值合并：缺字段补默认，不丢未知字段', async () => {
    await chrome.storage.sync.set({ settings: { targetLang: 'ja', extra: 1 } });
    const settings = await getSettings();
    expect(settings.targetLang).toBe('ja');
    expect(settings.enabled).toBe(DEFAULT_SETTINGS.enabled);
    expect(settings.extra).toBe(1);
  });

  it('默认日志级别为 info', async () => {
    expect((await getSettings()).logLevel).toBe('info');
    const saved = await saveSettings({ logLevel: 'debug' });
    expect(saved.logLevel).toBe('debug');
  });

  it('saveSettings 合并写回并返回完整设置', async () => {
    const saved = await saveSettings({ concurrency: 5 });
    expect(saved.concurrency).toBe(5);
    expect((await getSettings()).concurrency).toBe(5);
  });

  it('keyStorage 归一：只认 sync，其余一律 local', () => {
    expect(normalizeKeyStorage('sync')).toBe('sync');
    expect(normalizeKeyStorage('local')).toBe('local');
    expect(normalizeKeyStorage('bogus')).toBe('local');
    expect(normalizeKeyStorage(undefined)).toBe('local');
  });

  it('keyArea 按 keyStorage 归一返回分区', async () => {
    expect(await keyArea()).toBe('local');
    await saveSettings({ keyStorage: 'sync' });
    expect(await keyArea()).toBe('sync');
  });
});
