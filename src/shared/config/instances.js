/**
 * E3 引擎实例
 *
 * 模块：公共模块（E）/ E3
 * 职责：管理引擎实例、首选与备用引擎、密钥键名与旧配置迁移；校验配置并算出实际生效的引擎。
 * 依赖：E2 设置与存储（settings.js/storage.js）、E3 引擎类型目录（registry.js，P1 起）。
 * 实现阶段：P1（引擎层与密钥配置）
 *
 * 密钥「只有后台读」是最终目标（P2 起）；P1 为做演示测试，设置页会临时直接读密钥，
 * 属需求文档 P1-5 已确认的临时偏离，P2 收敛到后台后消除。
 */

import { STORAGE_KEYS, read, write, removeKeys } from '../storage.js';
import { getSettings, keyArea } from '../settings.js';
import { ENGINE_TYPE_IDS, getEngineType } from './registry.js';

/** 默认实例 id。 */
const DEFAULT_INSTANCE_ID = 'default';

/**
 * 读引擎实例列表（storage.sync，不含密钥字段）。
 * @returns {Promise<Array<Record<string, unknown>>>}
 */
export async function getInstances() {
  const data = await read('sync', STORAGE_KEYS.instances);
  const list = data[STORAGE_KEYS.instances];
  return Array.isArray(list) ? list : [];
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
  };
}

/**
 * 取默认实例，不存在时按目录默认值创建并落盘。P1 只有一个默认实例。
 * @returns {Promise<Record<string, unknown>>}
 */
export async function getOrCreateDefaultInstance() {
  const instances = await getInstances();
  if (instances.length > 0) return instances[0];
  const created = createDefaultInstance();
  await saveInstances([created]);
  return created;
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
 * P1 只落空壳语义（当前无旧键可迁移），数据面由 P7 补；重复执行不产生重复实例。
 * @returns {Promise<void>}
 */
export async function migrateLegacyKey() {
  // P7 前无旧版配置，暂不迁移。
}
