/**
 * C 设置页共享工具
 *
 * 模块：插件独立页面（C）/ 设置页
 * 职责：提供设置页分区共用的应用上下文、后台一次性消息、字节/条数格式化、实例类型与状态文案、
 *       域名权限申请、测试页打开与浏览器扩展快捷键设置页跳转；不含任何凭据读写。
 * 依赖：React（Context）、E1（protocol）、E3（host-permission 的 origin 匹配模式）、`constants.js` 公共数值。
 * 实现阶段：P8-3（设置页内容分类与 UI 规范化）；P12 增加浏览器快捷键设置页跳转。
 *
 * 约定：只读 `ST_LIST_ENGINES` 返回的公开字段，不接触凭据明文；实例写入一律经 E3 的 CRUD 函数，
 * 由壳层统一串行并在完成后重新拉取列表。
 */

import { createContext, useContext } from 'react';
import { getOriginPattern } from '../shared/config/host-permission.js';
import { MAX_SEGMENT_CHARS } from '../shared/constants.js';

/** 设置页分区定义；顺序即导航顺序，`path` 即哈希路由。 */
export const ROUTES = Object.freeze([
  { id: 'overview', path: '#/overview', label: '概览', short: '概览' },
  { id: 'instances', path: '#/instances', label: '翻译实例', short: '实例' },
  { id: 'general', path: '#/general', label: '通用设置', short: '通用' },
  { id: 'test', path: '#/test', label: '测试翻译', short: '测试' },
  { id: 'data', path: '#/data', label: '数据管理', short: '数据' },
  { id: 'about', path: '#/about', label: '关于', short: '关于' },
]);

/** 默认分区。 */
export const DEFAULT_ROUTE = 'overview';

/** 实例预设显示名。 */
export const PRESET_LABELS = Object.freeze({
  deepseek: 'DeepSeek',
  custom: '自定义',
});

/** 认证方式显示名。 */
export const AUTH_LABELS = Object.freeze({
  bearer: 'Bearer',
  header: '自定义 Header',
  query: 'Query 参数',
  none: '无认证',
});

/** 思考参数模式显示名。 */
export const REASONING_MODE_LABELS = Object.freeze({
  none: '关闭',
  effort: '强度',
  budget: '预算',
  toggle: '开关',
});

/** 百度实例的固定模型说明。 */
export const BAIDU_MODEL_LABEL = '通用文本翻译';

/** 测试翻译单次字符上限，与页面提交一致。 */
export const TEST_TEXT_MAX_CHARS = MAX_SEGMENT_CHARS;

/** 应用上下文：壳层向分区提供数据、写操作与导航。 */
export const AppContext = createContext(null);

/**
 * 读取设置页应用上下文；不在壳层内调用时抛出，便于尽早发现接线错误。
 * @returns {Record<string, any>}
 */
export function useApp() {
  const value = useContext(AppContext);
  if (!value) throw new Error('设置页上下文缺失');
  return value;
}

/**
 * 发一条一次性消息；后台不可用时归一为 NETWORK，返回统一结构。
 * @param {string} type
 * @param {object} [payload]
 * @returns {Promise<{ ok: boolean, data?: any, error?: { code?: string, message?: string } }>}
 */
export async function sendToBackground(type, payload) {
  if (!globalThis.chrome?.runtime?.sendMessage) {
    return { ok: false, error: { code: 'NETWORK', message: '扩展未就绪，请重新打开设置页' } };
  }
  try {
    const response = await chrome.runtime.sendMessage({ type, payload });
    return response ?? { ok: false, error: { code: 'OTHER', message: '后台没有返回结果' } };
  } catch {
    return { ok: false, error: { code: 'NETWORK', message: '无法连接后台，请稍后重试' } };
  }
}

/**
 * 打开 C6 翻译测试页；失败返回可显示的原因。
 * @returns {Promise<{ ok: boolean, message?: string }>}
 */
export async function openTestPage() {
  const runtime = globalThis.chrome?.runtime;
  const tabs = globalThis.chrome?.tabs;
  if (!runtime?.getURL || !tabs?.create) {
    return { ok: false, message: '扩展未就绪，无法打开测试页' };
  }
  try {
    await tabs.create({ url: runtime.getURL('testpage/index.html') });
    return { ok: true };
  } catch {
    return { ok: false, message: '无法打开翻译测试页，请重试' };
  }
}

