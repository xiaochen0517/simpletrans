/**
 * A3 百度翻译适配器测试（P8-2）
 *
 * 覆盖签名标准向量、语言码、请求参数、原生批量、空译文、错误码、字节上限与取消/超时。
 * 全程 mock fetch，不联网。
 */

import { describe, expect, it, vi } from 'vitest';
import {
  BAIDU_ENDPOINT,
  mapBaiduError,
  normalizeBaiduText,
  signBaidu,
  translate,
  translateBatch,
  utf8Bytes,
} from '../../src/shared/translate/adapters/baidu.js';
import { ERROR_CODES } from '../../src/shared/protocol.js';
import { BAIDU_BATCH_MAX_BYTES, BAIDU_SEGMENT_MAX_BYTES } from '../../src/shared/constants.js';
import { BatchAlignError } from '../../src/shared/translate/batch.js';
import { initLogging } from '../../src/shared/log/logger.js';

initLogging({ level: 'off', sessionId: 'baidu-adapter-test' });

/** 合法百度实例（包含运行时凭据字段）。 */
function baiduInstance(patch = {}) {
  return {
    id: 'baidu-1',
    type: 'baidu',
    name: '百度翻译',
    baseUrl: 'https://fanyi-api.baidu.com',
    model: 'general',
    batchSize: 8,
    batchMaxChars: 1000,
    maxConcurrency: 1,
    appId: 'appid',
    secretKey: 'secret',
    ...patch,
  };
}

/**
 * 构造 JSON 响应。
 * @param {unknown} payload
 * @param {number} [status]
 */
function jsonResponse(payload, status = 200) {
  const text = typeof payload === 'string' ? payload : JSON.stringify(payload);
  return {
    ok: status >= 200 && status < 300,
    status,
    headers: { get: () => 'application/json' },
    async text() {
      return text;
    },
  };
}

/** 成功的单段响应。 */
function successSingle(dst = '你好') {
  return jsonResponse({ from: 'en', to: 'zh', trans_result: [{ src: 'Hello', dst }] });
}

describe('A3 百度适配器：签名与语言', () => {
  it('签名是 MD5(appid + q + salt + secretKey) 的 32 位小写', () => {
    expect(signBaidu({ appId: 'a', q: 'b', salt: 'c', secretKey: '' })).toBe(
      '900150983cd24fb0d6963f7d28e17f72'
    );
    expect(signBaidu({ appId: 'A', q: 'B', salt: '1', secretKey: 'C' })).toMatch(
      /^[0-9a-f]{32}$/
    );
  });

  it('语言码：ja → jp、ko → kor，源语言只允许 auto/en', async () => {
    const fetchImpl = vi.fn(async () => successSingle());
    await translate({ text: 'hi', targetLang: 'ja', sourceLang: 'en', instance: baiduInstance(), fetchImpl, salt: '1' });
    let body = new URLSearchParams(fetchImpl.mock.calls[0][1].body);
    expect(body.get('to')).toBe('jp');
    expect(body.get('from')).toBe('en');

    fetchImpl.mockClear();
    await translate({ text: 'hi', targetLang: 'ko', instance: baiduInstance(), fetchImpl, salt: '1' });
    body = new URLSearchParams(fetchImpl.mock.calls[0][1].body);
    expect(body.get('to')).toBe('kor');
    expect(body.get('from')).toBe('auto');
  });

  it('不支持的目标语言不发请求', async () => {
    const fetchImpl = vi.fn();
    await expect(
      translate({ text: 'hi', targetLang: 'auto', instance: baiduInstance(), fetchImpl })
    ).rejects.toMatchObject({ code: ERROR_CODES.OTHER });
    await expect(
      translate({ text: 'hi', targetLang: 'fr', instance: baiduInstance(), fetchImpl })
    ).rejects.toMatchObject({ code: ERROR_CODES.OTHER });
    expect(fetchImpl).not.toHaveBeenCalled();
  });

  it('文本归一：连续换行替换为空格', () => {
    expect(normalizeBaiduText('a\r\n\r\nb')).toBe('a b');
    expect(utf8Bytes('汉')).toBe(3);
  });
});

