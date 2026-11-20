/**
 * A3 OpenAI 请求构造测试
 *
 * 覆盖 URL/auth/header/body、生成参数启停、额外参数、保留字段与配置校验；纯函数，不联网。
 */

import { describe, expect, it } from 'vitest';
import { ERROR_CODES } from '../../src/shared/protocol.js';
import { createOpenAIConfig } from '../../src/shared/config/openai.js';
import {
  buildEndpointUrl,
  buildGenerationParams,
  buildHeaders,
  buildRequest,
  formatAuthValue,
} from '../../src/shared/translate/openai-request.js';

/** 构造一份 DeepSeek 请求配置。 */
function deepseek() {
  return createOpenAIConfig('deepseek');
}

/** 构造一份自定义 endpoint 配置。 */
function custom() {
  return createOpenAIConfig('custom');
}

/**
 * 断言构造请求抛出统一 CONFIG 错误。
 * @param {() => unknown} fn
 * @param {string} [message]
 */
function expectConfigError(fn, message) {
  let error = null;
  try {
    fn();
  } catch (caught) {
    error = caught;
  }
  expect(error?.code).toBe(ERROR_CODES.CONFIG);
  if (message) expect(error?.message).toBe(message);
}

describe('A3 OpenAI 请求构造：URL 与认证', () => {
  it('DeepSeek 默认请求：URL、Bearer 认证、system/user 消息与 stream', () => {
    const request = buildRequest({
      config: deepseek(),
      apiKey: ' sk-test ',
      targetLang: 'zh',
      text: 'hello',
    });

    expect(request.url).toBe('https://api.deepseek.com/chat/completions');
    expect(request.method).toBe('POST');
    expect(request.stream).toBe(true);
    expect(request.headers).toEqual({
      'Content-Type': 'application/json',
      Authorization: 'Bearer sk-test',
    });
    expect(request.body.model).toBe('deepseek-chat');
    expect(request.body.stream).toBe(true);
    expect(request.body.messages).toHaveLength(2);
    expect(request.body.messages[0].role).toBe('system');
    expect(request.body.messages[0].content).toContain('中文');
    expect(request.body.messages[0].content).not.toContain('{{');
    expect(request.body.messages[1]).toEqual({ role: 'user', content: 'hello' });
    // 请求体不含地址与密钥。
    expect(JSON.stringify(request.body)).not.toContain('sk-test');
    expect(JSON.stringify(request.body)).not.toContain('api.deepseek.com');
  });

  it('DeepSeek 默认关闭 temperature/top_p/max_tokens，只显式关闭思考', () => {
    const { body } = buildRequest({ config: deepseek(), apiKey: 'k', targetLang: 'zh', text: 'hi' });
    expect(body).not.toHaveProperty('temperature');
    expect(body).not.toHaveProperty('top_p');
    expect(body).not.toHaveProperty('max_tokens');
    expect(body).not.toHaveProperty('reasoning_effort');
    expect(body.thinking).toEqual({ type: 'disabled' });
  });

  it('自定义 endpoint：去尾部斜杠、路径前缀、静态 query 与认证 query', () => {
    const config = custom();
    config.endpoint = {
      baseUrl: 'https://gw.example.com/openai/v1/',
      path: '/chat/completions',
      query: [{ name: 'api-version', value: '2024-08-01' }],
      stream: true,
    };
    config.auth = { type: 'query', queryName: 'key' };
    config.model = 'gpt-4o-mini';

    const request = buildRequest({ config, apiKey: 'secret', targetLang: 'zh', text: 'hi' });
    const url = new URL(request.url);

    expect(url.origin).toBe('https://gw.example.com');
    expect(url.pathname).toBe('/openai/v1/chat/completions');
    expect(url.searchParams.get('api-version')).toBe('2024-08-01');
    expect(url.searchParams.get('key')).toBe('secret');
    expect(request.headers).toEqual({ 'Content-Type': 'application/json' });
  });

  it('header 认证支持自定义头名与前缀；prefix 为空时直接用密钥', () => {
    const config = custom();
    config.endpoint.baseUrl = 'https://gw.example.com';
    config.model = 'm';
    config.auth = { type: 'header', headerName: 'api-key', prefix: 'Bearer' };

    expect(buildRequest({ config, apiKey: 'k', targetLang: 'zh', text: 'hi' }).headers).toEqual({
      'Content-Type': 'application/json',
      'api-key': 'Bearer k',
    });

    config.auth = { type: 'header', headerName: 'api-key', prefix: '' };
    expect(buildRequest({ config, apiKey: 'k', targetLang: 'zh', text: 'hi' }).headers['api-key']).toBe('k');
    expect(formatAuthValue('token', 'k')).toBe('token k');
  });

  it('auth.type = none 时不需要密钥，也不产生认证头/查询参数', () => {
    const config = custom();
    config.endpoint.baseUrl = 'http://localhost:8080';
    config.model = 'local-model';
    config.auth = { type: 'none' };

    const request = buildRequest({ config, targetLang: 'zh', text: 'hi' });
    expect(request.headers).toEqual({ 'Content-Type': 'application/json' });
    expect(request.url).toBe('http://localhost:8080/chat/completions');
  });

  it('静态请求头按配置写入，并保留认证头', () => {
    const config = deepseek();
    config.headers = [{ name: 'X-Title', value: 'SimpleTrans' }];
    const request = buildRequest({ config, apiKey: 'k', targetLang: 'zh', text: 'hi' });
    expect(request.headers).toEqual({
      'Content-Type': 'application/json',
      Authorization: 'Bearer k',
      'X-Title': 'SimpleTrans',
    });
  });

  it('buildEndpointUrl / buildHeaders 可直接用于日志摘要之外的检查', () => {
    const config = deepseek();
    expect(buildEndpointUrl(config, 'k')).toBe('https://api.deepseek.com/chat/completions');
    expect(buildHeaders(config, 'k')).toEqual({
      'Content-Type': 'application/json',
      Authorization: 'Bearer k',
    });
  });
});