/**
 * 打开 Chrome 的扩展快捷键设置页；失败返回可显示的原因。
 * @returns {Promise<{ ok: boolean, message?: string }>}
 */
export async function openBrowserShortcutSettings() {
  const tabs = globalThis.chrome?.tabs;
  if (!tabs?.create) {
    return { ok: false, message: '扩展未就绪，无法打开浏览器快捷键设置' };
  }
  try {
    await tabs.create({ url: 'chrome://extensions/shortcuts' });
    return { ok: true };
  } catch {
    return {
      ok: false,
      message: '无法打开浏览器快捷键设置，请手动打开 chrome://extensions/shortcuts',
    };
  }
}

/**
 * 申请 endpoint 域名的主机权限；必须在用户手势（点击）中调用。
 * @param {unknown} baseUrl
 * @returns {Promise<{ ok: boolean, pattern?: string, message?: string }>}
 */
export async function requestOriginPermission(baseUrl) {
  const pattern = getOriginPattern(baseUrl);
  if (!pattern) {
    return { ok: false, message: '接口地址无效，无法申请域名权限' };
  }
  const permissions = globalThis.chrome?.permissions;
  if (!permissions?.request) {
    return { ok: false, pattern, message: '当前环境不支持申请域名权限' };
  }
  try {
    const granted = await permissions.request({ origins: [pattern] });
    return granted
      ? { ok: true, pattern }
      : { ok: false, pattern, message: '未获得域名授权，实例会标记为未授权' };
  } catch {
    return { ok: false, pattern, message: '申请域名权限失败，请重试' };
  }
}

/**
 * 字节数格式化为可读单位；非数字按 0 处理。
 * @param {unknown} value
 * @returns {string}
 */
export function formatBytes(value) {
  const n = Number.isFinite(value) ? Math.max(0, Number(value)) : 0;
  if (n < 1024) return `${Math.round(n)} B`;
  if (n < 1024 ** 2) return `${(n / 1024).toFixed(1)} KB`;
  if (n < 1024 ** 3) return `${(n / 1024 ** 2).toFixed(1)} MB`;
  return `${(n / 1024 ** 3).toFixed(1)} GB`;
}

/**
 * 条数加千分位；非数字按 0 处理。
 * @param {unknown} value
 * @returns {string}
 */
export function formatCount(value) {
  const n = Number.isFinite(value) ? Math.max(0, Number(value)) : 0;
  return Math.round(n).toLocaleString('zh-CN');
}

/**
 * 取 endpoint 的域名；无地址或非法地址返回空串。
 * @param {unknown} baseUrl
 * @returns {string}
 */
export function hostOf(baseUrl) {
  const text = String(baseUrl ?? '').trim();
  if (text === '') return '';
  try {
    return new URL(text).hostname;
  } catch {
    return '';
  }
}

/**
 * 实例的类型/预设组合徽标文字：「OpenAI 兼容 · DeepSeek」「百度翻译」。
 * @param {Record<string, unknown> | null} instance
 * @returns {string}
 */
export function typeBadgeLabel(instance) {
  if (!instance) return '';
  const typeLabel = String(instance.typeLabel ?? '').trim() || '未知类型';
  if (instance.kind === 'unsupported' || (instance.type !== 'openai' && instance.type !== 'baidu')) {
    return '不支持的类型';
  }
  if (instance.type === 'openai') {
    return `${typeLabel} · ${PRESET_LABELS[instance.preset] ?? '自定义'}`;
  }
  return typeLabel;
}

/**
 * 实例卡片的第二行说明：模型、endpoint 域名 + 路径或百度说明。
 * @param {Record<string, unknown> | null} instance
 * @returns {string}
 */
export function instanceDetail(instance) {
  if (!instance) return '';
  if (instance.kind === 'unsupported') return '类型不受支持（可能由更高版本创建）';
  if (instance.type === 'baidu') return BAIDU_MODEL_LABEL;
  const model = String(instance.model ?? '').trim();
  const host = hostOf(instance.endpoint?.baseUrl);
  if (instance.preset === 'custom' && host) {
    const path = String(instance.endpoint?.path ?? '');
    return `${host}${path}`;
  }
  return model || '未填写模型';
}

