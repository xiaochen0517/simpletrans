/**
 * chrome.storage 的低层封装
 *
 * 只负责“按区域读写”，不承载任何业务语义；语义在 settings.js。
 * 四个区域的分工见 docs/demand/20261111-02-插件架构设计与选型.md §5.3。
 */

export const AREA = Object.freeze({
  /** 缓存、可选的密钥存放区域；容量大、跨重启保留。 */
  LOCAL: 'local',
  /** 用户设置（非敏感）；跨设备同步。 */
  SYNC: 'sync',
  /** 任务状态镜像；内存态，浏览器重启即清空。 */
  SESSION: 'session',
});

/**
 * @param {string} name
 */
function areaOf(name) {
  const area = chrome.storage?.[name];
  if (!area) throw new Error(`chrome.storage.${name} 不可用`);
  return area;
}

/**
 * 读取整个区域，并用默认值补齐。
 * @param {string} name
 * @param {Record<string, unknown>} defaults
 */
export async function readArea(name, defaults = {}) {
  const data = await areaOf(name).get(defaults);
  return { ...defaults, ...data };
}

/**
 * @param {string} name
 * @param {Record<string, unknown>} patch
 */
export async function writeArea(name, patch) {
  await areaOf(name).set(patch);
}

/**
 * @param {string} name
 * @param {string | string[]} keys
 */
export async function removeAreaKeys(name, keys) {
  await areaOf(name).remove(keys);
}

/**
 * @param {string} name
 */
export async function clearArea(name) {
  await areaOf(name).clear();
}
