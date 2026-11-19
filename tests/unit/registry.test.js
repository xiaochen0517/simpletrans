/**
 * E3 引擎类型目录测试（P8-2）
 *
 * 覆盖双类型目录、百度上限、实例名称与提示词校验、两种实例的字段校验。
 */

import { describe, expect, it } from 'vitest';
import {
  BAIDU_BATCH_MAX_CHARS,
  BAIDU_BATCH_SIZE,
  BAIDU_MAX_CONCURRENCY,
  BAIDU_QPS,
  DEFAULT_BATCH_MAX_CHARS,
  DEFAULT_BATCH_SIZE,
  DEFAULT_MAX_CONCURRENCY,
  DEFAULT_SYSTEM_PROMPT,
  ENGINE_TYPE_IDS,
  ENGINE_TYPES,
  MAX_INSTANCE_NAME_CHARS,
  MAX_PROMPT_CHARS,
  MIN_BATCH_SIZE,
  getDefaultInstanceName,
  getEngineKind,
  getEngineType,
  getTypeLabel,
  isDefaultPrompt,
  isSupportedType,
  isValidInstanceName,
  normalizeBatchSize,
  normalizeInstanceName,
  normalizePositiveInt,
  validateInstance,
  validatePromptTemplate,
} from '../../src/shared/config/registry.js';
import { createOpenAIConfig } from '../../src/shared/config/openai.js';

/** 合法 OpenAI 实例。 */
function validOpenAI(patch = {}) {
  return {
    ...createOpenAIConfig('deepseek'),
    id: 'inst-openai',
    name: 'DeepSeek',
    enabled: true,
    createdAt: 1,
    updatedAt: 1,
    batchSize: DEFAULT_BATCH_SIZE,
    batchMaxChars: DEFAULT_BATCH_MAX_CHARS,
    maxConcurrency: DEFAULT_MAX_CONCURRENCY,
    systemPrompt: DEFAULT_SYSTEM_PROMPT,
    ...patch,
  };
}

/** 合法百度实例。 */
function validBaidu(patch = {}) {
  return {
    id: 'inst-baidu',
    type: 'baidu',
    name: '百度翻译',
    enabled: true,
    createdAt: 1,
    updatedAt: 1,
    baseUrl: 'https://fanyi-api.baidu.com',
    model: 'general',
    batchSize: BAIDU_BATCH_SIZE.default,
    batchMaxChars: BAIDU_BATCH_MAX_CHARS.default,
    maxConcurrency: BAIDU_MAX_CONCURRENCY.default,
    qps: BAIDU_QPS.default,
    ...patch,
  };
}

