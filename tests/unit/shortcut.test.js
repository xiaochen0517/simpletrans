/**
 * E6 快捷键测试
 *
 * 覆盖悬停快捷键归一、显示、平台按键映射，以及浏览器命令快捷键读取。
 */

import { beforeEach, describe, expect, it } from 'vitest';
import { installChrome } from '../helpers/load.js';
import {
  COMMAND_TRANSLATE_PAGE,
  DEFAULT_HOVER_SHORTCUT,
  HOVER_SHORTCUTS,
  hoverShortcutLabel,
  normalizeHoverShortcut,
  readCommandShortcut,
  resolveHoverShortcut,
} from '../../src/shared/shortcut.js';

beforeEach(() => {
  installChrome();
});

describe('E6 悬停快捷键', () => {
  it('枚举、默认值与归一', () => {
    expect(HOVER_SHORTCUTS).toEqual(['ctrl', 'alt', 'shift', 'command']);
    expect(DEFAULT_HOVER_SHORTCUT).toBe('ctrl');
    expect(normalizeHoverShortcut('ctrl')).toBe('ctrl');
    expect(normalizeHoverShortcut('alt')).toBe('alt');
    expect(normalizeHoverShortcut('shift')).toBe('shift');
    expect(normalizeHoverShortcut('command')).toBe('command');
    expect(normalizeHoverShortcut('Command')).toBe('ctrl');
    expect(normalizeHoverShortcut('meta')).toBe('ctrl');
    expect(normalizeHoverShortcut(undefined)).toBe('ctrl');
  });

  it('显示文案', () => {
    expect(hoverShortcutLabel('ctrl')).toBe('Ctrl');
    expect(hoverShortcutLabel('alt')).toBe('Alt');
    expect(hoverShortcutLabel('shift')).toBe('Shift');
    expect(hoverShortcutLabel('command')).toBe('Command');
    expect(hoverShortcutLabel('nope')).toBe('Ctrl');
  });

  it('非 macOS 按键映射', () => {
    expect(resolveHoverShortcut('ctrl', false)).toEqual({
      shortcut: 'ctrl',
      label: 'Ctrl',
      keys: ['Control'],
    });
    expect(resolveHoverShortcut('alt', false)).toEqual({
      shortcut: 'alt',
      label: 'Alt',
      keys: ['Alt'],
    });
    expect(resolveHoverShortcut('shift', false)).toEqual({
      shortcut: 'shift',
      label: 'Shift',
      keys: ['Shift'],
    });
    // Command 只在 macOS 可用，其它平台回退 Ctrl。
    expect(resolveHoverShortcut('command', false)).toEqual({
      shortcut: 'ctrl',
      label: 'Ctrl',
      keys: ['Control'],
    });
  });

  it('macOS 按键映射：Ctrl 兼容 Command，Command 只认 Meta', () => {
    expect(resolveHoverShortcut('ctrl', true)).toEqual({
      shortcut: 'ctrl',
      label: 'Ctrl',
      keys: ['Control', 'Meta'],
    });
    expect(resolveHoverShortcut('command', true)).toEqual({
      shortcut: 'command',
      label: 'Command',
      keys: ['Meta'],
    });
  });

  it('读取浏览器命令快捷键：已绑定、未绑定、找不到与读取失败', async () => {
    expect(await readCommandShortcut(COMMAND_TRANSLATE_PAGE)).toEqual({
      ok: true,
      shortcut: 'Ctrl+Shift+Y',
    });

    chrome.commands.__shortcuts = [
      { name: 'translate-page', shortcut: '', description: '翻译整页' },
    ];
    expect(await readCommandShortcut(COMMAND_TRANSLATE_PAGE)).toEqual({
      ok: true,
      shortcut: '',
    });

    expect(await readCommandShortcut('unknown-command')).toEqual({ ok: true, shortcut: '' });

    chrome.commands.__error = new Error('not available');
    expect(await readCommandShortcut(COMMAND_TRANSLATE_PAGE)).toEqual({ ok: false });

    delete globalThis.chrome.commands;
    expect(await readCommandShortcut(COMMAND_TRANSLATE_PAGE)).toEqual({ ok: false });
  });
});