describe('A3 百度适配器：单段', () => {
  it('POST 表单参数完整、签名正确，返回 dst 与 usage null', async () => {
    const fetchImpl = vi.fn(async () => successSingle('你好'));
    const result = await translate({
      text: 'Hello',
      targetLang: 'zh',
      instance: baiduInstance({ appId: 'appid', secretKey: 'secret' }),
      fetchImpl,
      salt: '12345',
    });

    expect(result).toEqual({ text: '你好', usage: null });
    expect(fetchImpl).toHaveBeenCalledTimes(1);
    const [url, options] = fetchImpl.mock.calls[0];
    expect(url).toBe(BAIDU_ENDPOINT);
    expect(options.method).toBe('POST');
    expect(options.headers['content-type']).toContain('application/x-www-form-urlencoded');
    expect(options.redirect).toBe('error');

    const body = new URLSearchParams(options.body);
    expect(body.get('q')).toBe('Hello');
    expect(body.get('from')).toBe('auto');
    expect(body.get('to')).toBe('zh');
    expect(body.get('appid')).toBe('appid');
    expect(body.get('salt')).toBe('12345');
    expect(body.get('sign')).toBe(signBaidu({ appId: 'appid', q: 'Hello', salt: '12345', secretKey: 'secret' }));
  });

  it('源文本换行替换为空格后再签名与发送', async () => {
    const fetchImpl = vi.fn(async () => successSingle());
    await translate({ text: 'a\n\nb', targetLang: 'zh', instance: baiduInstance(), fetchImpl, salt: '1' });
    const body = new URLSearchParams(fetchImpl.mock.calls[0][1].body);
    expect(body.get('q')).toBe('a b');
    expect(body.get('sign')).toBe(signBaidu({ appId: 'appid', q: 'a b', salt: '1', secretKey: 'secret' }));
  });

  it('空译文失败为 OTHER，空输入短路不请求', async () => {
    const fetchImpl = vi.fn(async () => successSingle('   '));
    await expect(
      translate({ text: 'Hello', targetLang: 'zh', instance: baiduInstance(), fetchImpl })
    ).rejects.toMatchObject({ code: ERROR_CODES.OTHER });

    fetchImpl.mockClear();
    expect(await translate({ text: '   ', targetLang: 'zh', instance: baiduInstance(), fetchImpl })).toEqual({
      text: '',
      usage: null,
    });
    expect(fetchImpl).not.toHaveBeenCalled();
  });

  it('单段超过 4800 字节直接失败，不发请求', async () => {
    const fetchImpl = vi.fn();
    const text = 'a'.repeat(BAIDU_SEGMENT_MAX_BYTES + 1);
    await expect(
      translate({ text, targetLang: 'zh', instance: baiduInstance(), fetchImpl })
    ).rejects.toMatchObject({ code: ERROR_CODES.OTHER });
    expect(fetchImpl).not.toHaveBeenCalled();
  });

  it('缺 APPID/密钥报 CONFIG，不发请求', async () => {
    const fetchImpl = vi.fn();
    await expect(
      translate({ text: 'hi', targetLang: 'zh', instance: baiduInstance({ appId: '' }), fetchImpl })
    ).rejects.toMatchObject({ code: ERROR_CODES.CONFIG });
    expect(fetchImpl).not.toHaveBeenCalled();
  });

  it('外部取消映射 CANCELLED，不发送', async () => {
    const controller = new AbortController();
    controller.abort();
    const fetchImpl = vi.fn();
    await expect(
      translate({
        text: 'hi',
        targetLang: 'zh',
        instance: baiduInstance(),
        fetchImpl,
        signal: controller.signal,
      })
    ).rejects.toMatchObject({ code: ERROR_CODES.CANCELLED });
    expect(fetchImpl).not.toHaveBeenCalled();
  });

  it('网络异常与超时映射 NETWORK', async () => {
    await expect(
      translate({
        text: 'hi',
        targetLang: 'zh',
        instance: baiduInstance(),
        fetchImpl: async () => {
          throw new TypeError('fetch failed');
        },
      })
    ).rejects.toMatchObject({ code: ERROR_CODES.NETWORK });

    await expect(
      translate({
        text: 'hi',
        targetLang: 'zh',
        instance: baiduInstance(),
        timeoutMs: 5,
        fetchImpl: (url, options) =>
          new Promise((resolve, reject) => {
            options.signal.addEventListener('abort', () =>
              reject(new DOMException('aborted', 'AbortError'))
            );
          }),
      })
    ).rejects.toMatchObject({ code: ERROR_CODES.NETWORK });
  });

  it('HTTP 401/429/5xx 与非法 JSON 正确归一', async () => {
    await expect(
      translate({
        text: 'hi',
        targetLang: 'zh',
        instance: baiduInstance(),
        fetchImpl: async () => jsonResponse({}, 401),
      })
    ).rejects.toMatchObject({ code: ERROR_CODES.AUTH });

    await expect(
      translate({
        text: 'hi',
        targetLang: 'zh',
        instance: baiduInstance(),
        fetchImpl: async () => jsonResponse({}, 429),
      })
    ).rejects.toMatchObject({ code: ERROR_CODES.RATE_LIMIT });

    await expect(
      translate({
        text: 'hi',
        targetLang: 'zh',
        instance: baiduInstance(),
        fetchImpl: async () => jsonResponse({}, 503),
      })
    ).rejects.toMatchObject({ code: ERROR_CODES.NETWORK });

    await expect(
      translate({
        text: 'hi',
        targetLang: 'zh',
        instance: baiduInstance(),
        fetchImpl: async () => jsonResponse('not json'),
      })
    ).rejects.toMatchObject({ code: ERROR_CODES.OTHER });
  });
});