/**
 * 实例凭据状态：无需密钥 / 已配置 / 部分配置 / 未配置。
 * @param {Record<string, unknown> | null} instance
 * @returns {{ key: 'none' | 'ok' | 'partial' | 'missing', label: string }}
 */
export function credentialState(instance) {
  if (!instance) return { key: 'missing', label: '未配置' };
  if (instance.requiresKey === false) return { key: 'none', label: '无需密钥' };
  if (instance.hasKey === true) return { key: 'ok', label: '已配置' };
  const fields = instance.credentialFields ?? {};
  const filled = Object.values(fields).filter(Boolean).length;
  if (filled > 0) return { key: 'partial', label: '部分配置' };
  return { key: 'missing', label: '未配置' };
}

/**
 * 实例是否满足「设为当前」的条件（与 E3 的资格检查同口径，仅用于禁用与原因提示）。
 * 最终仍以 E3 `setActiveInstance` 的校验为准。
 * @param {Record<string, unknown> | null} instance
 * @returns {{ ok: boolean, reason: string | null }}
 */
export function instanceEligibility(instance) {
  if (!instance) return { ok: false, reason: '实例不存在' };
  if (instance.kind === 'unsupported') return { ok: false, reason: '类型不受支持，只能删除' };
  if (instance.enabled === false) return { ok: false, reason: '实例已停用' };
  if (instance.requiresKey !== false && instance.hasKey !== true) {
    const state = credentialState(instance);
    return {
      ok: false,
      reason: state.key === 'partial' ? '凭据不完整，请补齐后再设为当前' : '缺少凭据，请先配置密钥',
    };
  }
  if (instance.type === 'openai' && instance.permission !== 'granted') {
    return { ok: false, reason: '接口域名未授权，请先授权访问' };
  }
  return { ok: true, reason: null };
}

/**
 * 当前实例是否真的可用于翻译（概览与警告区使用）。
 * @param {Record<string, unknown> | null} instance
 * @returns {{ usable: boolean, reason: string | null }}
 */
export function activeUsability(instance) {
  if (!instance) return { usable: false, reason: '没有当前实例' };
  const eligibility = instanceEligibility(instance);
  if (!eligibility.ok) return { usable: false, reason: eligibility.reason };
  return { usable: true, reason: null };
}

/**
 * 测试翻译的资格：允许测试未启用实例，但要求类型受支持、凭据完整、endpoint 已授权。
 * 与后台 `ST_TEST_ENGINE` 的校验同口径，只用于提前提示。
 * @param {Record<string, unknown> | null} instance
 * @returns {{ ok: boolean, reason: string | null }}
 */
export function testInstanceEligibility(instance) {
  if (!instance) return { ok: false, reason: '请选择一个翻译实例' };
  if (instance.kind === 'unsupported') {
    return { ok: false, reason: '该实例类型不受支持，无法测试。' };
  }
  if (instance.requiresKey !== false && instance.hasKey !== true) {
    return {
      ok: false,
      reason:
        credentialState(instance).key === 'partial'
          ? '百度翻译需要 APPID 与密钥，当前只配置了其中一项，测试会失败。'
          : '该实例尚未配置密钥，测试会失败。',
    };
  }
  if (instance.type === 'openai' && instance.permission !== 'granted') {
    return { ok: false, reason: '该实例的接口域名未授权，测试会失败。' };
  }
  return { ok: true, reason: null };
}

/**
 * 权限徽标文字。
 * @param {Record<string, unknown> | null} instance
 * @returns {{ key: 'ok' | 'missing' | 'unknown', label: string } | null}
 */
export function permissionState(instance) {
  if (!instance || instance.type !== 'openai') return null;
  return instance.permission === 'granted'
    ? { key: 'ok', label: '已授权' }
    : { key: 'missing', label: '未授权' };
}

/**
 * 概览状态摘要与主操作文案。
 * @param {{ instances: Array<Record<string, unknown>>, settings: Record<string, unknown> | null }} input
 * @returns {{ tone: 'ok' | 'warn', text: string, action: { label: string, route: string } | null }}
 */
