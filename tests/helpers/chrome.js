/**
 * chrome stub（测试用）
 *
 * 模块：测试基建（tests/helpers）
 * 职责：在 Node 环境里用内存实现本项目用到的 chrome API 语义，供单元测试与冒烟脚本复用。
 * 实现阶段：P1–P4（storage 三区 P1；runtime 事件、Port P2；storage.onChanged、getManifest、getURL P3；
 *             commands、tabs、scripting P4）
 *
 * P2 只实现有调用方的部分：runtime.id / onMessage / connect / onConnect 与 Port；
 * P3 补 storage.onChanged、getManifest、getURL；P4 补 commands.onCommand、tabs.query / sendMessage、
 * scripting.insertCSS / executeScript（记录调用顺序）；P6.5 补 tabs.create（打开测试页，记录创建参数）；
 * P7 补 runtime.openOptionsPage（打开设置页，记录调用次数与可注入的失败）；
 * P6.3 connect 支持传入 sender，模拟页面注入的 `sender.tab`。
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
 * - set 合并写；remove 删除；clear 清空；
 * - 写操作按 chrome.storage.onChanged 语义发出变更（含 oldValue/newValue）。
 * @param {string} areaName
 * @param {object} onChanged
 * @returns {object}
 */
function makeArea(areaName, onChanged) {
  const store = new Map();

  /**
   * @param {Record<string, object>} changes
   */
  function emitChanges(changes) {
    if (Object.keys(changes).length > 0) onChanged.emit(changes, areaName);
  }

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
      const changes = {};
      for (const [key, value] of Object.entries(values)) {
        changes[key] = { oldValue: store.get(key), newValue: value };
        store.set(key, value);
      }
      emitChanges(changes);
    },
    async remove(keys) {
      const list = Array.isArray(keys) ? keys : [keys];
      const changes = {};
      for (const key of list) {
        if (store.has(key)) {
          changes[key] = { oldValue: store.get(key) };
          store.delete(key);
        }
      }
      emitChanges(changes);
    },
    async clear() {
      const changes = {};
      for (const [key, value] of store) changes[key] = { oldValue: value };
      store.clear();
      emitChanges(changes);
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
  const onStorageChanged = makeEvent();
  const onCommand = makeEvent();

  const runtime = {
    id: 'test-extension-id',
    onMessage,
    onConnect,
    /** openOptionsPage 的调用次数与可注入的失败。 */
    __openOptionsCount: 0,
    __openOptionsError: null,
    async openOptionsPage() {
      runtime.__openOptionsCount += 1;
      if (runtime.__openOptionsError) throw runtime.__openOptionsError;
    },
    getManifest() {
      return { version: '0.1.0' };
    },
    getURL(path = '') {
      return `chrome-extension://${runtime.id}/${String(path).replace(/^\/+/, '')}`;
    },
    connect(options = {}) {
      // 生产代码只传 name；测试可额外传 sender，模拟页面注入的 sender.tab。
      const sender = options.sender ?? { id: runtime.id };
      const { client, server } = makePortPair(options.name ?? '', sender);
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

  const tabs = {
    /** 下一次 query 的结果；测试可整体替换。 */
    __queryResult: [{ id: 1, active: true }],
    /** sendMessage 收到的消息，按调用顺序记录。 */
    __sent: [],
    /** create 收到的参数，按调用顺序记录。 */
    __created: [],
    /** 按顺序消费的响应队列：{ response } 或 { error }；为空时退回 __response/__error。 */
    __sendQueue: [],
    __response: undefined,
    __error: null,
    async create(createProperties = {}) {
      tabs.__created.push({ ...createProperties });
      return { id: 100, ...createProperties };
    },
    async query() {
      return tabs.__queryResult.map((tab) => ({ ...tab }));
    },
    async sendMessage(tabId, message) {
      tabs.__sent.push({ tabId, message });
      if (tabs.__sendQueue.length > 0) {
        const next = tabs.__sendQueue.shift();
        if (next?.error) throw next.error;
        return next?.response;
      }
      if (tabs.__error) throw tabs.__error;
      if (tabs.__response !== undefined) return tabs.__response;
      throw new Error('Could not establish connection. Receiving end does not exist.');
    },
  };

  const scripting = {
    /** 按调用顺序记录 { api, details }，用于断言「先样式后脚本」。 */
    __calls: [],
    __error: null,
    async insertCSS(details) {
      scripting.__calls.push({ api: 'insertCSS', details });
      if (scripting.__error) throw scripting.__error;
    },
    async executeScript(details) {
      scripting.__calls.push({ api: 'executeScript', details });
      if (scripting.__error) throw scripting.__error;
    },
  };

  return {
    runtime,
    storage: {
      onChanged: onStorageChanged,
      local: makeArea('local', onStorageChanged),
      sync: makeArea('sync', onStorageChanged),
      session: makeArea('session', onStorageChanged),
    },
    commands: {
      onCommand,
    },
    tabs,
    scripting,
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
