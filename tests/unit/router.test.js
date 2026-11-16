/**
 * A1 控制面测试
 *
 * 覆盖 ST_LIST_ENGINES 与 ST_TEST_ENGINE；A3 用 vi.mock 隔离，不联网。
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
    TranslateError,
    isSupportedTargetLang: (lang) => lang === 'zh',
    SUPPORTED_TARGET_LANGS: ['zh'],
    PROMPT_VERSION: 1,
  };
});

vi.mock('../../src/shared/cache/store.js', () => {
  const state = {
    statsResult: null,
    clearResult: null,
    statsError: null,
    clearError: null,
  };

  const store = {
    stats: vi.fn(async () => {
      if (state.statsError) throw state.statsError;
      return state.statsResult;
    }),
    clear: vi.fn(async () => {
      if (state.clearError) throw state.clearError;
      return state.clearResult;
    }),
    getMany: vi.fn(async () => new Map()),
    set: vi.fn(async () => ({ written: false, bytes: 0 })),
    generation: vi.fn(() => 0),
    get: vi.fn(async () => null),
    close: vi.fn(async () => {}),
  };

  return {
    getCacheStore: () => store,
    createCacheStore: () => store,
    __cache: { state, store },
  };
});

import { installChrome } from '../helpers/load.js';
import {
  ERROR_CODES,
  FAILURE_REASONS,
  MESSAGE_TYPES,
} from '../../src/shared/protocol.js';
import { MAX_PAGE_PARAGRAPHS } from '../../src/shared/constants.js';
import { initLogging, resetLogging } from '../../src/shared/log/logger.js';
import { getOrCreateDefaultInstance, removeKey, updateInstance, writeKey } from '../../src/shared/config/instances.js';
import { saveSettings } from '../../src/shared/settings.js';
import { handleMessage, receivePageSubmit, sendToTab } from '../../src/background/router.js';
import { translate, TranslateError } from '../../src/shared/translate/adapter.js';
import { __cache } from '../../src/shared/cache/store.js';

let instance;
let sender;

beforeEach(async () => {
  installChrome();
  sender = { id: chrome.runtime.id };
  translate.mockReset();
  translate.mockResolvedValue({ text: '你好', usage: { totalTokens: 3 } });

  __cache.state.statsResult = {
    entries: 1234,
    bytes: 12582912,
    maxBytes: 1073741824,
    maxEntries: 1000000,
  };
  __cache.state.clearResult = { cleared: 1234, freedBytes: 12582912 };
  __cache.state.statsError = null;
  __cache.state.clearError = null;
  __cache.store.stats.mockClear();
  __cache.store.clear.mockClear();
  __cache.store.getMany.mockClear();
  __cache.store.set.mockClear();

  instance = await getOrCreateDefaultInstance();
  await writeKey(instance.id, 'sk-test');
});

afterEach(() => {
  resetLogging();
  vi.restoreAllMocks();
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
  it('返回完整实例参数与 hasKey，不含密钥、apiKey 与 baseUrl', async () => {
    const response = await handleMessage({ type: MESSAGE_TYPES.LIST_ENGINES }, sender);

    expect(response.ok).toBe(true);
    expect(response.data.instances).toHaveLength(1);
    expect(response.data.instances[0]).toMatchObject({
      id: instance.id,
      type: 'deepseek',
      hasKey: true,
      model: 'deepseek-chat',
      reasoningEffort: 'off',
      batchSize: 8,
      batchMaxChars: 1000,
      maxConcurrency: 4,
    });
    expect(response.data.instances[0].systemPrompt).toContain('{{targetLang}}');
    expect(response.data.instances[0].systemPrompt).toContain('{{outputFormat}}');
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

  it('返回保存后的实例参数', async () => {
    await updateInstance(instance.id, {
      model: 'deepseek-v4-pro',
      reasoningEffort: 'high',
      batchSize: 2,
      batchMaxChars: 300,
      maxConcurrency: 1,
      systemPrompt: '自定义 {{targetLang}} {{outputFormat}}',
    });

    const response = await handleMessage({ type: MESSAGE_TYPES.LIST_ENGINES }, sender);
    expect(response.data.instances[0]).toMatchObject({
      model: 'deepseek-v4-pro',
      reasoningEffort: 'high',
      batchSize: 2,
      batchMaxChars: 300,
      maxConcurrency: 1,
      systemPrompt: '自定义 {{targetLang}} {{outputFormat}}',
    });
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
    // ST_TEST_ENGINE 不查缓存、不写缓存。
    expect(__cache.store.getMany).not.toHaveBeenCalled();
    expect(__cache.store.set).not.toHaveBeenCalled();
  });

  it('使用保存后的实例参数，不使用未保存草稿', async () => {
    const prompt = '用书面语翻译成{{targetLang}}。{{outputFormat}}';
    await updateInstance(instance.id, {
      model: 'deepseek-v4-pro',
      reasoningEffort: 'low',
      systemPrompt: prompt,
    });

    const response = await handleMessage(
      { type: MESSAGE_TYPES.TEST_ENGINE, payload: { text: 'Hello' } },
      sender
    );

    expect(response.ok).toBe(true);
    expect(translate.mock.calls[0][0].instance).toMatchObject({
      model: 'deepseek-v4-pro',
      reasoningEffort: 'low',
      systemPrompt: prompt,
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

describe('A1 控制面：缓存消息（P5）', () => {
  it('ST_CACHE_STATS 返回条数、字节与上限', async () => {
    const response = await handleMessage(
      { type: MESSAGE_TYPES.CACHE_STATS, payload: {} },
      sender
    );

    expect(response).toEqual({
      ok: true,
      data: {
        entries: 1234,
        bytes: 12582912,
        maxBytes: 1073741824,
        maxEntries: 1000000,
      },
    });
    expect(__cache.store.stats).toHaveBeenCalledTimes(1);
  });

  it('ST_CACHE_STATS 读取异常归为 OTHER，不抛出', async () => {
    __cache.state.statsError = new Error('IndexedDB open failed');

    const response = await handleMessage({ type: MESSAGE_TYPES.CACHE_STATS }, sender);

    expect(response.ok).toBe(false);
    expect(response.error.code).toBe(ERROR_CODES.OTHER);
    expect(response.error.message).toContain('读取缓存占用失败');
    expect(response.error).not.toHaveProperty('data');
  });

  it('ST_CLEAR_CACHE 返回清空条数与释放字节', async () => {
    const response = await handleMessage(
      { type: MESSAGE_TYPES.CLEAR_CACHE, payload: {} },
      sender
    );

    expect(response).toEqual({
      ok: true,
      data: { cleared: 1234, freedBytes: 12582912 },
    });
    expect(__cache.store.clear).toHaveBeenCalledTimes(1);
  });

  it('ST_CLEAR_CACHE 存储异常归为 OTHER', async () => {
    __cache.state.clearError = new Error('transaction aborted');

    const response = await handleMessage({ type: MESSAGE_TYPES.CLEAR_CACHE }, sender);

    expect(response.ok).toBe(false);
    expect(response.error.code).toBe(ERROR_CODES.OTHER);
    expect(response.error.message).toContain('清空缓存失败');
  });

  it('外部发送方的缓存消息被拒绝且不访问存储', async () => {
    const stats = await handleMessage({ type: MESSAGE_TYPES.CACHE_STATS }, { id: 'other' });
    const clear = await handleMessage({ type: MESSAGE_TYPES.CLEAR_CACHE }, { id: 'other' });

    for (const response of [stats, clear]) {
      expect(response.ok).toBe(false);
      expect(response.error.code).toBe(ERROR_CODES.OTHER);
    }
    expect(__cache.store.stats).not.toHaveBeenCalled();
    expect(__cache.store.clear).not.toHaveBeenCalled();
  });
});

describe('A1 标签页转发与按需注入', () => {
  const message = { type: MESSAGE_TYPES.TOGGLE, payload: { traceId: 't-1' } };
  const noReceiver = new Error(
    'Could not establish connection. Receiving end does not exist.'
  );

  it('页面已就绪时直接发送，不注入', async () => {
    chrome.tabs.__response = { ok: true, data: { action: 'submitted' } };

    const result = await sendToTab(7, message);

    expect(result).toEqual({ ok: true, data: { action: 'submitted' } });
    expect(chrome.tabs.__sent).toHaveLength(1);
    expect(chrome.tabs.__sent[0]).toMatchObject({ tabId: 7, message });
    expect(chrome.scripting.__calls).toEqual([]);
  });

  it('没有接收方时先注入样式再注入脚本，然后重发', async () => {
    chrome.tabs.__sendQueue = [
      { error: noReceiver },
      { response: { ok: true, data: { action: 'submitted' } } },
    ];

    const result = await sendToTab(9, message);

    expect(result.ok).toBe(true);
    expect(chrome.scripting.__calls.map((call) => call.api)).toEqual([
      'insertCSS',
      'executeScript',
    ]);
    expect(chrome.scripting.__calls[0].details).toEqual({
      target: { tabId: 9 },
      files: ['content.css'],
    });
    expect(chrome.scripting.__calls[1].details).toEqual({
      target: { tabId: 9 },
      files: ['content.js'],
    });
    expect(chrome.tabs.__sent).toHaveLength(2);
  });

  it('注入失败时返回 INJECTION_FAILED，不再重发', async () => {
    chrome.tabs.__sendQueue = [{ error: noReceiver }];
    chrome.scripting.__error = new Error('Cannot access a chrome:// URL');

    const result = await sendToTab(3, message);

    expect(result.ok).toBe(false);
    expect(result.error.reason).toBe(FAILURE_REASONS.INJECTION_FAILED);
    expect(chrome.scripting.__calls.map((call) => call.api)).toEqual(['insertCSS']);
    expect(chrome.tabs.__sent).toHaveLength(1);
  });

  it('注入后仍然没有接收方时返回 NO_RECEIVER', async () => {
    chrome.tabs.__sendQueue = [{ error: noReceiver }, { error: noReceiver }];

    const result = await sendToTab(4, message);

    expect(result.ok).toBe(false);
    expect(result.error.reason).toBe(FAILURE_REASONS.NO_RECEIVER);
    expect(chrome.scripting.__calls).toHaveLength(2);
  });

  it('非「没有接收方」的通信错误不注入', async () => {
    chrome.tabs.__sendQueue = [{ error: new Error('boom') }];

    const result = await sendToTab(5, message);

    expect(result.ok).toBe(false);
    expect(result.error.reason).toBe(FAILURE_REASONS.NO_RECEIVER);
    expect(chrome.scripting.__calls).toEqual([]);
  });

  it('缺少标签页 id 时返回 NO_ACTIVE_TAB', async () => {
    const result = await sendToTab(undefined, message);
    expect(result.ok).toBe(false);
    expect(result.error.reason).toBe(FAILURE_REASONS.NO_ACTIVE_TAB);
    expect(chrome.tabs.__sent).toEqual([]);
  });
});

describe('A1 控制面：ST_ROUTE（P6.1）', () => {
  /**
   * @param {object} payload
   * @returns {Promise<object>}
   */
  function route(payload) {
    return handleMessage({ type: MESSAGE_TYPES.ROUTE, payload }, sender);
  }

  it('start 读取设置与活动标签页，向页面发 ST_START 并原样返回页面响应', async () => {
    const pageResponse = { ok: true, data: { phase: 'submitted', total: 3 } };
    chrome.tabs.__response = pageResponse;

    const response = await route({ command: 'start', traceId: 't-route-1' });

    expect(response).toEqual(pageResponse);
    expect(chrome.tabs.__sent).toHaveLength(1);
    expect(chrome.tabs.__sent[0]).toEqual({
      tabId: 1,
      message: {
        type: MESSAGE_TYPES.START,
        payload: {
          targetLang: 'zh',
          traceId: 't-route-1',
        },
      },
    });
    // P6.1 页面侧不建批，ST_START 不再携带 batch。
    expect(chrome.tabs.__sent[0].message.payload).not.toHaveProperty('batch');
    expect(chrome.scripting.__calls).toEqual([]);
  });

  it('start 没有 traceId 时载荷只有 targetLang', async () => {
    chrome.tabs.__response = { ok: true, data: { phase: 'idle', total: 0 } };

    await route({ command: 'start' });

    expect(chrome.tabs.__sent[0].message.payload).toEqual({ targetLang: 'zh' });
    expect(chrome.tabs.__sent[0].message.payload).not.toHaveProperty('batch');
  });

  it('clear 向页面发 ST_CLEAR 并返回清除结果', async () => {
    const pageResponse = { ok: true, data: { removed: 3 } };
    chrome.tabs.__response = pageResponse;

    const response = await route({ command: 'clear', traceId: 't-route-clear' });

    expect(response).toEqual(pageResponse);
    expect(chrome.tabs.__sent).toHaveLength(1);
    expect(chrome.tabs.__sent[0]).toEqual({
      tabId: 1,
      message: { type: MESSAGE_TYPES.CLEAR, payload: { traceId: 't-route-clear' } },
    });
  });

  it('未知命令返回 OTHER / INVALID_MESSAGE，不查询标签页也不发送', async () => {
    const query = vi.spyOn(chrome.tabs, 'query');

    const response = await route({ command: 'pause' });

    expect(response.ok).toBe(false);
    expect(response.error.code).toBe(ERROR_CODES.OTHER);
    expect(response.error.reason).toBe(FAILURE_REASONS.INVALID_MESSAGE);
    expect(query).not.toHaveBeenCalled();
    expect(chrome.tabs.__sent).toEqual([]);
  });

  it('扩展停用时返回 CONFIG「扩展已停用」，不发送命令', async () => {
    await saveSettings({ enabled: false });

    const response = await route({ command: 'start' });

    expect(response).toEqual({
      ok: false,
      error: { code: ERROR_CODES.CONFIG, message: '扩展已停用' },
    });
    expect(chrome.tabs.__sent).toEqual([]);
  });

  it('没有活动标签页时返回 OTHER / NO_ACTIVE_TAB', async () => {
    chrome.tabs.__queryResult = [];

    const response = await route({ command: 'start' });

    expect(response.ok).toBe(false);
    expect(response.error.code).toBe(ERROR_CODES.OTHER);
    expect(response.error.reason).toBe(FAILURE_REASONS.NO_ACTIVE_TAB);
    expect(chrome.tabs.__sent).toEqual([]);
  });

  it('页面的 ok:false 错误码原样返回', async () => {
    chrome.tabs.__response = {
      ok: false,
      error: { code: ERROR_CODES.CONFIG, message: '缺少密钥，请先在设置页保存密钥' },
    };

    const response = await route({ command: 'start' });

    expect(response).toEqual({
      ok: false,
      error: { code: ERROR_CODES.CONFIG, message: '缺少密钥，请先在设置页保存密钥' },
    });
  });

  it('页面未注入时先 insertCSS 再 executeScript 后重发一次', async () => {
    const noReceiver = new Error(
      'Could not establish connection. Receiving end does not exist.'
    );
    chrome.tabs.__sendQueue = [
      { error: noReceiver },
      { response: { ok: true, data: { phase: 'submitted', total: 1 } } },
    ];

    const response = await route({ command: 'start' });

    expect(response.ok).toBe(true);
    expect(chrome.scripting.__calls.map((call) => call.api)).toEqual([
      'insertCSS',
      'executeScript',
    ]);
    expect(chrome.tabs.__sent).toHaveLength(2);
    expect(chrome.tabs.__sent[1].message.type).toBe(MESSAGE_TYPES.START);
  });

  it('注入失败时返回 INJECTION_FAILED', async () => {
    chrome.tabs.__sendQueue = [
      {
        error: new Error('Could not establish connection. Receiving end does not exist.'),
      },
    ];
    chrome.scripting.__error = new Error('Cannot access a chrome:// URL');

    const response = await route({ command: 'start' });

    expect(response.ok).toBe(false);
    expect(response.error.reason).toBe(FAILURE_REASONS.INJECTION_FAILED);
    expect(chrome.tabs.__sent).toHaveLength(1);
  });

  it('注入后仍无接收方时返回 NO_RECEIVER', async () => {
    const noReceiver = new Error(
      'Could not establish connection. Receiving end does not exist.'
    );
    chrome.tabs.__sendQueue = [{ error: noReceiver }, { error: noReceiver }];

    const response = await route({ command: 'clear' });

    expect(response.ok).toBe(false);
    expect(response.error.reason).toBe(FAILURE_REASONS.NO_RECEIVER);
    expect(chrome.scripting.__calls).toHaveLength(2);
  });

  it('扩展外部发送方的 ST_ROUTE 被拒绝且不访问标签页', async () => {
    const response = await handleMessage(
      { type: MESSAGE_TYPES.ROUTE, payload: { command: 'start' } },
      { id: 'other' }
    );

    expect(response.ok).toBe(false);
    expect(response.error.code).toBe(ERROR_CODES.OTHER);
    expect(chrome.tabs.__sent).toEqual([]);
  });

  it('读取设置失败返回 CONFIG 且不发送命令', async () => {
    const originalGet = chrome.storage.sync.get.bind(chrome.storage.sync);
    chrome.storage.sync.get = async (keys) => {
      if (keys === 'settings') throw new Error('storage unavailable');
      return originalGet(keys);
    };

    const response = await route({ command: 'start' });

    expect(response).toEqual({
      ok: false,
      error: { code: ERROR_CODES.CONFIG, message: '读取设置失败' },
    });
    expect(chrome.tabs.__sent).toEqual([]);
  });
});

