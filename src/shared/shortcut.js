/**
 * E6 快捷键
 *
 * 模块：公共模块（E）/ 快捷键
 * 职责：定义悬停翻译快捷键的枚举、归一、显示文案与平台按键映射，以及整页命令名与浏览器命令快捷键读取；
 *       不读写 storage，页面注入、后台、设置页与弹窗共用同一套字符串。
 * 依赖：无（`readCommandShortcut` 使用 `chrome.commands`，只在弹窗与设置页调用）。
 * 实现阶段：P12（翻译快捷键配置）
 */

/** 悬停翻译可选的修饰键。 */
export const HOVER_SHORTCUTS = Object.freeze(['ctrl', 'alt', 'shift', 'command']);

/** 悬停翻译默认修饰键。 */
export const DEFAULT_HOVER_SHORTCUT = 'ctrl';

/** 整页翻译命令名，与清单 `commands` 保持一致。 */
export const COMMAND_TRANSLATE_PAGE = 'translate-page';

/** 修饰键 → 界面文案。 */
const SHORTCUT_LABELS = Object.freeze({
  ctrl: 'Ctrl',
  alt: 'Alt',
  shift: 'Shift',
  command: 'Command',
});

/**
 * 归一悬停快捷键：只接受四个枚举值，其余一律回退默认。
 * @param {unknown} value
 * @returns {'ctrl'|'alt'|'shift'|'command'}
 */
export function normalizeHoverShortcut(value) {
  return HOVER_SHORTCUTS.includes(value) ? value : DEFAULT_HOVER_SHORTCUT;
}

/**
 * 悬停快捷键的界面文案。
 * @param {unknown} value
 * @returns {string}
 */
export function hoverShortcutLabel(value) {
  return SHORTCUT_LABELS[normalizeHoverShortcut(value)];
}

/**
 * 当前是否 macOS；Node 环境或 navigator 不可用时按非 macOS 处理。
 * @returns {boolean}
 */
export function isMacPlatform() {
  if (typeof navigator === 'undefined') return false;
  return /Mac/i.test(navigator.platform || navigator.userAgent || '');
}

/**
 * 解析悬停快捷键在当前平台的生效值与需要监听的按键。
 * `command` 只在 macOS 生效，其它平台回退 `ctrl`；macOS 的 `ctrl` 兼容旧行为，
 * 同时接受 Control 与 Meta 单键。
 * @param {unknown} value
 * @param {boolean} [isMac]
 * @returns {{ shortcut: 'ctrl'|'alt'|'shift'|'command', label: string, keys: string[] }}
 */
export function resolveHoverShortcut(value, isMac = isMacPlatform()) {
  const normalized = normalizeHoverShortcut(value);

  if (normalized === 'command') {
    if (!isMac) return { shortcut: 'ctrl', label: 'Ctrl', keys: ['Control'] };
    return { shortcut: 'command', label: 'Command', keys: ['Meta'] };
  }
  if (normalized === 'ctrl') {
    return { shortcut: 'ctrl', label: 'Ctrl', keys: isMac ? ['Control', 'Meta'] : ['Control'] };
  }
  if (normalized === 'alt') {
    return { shortcut: 'alt', label: 'Alt', keys: ['Alt'] };
  }
  return { shortcut: 'shift', label: 'Shift', keys: ['Shift'] };
}

/**
 * 读取浏览器扩展命令的当前快捷键；未绑定返回空串，读取失败返回 `ok: false`。
 * @param {string} name 清单 `commands` 中的命令名
 * @returns {Promise<{ ok: true, shortcut: string } | { ok: false }>}
 */
export async function readCommandShortcut(name) {
  const commands = globalThis.chrome?.commands;
  if (!commands?.getAll) return { ok: false };
  try {
    const list = await commands.getAll();
    const found = Array.isArray(list)
      ? list.find((command) => command?.name === name) ?? null
      : null;
    return {
      ok: true,
      shortcut: typeof found?.shortcut === 'string' ? found.shortcut : '',
    };
  } catch {
    return { ok: false };
  }
}
