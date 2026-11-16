/**
 * E3 引擎类型目录测试
 *
 * 覆盖 P6.2：实例字段、默认值、思考强度与批次/并发归一、模型与提示词校验。
 */

import { describe, expect, it } from 'vitest';
import {
  DEFAULT_BATCH_MAX_CHARS,
  DEFAULT_BATCH_SIZE,
  DEFAULT_MAX_CONCURRENCY,
  DEFAULT_REASONING_EFFORT,
  DEFAULT_SYSTEM_PROMPT,
  ENGINE_TYPE_IDS,
  ENGINE_TYPES,
  MAX_MODEL_CHARS,
  MAX_PROMPT_CHARS,
  MIN_BATCH_SIZE,
  REASONING_EFFORTS,
  getEngineType,
  isDefaultPrompt,
  normalizeBatchSize,
  normalizePositiveInt,
  normalizeReasoningEffort,
  validateInstance,
  validatePromptTemplate,
} from '../../src/shared/config/registry.js';

/** 合法实例：默认值基础上按需覆盖。 */
function validInstance(patch = {}) {
  return {
    id: 'default',
    type: 'deepseek',
    name: 'DeepSeek',
    model: 'deepseek-chat',
    baseUrl: 'https://api.deepseek.com',
    reasoningEffort: DEFAULT_REASONING_EFFORT,
    batchSize: DEFAULT_BATCH_SIZE,
    batchMaxChars: DEFAULT_BATCH_MAX_CHARS,
    maxConcurrency: DEFAULT_MAX_CONCURRENCY,
    systemPrompt: DEFAULT_SYSTEM_PROMPT,
    ...patch,
  };
}

