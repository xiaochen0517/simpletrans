/**
 * A3 OpenAI 缓存 profile 与主机权限契约
 *
 * 模块：后台服务（A）/ A3
 * 职责：提供 cache key v3 所需的 endpoint 指纹与生成参数哈希，并转出 E3 的主机权限约定。
 * 依赖：E3 OpenAI 兼容配置（openai.js）、E3 主机权限（config/host-permission.js）、
 *       A3 请求参数展开（openai-request.js，P8-1 起）。
 * 实现阶段：P8-1（大模型 OpenAI 兼容协议与执行）；P8-2 主机权限实现移到 E3 供实例资格检查共用。
 *
 * profile 只含 endpoint 与生成参数，不含密钥、认证 query 与请求头；实际权限申请
 * （`chrome.permissions.request`）与 UI 由 P8-3 负责。
 */

import { normalizeOpenAIConfig } from '../config/openai.js';
import { getOriginPattern, isEndpointPermitted } from '../config/host-permission.js';
import { buildGenerationParams } from './openai-request.js';

export { getOriginPattern, isEndpointPermitted };

/**
 * 稳定序列化：对象键排序、忽略 `undefined`、数组保持顺序。
 * 用于生成参数哈希，保证同一组参数得到同一字符串。
 * @param {unknown} value
 * @returns {string}
 */
export function stableStringify(value) {
  if (value === null || typeof value !== 'object') return JSON.stringify(value) ?? 'null';
  if (Array.isArray(value)) {
    return `[${value.map((item) => stableStringify(item)).join(',')}]`;
  }
  const keys = Object.keys(value)
    .filter((key) => value[key] !== undefined)
    .sort();
  return `{${keys
    .map((key) => `${JSON.stringify(key)}:${stableStringify(value[key])}`)
    .join(',')}}`;
}

/**
 * 把字节数组转成小写十六进制。
 * @param {ArrayBuffer} buffer
 * @returns {string}
 */
function toHex(buffer) {
  const bytes = new Uint8Array(buffer);
  let out = '';
  for (const byte of bytes) out += byte.toString(16).padStart(2, '0');
  return out;
}

/**
 * 计算 endpoint 指纹：`origin + baseUrl 路径前缀 + path + 非敏感静态 query`。
 * 不含认证 query、密钥与请求头；静态 query 按名字与值排序，顺序不同视为同一个 endpoint。
 * @param {unknown} config
 * @returns {string}
 */
export function endpointFingerprint(config) {
  const normalized = normalizeOpenAIConfig(config);
  const baseUrl = String(normalized.endpoint.baseUrl ?? '').replace(/\/+$/, '');
  let url;
  try {
    url = new URL(baseUrl);
  } catch {
    return '';
  }
  const basePath = url.pathname.replace(/\/+$/, '');
  const path = String(normalized.endpoint.path ?? '');
  const query = normalized.endpoint.query
    .map((item) => [item.name, item.value])
    .sort((left, right) => {
      if (left[0] !== right[0]) return left[0] < right[0] ? -1 : 1;
      if (left[1] === right[1]) return 0;
      return left[1] < right[1] ? -1 : 1;
    })
    .map(([name, value]) => `${encodeURIComponent(name)}=${encodeURIComponent(value)}`)
    .join('&');
  return `${url.origin}${basePath}${path}${query ? `?${query}` : ''}`;
}

/**
 * 生成参数 profile：`stream` 与实际写入请求体的参数。
 * 关闭的参数不参与；额外参数与思考参数按其展开后的点路径参与。
 * @param {unknown} config
 * @returns {{ stream: boolean, params: Record<string, unknown> }}
 */
export function generationProfile(config) {
  const normalized = normalizeOpenAIConfig(config);
  return {
    stream: normalized.endpoint.stream !== false,
    params: buildGenerationParams(normalized),
  };
}

/**
 * 计算生成参数哈希（SHA-256，小写十六进制）。
 * 键排序、忽略未启用项；密钥、请求头与模型不参与，由 P8-2 的 cache key 统一拼接。
 * @param {unknown} config
 * @returns {Promise<string>}
 */
export async function generationHash(config) {
  const payload = stableStringify(generationProfile(config));
  const subtle = globalThis.crypto?.subtle;
  if (!subtle || typeof subtle.digest !== 'function') {
    throw new TypeError('当前环境不支持 SHA-256，无法计算生成参数哈希');
  }
  const digest = await subtle.digest('SHA-256', new TextEncoder().encode(payload));
  return toHex(digest);
}

/**
 * 一次返回 cache key v3 需要的两个 LLM profile 值。
 * @param {unknown} config
 * @returns {Promise<{ endpointFingerprint: string, generationHash: string }>}
 */
export async function buildLLMProfile(config) {
  return {
    endpointFingerprint: endpointFingerprint(config),
    generationHash: await generationHash(config),
  };
}
