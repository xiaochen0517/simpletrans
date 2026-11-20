/**
 * A5 快速翻译测试
 *
 * 覆盖实例解析、参数校验、OpenAI 快速提示词与 quick 模式、百度不传提示词、
 * 快速提示词缺失/非法回退、错误映射与响应字段；A3 用 vi.mock 隔离，不联网。
 */

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

vi.mock('../../src/shared/translate/adapter.js', () => {
  class TranslateError extends Error {
    constructor(code, message) {
      super(message);
      this.name = 'TranslateError';
      this.code = code;
    }
  }
  return {
    translate: vi.fn(),
    translateBatch: vi.fn(),
    TranslateError,
  };
});

import { installChrome } from '../helpers/load.js';
import { ERROR_CODES, FAILURE_REASONS } from '../../src/shared/protocol.js';
import { BAIDU_TIMEOUT_MS } from '../../src/shared/constants.js';
import {
  createInstance,
  getOrCreateDefaultInstance,
  quickPromptKey,
  updateInstance,
  writeCredentials,
  writeKey,
} from '../../src/shared/config/instances.js';
import { DEFAULT_QUICK_PROMPT } from '../../src/shared/config/registry.js';
import { saveSettings } from '../../src/shared/settings.js';
import { resetLogging } from '../../src/shared/log/logger.js';
import { quickTranslate } from '../../src/background/quick.js';
import { translate, TranslateError } from '../../src/shared/translate/adapter.js';

/** 默认 OpenAI 实例。 */
let instance;

beforeEach(async () => {
  installChrome();
  translate.mockReset();
  translate.mockResolvedValue({ text: '你好', usage: { totalTokens: 5 } });
  instance = await getOrCreateDefaultInstance();
  await writeKey(instance.id, 'sk-test');
});

afterEach(() => {
  resetLogging();
  vi.restoreAllMocks();
});

describe('A5 快速翻译：参数与实例', () => {
  it('扩展停用、空文本、超长与不支持的目标语言分别返回错误', async () => {
    const disabled = await quickTranslate({ text: 'hello', instanceId: instance.id });
    expect(disabled.ok).toBe(true);

    await saveSettings({ enabled: false });
    const stop = await quickTranslate({ text: 'hello', instanceId: instance.id });
    expect(stop.ok).toBe(false);
    expect(stop.error.code).toBe(ERROR_CODES.CONFIG);
    await saveSettings({ enabled: true });

    const empty = await quickTranslate({ text: '   ', instanceId: instance.id });
    expect(empty.error.reason).toBe(FAILURE_REASONS.EMPTY_TEXT);

    const long = await quickTranslate({ text: 'x'.repeat(4001), instanceId: instance.id });
    expect(long.error.reason).toBe(FAILURE_REASONS.TEXT_TOO_LONG);

    const lang = await quickTranslate({ text: 'hello', targetLang: 'xx', instanceId: instance.id });
    expect(lang.error.reason).toBe(FAILURE_REASONS.UNSUPPORTED_LANG);
  });

  it('拒绝不存在、未启用与缺少凭据的实例', async () => {
    const missing = await quickTranslate({ text: 'hello', instanceId: 'inst-nope' });
    expect(missing.ok).toBe(false);
    expect(missing.error.code).toBe(ERROR_CODES.CONFIG);
    expect(missing.error.message).toContain('实例不存在');

    await updateInstance(instance.id, { enabled: false });
    const disabled = await quickTranslate({ text: 'hello', instanceId: instance.id });
    expect(disabled.error.message).toContain('已停用');
    await updateInstance(instance.id, { enabled: true });

    await chrome.storage.local.remove(`engineKey:${instance.id}`);
    const noKey = await quickTranslate({ text: 'hello', instanceId: instance.id });
    expect(noKey.error.message).toContain('缺少密钥');
  });

  it('未传 instanceId 时使用当前实例', async () => {
    await saveSettings({ activeInstanceId: instance.id });
    const response = await quickTranslate({ text: 'hello' });
    expect(response.ok).toBe(true);
    expect(response.data.engine.id).toBe(instance.id);
  });

  it('拒绝禁止字段与非法实例标识', async () => {
    const forbidden = await quickTranslate({
      text: 'hello',
      instanceId: instance.id,
      apiKey: 'sk-x',
    });
    expect(forbidden.error.reason).toBe(FAILURE_REASONS.FORBIDDEN_FIELD);

    const invalid = await quickTranslate({ text: 'hello', instanceId: 42 });
    expect(invalid.error.reason).toBe(FAILURE_REASONS.INVALID_MESSAGE);
  });
});

describe('A5 快速翻译：提示词与模式', () => {
  it('OpenAI 实例使用实例快速提示词并以 quick 模式调用', async () => {
    const prompt = '快速模板 {{targetLang}} {{outputFormat}}';
    await updateInstance(instance.id, { quickPrompt: prompt });

    const response = await quickTranslate({
      text: 'hello',
      targetLang: 'zh',
      instanceId: instance.id,
    });

    expect(response.ok).toBe(true);
    expect(response.data).toMatchObject({ text: '你好', targetLang: 'zh', chars: 5 });
    expect(translate).toHaveBeenCalledTimes(1);
    const args = translate.mock.calls[0][0];
    expect(args.mode).toBe('quick');
    expect(args.targetLang).toBe('zh');
    expect(args.text).toBe('hello');
    expect(args.instance.systemPrompt).toBe(prompt);
    expect(args.timeoutMs).toBe(120_000);
  });

  it('未保存快速提示词时使用默认模板', async () => {
    await quickTranslate({ text: 'hello', targetLang: 'zh', instanceId: instance.id });
    expect(translate.mock.calls[0][0].instance.systemPrompt).toBe(DEFAULT_QUICK_PROMPT);
  });

  it('快速提示词非法时回退默认模板，不阻塞翻译', async () => {
    await chrome.storage.local.set({ [quickPromptKey(instance.id)]: '没有占位符' });

    const response = await quickTranslate({ text: 'hello', instanceId: instance.id });
    expect(response.ok).toBe(true);
    expect(translate.mock.calls[0][0].instance.systemPrompt).toBe(DEFAULT_QUICK_PROMPT);
  });

  it('百度实例不使用提示词，按百度单段超时调用', async () => {
    const baidu = await createInstance({ type: 'baidu', name: '百度' });
    await writeCredentials(baidu.id, { appId: 'app', secretKey: 'secret' });

    const response = await quickTranslate({
      text: 'hello',
      targetLang: 'zh',
      instanceId: baidu.id,
    });

    expect(response.ok).toBe(true);
    const args = translate.mock.calls[0][0];
    expect(args.mode).toBe('single');
    expect(args.instance.systemPrompt).toBeUndefined();
    expect(args.timeoutMs).toBe(BAIDU_TIMEOUT_MS.single);
    expect(response.data.engine.type).toBe('baidu');
    expect(response.data.engine.kind).toBe('traditional');
  });

  it('上游错误按统一错误码返回', async () => {
    translate.mockRejectedValue(new TranslateError(ERROR_CODES.AUTH, '鉴权失败'));
    const response = await quickTranslate({ text: 'hello', instanceId: instance.id });
    expect(response.ok).toBe(false);
    expect(response.error).toMatchObject({ code: ERROR_CODES.AUTH, message: '鉴权失败' });
  });
});