describe('E3 引擎类型目录', () => {
  it('注册 openai 与 baidu 两种类型，旧 deepseek 不再是可执行类型', () => {
    expect(Object.keys(ENGINE_TYPES).sort()).toEqual(['baidu', 'openai']);
    expect(getEngineType(ENGINE_TYPE_IDS.OPENAI)?.id).toBe('openai');
    expect(getEngineType(ENGINE_TYPE_IDS.BAIDU)?.id).toBe('baidu');
    expect(getEngineType('deepseek')).toBeNull();
    expect(isSupportedType('deepseek')).toBe(false);
    expect(isSupportedType('deepl')).toBe(false);
  });

  it('类型显示名与类别', () => {
    expect(getTypeLabel('openai')).toBe('OpenAI 兼容');
    expect(getTypeLabel('baidu')).toBe('百度翻译');
    expect(getTypeLabel('deepl')).toBe('不支持');
    expect(getEngineKind('openai')).toBe('llm');
    expect(getEngineKind('baidu')).toBe('traditional');
    expect(getEngineKind('deepl')).toBe('unsupported');
  });

  it('默认实例名按类型/预设生成', () => {
    expect(getDefaultInstanceName('openai', 'deepseek')).toBe('DeepSeek');
    expect(getDefaultInstanceName('openai', 'custom')).toBe('自定义');
    expect(getDefaultInstanceName('baidu')).toBe('百度翻译');
    expect(getDefaultInstanceName('deepl')).toBe('翻译实例');
  });

  it('实例名称归一与 1–40 字符校验', () => {
    expect(normalizeInstanceName('  Deep   Seek  ')).toBe('Deep Seek');
    expect(normalizeInstanceName('\u0000abc\n')).toBe('abc');
    expect(isValidInstanceName('a')).toBe(true);
    expect(isValidInstanceName('   ')).toBe(false);
    expect(isValidInstanceName('x'.repeat(MAX_INSTANCE_NAME_CHARS))).toBe(true);
    expect(isValidInstanceName('x'.repeat(MAX_INSTANCE_NAME_CHARS + 1))).toBe(false);
  });

  it('默认提示词含两个占位符，且被判定为默认模板', () => {
    expect(DEFAULT_SYSTEM_PROMPT).toContain('{{targetLang}}');
    expect(DEFAULT_SYSTEM_PROMPT).toContain('{{outputFormat}}');
    expect(isDefaultPrompt(DEFAULT_SYSTEM_PROMPT)).toBe(true);
    expect(isDefaultPrompt(`  ${DEFAULT_SYSTEM_PROMPT}\r\n`)).toBe(true);
    expect(isDefaultPrompt('自定义模板 {{targetLang}} {{outputFormat}}')).toBe(false);
  });

  it('normalizeBatchSize：保证 ≥1 并向下取整，可指定上限', () => {
    expect(normalizeBatchSize(1)).toBe(1);
    expect(normalizeBatchSize(999)).toBe(999);
    expect(normalizeBatchSize(999, 20)).toBe(20);
    expect(normalizeBatchSize(0)).toBe(1);
    expect(normalizeBatchSize(4.7)).toBe(4);
    expect(normalizeBatchSize('6')).toBe(6);
    expect(normalizeBatchSize('nope')).toBe(DEFAULT_BATCH_SIZE);
  });

  it('normalizePositiveInt：只接受 >=1 的值，可指定上下限', () => {
    expect(normalizePositiveInt(3, 4)).toBe(3);
    expect(normalizePositiveInt(3.9, 4)).toBe(3);
    expect(normalizePositiveInt(0, 4)).toBe(4);
    expect(normalizePositiveInt('7', 4)).toBe(7);
    expect(normalizePositiveInt(30, 4, { max: 10 })).toBe(10);
    expect(normalizePositiveInt('x', 4)).toBe(4);
  });

  it('validatePromptTemplate：缺少/未知占位符、空与超长都被拒绝', () => {
    expect(validatePromptTemplate(DEFAULT_SYSTEM_PROMPT).ok).toBe(true);
    expect(validatePromptTemplate('').ok).toBe(false);
    expect(validatePromptTemplate('只有 {{targetLang}}').ok).toBe(false);
    expect(validatePromptTemplate('{{targetLang}} {{outputFormat}} {{foo}}').ok).toBe(false);
    expect(validatePromptTemplate('x'.repeat(MAX_PROMPT_CHARS + 1)).ok).toBe(false);
  });

  it('validateInstance：OpenAI 字段逐项校验', () => {
    expect(validateInstance(validOpenAI()).ok).toBe(true);
    expect(validateInstance(null).ok).toBe(false);
    expect(validateInstance(validOpenAI({ name: '' })).ok).toBe(false);
    expect(validateInstance(validOpenAI({ enabled: 'yes' })).ok).toBe(false);
    expect(validateInstance(validOpenAI({ model: '' })).ok).toBe(false);
    expect(validateInstance(validOpenAI({ endpoint: { baseUrl: 'ftp://x', path: '/x' } })).ok).toBe(
      false
    );
    expect(validateInstance(validOpenAI({ preset: 'unknown' })).ok).toBe(false);
    expect(validateInstance(validOpenAI({ batchSize: 0 })).ok).toBe(false);
    expect(validateInstance(validOpenAI({ batchMaxChars: 0 })).ok).toBe(false);
    expect(validateInstance(validOpenAI({ maxConcurrency: 0 })).ok).toBe(false);
    expect(validateInstance(validOpenAI({ systemPrompt: '缺少占位符' })).ok).toBe(false);
    // OpenAI 不设批次/并发上限。
    expect(validateInstance(validOpenAI({ batchSize: 999, maxConcurrency: 99 })).ok).toBe(true);
  });

  it('validateInstance：百度字段与范围校验', () => {
    expect(validateInstance(validBaidu()).ok).toBe(true);
    expect(validateInstance(validBaidu({ baseUrl: 'https://example.com' })).ok).toBe(false);
    expect(validateInstance(validBaidu({ model: 'chat' })).ok).toBe(false);
    expect(validateInstance(validBaidu({ batchSize: 21 })).ok).toBe(false);
    expect(validateInstance(validBaidu({ batchSize: 0 })).ok).toBe(false);
    expect(validateInstance(validBaidu({ batchMaxChars: 2001 })).ok).toBe(false);
    expect(validateInstance(validBaidu({ maxConcurrency: 11 })).ok).toBe(false);
    expect(validateInstance(validBaidu({ maxConcurrency: 10 })).ok).toBe(true);
    expect(validateInstance(validBaidu({ batchSize: 2.5 })).ok).toBe(false);
    // P9：百度接口 QPS 必须是 1–100 的整数。
    expect(validateInstance(validBaidu({ qps: 0 })).ok).toBe(false);
    expect(validateInstance(validBaidu({ qps: 101 })).ok).toBe(false);
    expect(validateInstance(validBaidu({ qps: 2.5 })).ok).toBe(false);
    expect(validateInstance(validBaidu({ qps: 'x' })).ok).toBe(false);
    expect(validateInstance(validBaidu({ qps: BAIDU_QPS.min })).ok).toBe(true);
    expect(validateInstance(validBaidu({ qps: BAIDU_QPS.max })).ok).toBe(true);
  });

  it('validateInstance：不支持的类型被拒绝', () => {
    expect(validateInstance({ type: 'deepl', name: 'X', enabled: true }).ok).toBe(false);
  });

  it('百度默认值与状态目录一致', () => {
    expect(MIN_BATCH_SIZE).toBe(1);
    expect(BAIDU_BATCH_SIZE).toEqual({ min: 1, max: 20, default: 8 });
    expect(BAIDU_BATCH_MAX_CHARS).toEqual({ min: 1, max: 2000, default: 1000 });
    expect(BAIDU_MAX_CONCURRENCY).toEqual({ min: 1, max: 10, default: 1 });
    expect(BAIDU_QPS).toEqual({ min: 1, max: 100, default: 1 });
    // 百度字段目录增加 qps；OpenAI 没有该字段。
    expect(ENGINE_TYPES.baidu.fields).toContain('qps');
    expect(ENGINE_TYPES.openai.fields).not.toContain('qps');
  });
});
