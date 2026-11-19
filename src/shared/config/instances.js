/**
 * E3 引擎实例
 *
 * 模块：公共模块（E）/ E3
 * 职责：实例模型 v2（`openai`/`baidu`）、CRUD、启停、当前实例改选、每实例凭据、`keyStorage` 迁移、
 *       提示词存储、公开字段与 v1 → v2 配置迁移。
 * 依赖：E2 设置与存储（settings.js/storage.js）、E3 类型目录（registry.js）、
 *       E3 OpenAI 兼容配置（openai.js）、E3 主机权限（host-permission.js）。
 * 实现阶段：P1（引擎层与密钥配置）；P6.2 增加实例参数归一与并发迁移；
 *           P8-2 改为多实例模型：公共字段、百度类型、每实例凭据、启用/当前实例、
 *           `storage.local` 提示词、`keyStorage` 迁移与 v1 → v2 迁移框架。
 *
 * 实例与设置写 `storage.sync`，提示词与凭据写 `storage.local`/`sync`（分区由 `keyStorage` 决定）。
 * 只有本模块能读凭据明文；公开字段只暴露 `hasKey`/`credentialStatus`/`requiresKey`。
 */

import { STORAGE_KEYS, read, removeKeys, write } from '../storage.js';
import { CONFIG_VERSION, getSettings, normalizeKeyStorage, normalizeSettings } from '../settings.js';
import {
  BAIDU_BASE_URL,
  BAIDU_BATCH_MAX_CHARS,
  BAIDU_BATCH_SIZE,
  BAIDU_MAX_CONCURRENCY,
  BAIDU_MODEL,
  BAIDU_QPS,
  DEFAULT_BATCH_MAX_CHARS,
  DEFAULT_BATCH_SIZE,
  DEFAULT_MAX_CONCURRENCY,
  DEFAULT_SYSTEM_PROMPT,
  ENGINE_TYPE_IDS,
  MAX_INSTANCE_BYTES,
  MAX_INSTANCES,
  MAX_INSTANCE_NAME_CHARS,
  getDefaultInstanceName,
  getEngineKind,
  getEngineType,
  getTypeLabel,
  isSupportedType,
  normalizeBatchSize,
  normalizeInstanceName,
  normalizePositiveInt,
  validateInstance,
  validatePromptTemplate,
} from './registry.js';
import {
  OPENAI_PRESET_IDS,
  createOpenAIConfig,
  isKnownPreset,
  mapLegacyDeepSeek,
  normalizeOpenAIConfig,
} from './openai.js';
import { isEndpointPermitted } from './host-permission.js';
import { createLogger } from '../log/logger.js';

/** E3 日志入口。 */
const log = createLogger('E3');

/** 运行时字段：只存在于内存视图，不写 `storage.sync`。 */
const RUNTIME_FIELDS = Object.freeze([
  'systemPrompt',
  'apiKey',
  'appId',
  'secretKey',
  'hasKey',
  'credentialStatus',
  'requiresKey',
  'permission',
  'credentials',
]);

/** 迁移只执行一次的内存 Promise；失败后允许重试。 */
let migrationPromise = null;

/**
 * 判断是否为普通对象。
 * @param {unknown} value
 * @returns {boolean}
 */
function isPlainObject(value) {
  return Boolean(value) && typeof value === 'object' && !Array.isArray(value);
}

/**
 * 生成实例 id。
 * @returns {string}
 */
function createId() {
  const uuid = globalThis.crypto?.randomUUID?.();
  return uuid ? `inst-${uuid}` : `inst-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 10)}`;
}

/**
 * 归一时间戳：有限正数保留，否则用回退值。
 * @param {unknown} value
 * @param {number} fallback
 * @returns {number}
 */
function normalizeTimestamp(value, fallback) {
  const n = Number(value);
  return Number.isFinite(n) && n > 0 ? n : fallback;
}

/**
 * 取实例提示词的存储键。
 * @param {string} id
 * @returns {string}
 */
export function promptKey(id) {
  return STORAGE_KEYS.promptPrefix + id;
}

/**
 * 取实例凭据的存储键。
 * @param {string} id
 * @returns {string}
 */
export function credentialKey(id) {
  return STORAGE_KEYS.keyPrefix + id;
}

/**
 * 去掉运行时字段，得到可写入 `storage.sync` 的实例对象。
 * @param {Record<string, unknown>} instance
 * @returns {Record<string, unknown>}
 */
export function stripRuntimeFields(instance) {
  const out = { ...(isPlainObject(instance) ? instance : {}) };
  for (const field of RUNTIME_FIELDS) delete out[field];
  return out;
}

/**
 * 校验实例列表的数量与字节上限；超限时抛错，不写存储。
 * @param {Array<Record<string, unknown>>} list
 */
function assertInstanceState(list) {
  if (list.length > MAX_INSTANCES) {
    throw new Error(`最多只能保存 ${MAX_INSTANCES} 个翻译实例`);
  }
  const bytes = new TextEncoder().encode(JSON.stringify(list)).length;
  if (bytes > MAX_INSTANCE_BYTES) {
    throw new Error(`实例配置过大（${bytes} 字节），请精简请求头、参数或提示词`);
  }
}

/**
 * 同时写实例与设置（只写提供的字段），保证一次 `storage.sync.set` 完成。
 * @param {{ instances?: Array<Record<string, unknown>>, settings?: Record<string, unknown> }} patch
 */
async function writeSyncState({ instances, settings } = {}) {
  const values = {};
  if (instances) {
    const stored = instances.map(stripRuntimeFields);
    assertInstanceState(stored);
    values[STORAGE_KEYS.instances] = stored;
  }
  if (settings) values[STORAGE_KEYS.settings] = settings;
  if (Object.keys(values).length === 0) return;
  await write('sync', values);
}

/**
 * 按类型归一实例：合并默认值、裁剪字符串、归一参数；不校验、不写存储。
 *
 * - `openai`：结构由 P8-1 `normalizeOpenAIConfig` 归一；旧 `deepseek` 先经 `mapLegacyDeepSeek` 映射；
 * - `baidu`：固定地址与虚拟模型，批次/并发按百度范围夹取；
 * - 不支持的类型只补公共字段，其余字段原样保留（只允许查看与删除）。
 *
 * @param {unknown} instance
 * @param {{ fallbackConcurrency?: unknown, now?: number }} [options] 旧实例缺 `maxConcurrency` 时的迁移回退
 * @returns {Record<string, unknown>}
 */
