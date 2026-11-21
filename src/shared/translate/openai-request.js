/**
 * A3 OpenAI 请求构造
 *
 * 模块：后台服务（A）/ A3
 * 职责：校验 OpenAI 实例配置，构造 Chat Completions 的 URL、请求头与请求体：
 *       认证（bearer/header/query/none）、静态 query/header、model、system/user messages、
 *       生成参数（temperature/top_p/max_tokens/思考强度/额外参数）与 stream。
 * 依赖：E3 OpenAI 兼容配置（openai.js）、A3 提示词模板（prompt.js）、A3 错误映射（openai-errors.js）、
 *       E1 消息协议（错误码）。
 *
 * `buildRequest()` 是纯函数：不读存储、不发请求、不记日志。密钥只进入请求头/查询参数，不进入日志摘要。
 */

import { ERROR_CODES } from '../protocol.js';
import {
  MAX_TOKEN_FIELDS,
  OPENAI_ERROR_MESSAGES,
  coerceExtraValue,
  normalizeOpenAIConfig,
  validateOpenAIConfig,
} from '../config/openai.js';
import { TranslateError } from './openai-errors.js';
import { buildSystemPrompt } from './prompt.js';

/**
 * 按点路径写入请求体；中间对象不存在时创建。
 * @param {Record<string, unknown>} target
 * @param {string} path
 * @param {unknown} value
 */
export function setByPath(target, path, value) {
  const parts = String(path).split('.').filter(Boolean);
  if (parts.length === 0) return;
  let node = target;
  for (let index = 0; index < parts.length - 1; index += 1) {
    const key = parts[index];
    const current = node[key];
    if (!current || typeof current !== 'object' || Array.isArray(current)) node[key] = {};
    node = node[key];
  }
  node[parts[parts.length - 1]] = value;
}

/**
 * 按配置生成实际写入请求体的生成参数（不含 model/messages/stream）。
 * 关闭的参数不写入；思考参数按模式展开为点路径字段。
 * @param {import('../config/openai.js').OpenAIConfig} config 已归一的配置
 * @returns {Record<string, unknown>}
 */
export function buildGenerationParams(config) {
  const out = {};
  const params = config?.params ?? {};

  const temperature = params.temperature;
  if (temperature?.enabled === true) out.temperature = Number(temperature.value);

  const topP = params.topP;
  if (topP?.enabled === true) out.top_p = Number(topP.value);

  const maxTokens = params.maxTokens;
  if (maxTokens?.enabled === true && MAX_TOKEN_FIELDS.includes(maxTokens.field)) {
    out[maxTokens.field] = Number(maxTokens.value);
  }

  const reasoning = params.reasoning ?? {};
  if (reasoning.mode === 'effort') {
    const field = String(reasoning.field ?? '');
    const value = String(reasoning.value ?? '');
    const toggleField = String(reasoning.toggleField ?? '');
    if (value === 'off' || value === '') {
      if (toggleField !== '' && String(reasoning.offValue ?? '') !== '') {
        setByPath(out, toggleField, reasoning.offValue);
      }
    } else {
      if (field !== '') setByPath(out, field, value);
      if (toggleField !== '' && String(reasoning.onValue ?? '') !== '') {
        setByPath(out, toggleField, reasoning.onValue);
      }
    }
  } else if (reasoning.mode === 'budget') {
    const field = String(reasoning.budgetField ?? '');
    if (field !== '') setByPath(out, field, Number(reasoning.budget));
  } else if (reasoning.mode === 'toggle') {
    const field = String(reasoning.toggleField ?? '');
    if (field !== '') {
      const enabled = !(reasoning.value === 'off' || reasoning.value === 'false' || reasoning.value === '');
      const value = enabled ? reasoning.onValue : reasoning.offValue;
      if (String(value ?? '') !== '') setByPath(out, field, value);
    }
  }

  const extra = Array.isArray(params.extra) ? params.extra : [];
  for (const item of extra) {
    if (!item || item.enabled !== true) continue;
    const value = coerceExtraValue(item);
    if (value === undefined) continue;
    setByPath(out, item.path, value);
  }

  return out;
}

