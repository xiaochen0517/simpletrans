/**
 * E3 OpenAI 兼容配置
 *
 * 模块：公共模块（E）/ E3
 * 职责：定义 OpenAI-compatible Chat Completions 的实例配置结构、DeepSeek 预设、通用默认值、
 *       归一规则与校验，以及旧 DeepSeek 实例到 OpenAI 实例的字段映射。
 * 依赖：无（P8-1 起）。
 * 实现阶段：P8-1（大模型 OpenAI 兼容协议与执行）
 *
 * 本文件含服务商默认地址与字段名，属于 config/，页面注入（content）禁止引用（架构 5.1）。
 * 只做结构、默认值与校验，不读写存储、不调用引擎、不记录日志。
 */

/** 大模型实例类型。 */
export const OPENAI_TYPE = 'openai';

/** 内置预设 id。 */
export const OPENAI_PRESET_IDS = Object.freeze({
  DEEPSEEK: 'deepseek',
  CUSTOM: 'custom',
});

/** 默认接口路径。 */
export const DEFAULT_ENDPOINT_PATH = '/chat/completions';

/** 模型名最大字符数。 */
export const MAX_MODEL_CHARS = 100;

/** 接口地址最大字符数。 */
export const MAX_BASE_URL_CHARS = 2048;

/** 接口路径最大字符数。 */
export const MAX_ENDPOINT_PATH_CHARS = 2048;

/** 查询参数名/值最大字符数。 */
export const MAX_QUERY_CHARS = 2048;

/** 请求头值最大字符数。 */
export const MAX_HEADER_VALUE_CHARS = 2048;

/** 额外参数个数上限。 */
export const MAX_EXTRA_PARAMS = 50;

/** 额外参数值最大字符数。 */
export const MAX_EXTRA_VALUE_CHARS = 4096;

/** 认证方式。 */
export const AUTH_TYPES = Object.freeze(['bearer', 'header', 'query', 'none']);

/** 思考参数模式。 */
export const REASONING_MODES = Object.freeze(['none', 'effort', 'budget', 'toggle']);

/** maxTokens 可写入的请求体字段。 */
export const MAX_TOKEN_FIELDS = Object.freeze(['max_tokens', 'max_completion_tokens']);

/** 额外参数值类型。 */
export const EXTRA_PARAM_TYPES = Object.freeze(['string', 'number', 'boolean', 'json']);

/** DeepSeek 思考强度可选值（`off` 关闭思考）。 */
export const DEEPSEEK_REASONING_VALUES = Object.freeze(['off', 'low', 'medium', 'high', 'max']);

/** 静态请求头禁止项（小写）：认证只走 auth，传输相关头由本模块设置。 */
export const FORBIDDEN_HEADERS = Object.freeze([
  'authorization',
  'api-key',
  'x-api-key',
  'cookie',
  'host',
  'content-length',
  'content-type',
]);

/** 额外参数禁止覆盖的请求体顶层字段。 */
export const RESERVED_BODY_FIELDS = Object.freeze(['messages', 'model', 'stream']);

/** 认证 header 禁止项（小写）：只允许用来传凭据的头不能由用户覆盖传输语义。 */
const FORBIDDEN_AUTH_HEADERS = Object.freeze(['cookie', 'host', 'content-length', 'content-type']);

/** 通用错误提示（与 P8-1 需求文档的错误映射表一致）。 */
export const OPENAI_ERROR_MESSAGES = Object.freeze({
  ENDPOINT: '接口地址无效，请检查 baseUrl 与 path',
  MISSING_KEY: '缺少密钥，请先在设置页配置',
  MODEL: '模型名称无效，请输入 1–100 个字符',
  BAD_RESPONSE: '当前接口返回格式暂不支持，请使用标准 OpenAI Chat Completions',
  EMPTY_TEXT: '引擎返回空译文',
  PARAMS: '请求参数不被当前模型支持，请关闭不支持的参数',
});

/**
 * 深冻结对象（仅在模块初始化时对预设使用）。
 * @template T
 * @param {T} value
 * @returns {T}
 */
function deepFreeze(value) {
  if (value && typeof value === 'object' && !Object.isFrozen(value)) {
    for (const child of Object.values(value)) deepFreeze(child);
    Object.freeze(value);
  }
  return value;
}