export function normalizeInstance(instance, options = {}) {
  const source = isPlainObject(instance) ? instance : {};
  const isLegacy = source.type === ENGINE_TYPE_IDS.OPENAI ? false : source.type === 'deepseek';
  const type = isLegacy ? ENGINE_TYPE_IDS.OPENAI : String(source.type ?? '');
  const now = normalizeTimestamp(options.now, Date.now());

  const working = { ...source };
  for (const field of RUNTIME_FIELDS) delete working[field];
  if (type === ENGINE_TYPE_IDS.OPENAI) {
    delete working.baseUrl;
    delete working.reasoningEffort;
  } else if (type === ENGINE_TYPE_IDS.BAIDU) {
    delete working.preset;
  }

  const base = {
    ...working,
    id: typeof source.id === 'string' && source.id.trim() !== '' ? source.id : createId(),
    type,
    name: normalizeInstanceName(source.name),
    enabled: source.enabled !== false,
    createdAt: normalizeTimestamp(source.createdAt, now),
    updatedAt: normalizeTimestamp(source.updatedAt, now),
  };

  if (type === ENGINE_TYPE_IDS.OPENAI) {
    const config = isLegacy ? mapLegacyDeepSeek(source) : normalizeOpenAIConfig(source);
    const preset = config.preset;
    const fallbackConcurrency = normalizePositiveInt(options.fallbackConcurrency, DEFAULT_MAX_CONCURRENCY);
    return {
      ...base,
      type: ENGINE_TYPE_IDS.OPENAI,
      preset,
      endpoint: config.endpoint,
      auth: config.auth,
      headers: config.headers,
      model: config.model,
      params: config.params,
      batchSize: normalizeBatchSize(source.batchSize),
      batchMaxChars: normalizePositiveInt(source.batchMaxChars, DEFAULT_BATCH_MAX_CHARS),
      maxConcurrency:
        source.maxConcurrency == null
          ? fallbackConcurrency
          : normalizePositiveInt(source.maxConcurrency, DEFAULT_MAX_CONCURRENCY),
      name: base.name || getDefaultInstanceName(ENGINE_TYPE_IDS.OPENAI, preset),
    };
  }

  if (type === ENGINE_TYPE_IDS.BAIDU) {
    return {
      ...base,
      type: ENGINE_TYPE_IDS.BAIDU,
      baseUrl: BAIDU_BASE_URL,
      model: BAIDU_MODEL,
      batchSize: normalizeBatchSize(source.batchSize, BAIDU_BATCH_SIZE.max),
      batchMaxChars: normalizePositiveInt(
        source.batchMaxChars,
        BAIDU_BATCH_MAX_CHARS.default,
        { max: BAIDU_BATCH_MAX_CHARS.max }
      ),
      maxConcurrency: normalizePositiveInt(
        source.maxConcurrency,
        BAIDU_MAX_CONCURRENCY.default,
        { max: BAIDU_MAX_CONCURRENCY.max }
      ),
      qps: normalizePositiveInt(source.qps, BAIDU_QPS.default, {
        min: BAIDU_QPS.min,
        max: BAIDU_QPS.max,
      }),
      name: base.name || getDefaultInstanceName(ENGINE_TYPE_IDS.BAIDU),
    };
  }

  return { ...base, type: String(source.type ?? '') };
}

/**
 * 读引擎实例列表（storage.sync），并为 OpenAI 实例合并 `storage.local` 里的提示词。
 * 每次读取都做归一；旧实例缺字段按默认值补齐，但不主动写回。
 * @returns {Promise<Array<Record<string, unknown>>>}
 */
export async function getInstances() {
  const [data, settings] = await Promise.all([read('sync', STORAGE_KEYS.instances), getSettings()]);
  const list = data[STORAGE_KEYS.instances];
  if (!Array.isArray(list) || list.length === 0) return [];

  const instances = list.map((instance) =>
    normalizeInstance(instance, { fallbackConcurrency: settings.concurrency })
  );
  // 迁移前旧实例的提示词仍在实例对象里；读取时作为回退，迁移完成后以 local 为准。
  const legacyPrompts = new Map(
    list
      .filter((instance) => typeof instance?.systemPrompt === 'string' && instance.systemPrompt.trim() !== '')
      .map((instance) => [String(instance.id), instance.systemPrompt])
  );

  const promptIds = instances
    .filter((instance) => instance.type === ENGINE_TYPE_IDS.OPENAI)
    .map((instance) => promptKey(instance.id));
  let prompts = {};
  if (promptIds.length > 0) {
    try {
      prompts = await read('local', promptIds);
    } catch {
      prompts = {};
    }
  }

  return instances.map((instance) => {
    if (instance.type !== ENGINE_TYPE_IDS.OPENAI) return instance;
    const stored = prompts[promptKey(instance.id)];
    const prompt =
      typeof stored === 'string' && stored.trim() !== ''
        ? stored
        : legacyPrompts.get(String(instance.id));
    return {
      ...instance,
      systemPrompt:
        typeof prompt === 'string' && prompt.trim() !== '' ? prompt : DEFAULT_SYSTEM_PROMPT,
    };
  });
}

/**
 * 保存引擎实例列表（自动去掉提示词、凭据等运行时字段）。
 * @param {Array<Record<string, unknown>>} list
 * @returns {Promise<void>}
 */
export async function saveInstances(list) {
  await writeSyncState({ instances: Array.isArray(list) ? list : [] });
}

/**
 * 判断实例名称是否已被占用（忽略大小写与首尾空白）。
 * @param {Array<Record<string, unknown>>} instances
 * @param {string} name
 * @param {string} [exceptId]
 * @returns {boolean}
 */
function isNameTaken(instances, name, exceptId) {
  const target = normalizeInstanceName(name).toLowerCase();
  return instances.some(
    (instance) =>
      instance.id !== exceptId && normalizeInstanceName(instance.name).toLowerCase() === target
  );
}

/**
 * 生成唯一实例名称：重名时追加「2」「3」…，并保证不超过字符上限。
 * @param {Array<Record<string, unknown>>} instances
 * @param {string} name
 * @returns {string}
 */
function uniqueName(instances, name) {
  const base = normalizeInstanceName(name);
  if (!isNameTaken(instances, base)) return base;
  for (let index = 2; index < 1000; index += 1) {
    const suffix = ` ${index}`;
    const candidate = `${base.slice(0, MAX_INSTANCE_NAME_CHARS - suffix.length).trimEnd()}${suffix}`;
    if (!isNameTaken(instances, candidate)) return candidate;
  }
  throw new Error('无法生成唯一的实例名称');
}

/**
 * 判断实例类型是否需要凭据：OpenAI 无认证时不需要；百度必须 APPID + 密钥。
 * @param {Record<string, unknown>} instance
 * @returns {boolean}
 */
export function requiresKey(instance) {
  if (instance?.type === ENGINE_TYPE_IDS.OPENAI) return instance.auth?.type !== 'none';
  if (instance?.type === ENGINE_TYPE_IDS.BAIDU) return true;
  return false;
}

