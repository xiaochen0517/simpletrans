/**
 * E3 引擎实例
 *
 * 模块：公共模块（E）/ E3
 * 职责：管理引擎实例、首选与备用引擎、密钥键名与旧配置迁移；归一、校验并写入实例参数。
 * 依赖：E2 设置与存储（settings.js/storage.js）、E3 引擎类型目录（registry.js，P1 起）。
 * 实现阶段：P1（引擎层与密钥配置）；P6.2 增加实例参数归一、读取补齐、`updateInstance` 与旧并发迁移。
 *
 * 密钥「只有后台读」是最终目标（P2 起）；P1 为做演示测试，设置页会临时直接读密钥，
 * 属需求文档 P1-5 已确认的临时偏离，P2 收敛到后台后消除。
 */

import { STORAGE_KEYS, read, write, removeKeys } from '../storage.js';
import { getSettings, keyArea } from '../settings.js';
import {
  ENGINE_TYPE_IDS,
  DEFAULT_BATCH_MAX_CHARS,
  DEFAULT_BATCH_SIZE,
  DEFAULT_MAX_CONCURRENCY,
  DEFAULT_REASONING_EFFORT,
  DEFAULT_SYSTEM_PROMPT,
  getEngineType,
  normalizeBatchSize,
  normalizePositiveInt,
  normalizeReasoningEffort,
  validateInstance,
} from './registry.js';

/** 默认实例 id。 */
const DEFAULT_INSTANCE_ID = 'default';

/**
 * 归一实例：合并默认值、裁剪字符串、归一思考强度与数值；不校验、不写存储。
 * @param {unknown} instance
 * @param {{ fallbackConcurrency?: unknown }} [options] 旧实例缺失 `maxConcurrency` 时的迁移回退
 * @returns {Record<string, unknown>}
 */
export function normalizeInstance(instance, options = {}) {
  const source = instance && typeof instance === 'object' && !Array.isArray(instance) ? instance : {};
  const defaults = createDefaultInstance();

  const rawModel = String(source.model ?? defaults.model ?? '').trim();
  const rawBaseUrl = String(source.baseUrl ?? defaults.baseUrl ?? '').trim();
  const rawName = String(source.name ?? defaults.name ?? '').trim();
  const rawPrompt = String(source.systemPrompt ?? '').trim();
  const hasMaxConcurrency = source.maxConcurrency != null;
  const legacyConcurrency = normalizePositiveInt(
    options.fallbackConcurrency,
    DEFAULT_MAX_CONCURRENCY
  );

  return {
    ...source,
    id: String(source.id ?? defaults.id),
    type: String(source.type ?? defaults.type),
    name: rawName || defaults.name,
    model: rawModel,
    baseUrl: rawBaseUrl || defaults.baseUrl,
    reasoningEffort: normalizeReasoningEffort(source.reasoningEffort),
    batchSize: normalizeBatchSize(source.batchSize),
    batchMaxChars: normalizePositiveInt(source.batchMaxChars, DEFAULT_BATCH_MAX_CHARS),
    maxConcurrency: hasMaxConcurrency
      ? normalizePositiveInt(source.maxConcurrency, DEFAULT_MAX_CONCURRENCY)
      : legacyConcurrency,
    // 空提示词保留为空，交给 `validateInstance` 拒绝；读取旧实例缺字段时才补默认模板。
    systemPrompt: source.systemPrompt == null ? DEFAULT_SYSTEM_PROMPT : rawPrompt,
  };
}

/**
 * 读引擎实例列表（storage.sync，不含密钥字段）。
 * 每次读取都做归一；旧实例缺字段按默认值补齐，但不主动写回。
 * @returns {Promise<Array<Record<string, unknown>>>}
 */
export async function getInstances() {
  const data = await read('sync', STORAGE_KEYS.instances);
  const list = data[STORAGE_KEYS.instances];
  if (!Array.isArray(list) || list.length === 0) return [];

  // 旧实例缺少 maxConcurrency 时，用 `settings.concurrency` 的合法值作为一次性迁移回退。
  let fallbackConcurrency = DEFAULT_MAX_CONCURRENCY;
  try {
    fallbackConcurrency = (await getSettings()).concurrency;
  } catch {
    // 设置读取失败时保持默认值，不阻断实例读取。
  }
  return list.map((instance) => normalizeInstance(instance, { fallbackConcurrency }));
}

/**
 * 保存引擎实例列表。
 * @param {Array<Record<string, unknown>>} list
 * @returns {Promise<void>}
 */
export async function saveInstances(list) {
  await write('sync', { [STORAGE_KEYS.instances]: list });
}

/**
 * 用目录里的 DeepSeek 默认值构造默认实例。
 * @returns {Record<string, unknown>}
 */
