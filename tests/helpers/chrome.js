/**
 * chrome stub（测试用）
 *
 * 模块：测试基建（tests/helpers）
 * 职责：在 Node 环境里用内存实现本项目用到的 chrome API 语义，供单元测试与冒烟脚本复用。
 * 实现阶段：P1（引擎层与密钥配置）
 *
 * P1 只实现 storage 三区语义（storage.js 依赖它）；
 * runtime.onMessage、tabs.sendMessage、scripting、Port 随 P2 首次使用时补齐（见项目架构 7.4）。
 */

/**
 * 构造一个内存存储分区，语义对齐 chrome.storage：
 * - get 支持字符串 / 数组 / 对象（带默认值）三种入参；null/undefined 返回全部；
 * - 数组入参只返回存在的键，缺失键省略；
 * - 对象入参合并默认值；
 * - set 合并写；remove 删除；clear 清空。
 * @returns {object}
 */
function makeArea() {
  const store = new Map();

  return {
    async get(keys) {
      if (keys == null) {
        return Object.fromEntries(store);
      }
      if (typeof keys === 'string') {
        return { [keys]: store.get(keys) };
      }
      if (Array.isArray(keys)) {
        const out = {};
        for (const key of keys) {
          if (store.has(key)) out[key] = store.get(key);
        }
        return out;
      }
      const out = {};
      for (const [key, defaultValue] of Object.entries(keys)) {
        out[key] = store.has(key) ? store.get(key) : defaultValue;
      }
      return out;
    },
    async set(values) {
      for (const [key, value] of Object.entries(values)) store.set(key, value);
    },
    async remove(keys) {
      const list = Array.isArray(keys) ? keys : [keys];
      for (const key of list) store.delete(key);
    },
    async clear() {
      store.clear();
    },
  };
}

/**
 * 构造一个完整的 chrome stub 实例。
 * @returns {object}
 */
export function createChrome() {
  return {
    storage: {
      local: makeArea(),
      sync: makeArea(),
      session: makeArea(),
    },
  };
}

/**
 * 把 chrome stub 安装到全局（每个用例前调用，保证分区状态隔离）。
 * @returns {object} 安装的 stub。
 */
export function installChrome() {
  const stub = createChrome();
  globalThis.chrome = stub;
  return stub;
}