/**
 * 把存储值归一为类型声明的凭据对象；旧单字符串按 OpenAI `{ apiKey }` 兼容。
 * @param {string} type
 * @param {unknown} raw
 * @returns {Record<string, string>}
 */
function normalizeCredentials(type, raw) {
  if (type === ENGINE_TYPE_IDS.BAIDU) {
    if (!isPlainObject(raw)) return { appId: '', secretKey: '' };
    return {
      appId: String(raw.appId ?? ''),
      secretKey: String(raw.secretKey ?? ''),
    };
  }
  if (typeof raw === 'string') return { apiKey: raw };
  if (!isPlainObject(raw)) return { apiKey: '' };
  return { apiKey: String(raw.apiKey ?? '') };
}

/**
 * 读取某实例的凭据；只返回类型声明字段，缺失字段为空串。
 * @param {Record<string, unknown> | string} instanceOrId
 * @returns {Promise<Record<string, string>>}
 */
export async function getInstanceCredentials(instanceOrId) {
  const instance = await resolveInstance(instanceOrId);
  if (!instance) {
    return { apiKey: '', appId: '', secretKey: '' };
  }
  const area = await getSettings().then((settings) => normalizeKeyStorage(settings.keyStorage));
  const data = await read(area, credentialKey(instance.id));
  return normalizeCredentials(instance.type, data[credentialKey(instance.id)]);
}

/**
 * 取凭据状态：是否已配置、是否需要凭据；不含明文。
 * @param {Record<string, unknown>} instance
 * @returns {Promise<{ requiresKey: boolean, hasKey: boolean, credentialStatus: boolean, credentials: Record<string, string> }>}
 */
export async function getCredentialInfo(instance) {
  const needsKey = requiresKey(instance);
  const credentials = await getInstanceCredentials(instance);
  let hasKey = true;
  if (needsKey) {
    hasKey =
      instance.type === ENGINE_TYPE_IDS.BAIDU
        ? Boolean(credentials.appId && credentials.secretKey)
        : Boolean(credentials.apiKey);
  }
  return { requiresKey: needsKey, hasKey, credentialStatus: hasKey, credentials };
}

/**
 * 解析实例入参：对象原样返回，字符串按 id 查库。
 * @param {Record<string, unknown> | string | null | undefined} instanceOrId
 * @returns {Promise<Record<string, unknown> | null>}
 */
async function resolveInstance(instanceOrId) {
  if (isPlainObject(instanceOrId)) return instanceOrId;
  if (typeof instanceOrId !== 'string' || instanceOrId === '') return null;
  const instances = await getInstances();
  return instances.find((instance) => instance.id === instanceOrId) ?? null;
}

/**
 * 检查实例是否可执行/可设为当前。
 * 顺序：类型受支持 → 结构有效 → 已启用 → 凭据完整 → endpoint 已授权。
 * @param {Record<string, unknown>} instance
 * @param {{ requireKey?: boolean, requirePermission?: boolean }} [options]
 * @returns {Promise<{ ok: boolean, reason: string | null }>}
 */
export async function checkInstanceEligibility(
  instance,
  { requireKey = true, requirePermission = true } = {}
) {
  if (!instance || !getEngineType(instance.type)) {
    return { ok: false, reason: 'unsupported' };
  }
  if (!validateInstance(instance).ok) return { ok: false, reason: 'invalid' };
  if (instance.enabled === false) return { ok: false, reason: 'disabled' };
  if (requireKey) {
    const info = await getCredentialInfo(instance);
    if (!info.hasKey) return { ok: false, reason: 'missing-key' };
  }
  if (requirePermission) {
    const permitted = await isInstancePermitted(instance);
    if (!permitted) return { ok: false, reason: 'permission' };
  }
  return { ok: true, reason: null };
}

/**
 * 判断实例的 endpoint 是否已授权：百度固定主机随扩展安装授权；OpenAI 按域名检查。
 * @param {Record<string, unknown>} instance
 * @returns {Promise<boolean>}
 */
export async function isInstancePermitted(instance) {
  if (instance?.type === ENGINE_TYPE_IDS.BAIDU) return true;
  if (instance?.type === ENGINE_TYPE_IDS.OPENAI) {
    return isEndpointPermitted(instance.endpoint?.baseUrl);
  }
  return false;
}

/**
 * 按「当前实例 → 其它实例」顺序找第一个可用实例；只读，不写存储。
 * 全部不可用时返回 null，`reason` 为遇到的第一个失败原因。
 * @param {{ requireKey?: boolean, requirePermission?: boolean }} [options]
 * @returns {Promise<{ instance: Record<string, unknown> | null, reason: string | null, candidate: Record<string, unknown> | null }>}
 */
export async function resolveActiveInstance({
  requireKey = true,
  requirePermission = true,
} = {}) {
  const [instances, settings] = await Promise.all([getInstances(), getSettings()]);
  if (instances.length === 0) {
    return { instance: null, reason: 'no-instance', candidate: null };
  }
  const activeId = settings.activeInstanceId;
  const ordered = [
    ...instances.filter((instance) => instance.id === activeId),
    ...instances.filter((instance) => instance.id !== activeId),
  ];
  let reason = null;
  for (const instance of ordered) {
    const result = await checkInstanceEligibility(instance, { requireKey, requirePermission });
    if (result.ok) return { instance, reason: null, candidate: ordered[0] };
    reason ??= result.reason;
  }
  return { instance: null, reason: reason ?? 'unavailable', candidate: ordered[0] };
}

/**
 * 取当前生效实例；只读、不创建实例。
 * @param {{ requireKey?: boolean, requirePermission?: boolean }} [options]
 * @returns {Promise<Record<string, unknown> | null>}
 */
export async function getActiveInstance(options = {}) {
  return (await resolveActiveInstance(options)).instance;
}

/**
 * 取第一个可用实例的 id（用于停用/删除/清凭据后的改选）。
 * @param {Array<Record<string, unknown>>} instances
 * @param {string | null} [exceptId]
 * @returns {Promise<string | null>}
 */
async function electActiveId(instances, exceptId = null) {
  for (const instance of instances) {
    if (instance.id === exceptId) continue;
    const result = await checkInstanceEligibility(instance);
    if (result.ok) return instance.id;
  }
  return null;
}

/**
 * 取带凭据状态与权限状态的实例视图（内存字段，不写存储）。
 * @param {Record<string, unknown>} instance
 * @returns {Promise<Record<string, unknown>>}
 */
async function getInstanceView(instance) {
  const info = await getCredentialInfo(instance);
  const permitted = isSupportedType(instance.type) ? await isInstancePermitted(instance) : false;
  return {
    ...instance,
    ...info,
    permission: permitted ? 'granted' : 'missing',
  };
}