/**
 * @typedef {{
 *   temperature: { enabled: boolean, value: number },
 *   topP: { enabled: boolean, value: number },
 *   maxTokens: { enabled: boolean, field: string, value: number },
 *   reasoning: {
 *     mode: string,
 *     field: string,
 *     value: string,
 *     values: string[],
 *     budgetField: string,
 *     budget: number,
 *     toggleField: string,
 *     onValue: string,
 *     offValue: string,
 *   },
 *   extra: Array<{ path: string, type: string, value: string, enabled: boolean }>,
 * }} OpenAIParams
 */

/**
 * @typedef {{
 *   baseUrl: string,
 *   path: string,
 *   query: Array<{ name: string, value: string }>,
 *   stream: boolean,
 * }} OpenAIEndpoint
 */

/**
 * @typedef {{
 *   type: string,
 *   headerName: string,
 *   prefix: string,
 *   queryName: string,
 * }} OpenAIAuth
 */

/**
 * @typedef {{
 *   type: 'openai',
 *   preset: 'deepseek' | 'custom',
 *   endpoint: OpenAIEndpoint,
 *   auth: OpenAIAuth,
 *   headers: Array<{ name: string, value: string }>,
 *   model: string,
 *   params: OpenAIParams,
 * }} OpenAIConfig
 */

/** DeepSeek 预设：只是默认值，用户可改 endpoint、模型、参数与提示词。 */
const DEEPSEEK_PRESET = deepFreeze({
  id: OPENAI_PRESET_IDS.DEEPSEEK,
  label: 'DeepSeek',
  endpoint: {
    baseUrl: 'https://api.deepseek.com',
    path: DEFAULT_ENDPOINT_PATH,
    query: [],
    stream: true,
  },
  auth: { type: 'bearer', headerName: '', prefix: '', queryName: '' },
  headers: [],
  model: 'deepseek-chat',
  params: {
    temperature: { enabled: false, value: 1 },
    topP: { enabled: false, value: 1 },
    maxTokens: { enabled: false, field: 'max_tokens', value: 2048 },
    reasoning: {
      mode: 'effort',
      field: 'reasoning_effort',
      value: 'off',
      values: [...DEEPSEEK_REASONING_VALUES],
      budgetField: '',
      budget: 0,
      toggleField: 'thinking.type',
      onValue: 'enabled',
      offValue: 'disabled',
    },
    extra: [],
  },
});

/** 自定义预设：空地址/模型，全部生成参数关闭，不发送思考参数。 */
const CUSTOM_PRESET = deepFreeze({
  id: OPENAI_PRESET_IDS.CUSTOM,
  label: '自定义',
  endpoint: {
    baseUrl: '',
    path: DEFAULT_ENDPOINT_PATH,
    query: [],
    stream: true,
  },
  auth: { type: 'bearer', headerName: '', prefix: '', queryName: '' },
  headers: [],
  model: '',
  params: {
    temperature: { enabled: false, value: 1 },
    topP: { enabled: false, value: 1 },
    maxTokens: { enabled: false, field: 'max_tokens', value: 2048 },
    reasoning: {
      mode: 'none',
      field: '',
      value: 'off',
      values: [],
      budgetField: '',
      budget: 0,
      toggleField: '',
      onValue: '',
      offValue: '',
    },
    extra: [],
  },
});

/** 预设表。 */
export const OPENAI_PRESETS = deepFreeze({
  [OPENAI_PRESET_IDS.DEEPSEEK]: DEEPSEEK_PRESET,
  [OPENAI_PRESET_IDS.CUSTOM]: CUSTOM_PRESET,
});

/**
 * 判断是否已知预设 id。
 * @param {unknown} presetId
 * @returns {boolean}
 */
export function isKnownPreset(presetId) {
  return typeof presetId === 'string' && Object.hasOwn(OPENAI_PRESETS, presetId);
}

/**
 * 取预设定义；未知 id 返回 null。
 * @param {unknown} presetId
 * @returns {typeof DEEPSEEK_PRESET | typeof CUSTOM_PRESET | null}
 */
export function getPreset(presetId) {
  return isKnownPreset(presetId) ? OPENAI_PRESETS[presetId] : null;
}

/**
 * 把普通对象转为普通对象副本（用于克隆预设；预设只含 JSON 可序列化值）。
 * @template T
 * @param {T} value
 * @returns {T}
 */
