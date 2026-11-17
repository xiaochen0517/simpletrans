/**
 * E3 OpenAI 兼容配置测试
 *
 * 覆盖 DeepSeek/custom 预设默认值、归一、校验与旧 DeepSeek 迁移映射；不联网、不读写存储。
 */

import { describe, expect, it } from 'vitest';
import {
  AUTH_TYPES,
  DEEPSEEK_REASONING_VALUES,
  OPENAI_PRESET_IDS,
  OPENAI_TYPE,
  createOpenAIConfig,
  getPreset,
  isKnownPreset,
  mapLegacyDeepSeek,
  normalizeOpenAIConfig,
  resolveOpenAIConfig,
  validateOpenAIConfig,
} from '../../src/shared/config/openai.js';

/** 构造一份可修改的 DeepSeek 配置。 */
function deepseekConfig() {
  return createOpenAIConfig(OPENAI_PRESET_IDS.DEEPSEEK);
}

/** 校验失败时返回第一条错误，便于断言。 */
function firstError(config) {
  const result = validateOpenAIConfig(config);
  expect(result.ok).toBe(false);
  return result.errors[0];
}

describe('E3 OpenAI 预设', () => {
  it('DeepSeek 预设默认值符合需求表', () => {
    expect(createOpenAIConfig('deepseek')).toEqual({
      type: OPENAI_TYPE,
      preset: 'deepseek',
      endpoint: {
        baseUrl: 'https://api.deepseek.com',
        path: '/chat/completions',
        query: [],
        stream: true,
      },
      auth: { type: 'bearer', headerName: '', prefix: '', queryName: '' },
      headers: [],
      model: 'deepseek-chat',
      params: {
        temperature: { enabled: false, value: 1 },
        topP: { enabled: false, value: 1 },
        maxTokens: { enabled: false, field: 'max_tokens', value: 2048 },
        reasoning: {
          mode: 'effort',
          field: 'reasoning_effort',
          value: 'off',
          values: [...DEEPSEEK_REASONING_VALUES],
          budgetField: '',
          budget: 0,
          toggleField: 'thinking.type',
          onValue: 'enabled',
          offValue: 'disabled',
        },
        extra: [],
      },
    });
  });

  it('custom 预设为空地址、空模型、全部参数关闭', () => {
    const config = createOpenAIConfig('custom');
    expect(config.endpoint).toEqual({ baseUrl: '', path: '/chat/completions', query: [], stream: true });
    expect(config.auth.type).toBe('bearer');
    expect(config.model).toBe('');
    expect(config.params.temperature.enabled).toBe(false);
    expect(config.params.topP.enabled).toBe(false);
    expect(config.params.maxTokens.enabled).toBe(false);
    expect(config.params.reasoning.mode).toBe('none');
    expect(config.params.extra).toEqual([]);
  });

  it('预设是深拷贝，修改一份不影响下一次创建', () => {
    const first = createOpenAIConfig('deepseek');
    first.endpoint.baseUrl = 'https://changed.example';
    first.params.reasoning.value = 'high';
    expect(createOpenAIConfig('deepseek').endpoint.baseUrl).toBe('https://api.deepseek.com');
    expect(createOpenAIConfig('deepseek').params.reasoning.value).toBe('off');
  });

  it('getPreset / isKnownPreset 只认已注册预设', () => {
    expect(getPreset('deepseek').label).toBe('DeepSeek');
    expect(getPreset('custom').label).toBe('自定义');
    expect(getPreset('openai')).toBeNull();
    expect(isKnownPreset('nope')).toBe(false);
    expect(AUTH_TYPES).toEqual(['bearer', 'header', 'query', 'none']);
  });
});