/**
 * 转为公开字段：不含凭据明文；OpenAI 含 endpoint/auth/headers/model/params/systemPrompt，
 * 百度含 model 与批次参数，不支持类型只保留公共字段。
 *
 * `credentialFields` 只给出各凭据字段是否已填写（布尔），用于「部分配置」显示；
 * 明文只存在于入参视图的 `credentials`，不会出现在返回值里。
 * @param {Record<string, unknown>} instance 已合并凭据状态的实例视图
 * @returns {Record<string, unknown>}
 */
export function toPublicInstance(instance) {
  const credentials = isPlainObject(instance.credentials) ? instance.credentials : {};
  const hasValue = (field) => String(credentials[field] ?? '') !== '';
  const credentialFields =
    instance.type === ENGINE_TYPE_IDS.OPENAI
      ? { apiKey: hasValue('apiKey') }
      : instance.type === ENGINE_TYPE_IDS.BAIDU
        ? { appId: hasValue('appId'), secretKey: hasValue('secretKey') }
        : {};

  const base = {
    id: instance.id,
    type: instance.type,
    typeLabel: getTypeLabel(instance.type),
    kind: getEngineKind(instance.type),
    preset: instance.type === ENGINE_TYPE_IDS.OPENAI ? instance.preset : null,
    name: instance.name,
    enabled: instance.enabled !== false,
    createdAt: instance.createdAt,
    updatedAt: instance.updatedAt,
    hasKey: Boolean(instance.hasKey),
    credentialStatus: Boolean(instance.credentialStatus),
    credentialFields,
    requiresKey: Boolean(instance.requiresKey),
    permission: instance.permission ?? 'missing',
  };

  if (instance.type === ENGINE_TYPE_IDS.OPENAI) {
    return {
      ...base,
      endpoint: instance.endpoint,
      auth: instance.auth,
      headers: instance.headers,
      model: instance.model,
      params: instance.params,
      systemPrompt: instance.systemPrompt,
      batchSize: instance.batchSize,
      batchMaxChars: instance.batchMaxChars,
      maxConcurrency: instance.maxConcurrency,
    };
  }

  if (instance.type === ENGINE_TYPE_IDS.BAIDU) {
    return {
      ...base,
      baseUrl: instance.baseUrl,
      model: instance.model,
      batchSize: instance.batchSize,
      batchMaxChars: instance.batchMaxChars,
      maxConcurrency: instance.maxConcurrency,
      qps: instance.qps,
    };
  }

  return {
    ...base,
    typeLabel: '不支持',
    kind: 'unsupported',
    hasKey: false,
    credentialStatus: false,
    requiresKey: false,
    permission: 'unsupported',
  };
}

/**
 * 公开设置：设置 + 全部实例的公开字段（不含凭据明文）。
 * @returns {Promise<{ settings: Record<string, unknown>, instances: Array<Record<string, unknown>> }>}
 */
export async function getPublicSettings() {
  const [settings, instances] = await Promise.all([getSettings(), getInstances()]);
  const views = await Promise.all(instances.map(getInstanceView));
  return { settings, instances: views.map(toPublicInstance) };
}

/**
 * 完整设置：设置 + 全部实例（含类型声明的凭据明文）。仅后台使用。
 * @returns {Promise<{ settings: Record<string, unknown>, instances: Array<Record<string, unknown>> }>}
 */
export async function getFullSettings() {
  const [settings, instances] = await Promise.all([getSettings(), getInstances()]);
  return {
    settings,
    instances: await Promise.all(
      instances.map(async (instance) => ({
        ...instance,
        ...(await getCredentialInfo(instance)),
      }))
    ),
  };
}

/**
 * 新增实例：校验类型/名称/数量/字节，先写提示词再写实例，必要时自动设为当前。
 * @param {Record<string, unknown>} [input]
 * @returns {Promise<Record<string, unknown>>} 实例视图
 */
export async function createInstance(input = {}) {
  const source = isPlainObject(input) ? input : {};
  const type = source.type === 'deepseek' ? ENGINE_TYPE_IDS.OPENAI : source.type;
  if (!isSupportedType(type)) throw new Error('不支持的实例类型');

  const instances = await getInstances();
  if (instances.length >= MAX_INSTANCES) {
    throw new Error(`最多只能创建 ${MAX_INSTANCES} 个翻译实例`);
  }

  const preset =
    type === ENGINE_TYPE_IDS.OPENAI && isKnownPreset(source.preset)
      ? source.preset
      : OPENAI_PRESET_IDS.DEEPSEEK;
  const requestedName = normalizeInstanceName(source.name);
  if (requestedName !== '' && isNameTaken(instances, requestedName)) {
    throw new Error('实例名称已存在');
  }
  const name = requestedName || uniqueName(instances, getDefaultInstanceName(type, preset));

  const now = Date.now();
  const id = createId();
  const prompt =
    typeof source.systemPrompt === 'string' ? source.systemPrompt : DEFAULT_SYSTEM_PROMPT;
  if (type === ENGINE_TYPE_IDS.OPENAI) {
    const promptCheck = validatePromptTemplate(prompt);
    if (!promptCheck.ok) throw new Error(promptCheck.error);
  }

  const {
    systemPrompt: _prompt,
    id: _id,
    type: _type,
    createdAt: _createdAt,
    updatedAt: _updatedAt,
    hasKey: _hasKey,
    credentialStatus: _credentialStatus,
    requiresKey: _requiresKey,
    permission: _permission,
    ...overrides
  } = source;

  const defaults =
    type === ENGINE_TYPE_IDS.OPENAI
      ? {
          ...createOpenAIConfig(preset),
          batchSize: DEFAULT_BATCH_SIZE,
          batchMaxChars: DEFAULT_BATCH_MAX_CHARS,
          maxConcurrency: DEFAULT_MAX_CONCURRENCY,
        }
      : {
          baseUrl: BAIDU_BASE_URL,
          model: BAIDU_MODEL,
          batchSize: BAIDU_BATCH_SIZE.default,
          batchMaxChars: BAIDU_BATCH_MAX_CHARS.default,
          maxConcurrency: BAIDU_MAX_CONCURRENCY.default,
        };

  const merged = normalizeInstance({
    ...defaults,
    ...overrides,
    id,
    type,
    preset,
    name,
    enabled: source.enabled !== false,
    createdAt: now,
    updatedAt: now,
  });
  if (type === ENGINE_TYPE_IDS.OPENAI) merged.systemPrompt = prompt;
  const validation = validateInstance(merged);
  if (!validation.ok) throw new Error(validation.errors.join('；'));

  const prospective = [...instances, merged].map(stripRuntimeFields);
  assertInstanceState(prospective);
  if (type === ENGINE_TYPE_IDS.OPENAI) await write('local', { [promptKey(id)]: prompt });

  const settings = await getSettings();
  let nextSettings = null;
  if (!settings.activeInstanceId) {
    const eligibility = await checkInstanceEligibility(merged, {
      requireKey: true,
      requirePermission: true,
    });
    if (eligibility.ok) nextSettings = { ...settings, activeInstanceId: id };
  }

  await writeSyncState({ instances: [...instances, merged], settings: nextSettings });
  log.info('config.instance.create', '已创建翻译实例', {
    instanceId: id,
    type,
    preset: type === ENGINE_TYPE_IDS.OPENAI ? preset : null,
    enabled: merged.enabled,
    active: Boolean(nextSettings),
  });

  const created = await getInstanceView(merged);
  return toPublicInstance(created);
}