describe('E3 引擎类型目录', () => {
  it('P1 只注册 DeepSeek 一个类型', () => {
    expect(Object.keys(ENGINE_TYPES)).toEqual(['deepseek']);
    expect(getEngineType(ENGINE_TYPE_IDS.DEEPSEEK)?.id).toBe('deepseek');
    expect(getEngineType('openai')).toBeNull();
  });

  it('DeepSeek 默认模型与接口地址', () => {
    const type = getEngineType('deepseek');
    expect(typeof type.defaultModel).toBe('string');
    expect(type.defaultModel).not.toBe('');
    expect(type.baseUrl).toMatch(/^https:\/\//);
  });

  it('实例字段包含 P6.2 参数，默认值与文档一致', () => {
    const type = getEngineType('deepseek');
    expect(type.fields).toEqual(
      expect.arrayContaining([
        'model',
        'reasoningEffort',
        'batchSize',
        'batchMaxChars',
        'maxConcurrency',
        'systemPrompt',
      ])
    );
    expect(DEFAULT_BATCH_SIZE).toBe(8);
    expect(MIN_BATCH_SIZE).toBe(1);
    expect(DEFAULT_BATCH_MAX_CHARS).toBe(1000);
    expect(DEFAULT_MAX_CONCURRENCY).toBe(4);
    expect(REASONING_EFFORTS).toEqual(['off', 'low', 'medium', 'high', 'max']);
    expect(DEFAULT_REASONING_EFFORT).toBe('off');
    expect(MAX_PROMPT_CHARS).toBe(2000);
  });

  it('默认提示词含两个占位符，且被判定为默认模板', () => {
    expect(DEFAULT_SYSTEM_PROMPT).toContain('{{targetLang}}');
    expect(DEFAULT_SYSTEM_PROMPT).toContain('{{outputFormat}}');
    expect(isDefaultPrompt(DEFAULT_SYSTEM_PROMPT)).toBe(true);
    expect(isDefaultPrompt(`  ${DEFAULT_SYSTEM_PROMPT}\r\n`)).toBe(true);
    expect(isDefaultPrompt('自定义模板 {{targetLang}} {{outputFormat}}')).toBe(false);
  });

  it('normalizeReasoningEffort：合法值保留，非法值归一为 off', () => {
    for (const value of REASONING_EFFORTS) expect(normalizeReasoningEffort(value)).toBe(value);
    expect(normalizeReasoningEffort('turbo')).toBe('off');
    expect(normalizeReasoningEffort(undefined)).toBe('off');
    expect(normalizeReasoningEffort(null)).toBe('off');
  });

  it('normalizeBatchSize：保证 ≥1 并向下取整，不设业务上限，非法值回退 8', () => {
    expect(normalizeBatchSize(1)).toBe(1);
    expect(normalizeBatchSize(12)).toBe(12);
    expect(normalizeBatchSize(20)).toBe(20);
    expect(normalizeBatchSize(999)).toBe(999);
    expect(normalizeBatchSize(0)).toBe(1);
    expect(normalizeBatchSize(-5)).toBe(1);
    expect(normalizeBatchSize(4.7)).toBe(4);
    expect(normalizeBatchSize('6')).toBe(6);
    expect(normalizeBatchSize('nope')).toBe(DEFAULT_BATCH_SIZE);
    expect(normalizeBatchSize(undefined)).toBe(DEFAULT_BATCH_SIZE);
  });

  it('normalizePositiveInt：只接受 >=1 的值，其余回退', () => {
    expect(normalizePositiveInt(3, 4)).toBe(3);
    expect(normalizePositiveInt(3.9, 4)).toBe(3);
    expect(normalizePositiveInt(0, 4)).toBe(4);
    expect(normalizePositiveInt(-2, 4)).toBe(4);
    expect(normalizePositiveInt('7', 4)).toBe(7);
    expect(normalizePositiveInt('x', 4)).toBe(4);
  });

  it('validatePromptTemplate：缺少/未知占位符、空与超长都被拒绝', () => {
    expect(validatePromptTemplate(DEFAULT_SYSTEM_PROMPT).ok).toBe(true);
    expect(validatePromptTemplate('').ok).toBe(false);
    expect(validatePromptTemplate('   ').ok).toBe(false);
    expect(validatePromptTemplate('只有 {{targetLang}}').ok).toBe(false);
    expect(validatePromptTemplate('只有 {{outputFormat}}').ok).toBe(false);
    expect(validatePromptTemplate('{{targetLang}} {{outputFormat}} {{foo}}').ok).toBe(false);
    expect(validatePromptTemplate('x'.repeat(MAX_PROMPT_CHARS + 1)).ok).toBe(false);
    expect(validatePromptTemplate(`{{targetLang}} {{outputFormat}} ${'x'.repeat(100)}`).ok).toBe(
      true
    );
  });

  it('validateInstance：空实例/未知类型/缺模型被拦截，合法实例通过', () => {
    expect(validateInstance(null).ok).toBe(false);
    expect(validateInstance({ type: 'openai', model: 'gpt' }).ok).toBe(false);
    expect(validateInstance(validInstance({ model: '' })).ok).toBe(false);
    expect(validateInstance(validInstance()).ok).toBe(true);
  });

  it('validateInstance：模型超长、思考强度、批次、并发与提示词逐项校验', () => {
    expect(validateInstance(validInstance({ model: 'm'.repeat(MAX_MODEL_CHARS + 1) })).ok).toBe(
      false
    );
    expect(validateInstance(validInstance({ reasoningEffort: 'turbo' })).ok).toBe(false);
    expect(validateInstance(validInstance({ batchSize: 0 })).ok).toBe(false);
    expect(validateInstance(validInstance({ batchSize: -1 })).ok).toBe(false);
    expect(validateInstance(validInstance({ batchSize: 2.5 })).ok).toBe(false);
    expect(validateInstance(validInstance({ batchSize: 13 })).ok).toBe(true);
    expect(validateInstance(validInstance({ batchSize: 999 })).ok).toBe(true);
    expect(validateInstance(validInstance({ batchMaxChars: 0 })).ok).toBe(false);
    expect(validateInstance(validInstance({ batchMaxChars: 1.5 })).ok).toBe(false);
    expect(validateInstance(validInstance({ maxConcurrency: -1 })).ok).toBe(false);
    expect(validateInstance(validInstance({ maxConcurrency: 2.5 })).ok).toBe(false);
    expect(validateInstance(validInstance({ systemPrompt: '缺少占位符' })).ok).toBe(false);
    expect(validateInstance(validInstance({ systemPrompt: '' })).ok).toBe(false);

    expect(validateInstance(validInstance({ model: 'm'.repeat(MAX_MODEL_CHARS) })).ok).toBe(true);
    expect(validateInstance(validInstance({ batchSize: 1, maxConcurrency: 99 })).ok).toBe(true);
  });
});