export function overviewSummary({ instances, settings }) {
  const list = Array.isArray(instances) ? instances : [];
  const active = list.find((instance) => instance.id === settings?.activeInstanceId) ?? null;

  if (list.length === 0) {
    return {
      tone: 'warn',
      text: '还没有翻译实例，先新增一个',
      action: { label: '新增翻译实例', route: '#/instances' },
    };
  }
  const unsupported = list.filter((instance) => instance.kind === 'unsupported').length;
  if (!active) {
    return {
      tone: 'warn',
      text: '当前没有可用的翻译方式',
      action: { label: '去修复', route: '#/instances' },
    };
  }
  const usability = activeUsability(active);
  if (!usability.usable) {
    const isPermission = active.permission !== 'granted' && active.type === 'openai';
    return {
      tone: 'warn',
      text: isPermission
        ? '当前翻译方式未授权接口域名'
        : `当前翻译方式不可用：${usability.reason}`,
      action: { label: '去修复', route: '#/instances' },
    };
  }
  if (unsupported > 0) {
    return {
      tone: 'warn',
      text: `当前使用 ${typeBadgeLabel(active)}，另有 ${unsupported} 个实例类型不受支持`,
      action: { label: '查看实例', route: '#/instances' },
    };
  }
  return {
    tone: 'ok',
    text: `当前使用 ${typeBadgeLabel(active)} · ${active.name}`,
    action: null,
  };
}

/**
 * 概览警告项（按优先级排序）。
 * @param {{ instances: Array<Record<string, unknown>>, settings: Record<string, unknown> | null }} input
 * @returns {Array<{ id: string, tone: 'warn' | 'info', text: string, action: { label: string, route: string } | null }>}
 */
export function overviewWarnings({ instances, settings }) {
  const list = Array.isArray(instances) ? instances : [];
  const active = list.find((instance) => instance.id === settings?.activeInstanceId) ?? null;
  const warnings = [];

  if (list.length === 0) {
    warnings.push({
      id: 'no-instance',
      tone: 'warn',
      text: '还没有翻译实例。添加一个 OpenAI 兼容或百度翻译实例后即可开始翻译。',
      action: { label: '新增翻译实例', route: '#/instances' },
    });
    return warnings;
  }

  const usable = list.some(
    (instance) => instance.kind !== 'unsupported' && instanceEligibility(instance).ok
  );
  if (!usable) {
    warnings.push({
      id: 'no-usable',
      tone: 'warn',
      text: '当前没有可用的翻译方式。请启用一个实例并配置密钥/授权域名。',
      action: { label: '去修复', route: '#/instances' },
    });
  }

  if (active && active.requiresKey !== false && active.hasKey !== true) {
    warnings.push({
      id: 'missing-key',
      tone: 'warn',
      text:
        credentialState(active).key === 'partial'
          ? '百度翻译需要 APPID 与密钥，当前只配置了其中一项。'
          : '当前翻译方式缺少密钥，页面翻译无法使用。请配置密钥或切换实例。',
      action: { label: '配置密钥', route: '#/instances' },
    });
  }

  if (active && active.type === 'openai' && active.permission !== 'granted') {
    warnings.push({
      id: 'permission',
      tone: 'warn',
      text: '当前翻译方式未授权访问接口域名，页面翻译无法使用。请重新授权或切换实例。',
      action: { label: '去授权', route: '#/instances' },
    });
  }

  const unsupported = list.filter((instance) => instance.kind === 'unsupported').length;
  if (unsupported > 0) {
    warnings.push({
      id: 'unsupported',
      tone: 'warn',
      text: `${unsupported} 个实例由更高版本创建，当前版本无法使用。`,
      action: { label: '查看', route: '#/instances' },
    });
  }

  if (settings?.keyStorage === 'sync') {
    warnings.push({
      id: 'sync-key',
      tone: 'info',
      text: '密钥会随账号同步到其他设备，请只在信任的设备上使用。',
      action: null,
    });
  }

  if (list.some((instance) => instance.type === 'openai')) {
    warnings.push({
      id: 'prompt-local',
      tone: 'info',
      text: 'system 提示词只保存在本机，不随账号同步；换设备后会回退默认提示词。',
      action: null,
    });
  }

  return warnings;
}