/**
 * 更新一个实例：合并补丁、归一、校验，成功后写回完整字段；失败抛出且不写入。
 * @param {string} id
 * @param {Record<string, unknown>} patch
 * @returns {Promise<Record<string, unknown>>} 实例视图
 */
export async function updateInstance(id, patch = {}) {
  const instances = await getInstances();
  const index = instances.findIndex((item) => item.id === id);
  if (index < 0) throw new Error('实例不存在');
  const existing = instances[index];
  if (!getEngineType(existing.type)) throw new Error('不支持的实例类型，只能删除');

  const source = isPlainObject(patch) ? patch : {};
  const { systemPrompt, id: _id, type: _type, createdAt: _createdAt, ...rest } = source;
  const patchWithPreset = applyPresetSwitch(existing, rest);

  const merged = normalizeInstance({
    ...stripRuntimeFields(existing),
    ...patchWithPreset,
    id,
    type: existing.type,
    createdAt: existing.createdAt,
    updatedAt: Date.now(),
  });
  if (existing.type === ENGINE_TYPE_IDS.OPENAI) merged.systemPrompt = existing.systemPrompt;

  let nextPrompt = null;
  if (existing.type === ENGINE_TYPE_IDS.OPENAI && typeof systemPrompt === 'string') {
    const promptCheck = validatePromptTemplate(systemPrompt);
    if (!promptCheck.ok) throw new Error(promptCheck.error);
    nextPrompt = systemPrompt;
    merged.systemPrompt = nextPrompt;
  }

  if (isNameTaken(instances, merged.name, id)) throw new Error('实例名称已存在');
  const validation = validateInstance(merged);
  if (!validation.ok) throw new Error(validation.errors.join('；'));

  const list = instances.slice();
  list[index] = merged;
  assertInstanceState(list.map(stripRuntimeFields));

  if (nextPrompt != null) await write('local', { [promptKey(id)]: nextPrompt });

  const settings = await getSettings();
  let nextSettings = null;
  if (settings.activeInstanceId === id) {
    const eligibility = await checkInstanceEligibility(merged);
    if (!eligibility.ok) {
      nextSettings = { ...settings, activeInstanceId: await electActiveId(list, id) };
    }
  } else if (!settings.activeInstanceId && merged.enabled !== false) {
    const eligibility = await checkInstanceEligibility(merged);
    if (eligibility.ok) nextSettings = { ...settings, activeInstanceId: id };
  }

  await writeSyncState({ instances: list, settings: nextSettings });
  log.info('config.instance.update', '已更新翻译实例', {
    instanceId: id,
    type: merged.type,
    preset: merged.type === ENGINE_TYPE_IDS.OPENAI ? merged.preset : null,
    fields: Object.keys(patchWithPreset).sort(),
    promptUpdated: nextPrompt != null,
    activeChanged: Boolean(nextSettings),
  });

  return toPublicInstance(
    await getInstanceView({
      ...merged,
      systemPrompt:
        nextPrompt ?? (existing.type === ENGINE_TYPE_IDS.OPENAI ? existing.systemPrompt : undefined),
    })
  );
}

/**
 * 预设切换：DeepSeek 套用预设默认连接配置；自定义保留当前连接配置。
 * @param {Record<string, unknown>} existing
 * @param {Record<string, unknown>} patch
 * @returns {Record<string, unknown>}
 */
function applyPresetSwitch(existing, patch) {
  if (existing.type !== ENGINE_TYPE_IDS.OPENAI || !Object.hasOwn(patch, 'preset')) return patch;
  const preset = isKnownPreset(patch.preset) ? patch.preset : null;
  if (!preset || preset === existing.preset) return patch;
  if (preset === OPENAI_PRESET_IDS.DEEPSEEK) {
    const defaults = createOpenAIConfig(OPENAI_PRESET_IDS.DEEPSEEK);
    return {
      ...patch,
      endpoint: Object.hasOwn(patch, 'endpoint') ? patch.endpoint : defaults.endpoint,
      auth: Object.hasOwn(patch, 'auth') ? patch.auth : defaults.auth,
      headers: Object.hasOwn(patch, 'headers') ? patch.headers : defaults.headers,
      model: Object.hasOwn(patch, 'model') ? patch.model : defaults.model,
      params: Object.hasOwn(patch, 'params') ? patch.params : defaults.params,
    };
  }
  return patch;
}

/**
 * 复制实例：默认停用、不复制凭据、不改变当前实例；提示词一并复制。
 * @param {string} id
 * @returns {Promise<Record<string, unknown>>} 实例视图
 */
export async function duplicateInstance(id) {
  const instances = await getInstances();
  const source = instances.find((instance) => instance.id === id);
  if (!source) throw new Error('实例不存在');
  if (!getEngineType(source.type)) throw new Error('不支持的实例类型，无法复制');
  if (instances.length >= MAX_INSTANCES) {
    throw new Error(`最多只能创建 ${MAX_INSTANCES} 个翻译实例`);
  }

  const now = Date.now();
  const newId = createId();
  const merged = normalizeInstance({
    ...stripRuntimeFields(source),
    id: newId,
    name: uniqueName(instances, `${source.name} 副本`),
    enabled: false,
    createdAt: now,
    updatedAt: now,
  });
  if (merged.type === ENGINE_TYPE_IDS.OPENAI) merged.systemPrompt = source.systemPrompt;
  const validation = validateInstance(merged);
  if (!validation.ok) throw new Error(validation.errors.join('；'));

  assertInstanceState([...instances, merged].map(stripRuntimeFields));
  if (merged.type === ENGINE_TYPE_IDS.OPENAI && typeof source.systemPrompt === 'string') {
    await write('local', { [promptKey(newId)]: source.systemPrompt });
  }
  await writeSyncState({ instances: [...instances, merged] });
  log.info('config.instance.duplicate', '已复制翻译实例', {
    instanceId: newId,
    sourceId: id,
    type: merged.type,
  });
  return toPublicInstance(await getInstanceView({ ...merged, systemPrompt: source.systemPrompt }));
}

