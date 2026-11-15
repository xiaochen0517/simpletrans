/**
 * chrome stub（测试用）
 *
 * 模块：测试基建（tests/helpers）
 * 职责：在 Node 环境里用内存实现本项目用到的 chrome API 语义，供单元测试与冒烟脚本复用。
 * 实现阶段：P1–P2（storage 三区 P1；runtime 事件、runtime.connect、Port P2）
 *
 * P2 只实现有调用方的部分：runtime.id / onMessage / connect / onConnect 与 Port；
 * tabs.sendMessage、scripting 随 P3/P6 首次使用时补（见项目架构 7.3、7.4）。
 */

let portSequence = 0;

/**
 * 构造一个事件对象，语义对齐 chrome.events：
 * addListener / removeListener / hasListener / emit。
 * @returns {object}
 */
function makeEvent() {
  const listeners = new Set();

  return {
    addListener(listener) {
      if (typeof listener === 'function') listeners.add(listener);
    },
    removeListener(listener) {
      listeners.delete(listener);
    },
    hasListener(listener) {
      return listeners.has(listener);
    },
    emit(...args) {
      for (const listener of [...listeners]) listener(...args);
    },
    get listeners() {
      return [...listeners];
    },
  };
}

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
 * 构造一对互通的 Port。语义：
 * - 一端 postMessage 触发另一端 onMessage；
 * - 一端 disconnect 触发另一端 onDisconnect，断开后 postMessage 抛错；
 * - 调用 disconnect 的一端自己不触发 onDisconnect（与 Chrome 一致）。
 * @param {string} name
 * @param {object | undefined} serverSender
 */
function makePortPair(name, serverSender) {
  const id = `port-${++portSequence}`;
  const state = { closed: false };

  /** @type {object | null} */
  let client = null;
  /** @type {object | null} */
  let server = null;

  function makeSide(sender, getPeer) {
    const onMessage = makeEvent();
    const onDisconnect = makeEvent();
    return {
      id,
      name,
      sender,
      onMessage,
      onDisconnect,
      postMessage(message) {
        if (state.closed) {
          throw new Error('Attempting to use a disconnected port object');
        }
        getPeer().onMessage.emit(message);
      },
      disconnect() {
        if (state.closed) return;
        state.closed = true;
        getPeer().onDisconnect.emit();
      },
    };
  }

  client = makeSide(undefined, () => server);
  server = makeSide(serverSender, () => client);
  return { client, server };
}

/**
 * 构造一个完整的 chrome stub 实例。
 * @returns {object}
 */
export function createChrome() {
  const onMessage = makeEvent();
  const onConnect = makeEvent();

  const runtime = {
    id: 'test-extension-id',
    onMessage,
    onConnect,
    connect(options = {}) {
      const { client, server } = makePortPair(options.name ?? '', { id: runtime.id });
      onConnect.emit(server);
      return client;
    },
    sendMessage(message) {
      const sender = { id: runtime.id };
      return new Promise((resolve, reject) => {
        try {
          let settled = false;
          let asyncExpected = false;
          const sendResponse = (value) => {
            if (settled) return;
            settled = true;
            resolve(value);
          };
          for (const listener of onMessage.listeners) {
            const result = listener(message, sender, sendResponse);
            if (result === true) asyncExpected = true;
          }
          if (!asyncExpected && !settled) resolve(undefined);
        } catch (error) {
          reject(error);
        }
      });
    },
  };

  return {
    runtime,
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
