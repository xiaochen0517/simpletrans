/**
 * A3 OpenAI 缓存 profile 与主机权限契约测试
 *
 * 覆盖 origin 匹配模式、权限检查注入、endpoint 指纹与生成参数哈希的稳定性；
 * 不联网、不依赖真实 Chrome。
 */

import { describe, expect, it } from 'vitest';
import { createOpenAIConfig } from '../../src/shared/config/openai.js';
import {
  buildLLMProfile,
  endpointFingerprint,
  generationHash,
  generationProfile,
  getOriginPattern,
  isEndpointPermitted,
  stableStringify,
} from '../../src/shared/translate/openai-profile.js';

/** 构造一份 DeepSeek 配置。 */
function deepseek() {
  return createOpenAIConfig('deepseek');
}

/** 构造一份自定义 endpoint 配置。 */
function custom() {
  const config = createOpenAIConfig('custom');
  config.endpoint.baseUrl = 'https://gw.example.com/openai';
  config.endpoint.path = '/chat/completions';
  config.endpoint.query = [
    { name: 'b', value: '2' },
    { name: 'a', value: '1' },
  ];
  config.model = 'gpt-4o-mini';
  config.auth = { type: 'bearer' };
  return config;
}

describe('A3 主机权限契约', () => {
  it('HTTPS 与本地回环 HTTP 生成不带端口的 origin 匹配模式', () => {
    expect(getOriginPattern('https://api.example.com')).toBe('https://api.example.com/*');
    expect(getOriginPattern('https://api.example.com:8443/v1')).toBe('https://api.example.com/*');
    expect(getOriginPattern('http://localhost:8080')).toBe('http://localhost/*');
    expect(getOriginPattern('http://127.0.0.1:11434')).toBe('http://127.0.0.1/*');
  });

  it('非 HTTPS、非回环 HTTP、带账号密码或非法地址返回 null', () => {
    expect(getOriginPattern('http://api.example.com')).toBeNull();
    expect(getOriginPattern('file:///tmp/x')).toBeNull();
    expect(getOriginPattern('https://user:pass@api.example.com')).toBeNull();
    expect(getOriginPattern('')).toBeNull();
    expect(getOriginPattern('not a url')).toBeNull();
  });

  it('权限检查可注入 contains；未授权与异常都返回 false', async () => {
    const calls = [];
    const contains = (request) => {
      calls.push(request);
      return true;
    };
    await expect(isEndpointPermitted('https://api.example.com', { contains })).resolves.toBe(true);
    expect(calls).toEqual([{ origins: ['https://api.example.com/*'] }]);

    await expect(isEndpointPermitted('https://api.example.com', { contains: () => false })).resolves.toBe(false);
    await expect(
      isEndpointPermitted('https://api.example.com', {
        contains: () => {
          throw new Error('denied');
        },
      })
    ).resolves.toBe(false);
    await expect(isEndpointPermitted('http://api.example.com')).resolves.toBe(false);
  });

  it('没有权限 API 的环境（单元测试）按已授权处理', async () => {
    await expect(isEndpointPermitted('https://api.example.com')).resolves.toBe(true);
  });
});

describe('A3 endpoint 指纹', () => {
  it('包含 origin、baseUrl 路径前缀、path 与排序后的静态 query', () => {
    expect(endpointFingerprint(deepseek())).toBe('https://api.deepseek.com/chat/completions');
    expect(endpointFingerprint(custom())).toBe(
      'https://gw.example.com/openai/chat/completions?a=1&b=2'
    );
  });

  it('静态 query 顺序不同视为同一 endpoint；path 变化产生不同指纹', () => {
    const left = custom();
    const right = custom();
    right.endpoint.query = [
      { name: 'a', value: '1' },
      { name: 'b', value: '2' },
    ];
    expect(endpointFingerprint(left)).toBe(endpointFingerprint(right));

    right.endpoint.path = '/v1/chat/completions';
    expect(endpointFingerprint(right)).not.toBe(endpointFingerprint(left));
  });

  it('认证方式、密钥与请求头不进入指纹', () => {
    const base = custom();
    const changed = custom();
    changed.auth = { type: 'query', queryName: 'api-key' };
    changed.headers = [{ name: 'X-Title', value: 'SimpleTrans' }];
    expect(endpointFingerprint(changed)).toBe(endpointFingerprint(base));
  });
});

describe('A3 生成参数 profile 与哈希', () => {
  it('profile 只含 stream 与实际展开的参数', () => {
    const config = deepseek();
    config.params.temperature = { enabled: true, value: 0.3 };
    config.params.reasoning.value = 'high';
    expect(generationProfile(config)).toEqual({
      stream: true,
      params: {
        temperature: 0.3,
        reasoning_effort: 'high',
        thinking: { type: 'enabled' },
      },
    });
  });

  it('相同配置哈希稳定，键顺序不影响结果', async () => {
    const left = deepseek();
    left.params.temperature = { enabled: true, value: 0.3 };
    const right = deepseek();
    right.params.temperature = { enabled: true, value: 0.3 };

    expect(await generationHash(left)).toBe(await generationHash(right));
    expect(await generationHash(left)).toMatch(/^[0-9a-f]{64}$/);
    expect(stableStringify({ b: 1, a: 2 })).toBe('{"a":2,"b":1}');
  });

  it('参数、附加参数或 stream 变化产生不同哈希', async () => {
    const base = deepseek();
    const baseHash = await generationHash(base);

    const temperature = deepseek();
    temperature.params.temperature = { enabled: true, value: 0.3 };
    expect(await generationHash(temperature)).not.toBe(baseHash);

    const maxTokens = deepseek();
    maxTokens.params.maxTokens = { enabled: true, field: 'max_completion_tokens', value: 64 };
    expect(await generationHash(maxTokens)).not.toBe(baseHash);

    const reasoning = deepseek();
    reasoning.params.reasoning.value = 'medium';
    expect(await generationHash(reasoning)).not.toBe(baseHash);

    const extra = deepseek();
    extra.params.extra = [{ path: 'stream_options.include_usage', type: 'boolean', value: 'true', enabled: true }];
    expect(await generationHash(extra)).not.toBe(baseHash);

    const nonStream = deepseek();
    nonStream.endpoint.stream = false;
    expect(await generationHash(nonStream)).not.toBe(baseHash);
  });

  it('密钥、请求头、模型与认证方式不进入生成参数哈希', async () => {
    const base = deepseek();
    const changed = deepseek();
    changed.apiKey = 'sk-secret';
    changed.headers = [{ name: 'X-Title', value: 'SimpleTrans' }];
    changed.auth = { type: 'header', headerName: 'api-key', prefix: 'Bearer' };
    changed.model = 'another-model';
    expect(await generationHash(changed)).toBe(await generationHash(base));
  });

  it('buildLLMProfile 一次返回 endpoint 指纹与生成参数哈希', async () => {
    const profile = await buildLLMProfile(custom());
    expect(profile.endpointFingerprint).toBe(
      'https://gw.example.com/openai/chat/completions?a=1&b=2'
    );
    expect(profile.generationHash).toMatch(/^[0-9a-f]{64}$/);
  });
});