/**
 * 删除实例：先删凭据与提示词，再在一次 `storage.sync.set` 中写实例与改选后的当前实例。
 * @param {string} id
 * @returns {Promise<{ removed: string, activeInstanceId: string | null }>}
 */
export async function removeInstance(id) {
  const instances = await getInstances();
  const index = instances.findIndex((instance) => instance.id === id);
  if (index < 0) throw new Error('实例不存在');

  const remaining = instances.filter((instance) => instance.id !== id);
  const settings = await getSettings();
  let activeInstanceId = settings.activeInstanceId;
  if (activeInstanceId === id) activeInstanceId = await electActiveId(remaining);

  await removeKeys('local', promptKey(id));
  await removeKeys('local', credentialKey(id));
  await removeKeys('sync', credentialKey(id));

  await writeSyncState({
    instances: remaining,
    settings:
      activeInstanceId === settings.activeInstanceId
        ? null
        : { ...settings, activeInstanceId },
  });
  log.info('config.instance.remove', '已删除翻译实例', {
    instanceId: id,
    remaining: remaining.length,
    activeChanged: activeInstanceId !== settings.activeInstanceId,
  });
  return { removed: id, activeInstanceId };
}

/**
 * 启用/停用实例；停用当前实例时同一次写入完成改选。
 * @param {string} id
 * @param {boolean} enabled
 * @returns {Promise<Record<string, unknown>>} 实例视图
 */
export async function setInstanceEnabled(id, enabled) {
  if (typeof enabled !== 'boolean') throw new Error('启用状态无效');
  const instances = await getInstances();
  const index = instances.findIndex((instance) => instance.id === id);
  if (index < 0) throw new Error('实例不存在');
  const existing = instances[index];
  if (!getEngineType(existing.type)) throw new Error('不支持的实例类型，只能删除');

  const merged = normalizeInstance({
    ...stripRuntimeFields(existing),
    enabled,
    updatedAt: Date.now(),
  });
  if (merged.type === ENGINE_TYPE_IDS.OPENAI) merged.systemPrompt = existing.systemPrompt;
  const validation = validateInstance(merged);
  if (!validation.ok) throw new Error(validation.errors.join('；'));

  const list = instances.slice();
  list[index] = merged;

  const settings = await getSettings();
  let nextSettings = null;
  if (!enabled && settings.activeInstanceId === id) {
    nextSettings = { ...settings, activeInstanceId: await electActiveId(list, id) };
  } else if (enabled && !settings.activeInstanceId) {
    const eligibility = await checkInstanceEligibility(merged);
    if (eligibility.ok) nextSettings = { ...settings, activeInstanceId: id };
  }

  await writeSyncState({ instances: list, settings: nextSettings });
  log.info('config.instance.toggle', '已切换实例启用状态', {
    instanceId: id,
    enabled,
    activeChanged: Boolean(nextSettings),
  });
  return toPublicInstance(await getInstanceView(merged));
}

/**
 * 设为当前实例：要求类型受支持、已启用、凭据完整、endpoint 已授权。
 * @param {string} id
 * @returns {Promise<Record<string, unknown>>} 实例视图
 */
export async function setActiveInstance(id) {
  const instances = await getInstances();
  const instance = instances.find((item) => item.id === id);
  if (!instance) throw new Error('实例不存在');
  const eligibility = await checkInstanceEligibility(instance);
  if (!eligibility.ok) {
    const messages = {
      unsupported: '不支持的实例类型，不能设为当前',
      invalid: '实例配置无效，请先修复',
      disabled: '实例已停用，不能设为当前',
      'missing-key': '缺少凭据，不能设为当前',
      permission: '接口域名未授权，请先授权',
    };
    throw new Error(messages[eligibility.reason] ?? '实例不可用，不能设为当前');
  }

  const settings = await getSettings();
  if (settings.activeInstanceId !== id) {
    await write('sync', {
      [STORAGE_KEYS.settings]: normalizeSettings({ ...settings, activeInstanceId: id }),
    });
    log.info('config.active.set', '已切换当前翻译实例', { instanceId: id, type: instance.type });
  }
  return toPublicInstance(await getInstanceView(instance));
}

/**
 * 写某实例的凭据：只接受类型声明字段，未提供的字段保留原值。
 * @param {string} id
 * @param {Record<string, unknown>} input
 * @returns {Promise<{ requiresKey: boolean, hasKey: boolean, credentialStatus: boolean }>}
 */
export async function writeCredentials(id, input = {}) {
  const instance = await resolveInstance(id);
  if (!instance) throw new Error('实例不存在');
  if (!getEngineType(instance.type)) throw new Error('不支持的实例类型');

  const current = await getInstanceCredentials(instance);
  const source = isPlainObject(input) ? input : {};
  const readField = (name) =>
    Object.hasOwn(source, name) ? String(source[name] ?? '').trim() : current[name] ?? '';
  const next =
    instance.type === ENGINE_TYPE_IDS.BAIDU
      ? { appId: readField('appId'), secretKey: readField('secretKey') }
      : { apiKey: readField('apiKey') };

  if (Object.values(next).every((value) => value === '')) {
    return removeCredentials(id);
  }

  const area = normalizeKeyStorage((await getSettings()).keyStorage);
  await write(area, { [credentialKey(id)]: next });

  const settings = await getSettings();
  if (!settings.activeInstanceId) {
    const view = { ...instance, ...next };
    const eligibility = await checkInstanceEligibility(view);
    if (eligibility.ok) {
      await write('sync', {
        [STORAGE_KEYS.settings]: normalizeSettings({ ...settings, activeInstanceId: id }),
      });
    }
  }

  const info = await getCredentialInfo(instance);
  log.info('config.credentials.write', '已保存实例凭据', {
    instanceId: id,
    type: instance.type,
    hasKey: info.hasKey,
    area,
  });
  return { requiresKey: info.requiresKey, hasKey: info.hasKey, credentialStatus: info.hasKey };
}

/**
 * 删除某实例凭据（local 与 sync 两区副本），当前实例改选。
 * @param {string} id
 * @returns {Promise<{ requiresKey: boolean, hasKey: boolean, credentialStatus: boolean }>}
 */
export async function removeCredentials(id) {
  const instance = await resolveInstance(id);
  await removeKeys('local', credentialKey(id));
  await removeKeys('sync', credentialKey(id));

  if (instance) {
    const settings = await getSettings();
    if (settings.activeInstanceId === id) {
      const instances = await getInstances();
      const activeInstanceId = await electActiveId(instances, id);
      await write('sync', {
        [STORAGE_KEYS.settings]: normalizeSettings({ ...settings, activeInstanceId }),
      });
    }
  }

  const info = instance
    ? await getCredentialInfo(instance)
    : { requiresKey: false, hasKey: false, credentialStatus: false };
  log.info('config.credentials.remove', '已清除实例凭据', {
    instanceId: id,
    type: instance?.type ?? null,
  });
  return { requiresKey: info.requiresKey, hasKey: info.hasKey, credentialStatus: info.hasKey };
}