function clone(value) {
  return JSON.parse(JSON.stringify(value));
}

/**
 * 按预设构造一份完整配置默认值（深拷贝，可自由修改）。
 * @param {unknown} [presetId]
 * @returns {OpenAIConfig}
 */
export function createOpenAIConfig(presetId = OPENAI_PRESET_IDS.DEEPSEEK) {
  const preset = getPreset(presetId) ?? CUSTOM_PRESET;
  const { id: _id, label: _label, ...fields } = clone(preset);
  return { type: OPENAI_TYPE, preset: preset.id, ...fields };
}

/**
 * 判断值是否为普通对象（非 null、非数组）。
 * @param {unknown} value
 * @returns {boolean}
 */
function isPlainObject(value) {
  return Boolean(value) && typeof value === 'object' && !Array.isArray(value);
}

/**
 * 归一布尔值。
 * @param {unknown} value
 * @param {boolean} fallback
 * @returns {boolean}
 */
function toBoolean(value, fallback) {
  if (typeof value === 'boolean') return value;
  if (value === 'true') return true;
  if (value === 'false') return false;
  return fallback;
}

/**
 * 归一数字：保留 NaN 让校验报错，不静默改成合法值。
 * @param {unknown} value
 * @param {number} fallback
 * @returns {number}
 */
function toNumber(value, fallback) {
  if (value == null || value === '') return fallback;
  return Number(value);
}

/**
 * 归一字符串数组。
 * @param {unknown} value
 * @returns {string[]}
 */
function toStringArray(value) {
  if (!Array.isArray(value)) return [];
  return value.map((item) => String(item ?? '').trim());
}

/**
 * 归一静态查询参数列表。
 * @param {unknown} value
 * @returns {Array<{ name: string, value: string }>}
 */
function normalizeQuery(value) {
  if (!Array.isArray(value)) return [];
  return value
    .filter((item) => isPlainObject(item))
    .map((item) => ({
      name: String(item.name ?? '').trim(),
      value: String(item.value ?? '').trim(),
    }));
}

/**
 * 归一静态请求头列表。
 * @param {unknown} value
 * @returns {Array<{ name: string, value: string }>}
 */
function normalizeHeaders(value) {
  if (!Array.isArray(value)) return [];
  return value
    .filter((item) => isPlainObject(item))
    .map((item) => ({
      name: String(item.name ?? '').trim(),
      value: String(item.value ?? '').trim(),
    }));
}

/**
 * 归一额外参数列表。
 * @param {unknown} value
 * @returns {Array<{ path: string, type: string, value: string, enabled: boolean }>}
 */
function normalizeExtra(value) {
  if (!Array.isArray(value)) return [];
  return value
    .filter((item) => isPlainObject(item))
    .map((item) => ({
      path: String(item.path ?? '').trim(),
      type: EXTRA_PARAM_TYPES.includes(item.type) ? item.type : 'string',
      value: String(item.value ?? ''),
      enabled: toBoolean(item.enabled, false),
    }));
}

/**
 * 归一参数块：以预设默认值为底，逐项合并用户值。
 * @param {unknown} value
 * @param {OpenAIParams} base
 * @returns {OpenAIParams}
 */
function normalizeParams(value, base) {
  const source = isPlainObject(value) ? value : {};
  const temperature = isPlainObject(source.temperature) ? source.temperature : {};
  const topP = isPlainObject(source.topP) ? source.topP : {};
  const maxTokens = isPlainObject(source.maxTokens) ? source.maxTokens : {};
  const reasoning = isPlainObject(source.reasoning) ? source.reasoning : {};

  return {
    temperature: {
      enabled: toBoolean(temperature.enabled, base.temperature.enabled),
      value: toNumber(temperature.value, base.temperature.value),
    },
    topP: {
      enabled: toBoolean(topP.enabled, base.topP.enabled),
      value: toNumber(topP.value, base.topP.value),
    },
    maxTokens: {
      enabled: toBoolean(maxTokens.enabled, base.maxTokens.enabled),
      field: MAX_TOKEN_FIELDS.includes(maxTokens.field) ? maxTokens.field : base.maxTokens.field,
      value: toNumber(maxTokens.value, base.maxTokens.value),
    },
    reasoning: {
      mode: REASONING_MODES.includes(reasoning.mode) ? reasoning.mode : base.reasoning.mode,
      field: reasoning.field == null ? base.reasoning.field : String(reasoning.field).trim(),
      value: reasoning.value == null ? base.reasoning.value : String(reasoning.value).trim(),
      values: reasoning.values == null ? [...base.reasoning.values] : toStringArray(reasoning.values),
      budgetField:
        reasoning.budgetField == null
          ? base.reasoning.budgetField
          : String(reasoning.budgetField).trim(),
      budget: toNumber(reasoning.budget, base.reasoning.budget),
      toggleField:
        reasoning.toggleField == null
          ? base.reasoning.toggleField
          : String(reasoning.toggleField).trim(),
      onValue: reasoning.onValue == null ? base.reasoning.onValue : String(reasoning.onValue),
      offValue: reasoning.offValue == null ? base.reasoning.offValue : String(reasoning.offValue),
    },
    extra: source.extra == null ? clone(base.extra) : normalizeExtra(source.extra),
  };
}

