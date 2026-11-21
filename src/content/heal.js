/**
 * D6 译文自愈
 *
 * 模块：页面注入（D）/ D6
 * 职责：页面重渲染删除译文容器后，按会话内译文镜像把同一译文重新挂回原文未变化的宿主；
 *       原文已变化的段落不恢复、不重新提交；只处理已定稿（done）的译文。
 * 依赖：D1（文本提取、隐藏判定与局部扫描）、公共数值、E4；D3 的渲染器与 D5 的回调由调用方注入。
 *
 * 约束：不写 storage、不发消息、不做翻译请求、不读配置；只操作页面 DOM 与内存镜像；
 *       不包含原文或译文的日志输出。
 */

import {
  RESTORE_DEBOUNCE_MS,
  RESTORE_FLAP_LIMIT,
  RESTORE_FLAP_PAUSE_MS,
  RESTORE_FLAP_WINDOW_MS,
  RESTORE_MAX_CANDIDATES,
  RESTORE_MIRROR_LIMIT,
} from '../shared/constants.js';
import { createLogger } from '../shared/log/logger.js';
import {
  HOST_ATTR,
  TRANSLATION_ATTR,
  collectParagraphs,
  extractText,
  hasLetter as hasLetterIn,
  isHidden as isHiddenIn,
  normalizeText,
} from './dom/scanner.js';

/** D6 日志入口：只记录计数、状态与原因，不记录原文与译文。 */
const log = createLogger('D6');

/**
 * 读取节点所属元素：元素返回自身，文本节点返回父元素。
 * @param {Node | null} node
 * @returns {Element | null}
 */
function elementOf(node) {
  if (!node) return null;
  if (node.nodeType === 1) return /** @type {Element} */ (node);
  if (node.nodeType === 3) return node.parentElement ?? null;
  return null;
}

/**
 * 创建译文自愈控制器。
 *
 * @param {{
 *   document?: Document,
 *   renderer?: { remove?: (host: Element) => boolean },
 *   restore?: (host: Element, source: string, translated: string) => boolean,
 *   forget?: (host: Element) => void,
 *   scan?: (options: object) => Promise<Array<{ host: Element, text: string }>>,
 *   extract?: (host: Element) => string,
 *   normalize?: (value: unknown) => string,
 *   hasLetter?: (text: string) => boolean,
 *   isHidden?: (host: Element) => boolean,
 *   logger?: { debug: Function, warn: Function },
 *   now?: () => number,
 *   schedule?: (fn: () => void, ms: number) => unknown,
 *   cancel?: (handle: unknown) => void,
 *   MutationObserverCtor?: typeof MutationObserver,
 *   yieldToMain?: () => Promise<void>,
 * }} [deps]
 * @returns {{
 *   start: () => boolean,
 *   stop: () => void,
 *   reset: () => void,
 *   remember: (source: string, translated: string, host?: Element | null) => boolean,
 *   hide: (source: string) => void,
 *   unhide: (host: Element | null, source: string) => void,
 *   getMirrorSize: () => number,
 * }}
 */
