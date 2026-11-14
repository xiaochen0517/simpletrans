/**
 * E3 引擎类型目录测试
 */

import { describe, expect, it } from 'vitest';
import { ENGINE_TYPE_IDS, ENGINE_TYPES, getEngineType, validateInstance } from '../../src/shared/config/registry.js';

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

  it('validateInstance：空实例/未知类型/缺模型被拦截，合法实例通过', () => {
    expect(validateInstance(null).ok).toBe(false);
    expect(validateInstance({ type: 'openai', model: 'gpt' }).ok).toBe(false);
    expect(validateInstance({ type: 'deepseek', model: '' }).ok).toBe(false);
    expect(validateInstance({ type: 'deepseek', model: 'deepseek-chat' }).ok).toBe(true);
  });
});