/**
 * 归一 OpenAI 实例配置：按预设补齐默认值、裁剪字符串、归一数值与开关。
 * 保留调用方传入的其它字段（如 `id`、`name`、`apiKey`、`systemPrompt`），本函数不校验。
 * @param {unknown} raw
 * @returns {OpenAIConfig & Record<string, unknown>}
 */
export function normalizeOpenAIConfig(raw) {
  const source = isPlainObject(raw) ? raw : {};
  const presetId = isKnownPreset(source.preset) ? source.preset : OPENAI_PRESET_IDS.CUSTOM;
  const base = createOpenAIConfig(presetId);

  const endpointSource = isPlainObject(source.endpoint) ? source.endpoint : {};
  const authSource = isPlainObject(source.auth) ? source.auth : {};

  return {
    ...source,
    type: OPENAI_TYPE,
    preset: presetId,
    endpoint: {
      baseUrl: String(endpointSource.baseUrl ?? base.endpoint.baseUrl).trim(),
      path: String(endpointSource.path ?? base.endpoint.path).trim(),
      query:
        endpointSource.query == null ? clone(base.endpoint.query) : normalizeQuery(endpointSource.query),
      stream: toBoolean(endpointSource.stream, base.endpoint.stream),
    },
    auth: {
      type: AUTH_TYPES.includes(authSource.type) ? authSource.type : base.auth.type,
      headerName:
        authSource.headerName == null
          ? base.auth.headerName
          : String(authSource.headerName).trim(),
      prefix: authSource.prefix == null ? base.auth.prefix : String(authSource.prefix).trim(),
      queryName:
        authSource.queryName == null ? base.auth.queryName : String(authSource.queryName).trim(),
    },
    headers: source.headers == null ? clone(base.headers) : normalizeHeaders(source.headers),
    model: String(source.model ?? base.model).trim(),
    params: normalizeParams(source.params, base.params),
  };
}

/**
 * 把旧 DeepSeek 实例字段映射为 OpenAI 实例配置。
 * 只做字段映射，不写存储、不处理密钥（密钥由 P8-2 凭据层迁移）。
 * @param {unknown} instance 旧实例（`type: 'deepseek'`）
 * @param {unknown} [presetId] 目标预设，默认 DeepSeek
 * @returns {OpenAIConfig}
 */
export function mapLegacyDeepSeek(instance, presetId = OPENAI_PRESET_IDS.DEEPSEEK) {
  const source = isPlainObject(instance) ? instance : {};
  const config = createOpenAIConfig(isKnownPreset(presetId) ? presetId : OPENAI_PRESET_IDS.DEEPSEEK);

  const baseUrl = String(source.baseUrl ?? '').trim();
  if (baseUrl !== '') config.endpoint.baseUrl = baseUrl;

  const model = String(source.model ?? '').trim();
  if (model !== '') config.model = model;

  const effort = String(source.reasoningEffort ?? '').trim();
  if (config.params.reasoning.mode === 'effort' && config.params.reasoning.values.includes(effort)) {
    config.params.reasoning.value = effort;
  }

  // 旧实例的批次/并发/提示词字段由 P8-2 保留，不属于 OpenAI 协议配置。
  return config;
}

/**
 * 把任意实例解析为 OpenAI 配置：旧 `deepseek` 实例走迁移映射，其余按 OpenAI 结构归一。
 * @param {unknown} instance
 * @returns {OpenAIConfig & Record<string, unknown>}
 */
