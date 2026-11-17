/**
 * E2 存储读写
 *
 * 模块：公共模块（E）/ E2
 * 职责：封装扩展存储的分区读写（local / sync / session），只做存取，不承载业务语义。
 * 依赖：无（P1 起）。
 * 实现阶段：P1（引擎层与密钥配置）；P8-2 增加实例提示词键前缀（提示词存 `storage.local`）。
 *
 * P1 只提供分区读写与存储键常量；`chrome` 仅在函数体内访问，便于测试用 stub 替换。
 */

/** 存储键常量（分区见项目架构 5.4；译文缓存放 IndexedDB，不占存储键）。 */
export const STORAGE_KEYS = Object.freeze({
  settings: 'settings', // storage.sync：普通设置
  instances: 'engineInstances', // storage.sync：引擎实例列表（不含密钥与提示词）
  preferred: 'preferredEngine', // storage.sync：首选/备用引擎
  keyPrefix: 'engineKey:', // storage.local/sync：每实例凭据 JSON 前缀（分区由 keyStorage 决定）
  promptPrefix: 'systemPrompt:', // storage.local：每实例 system 提示词前缀
});

/**
 * 读取一个分区的一个或多个键。
 * 入参支持 `'key'`、`['k1','k2']`、`{ k: 默认值 }` 三种形式，语义与 chrome.storage 一致。
 * @param {'local'|'sync'|'session'} area
 * @param {string|string[]|Record<string, unknown>} keys
 * @returns {Promise<Record<string, unknown>>}
 */
export function read(area, keys) {
  return chrome.storage[area].get(keys);
}

/**
 * 写入键值（合并，不覆盖未提供的键）。
 * @param {'local'|'sync'|'session'} area
 * @param {Record<string, unknown>} values
 * @returns {Promise<void>}
 */
export async function write(area, values) {
  await chrome.storage[area].set(values);
}

/**
 * 删除一个或多个键。
 * @param {'local'|'sync'|'session'} area
 * @param {string|string[]} keys
 * @returns {Promise<void>}
 */
export async function removeKeys(area, keys) {
  await chrome.storage[area].remove(keys);
}

/**
 * 清空一个分区。
 * @param {'local'|'sync'|'session'} area
 * @returns {Promise<void>}
 */
export async function clearArea(area) {
  await chrome.storage[area].clear();
}
