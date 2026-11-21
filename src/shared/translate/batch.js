/**
 * A3 批量编码与解析
 *
 * 模块：后台服务（A）/ A3
 * 职责：把一批段落编码成 JSONL 请求、按段解析流式输出并对齐校验；定义批量编码版本与对齐错误。
 * 依赖：E1 消息协议（批量对齐错误码）；不依赖 adapter，避免循环引用。
 *
 * 只做编码、解析与校验，不调用引擎、不读缓存、不写日志；逐段文本的归一由 adapter 在回调前完成。
 */

import { ERROR_CODES } from '../protocol.js';

/**
 * 批量编码版本：JSONL 行格式或解析规则变化时递增。
 * 进入 A4 缓存 key； 使用 1，不改变 key/DB 版本。
 */
export const BATCH_ENCODING_VERSION = 1;

/** 批量结果与输入对不上时抛出的错误；`counts` 只含计数，不含任何文本。 */
export class BatchAlignError extends Error {
  /**
   * @param {{ missing?: number, duplicate?: number, extra?: number, invalid?: number }} [counts]
   * @param {string} [message]
   */
  constructor(counts = {}, message = '批量结果与输入不对齐') {
    super(message);
    this.name = 'BatchAlignError';
    this.code = ERROR_CODES.BATCH_ALIGN;
    this.counts = {
      missing: counts.missing ?? 0,
      duplicate: counts.duplicate ?? 0,
      extra: counts.extra ?? 0,
      invalid: counts.invalid ?? 0,
    };
  }
}

/**
 * 归一期望 id 集合；接受 Set 或数组。
 * @param {Iterable<string> | string[]} expectedIds
 * @returns {Set<string>}
 */
function toIdSet(expectedIds) {
  if (expectedIds instanceof Set) return new Set(expectedIds);
  return new Set(Array.isArray(expectedIds) ? expectedIds : []);
}

/**
 * 把一批段落编码为 JSONL：每行只有 `id` 与 `text`，行间用 `\n` 连接。
 * `JSON.stringify` 保证引号、反斜杠与换行安全；不发送上下文、页面信息或提示词。
 *
 * @param {Array<{ groupId: string, text: string }>} items
 * @returns {string}
 */
export function encodeBatchInput(items) {
  return (Array.isArray(items) ? items : [])
    .map((item) => JSON.stringify({ id: String(item?.groupId ?? ''), text: String(item?.text ?? '') }))
    .join('\n');
}

/**
 * 创建流式批量解析器。
 *
 * - 只在完整行上解析；末尾没有换行的最后一行在 `end()` 时解析。
 * - 忽略空行与单独的代码围栏行（```` ``` ```` 或 ```` ```json ````）。
 * - 每解析出一行就立即 `onItem({ id, text })`，供调用方逐段回帧与写缓存。
 * - 缺失、重复、未知 id 或非法行抛 `BatchAlignError`；已解析的段落不回滚。
 *
 * @param {Iterable<string> | string[]} expectedIds
 * @param {{ onItem?: (entry: { id: string, text: string }) => void }} [options]
 * @returns {{ push: (chunk: string) => void, end: () => Map<string, string> }}
 */
export function createBatchParser(expectedIds, { onItem } = {}) {
  const ids = toIdSet(expectedIds);
  const items = new Map();
  const seen = new Set();
  let buffer = '';

  /**
   * 消费一整行：忽略空行与围栏，校验结构、id 与重复。
   * @param {string} raw
   */
  function consumeLine(raw) {
    const line = raw.trim();
    if (line === '' || line === '```' || line === '```json') return;

    let parsed;
    try {
      parsed = JSON.parse(line);
    } catch {
      throw new BatchAlignError({ invalid: 1 }, '批量结果包含非 JSON 行');
    }

    if (
      !parsed ||
      typeof parsed !== 'object' ||
      Array.isArray(parsed) ||
      typeof parsed.id !== 'string' ||
      typeof parsed.text !== 'string'
    ) {
      throw new BatchAlignError({ invalid: 1 }, '批量结果缺少 id 或 text');
    }
    if (!ids.has(parsed.id)) {
      throw new BatchAlignError({ extra: 1 }, '批量结果包含未知段落');
    }
    if (seen.has(parsed.id)) {
      throw new BatchAlignError({ duplicate: 1 }, '批量结果段落重复');
    }

    seen.add(parsed.id);
    const text = parsed.text.trim();
    items.set(parsed.id, text);
    onItem?.({ id: parsed.id, text });
  }

  return {
    /**
     * 喂入一段增量；只解析已经完整的行。
     * @param {string} chunk
     */
    push(chunk) {
      buffer += String(chunk ?? '');
      let index = buffer.indexOf('\n');
      while (index >= 0) {
        const line = buffer.slice(0, index);
        buffer = buffer.slice(index + 1);
        consumeLine(line);
        index = buffer.indexOf('\n');
      }
    },

    /**
     * 结束解析：处理最后一行、校验缺失 id 并返回 id → 译文。
     * @returns {Map<string, string>}
     */
    end() {
      if (buffer.trim() !== '') consumeLine(buffer);
      buffer = '';
      const missing = [...ids].filter((id) => !seen.has(id)).length;
      if (missing > 0) throw new BatchAlignError({ missing });
      return items;
    },
  };
}

/**
 * 一次性解析完整批量输出（非流式场景与单测使用）。
 * @param {string} text
 * @param {Iterable<string> | string[]} expectedIds
 * @param {{ onItem?: (entry: { id: string, text: string }) => void }} [options]
 * @returns {Map<string, string>}
 */
export function parseBatchOutput(text, expectedIds, options = {}) {
  const parser = createBatchParser(expectedIds, options);
  parser.push(String(text ?? ''));
  return parser.end();
}
