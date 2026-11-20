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
  POPUP_DEFAULT_TABS,
  THEMES,
  getSettings,
  keyArea,
  normalizeKeyStorage,
  normalizePopupDefaultTab,
  normalizeSettings,
  normalizeTheme,
  resolveTheme,
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
    expect(DEFAULT_SETTINGS.popupDefaultTab).toBe('default');
    expect(DEFAULT_SETTINGS.theme).toBe('system');
    expect(DEFAULT_SETTINGS.hoverShortcut).toBe('ctrl');
    expect(POPUP_DEFAULT_TABS).toEqual(['default', 'quick']);
    expect(THEMES).toEqual(['system', 'light', 'dark']);
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
      hoverShortcut: 'meta',
    });
    expect(settings.sourceLang).toBe('auto');
    expect(settings.targetLang).toBe('zh');
    expect(settings.enabled).toBe(false);
    expect(settings.cacheEnabled).toBe(true);
    expect(settings.keyStorage).toBe('local');
    expect(settings.activeInstanceId).toBeNull();
    expect(settings.configVersion).toBe(CONFIG_VERSION);
    expect(settings.logLevel).toBe('info');
    expect(settings.hoverShortcut).toBe('ctrl');
  });

  it('悬停快捷键：四个合法值保留，缺失与非法值回退 ctrl，并可保存读取', async () => {
    for (const value of ['ctrl', 'alt', 'shift', 'command']) {
      expect(normalizeSettings({ hoverShortcut: value }).hoverShortcut).toBe(value);
    }
    expect(normalizeSettings({}).hoverShortcut).toBe('ctrl');
    expect(normalizeSettings({ hoverShortcut: 'Command' }).hoverShortcut).toBe('ctrl');

    await saveSettings({ hoverShortcut: 'alt' });
    expect((await getSettings()).hoverShortcut).toBe('alt');
    await saveSettings({ hoverShortcut: 'nope' });
    expect((await getSettings()).hoverShortcut).toBe('ctrl');
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

  it('popupDefaultTab 保存后读取', async () => {
    await saveSettings({ popupDefaultTab: 'quick' });
    expect((await getSettings()).popupDefaultTab).toBe('quick');
    await saveSettings({ popupDefaultTab: 'nope' });
    expect((await getSettings()).popupDefaultTab).toBe('default');
  });

  it('keyStorage 归一：只认 sync，其余一律 local', () => {
    expect(normalizeKeyStorage('sync')).toBe('sync');
    expect(normalizeKeyStorage('local')).toBe('local');
    expect(normalizeKeyStorage('cloud')).toBe('local');
    expect(normalizeKeyStorage(undefined)).toBe('local');
  });

  it('弹窗初始页：只认 quick，其余回退 default，并可保存读取', () => {
    expect(normalizePopupDefaultTab('quick')).toBe('quick');
    expect(normalizePopupDefaultTab('default')).toBe('default');
    expect(normalizePopupDefaultTab('nope')).toBe('default');
    expect(normalizePopupDefaultTab(undefined)).toBe('default');
    expect(normalizeSettings({ popupDefaultTab: 'quick' }).popupDefaultTab).toBe('quick');
  });

  it('主题：system / light / dark 归一，system 跟随系统', () => {
    expect(normalizeTheme('light')).toBe('light');
    expect(normalizeTheme('dark')).toBe('dark');
    expect(normalizeTheme('system')).toBe('system');
    expect(normalizeTheme('nope')).toBe('system');
    expect(normalizeTheme(undefined)).toBe('system');

    expect(resolveTheme('light', true)).toBe('light');
    expect(resolveTheme('dark', false)).toBe('dark');
    expect(resolveTheme('system', true)).toBe('dark');
    expect(resolveTheme('system', false)).toBe('light');
    expect(normalizeSettings({ theme: 'dark' }).theme).toBe('dark');
  });

  it('keyArea 按 keyStorage 归一返回分区', async () => {
    expect(await keyArea()).toBe('local');
    await saveSettings({ keyStorage: 'sync' });
    expect(await keyArea()).toBe('sync');
    await saveSettings({ keyStorage: 'nope' });
    expect(await keyArea()).toBe('local');
  });
});
