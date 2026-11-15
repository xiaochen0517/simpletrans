/**
 * A1 控制面测试
 *
 * 覆盖 ST_LIST_ENGINES 与 ST_TEST_ENGINE；A3 用 vi.mock 隔离，不联网。
 */

import { beforeEach, describe, expect, it, vi } from 'vitest';

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
    TranslateError,
    isSupportedTargetLang: (lang) => lang === 'zh',
    SUPPORTED_TARGET_LANGS: ['zh'],
  };
});

import { installChrome } from '../helpers/load.js';
import {
  ERROR_CODES,
  FAILURE_REASONS,
  MESSAGE_TYPES,
} from '../../src/shared/protocol.js';
import { getOrCreateDefaultInstance, removeKey, writeKey } from '../../src/shared/config/instances.js';
import { handleMessage } from '../../src/background/router.js';
import { translate, TranslateError } from '../../src/shared/translate/adapter.js';

let instance;
let sender;

beforeEach(async () => {
  installChrome();
  sender = { id: chrome.runtime.id };
  translate.mockReset();
  translate.mockResolvedValue({ text: '你好', usage: { totalTokens: 3 } });

  instance = await getOrCreateDefaultInstance();
  await writeKey(instance.id, 'sk-test');
});

describe('A1 控制面：消息与发送方', () => {
  it('拒绝来自扩展外部的消息', async () => {
    const response = await handleMessage({ type: MESSAGE_TYPES.LIST_ENGINES }, { id: 'other' });
    expect(response.ok).toBe(false);
    expect(response.error.code).toBe(ERROR_CODES.OTHER);
  });

  it('未知消息与已声明但未实现的消息分别提示', async () => {
    const unknown = await handleMessage({ type: 'ST_NOPE' }, sender);
    expect(unknown.ok).toBe(false);
    expect(unknown.error.reason).toBe(FAILURE_REASONS.INVALID_MESSAGE);

    const deferred = await handleMessage({ type: MESSAGE_TYPES.START }, sender);
    expect(deferred.ok).toBe(false);
    expect(deferred.error.message).toContain('暂未实现');
  });
});

describe('A1 控制面：ST_LIST_ENGINES', () => {
  it('返回实例与 hasKey，不含密钥、apiKey 与 baseUrl', async () => {
    const response = await handleMessage({ type: MESSAGE_TYPES.LIST_ENGINES }, sender);

    expect(response.ok).toBe(true);
    expect(response.data.instances).toHaveLength(1);
    expect(response.data.instances[0]).toMatchObject({
      id: instance.id,
      type: 'deepseek',
      hasKey: true,
    });
    expect(response.data.instances[0]).not.toHaveProperty('apiKey');
    expect(response.data.instances[0]).not.toHaveProperty('baseUrl');

    const serialized = JSON.stringify(response);
    expect(serialized).not.toContain('sk-test');
    expect(serialized).not.toContain('apiKey');
    expect(serialized).not.toContain('baseUrl');
  });

  it('未配置密钥时 hasKey 为 false', async () => {
    await removeKey(instance.id);
    const response = await handleMessage({ type: MESSAGE_TYPES.LIST_ENGINES }, sender);
    expect(response.ok).toBe(true);
    expect(response.data.instances[0].hasKey).toBe(false);
  });

  it('首次列表会创建默认实例', async () => {
    await chrome.storage.sync.remove('engineInstances');
    const response = await handleMessage({ type: MESSAGE_TYPES.LIST_ENGINES }, sender);
    expect(response.ok).toBe(true);
    expect(response.data.instances).toHaveLength(1);
    expect(response.data.instances[0].id).toBe(instance.id);
  });
});

describe('A1 控制面：ST_TEST_ENGINE', () => {
  it('成功返回译文、耗时与用量，且调用 A3 时带上密钥', async () => {
    const response = await handleMessage(
      { type: MESSAGE_TYPES.TEST_ENGINE, payload: { text: 'Hello world' } },
      sender
    );

    expect(response.ok).toBe(true);
    expect(response.data.text).toBe('你好');
    expect(typeof response.data.elapsedMs).toBe('number');
    expect(response.data.elapsedMs).toBeGreaterThanOrEqual(0);
    expect(response.data.usage).toEqual({ totalTokens: 3 });

    expect(translate).toHaveBeenCalledTimes(1);
    expect(translate.mock.calls[0][0]).toMatchObject({
      text: 'Hello world',
      targetLang: 'zh',
      instance: { apiKey: 'sk-test' },
    });
  });

  it('缺密钥返回 CONFIG，不调用上游', async () => {
    await removeKey(instance.id);
    const response = await handleMessage(
      { type: MESSAGE_TYPES.TEST_ENGINE, payload: { text: 'hi' } },
      sender
    );

    expect(response.ok).toBe(false);
    expect(response.error.code).toBe(ERROR_CODES.CONFIG);
    expect(translate).not.toHaveBeenCalled();
  });

  it('空文本、超长、禁止字段与不支持语言都在调用上游前拒绝', async () => {
    const empty = await handleMessage(
      { type: MESSAGE_TYPES.TEST_ENGINE, payload: { text: '   ' } },
      sender
    );
    expect(empty.ok).toBe(false);
    expect(empty.error.reason).toBe(FAILURE_REASONS.EMPTY_TEXT);

    const tooLong = await handleMessage(
      { type: MESSAGE_TYPES.TEST_ENGINE, payload: { text: 'x'.repeat(4001) } },
      sender
    );
    expect(tooLong.ok).toBe(false);
    expect(tooLong.error.reason).toBe(FAILURE_REASONS.TEXT_TOO_LONG);

    const forbidden = await handleMessage(
      { type: MESSAGE_TYPES.TEST_ENGINE, payload: { text: 'hi', apiKey: 'sk-x' } },
      sender
    );
    expect(forbidden.ok).toBe(false);
    expect(forbidden.error.reason).toBe(FAILURE_REASONS.FORBIDDEN_FIELD);

    const language = await handleMessage(
      { type: MESSAGE_TYPES.TEST_ENGINE, payload: { text: 'hi', targetLang: 'ja' } },
      sender
    );
    expect(language.ok).toBe(false);
    expect(language.error.reason).toBe(FAILURE_REASONS.UNSUPPORTED_LANG);

    expect(translate).not.toHaveBeenCalled();
  });

  it('上游错误码原样回传给设置页', async () => {
    translate.mockRejectedValue(new TranslateError(ERROR_CODES.AUTH, '密钥无效或鉴权失败'));
    const response = await handleMessage(
      { type: MESSAGE_TYPES.TEST_ENGINE, payload: { text: 'hi' } },
      sender
    );

    expect(response.ok).toBe(false);
    expect(response.error.code).toBe(ERROR_CODES.AUTH);
    expect(response.error.message).toBe('密钥无效或鉴权失败');
  });
});