describe('A1 控制面：ST_PAGE_SUBMIT（P6.1）', () => {
  /**
   * 一条合法的整页提交载荷。
   * @returns {object}
   */
  function validPayload() {
    return {
      requestId: 's-1',
      traceId: 't-recv',
      scope: 'page',
      targetLang: 'zh',
      domain: 'example.com',
      viewport: { width: 1280, height: 800 },
      paragraphs: [
        { index: 0, hostId: 'h1', text: 'Hello' },
        { index: 1, hostId: 'h2', text: 'World' },
      ],
    };
  }

  /**
   * @param {unknown} payload
   * @param {{ id?: string, tab?: { id?: number } }} [from]
   * @returns {Promise<object>}
   */
  function submitPage(payload, from = sender) {
    return handleMessage({ type: MESSAGE_TYPES.PAGE_SUBMIT, payload }, from);
  }

  it('合法提交回执 accepted 与段数/字符数，不查缓存、不调用上游', async () => {
    const response = await submitPage(validPayload());

    expect(response).toEqual({
      ok: true,
      data: {
        accepted: true,
        requestId: 's-1',
        scope: 'page',
        paragraphs: 2,
        chars: 10,
      },
    });
    expect(translate).not.toHaveBeenCalled();
    expect(__cache.store.getMany).not.toHaveBeenCalled();
    expect(__cache.store.set).not.toHaveBeenCalled();
    expect(__cache.store.stats).not.toHaveBeenCalled();
    expect(__cache.store.clear).not.toHaveBeenCalled();
  });

  it('receivePageSubmit 已导出，可直接校验与回执', () => {
    const response = receivePageSubmit(validPayload(), { tab: { id: 7 } }, 't-direct');

    expect(response).toEqual({
      ok: true,
      data: {
        accepted: true,
        requestId: 's-1',
        scope: 'page',
        paragraphs: 2,
        chars: 10,
      },
    });
  });

  it('scope 缺省为 page；scope=single 时只接受 1 段', async () => {
    const page = await submitPage({ paragraphs: [{ text: 'Hi' }] });
    expect(page.ok).toBe(true);
    expect(page.data.scope).toBe('page');
    expect(page.data.requestId).toBe(null);

    const single = await submitPage({
      scope: 'single',
      requestId: 's-single',
      paragraphs: [{ index: 0, hostId: 'h1', text: 'Hi' }],
    });
    expect(single).toEqual({
      ok: true,
      data: {
        accepted: true,
        requestId: 's-single',
        scope: 'single',
        paragraphs: 1,
        chars: 2,
      },
    });

    const tooMany = await submitPage({
      scope: 'single',
      paragraphs: [{ text: 'One' }, { text: 'Two' }],
    });
    expect(tooMany.ok).toBe(false);
    expect(tooMany.error.reason).toBe(FAILURE_REASONS.INVALID_ITEMS);
  });

  it('scope 非法或 requestId 非法时返回 INVALID_MESSAGE', async () => {
    const badScope = await submitPage({ scope: 'other', paragraphs: [{ text: 'Hi' }] });
    expect(badScope.ok).toBe(false);
    expect(badScope.error.reason).toBe(FAILURE_REASONS.INVALID_MESSAGE);

    for (const requestId of [123, 's'.repeat(65)]) {
      const badId = await submitPage({ requestId, paragraphs: [{ text: 'Hi' }] });
      expect(badId.ok).toBe(false);
      expect(badId.error.reason).toBe(FAILURE_REASONS.INVALID_MESSAGE);
    }
  });

  it('hostId 恰好 64 字符时接受', async () => {
    const response = await submitPage({
      paragraphs: [
        {
          text: 'Hi',
          hostId: 'h'.repeat(64),
        },
      ],
    });

    expect(response).toEqual({
      ok: true,
      data: {
        accepted: true,
        requestId: null,
        scope: 'page',
        paragraphs: 1,
        chars: 2,
      },
    });
  });

  it('载荷不是对象时返回 INVALID_MESSAGE', async () => {
    for (const payload of [null, 'text', 42, []]) {
      const response = await submitPage(payload);
      expect(response.ok).toBe(false);
      expect(response.error.code).toBe(ERROR_CODES.OTHER);
      expect(response.error.reason).toBe(FAILURE_REASONS.INVALID_MESSAGE);
    }
  });

  it('paragraphs 不是数组或为空时返回 INVALID_ITEMS', async () => {
    for (const payload of [
      {},
      { paragraphs: undefined },
      { paragraphs: 'x' },
      { paragraphs: {} },
      { paragraphs: [] },
    ]) {
      const response = await submitPage(payload);
      expect(response.ok).toBe(false);
      expect(response.error.reason).toBe(FAILURE_REASONS.INVALID_ITEMS);
    }
  });

  it('超过 5000 段返回 INVALID_ITEMS（需求 3.5）', async () => {
    const paragraphs = Array.from({ length: MAX_PAGE_PARAGRAPHS + 1 }, (_, index) => ({
      text: `T ${index}`,
    }));

    const response = await submitPage({ paragraphs });

    expect(response.ok).toBe(false);
    expect(response.error.reason).toBe(FAILURE_REASONS.INVALID_ITEMS);
  });

  it('每段 text 必须为非空字符串，否则返回 EMPTY_TEXT', async () => {
    for (const text of ['', '   ', 123, null, undefined]) {
      const response = await submitPage({ paragraphs: [{ text }] });
      expect(response.ok).toBe(false);
      expect(response.error.reason).toBe(FAILURE_REASONS.EMPTY_TEXT);
    }
  });

  it('段落里的 context 字段被忽略，不报错也不影响回执', async () => {
    const response = await submitPage({
      paragraphs: [
        { text: 'Hi', context: 'c'.repeat(500) },
        { text: 'Yo', context: 123 },
      ],
    });

    expect(response).toEqual({
      ok: true,
      data: {
        accepted: true,
        requestId: null,
        scope: 'page',
        paragraphs: 2,
        chars: 4,
      },
    });
  });

  it('hostId 不是字符串或超过 64 字符返回 INVALID_ITEMS', async () => {
    for (const hostId of [123, 'h'.repeat(65)]) {
      const response = await submitPage({ paragraphs: [{ text: 'Hi', hostId }] });
      expect(response.ok).toBe(false);
      expect(response.error.reason).toBe(FAILURE_REASONS.INVALID_ITEMS);
    }
  });

  it('禁止字段（含嵌套）返回 FORBIDDEN_FIELD', async () => {
    const topLevel = await submitPage({ ...validPayload(), apiKey: 'sk-x' });
    expect(topLevel.ok).toBe(false);
    expect(topLevel.error.reason).toBe(FAILURE_REASONS.FORBIDDEN_FIELD);

    const nested = await submitPage({
      paragraphs: [{ text: 'Hi', model: 'deepseek-chat' }],
    });
    expect(nested.ok).toBe(false);
    expect(nested.error.reason).toBe(FAILURE_REASONS.FORBIDDEN_FIELD);
  });

  it('扩展外部发送方的 ST_PAGE_SUBMIT 被拒绝', async () => {
    const response = await submitPage(validPayload(), { id: 'other', tab: { id: 9 } });

    expect(response.ok).toBe(false);
    expect(response.error.code).toBe(ERROR_CODES.OTHER);
  });

  it('成功接收记录 page.received 与逐段 page.item，预览不超过 60 字', async () => {
    initLogging({ context: 'background', level: 'info', sessionId: 's-test' });
    const info = vi.spyOn(console, 'info').mockImplementation(() => {});
    const payload = {
      requestId: 's-log',
      scope: 'single',
      paragraphs: [{ index: 0, hostId: 'h1', text: 'Secret paragraph one' }],
    };
    const chars = payload.paragraphs.reduce((sum, paragraph) => sum + paragraph.text.length, 0);

    const response = receivePageSubmit(payload, { tab: { id: 7 } }, 't-recv');

    expect(response.ok).toBe(true);
    const lines = info.mock.calls.map((call) => String(call[0]));
    const received = lines.find((entry) => entry.includes('page.received'));
    expect(received).toBeTruthy();
    expect(received).toContain('"scope":"single"');
    expect(received).toContain('"requestId":"s-log"');
    expect(received).toContain(`"paragraphs":${payload.paragraphs.length}`);
    expect(received).toContain(`"chars":${chars}`);
    expect(received).toContain('"tabId":7');
    expect(received).not.toContain('Secret paragraph one');

    const items = lines.filter((entry) => entry.includes('page.item'));
    expect(items).toHaveLength(1);
    expect(items[0]).toContain('"index":0');
    expect(items[0]).toContain('"hostId":"h1"');
    expect(items[0]).toContain('"textLength":20');
    expect(items[0]).toContain('"preview":"Secret paragraph one"');

    // 超过 60 字的段落只打印前 60 字。
    const longText = 'A'.repeat(80);
    receivePageSubmit(
      { requestId: 's-long', paragraphs: [{ index: 0, text: longText }] },
      { tab: { id: 7 } },
      't-long'
    );
    const longItem = info.mock.calls
      .map((call) => String(call[0]))
      .filter((entry) => entry.includes('page.item'))
      .at(-1);
    expect(longItem).toContain(`"preview":"${'A'.repeat(60)}"`);
    expect(longItem).not.toContain(longText);
  });
});