describe('E3 OpenAI 配置归一', () => {
  it('按预设补齐缺失字段并保留自定义值', () => {
    const config = normalizeOpenAIConfig({ preset: 'deepseek', model: 'deepseek-reasoner' });
    expect(config.endpoint.baseUrl).toBe('https://api.deepseek.com');
    expect(config.endpoint.path).toBe('/chat/completions');
    expect(config.endpoint.stream).toBe(true);
    expect(config.auth.type).toBe('bearer');
    expect(config.model).toBe('deepseek-reasoner');
    expect(config.params.reasoning.value).toBe('off');
  });

  it('裁剪字符串、归一布尔/数字与额外参数', () => {
    const config = normalizeOpenAIConfig({
      preset: 'deepseek',
      type: 'openai',
      endpoint: {
        baseUrl: '  https://api.example.com/v1  ',
        path: '  /chat/completions  ',
        query: [{ name: ' api-version ', value: ' 2024-08-01 ' }],
        stream: 'false',
      },
      auth: { type: 'header', headerName: ' api-key ', prefix: ' Bearer ' },
      headers: [{ name: ' X-Title ', value: ' SimpleTrans ' }],
      model: '   my-model   ',
      params: {
        temperature: { enabled: 'true', value: '0.5' },
        topP: { enabled: true, value: '0.9' },
        maxTokens: { enabled: 'true', field: 'max_completion_tokens', value: '128' },
        reasoning: { mode: 'budget', budgetField: 'thinking.budget_tokens', budget: '256' },
        extra: [{ path: 'stream_options.include_usage', type: 'boolean', value: 'true', enabled: 'true' }],
      },
    });

    expect(config.type).toBe('openai');
    expect(config.endpoint.baseUrl).toBe('https://api.example.com/v1');
    expect(config.endpoint.path).toBe('/chat/completions');
    expect(config.endpoint.query).toEqual([{ name: 'api-version', value: '2024-08-01' }]);
    expect(config.endpoint.stream).toBe(false);
    expect(config.auth).toEqual({ type: 'header', headerName: 'api-key', prefix: 'Bearer', queryName: '' });
    expect(config.headers).toEqual([{ name: 'X-Title', value: 'SimpleTrans' }]);
    expect(config.model).toBe('my-model');
    expect(config.params.temperature).toEqual({ enabled: true, value: 0.5 });
    expect(config.params.topP).toEqual({ enabled: true, value: 0.9 });
    expect(config.params.maxTokens).toEqual({ enabled: true, field: 'max_completion_tokens', value: 128 });
    expect(config.params.reasoning).toMatchObject({
      mode: 'budget',
      budgetField: 'thinking.budget_tokens',
      budget: 256,
    });
    expect(config.params.extra).toEqual([
      { path: 'stream_options.include_usage', type: 'boolean', value: 'true', enabled: true },
    ]);
  });

  it('未知预设回退 custom；保留调用方的 id/name 等字段', () => {
    const config = normalizeOpenAIConfig({ id: 'a', name: 'A', preset: 'unknown', model: 'm' });
    expect(config.preset).toBe('custom');
    expect(config.id).toBe('a');
    expect(config.name).toBe('A');
    expect(config.endpoint.baseUrl).toBe('');
  });
});