export function resolveOpenAIConfig(instance) {
  const source = isPlainObject(instance) ? instance : {};
  if (source.type === 'deepseek') {
    const config = mapLegacyDeepSeek(source);
    return {
      ...source,
      ...config,
      preset: OPENAI_PRESET_IDS.DEEPSEEK,
    };
  }
  return normalizeOpenAIConfig(source);
}

/** RFC 7230 token：合法请求头名。 */
const HEADER_NAME_PATTERN = /^[!#$%&'*+\-.^_`|~0-9A-Za-z]+$/;

/** 合法 extra 路径段。 */
const EXTRA_PATH_SEGMENT_PATTERN = /^[A-Za-z_][A-Za-z0-9_-]*$/;

/** 合法查询参数名：不允许分隔符与控制字符。 */
const QUERY_NAME_PATTERN = /^[^\s&=#?]+$/;

/**
 * 判断字符串是否含控制字符。
 * @param {string} value
 * @returns {boolean}
 */
function hasControlChar(value) {
  return /[\u0000-\u001f\u007f]/.test(value);
}

/**
 * 解析并校验 baseUrl；失败返回 `{ error }`。
 * 只允许 HTTPS 或本地回环 HTTP，禁止账号密码、查询参数与片段。
 * @param {unknown} baseUrl
 * @returns {{ url?: URL, error?: string }}
 */
function parseBaseUrl(baseUrl) {
  const text = String(baseUrl ?? '').trim();
  if (text === '' || text.length > MAX_BASE_URL_CHARS) {
    return { error: OPENAI_ERROR_MESSAGES.ENDPOINT };
  }
  let url;
  try {
    url = new URL(text);
  } catch {
    return { error: OPENAI_ERROR_MESSAGES.ENDPOINT };
  }
  if (url.username !== '' || url.password !== '') return { error: OPENAI_ERROR_MESSAGES.ENDPOINT };
  if (url.protocol !== 'https:') {
    const isLoopback =
      url.protocol === 'http:' && (url.hostname === 'localhost' || url.hostname === '127.0.0.1');
    if (!isLoopback) return { error: OPENAI_ERROR_MESSAGES.ENDPOINT };
  }
  if (url.search !== '' || url.hash !== '') {
    return { error: '接口地址不能包含查询参数或片段，请把参数填到「查询参数」' };
  }
  return { url };
}

/**
 * 判断路径是否可用于拼接到 baseUrl 后。
 * @param {string} path
 * @returns {boolean}
 */
function isValidEndpointPath(path) {
  if (path === '' || path.length > MAX_ENDPOINT_PATH_CHARS) return false;
  if (!path.startsWith('/')) return false;
  return !/[\s?#]/.test(path) && !hasControlChar(path);
}

/**
 * 判断点路径是否合法（每段是标识符，最多 6 段）。
 * @param {string} path
 * @returns {boolean}
 */
function isValidFieldPath(path) {
  if (typeof path !== 'string' || path === '') return false;
  const parts = path.split('.');
  if (parts.length === 0 || parts.length > 6) return false;
  return parts.every((part) => EXTRA_PATH_SEGMENT_PATTERN.test(part));
}

/**
 * 判断额外参数是否与已启用的生成参数重复。
 * @param {string} path
 * @param {OpenAIParams} params
 * @returns {boolean}
 */
function conflictsWithManagedParams(path, params) {
  const managed = new Set();
  if (params.temperature.enabled) managed.add('temperature');
  if (params.topP.enabled) managed.add('top_p');
  if (params.maxTokens.enabled) managed.add(params.maxTokens.field);
  const reasoning = params.reasoning;
  if (reasoning.mode === 'effort' && reasoning.value !== 'off') managed.add(reasoning.field);
  if (reasoning.mode === 'budget') managed.add(reasoning.budgetField);
  if (reasoning.mode === 'effort' || reasoning.mode === 'toggle') managed.add(reasoning.toggleField);
  return managed.has(path);
}

/**
 * 归一额外参数值：只转换类型，不吞掉非法值（由校验处理）。
 * @param {{ type: string, value: string }} entry
 * @returns {unknown}
 */
export function coerceExtraValue(entry) {
  switch (entry?.type) {
    case 'number':
      return Number(entry.value);
    case 'boolean':
      return entry.value === 'true' || entry.value === true;
    case 'json':
      try {
        return JSON.parse(String(entry.value));
      } catch {
        return undefined;
      }
    default:
      return String(entry?.value ?? '');
  }
}

/**
 * 校验 OpenAI 实例配置。
 * 返回用户可见错误文案；调用方统一映射为 `CONFIG`，不发请求。
 * @param {unknown} config 已归一的配置（`normalizeOpenAIConfig` 的输出）
 * @returns {{ ok: boolean, errors: string[] }}
 */
export function validateOpenAIConfig(config) {
  const errors = [];
  const add = (message) => {
    if (!errors.includes(message)) errors.push(message);
  };

  if (!isPlainObject(config)) {
    return { ok: false, errors: [OPENAI_ERROR_MESSAGES.ENDPOINT] };
  }
  if (config.type !== OPENAI_TYPE) add('实例类型必须是 openai');
  if (!isKnownPreset(config.preset)) add('未知的模型预设');

  const endpoint = isPlainObject(config.endpoint) ? config.endpoint : {};
  const parsedBaseUrl = parseBaseUrl(endpoint.baseUrl);
  if (!parsedBaseUrl.url) add(parsedBaseUrl.error ?? OPENAI_ERROR_MESSAGES.ENDPOINT);

  const path = String(endpoint.path ?? '');
  if (!isValidEndpointPath(path)) add(OPENAI_ERROR_MESSAGES.ENDPOINT);

  const query = Array.isArray(endpoint.query) ? endpoint.query : [];
  const queryNames = new Set();
  for (const item of query) {
    const name = String(item?.name ?? '');
    const value = String(item?.value ?? '');
    if (
      name === '' ||
      hasControlChar(name) ||
      !QUERY_NAME_PATTERN.test(name) ||
      name.length > MAX_QUERY_CHARS
    ) {
      add('查询参数名无效');
      continue;
    }
    if (value.length > MAX_QUERY_CHARS || hasControlChar(value)) add(`查询参数 ${name} 的值无效`);
    if (queryNames.has(name)) add(`查询参数名重复：${name}`);
    queryNames.add(name);
  }

  if (typeof endpoint.stream !== 'boolean') add('stream 配置无效');

  const auth = isPlainObject(config.auth) ? config.auth : {};
  const authType = String(auth.type ?? '');
  if (!AUTH_TYPES.includes(authType)) {
    add('认证方式无效');
  } else if (authType === 'header') {
    const name = String(auth.headerName ?? '');
    if (name === '' || !HEADER_NAME_PATTERN.test(name)) add('认证请求头名称无效');
    else if (FORBIDDEN_AUTH_HEADERS.includes(name.toLowerCase())) {
      add(`认证请求头不能使用系统保留头：${name}`);
    }
  } else if (authType === 'query') {
    const name = String(auth.queryName ?? '');
    if (name === '' || !QUERY_NAME_PATTERN.test(name)) add('认证查询参数名无效');
    else if (queryNames.has(name)) add('认证参数名与静态查询参数重复');
  }

  const model = String(config.model ?? '');
  if (model === '' || model.length > MAX_MODEL_CHARS) add(OPENAI_ERROR_MESSAGES.MODEL);

  const headers = Array.isArray(config.headers) ? config.headers : [];
  const headerNames = new Set();
  if (headers.length > 0) {
    const authHeaderName = authType === 'header' ? String(auth.headerName ?? '').toLowerCase() : '';
    for (const item of headers) {
      const name = String(item?.name ?? '');
      const value = String(item?.value ?? '');
      const lower = name.toLowerCase();
      if (name === '' || !HEADER_NAME_PATTERN.test(name)) {
        add(`静态请求头名称无效：${name || '(空)'}`);
        continue;
      }
      if (FORBIDDEN_HEADERS.includes(lower)) {
        add(`静态请求头不能包含鉴权或系统保留头：${name}`);
      }
      if (authHeaderName !== '' && lower === authHeaderName) {
        add(`静态请求头与认证请求头重复：${name}`);
      }
      if (headerNames.has(lower)) add(`静态请求头重复：${name}`);
      headerNames.add(lower);
      if (value.length > MAX_HEADER_VALUE_CHARS || hasControlChar(value)) {
        add(`静态请求头 ${name} 的值无效`);
      }
    }
  }

  const params = isPlainObject(config.params) ? config.params : {};
  const temperature = isPlainObject(params.temperature) ? params.temperature : {};
  const topP = isPlainObject(params.topP) ? params.topP : {};
  const maxTokens = isPlainObject(params.maxTokens) ? params.maxTokens : {};
  const reasoning = isPlainObject(params.reasoning) ? params.reasoning : {};

  if (temperature.enabled === true) {
    const value = Number(temperature.value);
    if (!Number.isFinite(value) || value < 0 || value > 2) add('temperature 必须是 0–2 之间的数字');
  }
  if (topP.enabled === true) {
    const value = Number(topP.value);
    if (!Number.isFinite(value) || value < 0 || value > 1) add('top_p 必须是 0–1 之间的数字');
  }
  if (maxTokens.enabled === true) {
    if (!MAX_TOKEN_FIELDS.includes(maxTokens.field)) add('maxTokens 字段无效');
    const value = Number(maxTokens.value);
    if (!Number.isInteger(value) || value < 1) add('max_tokens 必须是正整数');
  }

  const reasoningMode = String(reasoning.mode ?? '');
  if (!REASONING_MODES.includes(reasoningMode)) add('思考参数模式无效');
  if (reasoningMode === 'effort') {
    const field = String(reasoning.field ?? '');
    if (!isValidFieldPath(field)) add('思考强度字段路径无效');
    const value = String(reasoning.value ?? '');
    const values = Array.isArray(reasoning.values) ? reasoning.values.map(String) : [];
    if (value === '') add('思考强度取值不能为空');
    else if (values.length > 0 && !values.includes(value)) add('思考强度取值不在允许列表内');
    if (reasoning.toggleField != null && String(reasoning.toggleField) !== '') {
      if (!isValidFieldPath(String(reasoning.toggleField))) add('思考开关字段路径无效');
    }
  } else if (reasoningMode === 'budget') {
    const field = String(reasoning.budgetField ?? '');
    if (!isValidFieldPath(field)) add('思考预算字段路径无效');
    const budget = Number(reasoning.budget);
    if (!Number.isInteger(budget) || budget < 1) add('思考预算必须是正整数');
  } else if (reasoningMode === 'toggle') {
    const field = String(reasoning.toggleField ?? '');
    if (!isValidFieldPath(field)) add('思考开关字段路径无效');
    if (String(reasoning.onValue ?? '') === '') add('思考开关开启值不能为空');
  }

  const extra = Array.isArray(params.extra) ? params.extra : [];
  if (extra.length > MAX_EXTRA_PARAMS) add(`额外参数不能超过 ${MAX_EXTRA_PARAMS} 项`);
  const extraPaths = new Set();
  for (const item of extra) {
    if (!item || item.enabled !== true) continue;
    const path = String(item.path ?? '');
    if (!isValidFieldPath(path)) {
      add(`额外参数路径无效：${path || '(空)'}`);
      continue;
    }
    const topLevel = path.split('.')[0];
    if (RESERVED_BODY_FIELDS.includes(topLevel)) {
      add(`额外参数不能覆盖保留字段：${path}`);
      continue;
    }
    if (conflictsWithManagedParams(path, params)) {
      add(`额外参数与已启用参数重复：${path}`);
      continue;
    }
    if (extraPaths.has(path)) add(`额外参数重复：${path}`);
    for (const existing of extraPaths) {
      if (existing.startsWith(`${path}.`) || path.startsWith(`${existing}.`)) {
        add(`额外参数路径冲突：${path}`);
      }
    }
    extraPaths.add(path);
    if (String(item.value ?? '').length > MAX_EXTRA_VALUE_CHARS) {
      add(`额外参数 ${path} 的值过长`);
      continue;
    }
    if (item.type === 'number' && !Number.isFinite(Number(item.value))) {
      add(`额外参数 ${path} 必须是数字`);
    } else if (item.type === 'boolean' && !['true', 'false', true, false].includes(item.value)) {
      add(`额外参数 ${path} 必须是布尔值`);
    } else if (item.type === 'json') {
      try {
        JSON.parse(String(item.value ?? ''));
      } catch {
        add(`额外参数 ${path} 不是合法 JSON`);
      }
    }
  }

  return { ok: errors.length === 0, errors };
}