describe('A3 百度适配器：批量', () => {
  it('多段一次原生批量，q 用换行连接，按输入顺序回调', async () => {
    const onItem = vi.fn();
    const fetchImpl = vi.fn(async () =>
      jsonResponse({
        trans_result: [
          { src: 'a', dst: '甲' },
          { src: 'b', dst: '乙' },
        ],
      })
    );

    const result = await translateBatch({
      items: [
        { groupId: 'g0', text: 'a' },
        { groupId: 'g1', text: 'b' },
      ],
      targetLang: 'zh',
      instance: baiduInstance(),
      onItem,
      fetchImpl,
      salt: '9',
    });

    expect(result).toEqual({ usage: null });
    expect(fetchImpl).toHaveBeenCalledTimes(1);
    const body = new URLSearchParams(fetchImpl.mock.calls[0][1].body);
    expect(body.get('q')).toBe('a\nb');
    expect(onItem.mock.calls).toEqual([
      [{ groupId: 'g0', text: '甲' }],
      [{ groupId: 'g1', text: '乙' }],
    ]);
  });

  it('结果数量不符抛 BATCH_ALIGN', async () => {
    const fetchImpl = vi.fn(async () =>
      jsonResponse({ trans_result: [{ src: 'a', dst: '甲' }] })
    );
    await expect(
      translateBatch({
        items: [
          { groupId: 'g0', text: 'a' },
          { groupId: 'g1', text: 'b' },
        ],
        targetLang: 'zh',
        instance: baiduInstance(),
        fetchImpl,
      })
    ).rejects.toBeInstanceOf(BatchAlignError);
  });

  it('单批超过 4800 字节直接失败，不发请求', async () => {
    const fetchImpl = vi.fn();
    const text = 'a'.repeat(BAIDU_BATCH_MAX_BYTES);
    await expect(
      translateBatch({
        items: [
          { groupId: 'g0', text },
          { groupId: 'g1', text: 'b' },
        ],
        targetLang: 'zh',
        instance: baiduInstance(),
        fetchImpl,
      })
    ).rejects.toMatchObject({ code: ERROR_CODES.OTHER });
    expect(fetchImpl).not.toHaveBeenCalled();
  });

  it('空文本段落失败；空译文按段回调空串由 A2 判定', async () => {
    await expect(
      translateBatch({
        items: [
          { groupId: 'g0', text: ' ' },
          { groupId: 'g1', text: 'b' },
        ],
        targetLang: 'zh',
        instance: baiduInstance(),
        fetchImpl: vi.fn(),
      })
    ).rejects.toMatchObject({ code: ERROR_CODES.OTHER });

    const onItem = vi.fn();
    await translateBatch({
      items: [
        { groupId: 'g0', text: 'a' },
        { groupId: 'g1', text: 'b' },
      ],
      targetLang: 'zh',
      instance: baiduInstance(),
      onItem,
      fetchImpl: async () =>
        jsonResponse({
          trans_result: [
            { src: 'a', dst: '' },
            { src: 'b', dst: '乙' },
          ],
        }),
    });
    expect(onItem).toHaveBeenNthCalledWith(1, { groupId: 'g0', text: '' });
    expect(onItem).toHaveBeenNthCalledWith(2, { groupId: 'g1', text: '乙' });
  });
});

describe('A3 百度适配器：错误码映射', () => {
  const cases = [
    ['52001', ERROR_CODES.NETWORK],
    ['52002', ERROR_CODES.NETWORK],
    ['52003', ERROR_CODES.AUTH],
    ['54001', ERROR_CODES.AUTH],
    ['90107', ERROR_CODES.AUTH],
    ['54000', ERROR_CODES.CONFIG],
    ['54003', ERROR_CODES.RATE_LIMIT],
    ['54005', ERROR_CODES.RATE_LIMIT],
    ['54004', ERROR_CODES.AUTH],
    ['20003', ERROR_CODES.OTHER],
    ['58000', ERROR_CODES.CONFIG],
    ['58001', ERROR_CODES.OTHER],
    ['58002', ERROR_CODES.OTHER],
    ['58003', ERROR_CODES.OTHER],
    ['99999', ERROR_CODES.OTHER],
  ];

  it.each(cases)('错误码 %s → %s', (code, expected) => {
    expect(mapBaiduError(code).code).toBe(expected);
  });

  it('接口返回 error_code 时抛出映射错误，不透传原始报文', async () => {
    const fetchImpl = vi.fn(async () =>
      jsonResponse({ error_code: '54003', error_msg: 'Invalid Access Limit' })
    );
    const error = await translate({
      text: 'hi',
      targetLang: 'zh',
      instance: baiduInstance(),
      fetchImpl,
    }).catch((caught) => caught);

    expect(error.code).toBe(ERROR_CODES.RATE_LIMIT);
    expect(error.message).not.toContain('Invalid Access Limit');
  });
});