describe('E3 OpenAI 配置校验', () => {
  it('默认 DeepSeek 配置合法；本地回环 HTTP 合法', () => {
    expect(validateOpenAIConfig(deepseekConfig())).toEqual({ ok: true, errors: [] });

    const local = deepseekConfig();
    local.endpoint.baseUrl = 'http://127.0.0.1:11434';
    expect(validateOpenAIConfig(local).ok).toBe(true);

    local.endpoint.baseUrl = 'http://localhost:8080';
    expect(validateOpenAIConfig(local).ok).toBe(true);
  });

  it('endpoint 未填/非 HTTPS/非回环 HTTP/含账号或查询串/路径非法都报配置错误', () => {
    const config = deepseekConfig();
    config.endpoint.baseUrl = '';
    expect(firstError(config)).toBe('接口地址无效，请检查 baseUrl 与 path');

    config.endpoint.baseUrl = 'http://api.example.com';
    expect(firstError(config)).toBe('接口地址无效，请检查 baseUrl 与 path');

    config.endpoint.baseUrl = 'https://user:pass@api.example.com';
    expect(firstError(config)).toBe('接口地址无效，请检查 baseUrl 与 path');

    config.endpoint.baseUrl = 'ftp://api.example.com';
    expect(firstError(config)).toBe('接口地址无效，请检查 baseUrl 与 path');

    config.endpoint.baseUrl = 'https://api.example.com';
    config.endpoint.path = 'chat/completions';
    expect(firstError(config)).toBe('接口地址无效，请检查 baseUrl 与 path');

    config.endpoint.path = '/chat/completions';
    config.endpoint.baseUrl = 'https://api.example.com?x=1';
    expect(firstError(config)).toBe('接口地址不能包含查询参数或片段，请把参数填到「查询参数」');
  });

  it('查询参数名非法或重复报错', () => {
    const config = deepseekConfig();
    config.endpoint.query = [
      { name: 'a', value: '1' },
      { name: 'a', value: '2' },
    ];
    expect(firstError(config)).toBe('查询参数名重复：a');

    config.endpoint.query = [{ name: '', value: '1' }];
    expect(firstError(config)).toBe('查询参数名无效');
  });

  it('认证字段按方式校验，且不与静态查询参数重名', () => {
    const config = deepseekConfig();
    config.auth = { type: 'header', headerName: '', prefix: '', queryName: '' };
    expect(firstError(config)).toBe('认证请求头名称无效');

    config.auth = { type: 'query', queryName: '' };
    expect(firstError(config)).toBe('认证查询参数名无效');

    config.endpoint.query = [{ name: 'api-version', value: '1' }];
    config.auth = { type: 'query', queryName: 'api-version' };
    expect(firstError(config)).toBe('认证参数名与静态查询参数重复');

    config.auth = { type: 'none' };
    expect(validateOpenAIConfig(config).ok).toBe(true);
  });

  it('静态请求头拒绝鉴权/系统保留头、重复与认证头冲突', () => {
    const config = deepseekConfig();
    config.headers = [{ name: 'Authorization', value: 'x' }];
    expect(firstError(config)).toBe('静态请求头不能包含鉴权或系统保留头：Authorization');

    config.headers = [{ name: 'X-Test', value: '1' }];
    config.auth = { type: 'header', headerName: 'x-test' };
    expect(firstError(config)).toBe('静态请求头与认证请求头重复：X-Test');

    config.auth = { type: 'bearer' };
    config.headers = [
      { name: 'X-Test', value: '1' },
      { name: 'x-test', value: '2' },
    ];
    expect(firstError(config)).toBe('静态请求头重复：x-test');
  });

  it('模型名必填且不超过 100 字符', () => {
    const config = deepseekConfig();
    config.model = '';
    expect(firstError(config)).toBe('模型名称无效，请输入 1–100 个字符');

    config.model = 'a'.repeat(101);
    expect(firstError(config)).toBe('模型名称无效，请输入 1–100 个字符');
  });

  it('生成参数只在启用时校验范围', () => {
    const config = deepseekConfig();
    config.params.temperature = { enabled: true, value: 3 };
    expect(firstError(config)).toBe('temperature 必须是 0–2 之间的数字');

    config.params.temperature = { enabled: false, value: 3 };
    expect(validateOpenAIConfig(config).ok).toBe(true);

    config.params.topP = { enabled: true, value: 1.5 };
    expect(firstError(config)).toBe('top_p 必须是 0–1 之间的数字');

    config.params.topP = { enabled: false, value: 1 };
    config.params.maxTokens = { enabled: true, field: 'max_tokens', value: 0 };
    expect(firstError(config)).toBe('max_tokens 必须是正整数');

    config.params.maxTokens = { enabled: true, field: 'max_new_tokens', value: 10 };
    expect(firstError(config)).toBe('maxTokens 字段无效');
  });

  it('思考参数按模式校验 field/value/预算/开关', () => {
    const config = deepseekConfig();
    config.params.reasoning.value = 'bogus';
    expect(firstError(config)).toBe('思考强度取值不在允许列表内');

    config.params.reasoning = {
      mode: 'effort',
      field: 'reasoning_effort',
      value: '',
      values: [],
    };
    expect(firstError(config)).toBe('思考强度取值不能为空');

    config.params.reasoning = { mode: 'budget', budgetField: '', budget: 0 };
    expect(firstError(config)).toBe('思考预算字段路径无效');

    config.params.reasoning = { mode: 'toggle', toggleField: '', onValue: 'enabled' };
    expect(firstError(config)).toBe('思考开关字段路径无效');

    config.params.reasoning = { mode: 'toggle', toggleField: 'thinking.type', onValue: '' };
    expect(firstError(config)).toBe('思考开关开启值不能为空');
  });

  it('额外参数拒绝保留字段、重复、路径冲突与非法值', () => {
    const config = deepseekConfig();
    config.params.extra = [{ path: 'stream', type: 'boolean', value: 'true', enabled: true }];
    expect(firstError(config)).toBe('额外参数不能覆盖保留字段：stream');

    config.params.temperature = { enabled: true, value: 0.7 };
    config.params.extra = [{ path: 'temperature', type: 'number', value: '1', enabled: true }];
    expect(firstError(config)).toBe('额外参数与已启用参数重复：temperature');

    config.params.temperature = { enabled: false, value: 1 };
    config.params.extra = [
      { path: 'a', type: 'number', value: '1', enabled: true },
      { path: 'a', type: 'number', value: '2', enabled: true },
    ];
    expect(firstError(config)).toBe('额外参数重复：a');

    config.params.extra = [
      { path: 'a', type: 'number', value: '1', enabled: true },
      { path: 'a.b', type: 'number', value: '2', enabled: true },
    ];
    expect(firstError(config)).toBe('额外参数路径冲突：a.b');

    config.params.extra = [{ path: 'custom', type: 'json', value: '{bad', enabled: true }];
    expect(firstError(config)).toBe('额外参数 custom 不是合法 JSON');

    // 关闭的额外参数不参与校验。
    config.params.extra = [{ path: 'stream', type: 'string', value: '', enabled: false }];
    expect(validateOpenAIConfig(config).ok).toBe(true);
  });
});