/**
 * 切换凭据存放位置：写目标 → 写设置 → 删源；任一步失败回滚设置并保留原数据。
 * @param {unknown} next
 * @returns {Promise<{ area: 'local'|'sync', migrated: number }>}
 */
export async function setKeyStorage(next) {
  const target = normalizeKeyStorage(next);
  const settings = await getSettings();
  const source = normalizeKeyStorage(settings.keyStorage);
  if (target === source) return { area: target, migrated: 0 };

  const instances = await getInstances();
  const keys = instances.map((instance) => credentialKey(instance.id));
  let values = {};
  if (keys.length > 0) {
    const data = await read(source, keys);
    values = Object.fromEntries(
      Object.entries(data).filter(([key, value]) => keys.includes(key) && value != null)
    );
  }
  const migrated = Object.keys(values).length;

  try {
    if (migrated > 0) await write(target, values);
    await write('sync', {
      [STORAGE_KEYS.settings]: normalizeSettings({ ...settings, keyStorage: target }),
    });
  } catch (error) {
    try {
      if (migrated > 0) await removeKeys(target, Object.keys(values));
      await write('sync', {
        [STORAGE_KEYS.settings]: normalizeSettings({ ...settings, keyStorage: source }),
      });
    } catch {
      // 回滚失败时保留原设置，下次重试。
    }
    log.warn('config.keyStorage.switch', '凭据存放位置切换失败，已回滚', {
      from: source,
      to: target,
      migrated,
    });
    throw error;
  }

  if (migrated > 0) {
    try {
      await removeKeys(source, Object.keys(values));
    } catch {
      // 目标区已有副本；源区残留不影响读取。
    }
  }
  log.info('config.keyStorage.switch', '已切换凭据存放位置', {
    from: source,
    to: target,
    migrated,
  });
  return { area: target, migrated };
}

/**
 * 旧配置惰性迁移入口的兼容别名。
 * @returns {Promise<unknown>}
 */
export async function migrateLegacyKey() {
  return migrateConfig();
}

/**
 * 旧密钥读写兼容：只用于 OpenAI 实例，实际存储为 `{ apiKey }`。
 * @param {string} instanceId
 * @param {string} key
 * @returns {Promise<void>}
 */
export async function writeKey(instanceId, key) {
  await writeCredentials(instanceId, { apiKey: key });
}

/**
 * 读旧式单密钥：只对 OpenAI 实例返回 `apiKey`，其余返回 null。
 * @param {string} instanceId
 * @returns {Promise<string | null>}
 */
export async function getKey(instanceId) {
  const instance = await resolveInstance(instanceId);
  if (!instance || instance.type !== ENGINE_TYPE_IDS.OPENAI) return null;
  const credentials = await getInstanceCredentials(instance);
  return credentials.apiKey || null;
}

/**
 * 判断实例是否已配置凭据（无认证 OpenAI 恒为 true）。
 * @param {string} instanceId
 * @returns {Promise<boolean>}
 */
export async function hasKey(instanceId) {
  const instance = await resolveInstance(instanceId);
  if (!instance) return false;
  return (await getCredentialInfo(instance)).hasKey;
}

/**
 * 删除旧式单密钥的兼容别名。
 * @param {string} instanceId
 * @returns {Promise<void>}
 */
export async function removeKey(instanceId) {
  await removeCredentials(instanceId);
}

/**
 * 旧键名兼容。
 * @param {string} instanceId
 * @returns {string}
 */
export function keyName(instanceId) {
  return credentialKey(instanceId);
}

/**
 * 用目录默认值构造默认实例（不写存储）。
 * @returns {Record<string, unknown>}
 */
export function createDefaultInstance() {
  return {
    ...normalizeInstance({
      ...createOpenAIConfig(OPENAI_PRESET_IDS.DEEPSEEK),
      name: getDefaultInstanceName(ENGINE_TYPE_IDS.OPENAI, OPENAI_PRESET_IDS.DEEPSEEK),
      enabled: true,
      batchSize: DEFAULT_BATCH_SIZE,
      batchMaxChars: DEFAULT_BATCH_MAX_CHARS,
      maxConcurrency: DEFAULT_MAX_CONCURRENCY,
    }),
    systemPrompt: DEFAULT_SYSTEM_PROMPT,
  };
}

/**
 * 取第一个实例，没有时创建默认 DeepSeek 实例。仅供旧调用方与测试使用。
 * @returns {Promise<Record<string, unknown>>}
 */
export async function getOrCreateDefaultInstance() {
  const instances = await getInstances();
  if (instances.length > 0) return instances[0];
  return createInstance({
    type: ENGINE_TYPE_IDS.OPENAI,
    preset: OPENAI_PRESET_IDS.DEEPSEEK,
    name: getDefaultInstanceName(ENGINE_TYPE_IDS.OPENAI, OPENAI_PRESET_IDS.DEEPSEEK),
  });
}

/**
 * 迁移结果初始化：构造默认 DeepSeek 原始实例（迁移内部使用，不写存储）。
 * @returns {Record<string, unknown>}
 */
function createMigrationDefaultInstance() {
  const now = Date.now();
  return {
    ...createDefaultInstance(),
    id: createId(),
    createdAt: now,
    updatedAt: now,
  };
}

/**
 * 从存储数据判断实例是否已有可用凭据。
 * @param {Record<string, unknown>} instance
 * @param {Record<string, unknown>} credentials
 * @returns {boolean}
 */
function hasCredentialsFromMap(instance, credentials) {
  if (!requiresKey(instance)) return true;
  const value = credentials[instance.id];
  const normalized = normalizeCredentials(instance.type, value);
  return instance.type === ENGINE_TYPE_IDS.BAIDU
    ? Boolean(normalized.appId && normalized.secretKey)
    : Boolean(normalized.apiKey);
}

/**
 * 配置迁移 v1 → v2：旧 DeepSeek 映射、提示词搬家、旧密钥对象化、当前实例改选。
 * 幂等；关键写入失败时不写 `configVersion`，下次重试。
 * @returns {Promise<{ migrated: boolean, reason?: string }>}
 */