/**
 * 拼接认证 header 值：前缀（如 `Bearer` / `token`）与密钥之间保留一个空格。
 * @param {string} prefix
 * @param {string} credential
 * @returns {string}
 */
export function formatAuthValue(prefix, credential) {
  const trimmed = String(prefix ?? '').trim();
  return trimmed === '' ? credential : `${trimmed} ${credential}`;
}

/**
 * 校验配置与凭据；失败抛 `TranslateError(CONFIG)`，不发请求。
 * @param {unknown} config
 * @param {unknown} apiKey
 * @returns {import('../config/openai.js').OpenAIConfig}
 */
function validateOrThrow(config, apiKey) {
  const validated = validateOpenAIConfig(config);
  if (!validated.ok) {
    throw new TranslateError(ERROR_CODES.CONFIG, validated.errors[0] ?? OPENAI_ERROR_MESSAGES.ENDPOINT);
  }
  const credential = String(apiKey ?? '').trim();
  if (config.auth.type !== 'none' && credential === '') {
    throw new TranslateError(ERROR_CODES.CONFIG, OPENAI_ERROR_MESSAGES.MISSING_KEY);
  }
  return config;
}

/**
 * 构造 endpoint URL：`baseUrl` 去尾部 `/` + `path` + 静态 query；认证 query 由 `auth` 追加。
 * @param {import('../config/openai.js').OpenAIConfig} config
 * @param {string} credential
 * @returns {string}
 */
export function buildEndpointUrl(config, credential = '') {
  const baseUrl = String(config.endpoint.baseUrl ?? '').replace(/\/+$/, '');
  const path = String(config.endpoint.path ?? '');
  const url = new URL(`${baseUrl}${path}`);
  for (const item of config.endpoint.query) {
    url.searchParams.append(item.name, item.value);
  }
  if (config.auth.type === 'query') {
    url.searchParams.set(config.auth.queryName, credential);
  }
  return url.toString();
}

/**
 * 构造请求头：`Content-Type`、认证头与静态 header。
 * @param {import('../config/openai.js').OpenAIConfig} config
 * @param {string} credential
 * @returns {Record<string, string>}
 */
export function buildHeaders(config, credential = '') {
  const headers = { 'Content-Type': 'application/json' };
  if (config.auth.type === 'bearer') {
    headers.Authorization = `Bearer ${credential}`;
  } else if (config.auth.type === 'header') {
    headers[config.auth.headerName] = formatAuthValue(config.auth.prefix, credential);
  }
  for (const item of config.headers) {
    headers[item.name] = item.value;
  }
  return headers;
}

/**
 * 构造一次 Chat Completions 请求。
 *
 * @param {{
 *   config: unknown,
 *   apiKey?: unknown,
 *   systemPrompt?: unknown,
 *   targetLang?: string,
 *   text?: unknown,
 *   mode?: 'single'|'batch'|'quick',
 * }} params
 * @returns {{
 *   url: string,
 *   method: 'POST',
 *   headers: Record<string, string>,
 *   body: Record<string, unknown>,
 *   stream: boolean,
 * }}
 */
export function buildRequest({ config, apiKey, systemPrompt, targetLang, text, mode = 'single' }) {
  const normalized = normalizeOpenAIConfig(config);
  const credential = String(apiKey ?? '').trim();
  validateOrThrow(normalized, credential);

  const stream = normalized.endpoint.stream !== false;
  const body = {
    model: normalized.model,
    messages: [
      {
        role: 'system',
        content: buildSystemPrompt({ targetLang, template: systemPrompt, mode }),
      },
      { role: 'user', content: String(text ?? '') },
    ],
    stream,
    ...buildGenerationParams(normalized),
  };

  return {
    url: buildEndpointUrl(normalized, credential),
    method: 'POST',
    headers: buildHeaders(normalized, credential),
    body,
    stream,
  };
}