describe('A3 OpenAI 请求构造：生成参数', () => {
  it('temperature/top_p/max_tokens 只在启用时发送', () => {
    const config = deepseek();
    config.params.temperature = { enabled: true, value: 0.7 };
    config.params.topP = { enabled: true, value: 0.9 };
    config.params.maxTokens = { enabled: true, field: 'max_completion_tokens', value: 256 };

    const { body } = buildRequest({ config, apiKey: 'k', targetLang: 'zh', text: 'hi' });
    expect(body.temperature).toBe(0.7);
    expect(body.top_p).toBe(0.9);
    expect(body.max_completion_tokens).toBe(256);
    expect(body).not.toHaveProperty('max_tokens');
  });

  it('思考强度 effort：开启发送 reasoning_effort + thinking.type=enabled，off 只发 disabled', () => {
    const config = deepseek();
    config.params.reasoning.value = 'medium';
    let body = buildRequest({ config, apiKey: 'k', targetLang: 'zh', text: 'hi' }).body;
    expect(body.reasoning_effort).toBe('medium');
    expect(body.thinking).toEqual({ type: 'enabled' });

    config.params.reasoning.value = 'off';
    body = buildRequest({ config, apiKey: 'k', targetLang: 'zh', text: 'hi' }).body;
    expect(body).not.toHaveProperty('reasoning_effort');
    expect(body.thinking).toEqual({ type: 'disabled' });
  });

  it('思考预算与开关模式按点路径展开', () => {
    const config = deepseek();
    config.params.reasoning = {
      mode: 'budget',
      field: '',
      value: 'off',
      values: [],
      budgetField: 'thinking.budget_tokens',
      budget: 1024,
      toggleField: '',
      onValue: '',
      offValue: '',
    };
    let body = buildRequest({ config, apiKey: 'k', targetLang: 'zh', text: 'hi' }).body;
    expect(body.thinking).toEqual({ budget_tokens: 1024 });

    config.params.reasoning = {
      mode: 'toggle',
      field: '',
      value: 'on',
      values: [],
      budgetField: '',
      budget: 0,
      toggleField: 'thinking.type',
      onValue: 'enabled',
      offValue: 'disabled',
    };
    body = buildRequest({ config, apiKey: 'k', targetLang: 'zh', text: 'hi' }).body;
    expect(body.thinking).toEqual({ type: 'enabled' });

    config.params.reasoning.value = 'off';
    body = buildRequest({ config, apiKey: 'k', targetLang: 'zh', text: 'hi' }).body;
    expect(body.thinking).toEqual({ type: 'disabled' });
  });

  it('额外参数按类型写入点路径，关闭项忽略', () => {
    const config = deepseek();
    config.params.extra = [
      { path: 'stream_options.include_usage', type: 'boolean', value: 'true', enabled: true },
      { path: 'metadata.count', type: 'number', value: '3', enabled: true },
      { path: 'metadata.tag', type: 'string', value: 'a', enabled: true },
      { path: 'custom', type: 'json', value: '{"a":1}', enabled: true },
      { path: 'ignored', type: 'string', value: 'x', enabled: false },
    ];

    const body = buildRequest({ config, apiKey: 'k', targetLang: 'zh', text: 'hi' }).body;
    expect(body.stream_options).toEqual({ include_usage: true });
    expect(body.metadata).toEqual({ count: 3, tag: 'a' });
    expect(body.custom).toEqual({ a: 1 });
    expect(body).not.toHaveProperty('ignored');
  });

  it('buildGenerationParams 只返回生成参数，不含 model/messages/stream', () => {
    const config = deepseek();
    config.params.temperature = { enabled: true, value: 0.2 };
    expect(buildGenerationParams(config)).toEqual({
      temperature: 0.2,
      thinking: { type: 'disabled' },
    });
  });

  it('stream=false 写入请求体与请求描述', () => {
    const config = deepseek();
    config.endpoint.stream = false;
    const request = buildRequest({ config, apiKey: 'k', targetLang: 'zh', text: 'hi' });
    expect(request.stream).toBe(false);
    expect(request.body.stream).toBe(false);
  });
});