export function createDefaultInstance() {
  const type = getEngineType(ENGINE_TYPE_IDS.DEEPSEEK);
  return {
    id: DEFAULT_INSTANCE_ID,
    type: type.id,
    name: type.label,
    model: type.defaultModel,
    baseUrl: type.baseUrl,
    reasoningEffort: DEFAULT_REASONING_EFFORT,
    batchSize: DEFAULT_BATCH_SIZE,
    batchMaxChars: DEFAULT_BATCH_MAX_CHARS,
    maxConcurrency: DEFAULT_MAX_CONCURRENCY,
    systemPrompt: DEFAULT_SYSTEM_PROMPT,
  };
}

/**
 * 取默认实例，不存在时按目录默认值创建并落盘。P1 只有一个默认实例。
 * @returns {Promise<Record<string, unknown>>}
 */
export async function getOrCreateDefaultInstance() {
  const instances = await getInstances();
  if (instances.length > 0) return instances[0];
  const created = normalizeInstance(createDefaultInstance());
  await saveInstances([created]);
  return created;
}

/**
 * 取当前生效实例：优先 `settings.activeInstanceId`，找不到时回退第一个实例。
 * 默认只读、不创建实例（网关不得因请求而写 storage）；`create` 为 true 时按目录默认值惰性创建。
 * @param {{ create?: boolean }} [options]
 * @returns {Promise<Record<string, unknown> | null>}
 */
export async function getActiveInstance(options = {}) {
  if (options.create === true) await getOrCreateDefaultInstance();
  const [instances, settings] = await Promise.all([getInstances(), getSettings()]);
  const activeId = typeof settings.activeInstanceId === 'string' ? settings.activeInstanceId : null;
  return instances.find((instance) => instance.id === activeId) ?? instances[0] ?? null;
}

/**
 * 更新一个实例：合并补丁、归一、校验，成功后写回完整字段；失败抛出且不写入。
 * @param {string} id
 * @param {Record<string, unknown>} patch
 * @returns {Promise<Record<string, unknown>>}
 */
export async function updateInstance(id, patch) {
  const instances = await getInstances();
  const index = instances.findIndex((item) => item.id === id);
  if (index < 0) throw new Error('实例不存在');

  const merged = normalizeInstance({
    ...instances[index],
    ...(patch && typeof patch === 'object' && !Array.isArray(patch) ? patch : {}),
  });
  const validation = validateInstance(merged);
  if (!validation.ok) throw new Error(validation.errors.join('；'));

  const next = instances.slice();
  next[index] = merged;
  await saveInstances(next);
  return merged;
}

/**
 * 计算某实例的密钥存储键名。
 * @param {string} instanceId
 * @returns {string}
 */
export function keyName(instanceId) {
  return STORAGE_KEYS.keyPrefix + instanceId;
}

/**
 * 写密钥（P1 临时由设置页调用；P2 起仅后台）。
 * @param {string} instanceId
 * @param {string} key
 * @returns {Promise<void>}
 */
export async function writeKey(instanceId, key) {
  const area = await keyArea();
  await write(area, { [keyName(instanceId)]: key });
}

/**
 * 读密钥（P1 临时由设置页调用；P2 起仅后台）。不存在返回 null。
 * @param {string} instanceId
 * @returns {Promise<string | null>}
 */
export async function getKey(instanceId) {
  const area = await keyArea();
  const data = await read(area, keyName(instanceId));
  return data[keyName(instanceId)] ?? null;
}

/**
 * 判断某实例是否已配置密钥（不暴露明文）。
 * @param {string} instanceId
 * @returns {Promise<boolean>}
 */
export async function hasKey(instanceId) {
  return (await getKey(instanceId)) != null;
}

/**
 * 删除某实例的密钥。
 * @param {string} instanceId
 * @returns {Promise<void>}
 */
export async function removeKey(instanceId) {
  const area = await keyArea();
  await removeKeys(area, keyName(instanceId));
}

/**
 * 公开设置：设置 + 实例列表（只含 hasKey 布尔，不含密钥）。供弹窗/设置页使用。
 * @returns {Promise<{ settings: Record<string, unknown>, instances: Array<Record<string, unknown>> }>}
 */
export async function getPublicSettings() {
  const settings = await getSettings();
  const instances = await Promise.all(
    (await getInstances()).map(async (instance) => ({ ...instance, hasKey: await hasKey(instance.id) }))
  );
  return { settings, instances };
}

/**
 * 完整设置：设置 + 实例列表（含 apiKey 明文）。仅后台使用。
 * @returns {Promise<{ settings: Record<string, unknown>, instances: Array<Record<string, unknown>> }>}
 */
export async function getFullSettings() {
  const settings = await getSettings();
  const instances = await Promise.all(
    (await getInstances()).map(async (instance) => ({ ...instance, apiKey: await getKey(instance.id) }))
  );
  return { settings, instances };
}

/**
 * 旧配置惰性迁移入口：把旧的单一密钥转成默认引擎实例。
 * P1 只落空壳语义（当前无旧键可迁移），数据面由 P8 补；重复执行不产生重复实例。
 * @returns {Promise<void>}
 */
export async function migrateLegacyKey() {
  // P8 前无旧版配置，暂不迁移。
}