export function createHealer({
  document: doc = globalThis.document,
  renderer,
  restore,
  forget,
  scan = collectParagraphs,
  extract = extractText,
  normalize = normalizeText,
  hasLetter = hasLetterIn,
  isHidden = isHiddenIn,
  logger = log,
  now = () => Date.now(),
  schedule = (fn, ms) => setTimeout(fn, ms),
  cancel = (handle) => clearTimeout(handle),
  MutationObserverCtor = globalThis.MutationObserver,
  yieldToMain,
} = {}) {
  /** 译文镜像：归一化原文 → { translated, at }，按写入顺序淘汰。 */
  const mirror = new Map();
  /** 用户主动隐藏的原文文本：本次会话内不再自动恢复。 */
  const hidden = new Set();
  /** 同一文本的恢复次数窗口：用于暂停持续重建的站点。 */
  const flapping = new Map();

  /** 宿主 → 该宿主当前译文对应的原文（用于判断原文是否变化）。 */
  let hostSources = new WeakMap();
  /** 原文已变化的宿主：本次会话内不再自动恢复。 */
  let staleHosts = new WeakSet();

  /** @type {MutationObserver | null} */
  let observer = null;
  let observed = false;
  let flushing = false;
  let flushTimer = null;
  let generation = 0;

  /** 待检查的宿主与新增子树。 */
  const pendingHosts = new Set();
  const pendingRoots = new Set();

  /**
   * 宿主直属的译文容器；没有时返回 null。
   * @param {Element} host
   * @returns {Element | null}
   */
  function findContainer(host) {
    const children = host?.children;
    if (!children) return null;
    for (let index = 0; index < children.length; index += 1) {
      if (children[index].hasAttribute?.(TRANSLATION_ATTR)) return children[index];
    }
    return null;
  }

  /**
   * 节点是否位于译文容器内部（自己的写入不触发恢复）。
   * @param {Node | null} node
   * @returns {boolean}
   */
  function insideTranslation(node) {
    const element = elementOf(node);
    return Boolean(element?.closest?.(`[${TRANSLATION_ATTR}]`));
  }

  /**
   * 读取宿主的归一化原文；不可翻译时返回空串。
   * @param {Element} host
   * @returns {string}
   */
  function readSource(host) {
    let text = '';
    try {
      text = normalize(extract(host));
    } catch {
      return '';
    }
    return text && hasLetter(text) ? text : '';
  }

  /**
   * 把新增节点归入待检查宿主或待扫描子树。
   * 已知宿主（含宿主自身）直接按宿主处理；新增子树只有在不属于已有宿主时才扫描。
   * @param {Element} node
   */
  function addRoot(node) {
    if (!node || node.nodeType !== 1) return;
    if (node.hasAttribute?.(TRANSLATION_ATTR)) return;
    if (insideTranslation(node)) return;

    const host = node.closest?.(`[${HOST_ATTR}]`);
    if (host) {
      pendingHosts.add(host);
      return;
    }
    if (pendingRoots.size >= RESTORE_MAX_CANDIDATES) return;
    for (const existing of pendingRoots) {
      if (existing === node || existing.contains?.(node)) return;
    }
    for (const existing of pendingRoots) {
      if (node.contains?.(existing)) pendingRoots.delete(existing);
    }
    pendingRoots.add(node);
  }

  /**
   * 把一批 DOM 变更收敛成候选集合；只读记录，不做重活。
   * @param {MutationRecord[]} records
   */
  function collect(records) {
    for (const record of records) {
      if (record.type !== 'childList') continue;
      if (insideTranslation(record.target)) continue;

      const host = elementOf(record.target)?.closest?.(`[${HOST_ATTR}]`);
      if (host) pendingHosts.add(host);

      for (const node of record.addedNodes ?? []) {
        if (node.nodeType === 1) addRoot(/** @type {Element} */ (node));
      }
    }
  }

  /**
   * 原文变化：移除已定稿的旧译文容器，并让 D5 注销该段；不提交新请求。
   * 容器仍在提交中/翻译中时不动，交给结果帧收尾。
   * @param {Element} host
   */
  function markStale(host) {
    const container = findContainer(host);
    if (container && container.getAttribute?.('data-st-state') !== 'done') return;

    try {
      renderer?.remove?.(host);
    } catch {
      return;
    }

    hostSources.delete(host);
    staleHosts.add(host);
    try {
      forget?.(host);
    } catch {
      // 注销失败只影响注册表，不影响页面显示。
    }
    logger.debug?.('heal.stale', '原文已变化，移除旧译文', { removed: container ? 1 : 0 });
  }

  /**
   * 文本在某窗口内是否因反复重建被暂停恢复。
   * @param {string} source
   * @returns {boolean}
   */
  function isPaused(source) {
    const entry = flapping.get(source);
    return Boolean(entry && entry.pausedUntil > now());
  }

  /**
   * 记录一次恢复；超过阈值后暂停该文本一段时间。
   * @param {string} source
   */
  function noteRestore(source) {
    const at = now();
    let entry = flapping.get(source);
    if (!entry || at - entry.since > RESTORE_FLAP_WINDOW_MS) {
      entry = { count: 0, since: at, pausedUntil: 0 };
    }
    entry.count += 1;
    if (entry.count >= RESTORE_FLAP_LIMIT) {
      entry.count = 0;
      entry.since = at;
      entry.pausedUntil = at + RESTORE_FLAP_PAUSE_MS;
      logger.debug?.('heal.paused', '同一文本反复重建，暂停自动恢复', {
        pausedMs: RESTORE_FLAP_PAUSE_MS,
      });
    }
    flapping.set(source, entry);
  }

  /**
   * 把镜像里的译文重新挂到宿主；未命中、隐藏、已变化一律跳过。
   * @param {Element} host
   * @param {string} source
   * @returns {boolean}
   */
  function restoreHost(host, source) {
    if (!host || host.isConnected === false) return false;
    if (isHidden(host)) return false;
    if (findContainer(host)) return false;
    if (staleHosts.has(host)) return false;
    if (hidden.has(source)) return false;
    if (isPaused(source)) return false;

    const entry = mirror.get(source);
    if (!entry) return false;

    let applied = false;
    try {
      applied = restore?.(host, source, entry.translated) === true;
    } catch {
      applied = false;
    }
    if (!applied) return false;

    hostSources.set(host, source);
    noteRestore(source);
    logger.debug?.('heal.restore', '译文已自动恢复', { restored: 1 });
    return true;
  }

  /**
   * 处理单个宿主：原文变化时清理旧译文，否则在容器丢失时尝试恢复。
   * @param {Element} host
   */
  function handleHost(host) {
    if (!host || host.isConnected === false) return;
    if (isHidden(host)) return;

    const source = readSource(host);
    if (!source) return;

    // 已经渲染过译文的宿主：文本变了就不再恢复，也不重新提交。
    const known = hostSources.get(host);
    if (known && known !== source) {
      markStale(host);
      return;
    }

    if (findContainer(host)) return;
    restoreHost(host, source);
  }

  /**
   * 扫描新增子树里的段落；属于已有宿主的子树交给宿主检查。
   * @param {Element[]} roots
   * @param {number} gen
   * @returns {Promise<void>}
   */
  async function processRoots(roots, gen) {
    let candidates = 0;
    for (const root of roots) {
      if (gen !== generation) return;
      if (!root.isConnected || insideTranslation(root)) continue;

      const enclosing = root.closest?.(`[${HOST_ATTR}]`);
      if (enclosing) {
        try {
          handleHost(enclosing);
        } catch {
          // 单个宿主失败不影响其它候选。
        }
        continue;
      }

      let paragraphs = [];
      try {
        paragraphs = await scan({
          root,
          inViewport: () => true,
          maxParagraphs: RESTORE_MAX_CANDIDATES,
          logger: null,
          ...(yieldToMain ? { yieldToMain } : {}),
        });
      } catch {
        continue;
      }
      if (gen !== generation) return;

      for (const paragraph of Array.isArray(paragraphs) ? paragraphs : []) {
        if (gen !== generation) return;
        candidates += 1;
        if (candidates > RESTORE_MAX_CANDIDATES) return;
        if (!paragraph?.host) continue;
        try {
          handleHost(paragraph.host);
        } catch {
          // 单个宿主失败不影响其它候选。
        }
      }
    }
    if (candidates > 0) logger.debug?.('heal.scan', '已检查新增内容', { candidates });
  }

  /**
   * 到点后统一处理本轮候选；同一时间只跑一轮，期间的新变更留到下一轮。
   * @returns {Promise<void>}
   */
  async function flush() {
    if (flushing) {
      scheduleFlush();
      return;
    }
    flushing = true;
    const gen = generation;
    try {
      if (observer?.takeRecords) collect(observer.takeRecords());

      const hosts = [...pendingHosts];
      const roots = [...pendingRoots];
      pendingHosts.clear();
      pendingRoots.clear();

      for (const host of hosts) {
        if (gen !== generation) return;
        try {
          handleHost(host);
        } catch {
          // 单个宿主失败不影响其它候选。
        }
      }
      await processRoots(roots, gen);
    } catch (error) {
      logger.warn?.('heal.error', '自动恢复检查失败', {
        reason: error?.name ?? null,
      });
    } finally {
      flushing = false;
      if (gen === generation && (pendingHosts.size > 0 || pendingRoots.size > 0)) {
        scheduleFlush();
      }
    }
  }

  /**
   * 安排一次去抖检查。
   */
  function scheduleFlush() {
    if (flushTimer != null) return;
    flushTimer = schedule(() => {
      flushTimer = null;
      void flush();
    }, RESTORE_DEBOUNCE_MS);
  }

  /**
   * DOM 变更入口。
   * @param {MutationRecord[]} records
   */
  function onMutations(records) {
    if (!observed) return;
    collect(records);
    if (pendingHosts.size === 0 && pendingRoots.size === 0) return;
    scheduleFlush();
  }

  /**
   * 建立 DOM 观察；已建立时返回 true。
   * @returns {boolean}
   */
  function connect() {
    if (observed) return true;
    if (!doc || typeof MutationObserverCtor !== 'function') return false;
    observer = new MutationObserverCtor(onMutations);
    try {
      observer.observe(doc, { childList: true, subtree: true });
    } catch {
      observer = null;
      return false;
    }
    observed = true;
    return true;
  }

  /**
   * 断开观察并放弃未处理的候选；镜像保留。
   */
  function disconnect() {
    observed = false;
    if (observer) {
      try {
        observer.disconnect();
      } catch {
        // 断开失败不影响释放引用。
      }
      observer = null;
    }
    pendingHosts.clear();
    pendingRoots.clear();
    if (flushTimer != null) {
      cancel(flushTimer);
      flushTimer = null;
    }
  }

  return {
    /**
     * 开始观察页面 DOM；没有镜像时不建立观察，等首个定稿译文写入后自动开始。
     * @returns {boolean}
     */
    start() {
      return mirror.size > 0 ? connect() : false;
    },

    /**
     * 停止观察并放弃未处理的候选；镜像保留，供 bfcache 返回后继续使用。
     */
    stop() {
      generation += 1;
      disconnect();
    },

    /**
     * 清空会话内镜像、隐藏集合与抖动计数；正在排队的检查作废，并断开观察。
     */
    reset() {
      generation += 1;
      mirror.clear();
      hidden.clear();
      flapping.clear();
      hostSources = new WeakMap();
      staleHosts = new WeakSet();
      disconnect();
    },

    /**
     * 记录定稿译文；只保存文本，不保存 DOM 与页面信息。
     * 首次写入后建立 DOM 观察。
     * @param {string} source
     * @param {string} translated
     * @param {Element | null} [host]
     * @returns {boolean}
     */
    remember(source, translated, host) {
      if (typeof source !== 'string' || source === '') return false;
      if (typeof translated !== 'string' || translated === '') return false;

      if (mirror.has(source)) mirror.delete(source);
      mirror.set(source, { translated, at: now() });
      while (mirror.size > RESTORE_MIRROR_LIMIT) {
        const oldest = mirror.keys().next().value;
        if (typeof oldest !== 'string') break;
        mirror.delete(oldest);
      }

      if (host && host.nodeType === 1 && host.isConnected !== false) {
        hostSources.set(host, source);
        staleHosts.delete(host);
      }
      connect();
      return true;
    },

    /**
     * 用户主动隐藏：本次会话内不再自动恢复该文本。
     * @param {string} source
     */
    hide(source) {
      if (typeof source === 'string' && source !== '') hidden.add(source);
    },

    /**
     * 用户重新提交或手动翻译：解除隐藏与该宿主的「原文已变化」标记。
     * @param {Element | null} host
     * @param {string} source
     */
    unhide(host, source) {
      if (typeof source === 'string' && source !== '') hidden.delete(source);
      if (host) staleHosts.delete(host);
    },

    /**
     * 当前镜像条数，供测试与诊断使用。
     * @returns {number}
     */
    getMirrorSize() {
      return mirror.size;
    },
  };
}