describe('E3 旧 DeepSeek 迁移映射', () => {
  it('旧字段映射为 openai + deepseek 预设，且不携带密钥', () => {
    const mapped = mapLegacyDeepSeek({
      id: 'a',
      type: 'deepseek',
      baseUrl: 'https://api.deepseek.com/v1',
      model: 'deepseek-reasoner',
      reasoningEffort: 'high',
      apiKey: 'sk-secret',
      systemPrompt: '模板',
      batchSize: 4,
    });

    expect(mapped.type).toBe('openai');
    expect(mapped.preset).toBe('deepseek');
    expect(mapped.endpoint).toEqual({
      baseUrl: 'https://api.deepseek.com/v1',
      path: '/chat/completions',
      query: [],
      stream: true,
    });
    expect(mapped.auth.type).toBe('bearer');
    expect(mapped.model).toBe('deepseek-reasoner');
    expect(mapped.params.reasoning).toMatchObject({
      mode: 'effort',
      field: 'reasoning_effort',
      value: 'high',
      toggleField: 'thinking.type',
    });
    expect(mapped.params.temperature.enabled).toBe(false);
    expect(mapped.params.topP.enabled).toBe(false);
    expect(mapped.params.maxTokens.enabled).toBe(false);
    expect(mapped.apiKey).toBeUndefined();
  });

  it('未知思考强度回退 off；缺失字段使用预设默认值', () => {
    const mapped = mapLegacyDeepSeek({ type: 'deepseek', reasoningEffort: 'bogus' });
    expect(mapped.params.reasoning.value).toBe('off');
    expect(mapped.endpoint.baseUrl).toBe('https://api.deepseek.com');
    expect(mapped.model).toBe('deepseek-chat');
  });

  it('resolveOpenAIConfig 对旧实例走映射、对新实例走归一，并保留调用方字段', () => {
    const legacy = resolveOpenAIConfig({
      id: 'a',
      name: '旧实例',
      type: 'deepseek',
      apiKey: 'sk-x',
      systemPrompt: '模板',
      model: 'deepseek-chat',
    });
    expect(legacy.type).toBe('openai');
    expect(legacy.preset).toBe('deepseek');
    expect(legacy.apiKey).toBe('sk-x');
    expect(legacy.systemPrompt).toBe('模板');
    expect(legacy.name).toBe('旧实例');

    const current = resolveOpenAIConfig({ type: 'openai', preset: 'custom', model: 'm' });
    expect(current.type).toBe('openai');
    expect(current.preset).toBe('custom');
    expect(current.model).toBe('m');
  });
});