export async function migrateConfig() {
  const [syncData, localData] = await Promise.all([read('sync'), read('local')]);
  const rawSettings = isPlainObject(syncData[STORAGE_KEYS.settings])
    ? syncData[STORAGE_KEYS.settings]
    : {};
  const rawList = Array.isArray(syncData[STORAGE_KEYS.instances])
    ? syncData[STORAGE_KEYS.instances]
    : [];

  const configVersion = Number(rawSettings.configVersion ?? 0);
  const hasLegacyInstance = rawList.some(
    (instance) => instance?.type === 'deepseek' || typeof instance?.systemPrompt === 'string'
  );
  const dataKeys = [...Object.keys(localData), ...Object.keys(syncData)];
  const knownIds = new Set(
    rawList.map((instance) => String(instance?.id ?? '')).filter((id) => id !== '')
  );
  const hasLegacyKey = dataKeys.some(
    (key) =>
      key.startsWith(STORAGE_KEYS.keyPrefix) &&
      knownIds.has(key.slice(STORAGE_KEYS.keyPrefix.length)) &&
      (typeof localData[key] === 'string' || typeof syncData[key] === 'string')
  );

  if (configVersion >= CONFIG_VERSION && !hasLegacyInstance && !hasLegacyKey) {
    return { migrated: false };
  }

  const now = Date.now();
  const sources = rawList.length > 0 ? rawList : [createMigrationDefaultInstance()];
  const instances = sources.map((instance) =>
    normalizeInstance(instance, { fallbackConcurrency: rawSettings.concurrency, now })
  );

  let complete = true;
  const keepPromptIds = new Set();

  // 1. 提示词搬家：先写 local，成功后才从实例移除；失败保留实例字段以便下次重试。
  const promptValues = {};
  sources.forEach((raw, index) => {
    const instance = instances[index];
    if (instance.type !== ENGINE_TYPE_IDS.OPENAI) return;
    const legacyPrompt =
      typeof raw.systemPrompt === 'string' && raw.systemPrompt.trim() !== ''
        ? raw.systemPrompt
        : null;
    const existing = localData[promptKey(instance.id)];
    if (legacyPrompt == null) return;
    if (typeof existing === 'string' && existing.trim() !== '') return;
    promptValues[promptKey(instance.id)] = legacyPrompt;
  });
  if (Object.keys(promptValues).length > 0) {
    try {
      await write('local', promptValues);
    } catch {
      complete = false;
      for (const key of Object.keys(promptValues)) keepPromptIds.add(key.slice(STORAGE_KEYS.promptPrefix.length));
    }
  }

  // 2. 凭据对象化：旧单字符串 → `{ apiKey }`；先写目标区再删旧字符串。
  const targetArea = normalizeKeyStorage(rawSettings.keyStorage);
  const credentialValues = {};
  const legacyStringKeys = { local: [], sync: [] };
  const credentialMap = {};
  for (const instance of instances) {
    if (!getEngineType(instance.type)) continue;
    const key = credentialKey(instance.id);
    const present = [];
    if (localData[key] !== undefined) present.push({ area: 'local', value: localData[key] });
    if (syncData[key] !== undefined) present.push({ area: 'sync', value: syncData[key] });
    if (present.length === 0) continue;

    const objectEntry = present.find((entry) => isPlainObject(entry.value));
    const stringEntries = present.filter((entry) => typeof entry.value === 'string');
    const hasObjectInTarget = present.some(
      (entry) => entry.area === targetArea && isPlainObject(entry.value)
    );

    if (!hasObjectInTarget) {
      const value =
        objectEntry?.value ??
        (stringEntries.length > 0 ? { apiKey: stringEntries[0].value } : null);
      if (value) credentialValues[key] = value;
    }
    for (const entry of stringEntries) {
      if (entry.area !== targetArea) legacyStringKeys[entry.area].push(key);
    }
    credentialMap[instance.id] = credentialValues[key] ?? objectEntry?.value ?? null;
  }
  if (Object.keys(credentialValues).length > 0) {
    try {
      await write(targetArea, credentialValues);
    } catch {
      complete = false;
    }
  }
  if (complete) {
    for (const area of ['local', 'sync']) {
      const keys = legacyStringKeys[area];
      if (keys.length === 0) continue;
      try {
        await removeKeys(area, keys);
      } catch {
        // 目标区已有对象副本；字符串残留不影响读取。
      }
    }
  }

  // 3. 当前实例：保留有效者，否则第一个可用（凭据完整），都没有为 null。
  const usable = instances.filter(
    (instance) => getEngineType(instance.type) && instance.enabled !== false
  );
  const configured = usable.filter((instance) => hasCredentialsFromMap(instance, credentialMap));
  const currentId =
    typeof rawSettings.activeInstanceId === 'string' ? rawSettings.activeInstanceId : null;
  let activeInstanceId = null;
  if (currentId && configured.some((instance) => instance.id === currentId)) {
    activeInstanceId = currentId;
  } else {
    activeInstanceId = configured[0]?.id ?? usable[0]?.id ?? null;
  }

  // 4. 最后写 settings（configVersion 仅在全部关键写入成功后写入）与实例。
  const stored = instances.map((instance) => {
    const item = stripRuntimeFields(instance);
    const key = promptKey(instance.id);
    if (keepPromptIds.has(instance.id)) {
      const legacyPrompt = promptValues[key];
      if (typeof legacyPrompt === 'string') item.systemPrompt = legacyPrompt;
    }
    return item;
  });

  const nextSettings = normalizeSettings({
    ...rawSettings,
    configVersion: complete ? CONFIG_VERSION : rawSettings.configVersion ?? 0,
    activeInstanceId,
  });
  if (complete) delete nextSettings.concurrency;

  // 迁移必须保留实例内的旧提示词（提示词写入失败时），因此直接写入已处理好的实例数组。
  assertInstanceState(stored);
  await write('sync', {
    [STORAGE_KEYS.instances]: stored,
    [STORAGE_KEYS.settings]: nextSettings,
  });

  log.info('config.migrate.done', '配置迁移完成', {
    from: configVersion,
    to: complete ? CONFIG_VERSION : configVersion,
    instances: instances.length,
    promptsMoved: Object.keys(promptValues).length - keepPromptIds.size,
    credentialsMigrated: Object.keys(credentialValues).length,
    activeInstanceId: Boolean(activeInstanceId),
    complete,
  });
  return { migrated: true, reason: complete ? undefined : 'incomplete' };
}

/**
 * 确保迁移只执行一次；失败后下次调用重试。
 * @returns {Promise<unknown>}
 */
export function ensureConfigMigrated() {
  if (!migrationPromise) {
    migrationPromise = migrateConfig().catch((error) => {
      migrationPromise = null;
      throw error;
    });
  }
  return migrationPromise;
}

/**
 * 重置迁移记忆（测试用）。
 */
export function resetMigrationForTests() {
  migrationPromise = null;
}

export { MAX_INSTANCES, MAX_INSTANCE_NAME_CHARS, MAX_INSTANCE_BYTES };
