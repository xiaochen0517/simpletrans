/**
 * A3 批量编码与解析测试
 *
 * 覆盖 JSONL 输入编码、流式逐行解析、代码围栏/空行容错、按 id 对齐与 BatchAlignError 计数。
 */

import { describe, expect, it, vi } from 'vitest';
import { ERROR_CODES } from '../../src/shared/protocol.js';
import {
  BATCH_ENCODING_VERSION,
  BatchAlignError,
  createBatchParser,
  encodeBatchInput,
  parseBatchOutput,
} from '../../src/shared/translate/batch.js';

describe('A3 批量编码', () => {
  it('BATCH_ENCODING_VERSION 为 1 并进入缓存 key 口径', () => {
    expect(BATCH_ENCODING_VERSION).toBe(1);
  });

  it('每段编码为一行 JSON，只有 id 与 text', () => {
    const input = encodeBatchInput([
      { groupId: 'g0', text: 'Hello world' },
      { groupId: 'g1', text: 'Another paragraph.' },
    ]);

    expect(input).toBe(
      '{"id":"g0","text":"Hello world"}\n{"id":"g1","text":"Another paragraph."}'
    );
    const lines = input.split('\n');
    expect(lines).toHaveLength(2);
    expect(JSON.parse(lines[0])).toEqual({ id: 'g0', text: 'Hello world' });
  });

  it('引号、反斜杠与换行由 JSON.stringify 安全转义', () => {
    const text = 'He said "hi"\\n and\nleft';
    const line = encodeBatchInput([{ groupId: 'g0', text }]);
    expect(line.includes('\n')).toBe(false);
    expect(JSON.parse(line)).toEqual({ id: 'g0', text });
  });

  it('空输入返回空串，非法输入按空数组处理', () => {
    expect(encodeBatchInput([])).toBe('');
    expect(encodeBatchInput(undefined)).toBe('');
    expect(encodeBatchInput(null)).toBe('');
  });
});

describe('A3 批量解析', () => {
  it('按 id 解析全部段落，顺序不限', () => {
    const output = '{"id":"g1","text":"第二段"}\n{"id":"g0","text":"第一段"}';
    const items = parseBatchOutput(output, ['g0', 'g1']);

    expect([...items.keys()]).toEqual(['g1', 'g0']);
    expect(items.get('g0')).toBe('第一段');
    expect(items.get('g1')).toBe('第二段');
  });

  it('忽略空行与代码围栏，末尾无换行也能解析', () => {
    const output = '```json\n\n{"id":"g0","text":"你好"}\n```';
    const items = parseBatchOutput(output, ['g0']);
    expect(items.get('g0')).toBe('你好');
  });

  it('流式解析：跨 chunk 的行缓冲，每段解析完成立即回调', () => {
    const onItem = vi.fn();
    const parser = createBatchParser(new Set(['g0', 'g1']), { onItem });

    parser.push('{"id":"g0","text":"你');
    expect(onItem).not.toHaveBeenCalled();
    parser.push('好"}\n{"id":"g1","text":"世');
    expect(onItem).toHaveBeenCalledTimes(1);
    expect(onItem).toHaveBeenLastCalledWith({ id: 'g0', text: '你好' });
    parser.push('界"}\n');

    const items = parser.end();
    expect(onItem).toHaveBeenCalledTimes(2);
    expect(onItem).toHaveBeenLastCalledWith({ id: 'g1', text: '世界' });
    expect(items.get('g1')).toBe('世界');
  });

  it('解析出的文本去掉首尾空白', () => {
    const items = parseBatchOutput('{"id":"g0","text":"  你好  "}', ['g0']);
    expect(items.get('g0')).toBe('你好');
  });

  it('缺少段落时抛 BatchAlignError，counts.missing 为缺失数', () => {
    let error = null;
    try {
      parseBatchOutput('{"id":"g0","text":"一"}', ['g0', 'g1', 'g2']);
    } catch (caught) {
      error = caught;
    }

    expect(error).toBeInstanceOf(BatchAlignError);
    expect(error.code).toBe(ERROR_CODES.BATCH_ALIGN);
    expect(error.counts).toEqual({ missing: 2, duplicate: 0, extra: 0, invalid: 0 });
    expect(error.message).not.toContain('一');
  });

  it('重复 id、未知 id、非 JSON 行与非字符串 text 都失败', () => {
    const cases = [
      {
        output: '{"id":"g0","text":"a"}\n{"id":"g0","text":"b"}',
        counts: { missing: 0, duplicate: 1, extra: 0, invalid: 0 },
      },
      {
        output: '{"id":"g9","text":"a"}',
        counts: { missing: 0, duplicate: 0, extra: 1, invalid: 0 },
      },
      {
        output: 'not json',
        counts: { missing: 0, duplicate: 0, extra: 0, invalid: 1 },
      },
      {
        output: '{"id":"g0","text":123}',
        counts: { missing: 0, duplicate: 0, extra: 0, invalid: 1 },
      },
      {
        output: '["g0","a"]',
        counts: { missing: 0, duplicate: 0, extra: 0, invalid: 1 },
      },
    ];

    for (const entry of cases) {
      let error = null;
      try {
        parseBatchOutput(entry.output, ['g0']);
      } catch (caught) {
        error = caught;
      }
      expect(error, entry.output).toBeInstanceOf(BatchAlignError);
      expect(error.code).toBe(ERROR_CODES.BATCH_ALIGN);
      expect(error.counts, entry.output).toEqual(entry.counts);
    }
  });

  it('对齐失败前已解析的段落保留在 items 与回调中', () => {
    const onItem = vi.fn();
    const parser = createBatchParser(['g0', 'g1'], { onItem });
    parser.push('{"id":"g0","text":"已解析"}\n');

    expect(() => {
      parser.push('{"id":"g9","text":"未知"}\n');
    }).toThrow(BatchAlignError);
    expect(onItem).toHaveBeenCalledTimes(1);
    expect(onItem).toHaveBeenCalledWith({ id: 'g0', text: '已解析' });
  });

  it('expectedIds 接受 Set 或数组；空期望集合不报缺失', () => {
    expect(parseBatchOutput('', []).size).toBe(0);

    const parser = createBatchParser(new Set(), {});
    expect(parser.end().size).toBe(0);
  });
});