describe('A3 OpenAI 请求构造：提示词与批量', () => {
  it('使用实例提示词模板展开 targetLang 与 outputFormat', () => {
    const request = buildRequest({
      config: deepseek(),
      apiKey: 'k',
      targetLang: 'zh',
      systemPrompt: '把内容用书面语翻译成{{targetLang}}。{{outputFormat}}',
      text: 'hi',
    });
    const system = request.body.messages[0].content;
    expect(system).toContain('用书面语');
    expect(system).toContain('中文');
    expect(system).not.toContain('{{targetLang}}');
    expect(system).not.toContain('{{outputFormat}}');
  });

  it('批量模式 system 要求 JSONL，user 为 JSONL 输入', () => {
    const text = '{"id":"g0","text":"Hello"}\n{"id":"g1","text":"World"}';
    const request = buildRequest({ config: deepseek(), apiKey: 'k', targetLang: 'zh', text, mode: 'batch' });
    expect(request.body.messages[0].content).toContain('JSONL');
    expect(request.body.messages[1].content).toBe(text);
  });

  it('快速模式 system 使用快速输出格式（单词字段 / 句子纯译文）', () => {
    const request = buildRequest({
      config: deepseek(),
      apiKey: 'k',
      targetLang: 'zh',
      systemPrompt: '快速模板 {{targetLang}}。{{outputFormat}}',
      text: 'hello',
      mode: 'quick',
    });
    const system = request.body.messages[0].content;
    expect(system).toContain('快速模板 中文。');
    expect(system).toContain('音标');
    expect(system).toContain('只输出目标语言译文');
    expect(system).not.toContain('{{targetLang}}');
    expect(system).not.toContain('{{outputFormat}}');
  });
});

describe('A3 OpenAI 请求构造：校验失败不发请求', () => {
  it('缺密钥抛 CONFIG', () => {
    expectConfigError(
      () => buildRequest({ config: deepseek(), apiKey: '  ', targetLang: 'zh', text: 'hi' }),
      '缺少密钥，请先在设置页配置'
    );
  });

  it('endpoint 非法抛 CONFIG', () => {
    const config = custom();
    config.model = 'm';
    expectConfigError(
      () => buildRequest({ config, apiKey: 'k', targetLang: 'zh', text: 'hi' }),
      '接口地址无效，请检查 baseUrl 与 path'
    );
  });

  it('危险静态 header、保留字段与重复参数都抛 CONFIG', () => {
    const headerConfig = deepseek();
    headerConfig.headers = [{ name: 'Cookie', value: 'x' }];
    expectConfigError(() => buildRequest({ config: headerConfig, apiKey: 'k', targetLang: 'zh', text: 'hi' }));

    const extraConfig = deepseek();
    extraConfig.params.extra = [{ path: 'messages', type: 'json', value: '[]', enabled: true }];
    expectConfigError(
      () => buildRequest({ config: extraConfig, apiKey: 'k', targetLang: 'zh', text: 'hi' }),
      '额外参数不能覆盖保留字段：messages'
    );

    const conflictConfig = deepseek();
    conflictConfig.params.temperature = { enabled: true, value: 0.5 };
    conflictConfig.params.extra = [{ path: 'temperature', type: 'number', value: '1', enabled: true }];
    expectConfigError(() => buildRequest({ config: conflictConfig, apiKey: 'k', targetLang: 'zh', text: 'hi' }));
  });
});
