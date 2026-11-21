// @vitest-environment jsdom
/**
 * 设置页「测试翻译」分区的组件测试
 *
 * 覆盖：实例下拉（含未配置密钥实例与原因标注）、默认当前实例、成功结果的译文/耗时/用量、
 *       失败的错误码与下一步建议、字符上限、清空，以及没有实例时的引导。
 */

import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { act } from 'react';
import {
  chooseOption,
  click,
  createHarness,
  findButton,
  findSelect,
  flush,
  mountOptions,
  setValue,
  unmountOptions,
} from '../helpers/options.jsx';
import { createInstance, updateInstance, writeCredentials } from '../../src/shared/config/instances.js';
import { saveSettings } from '../../src/shared/settings.js';
import { TEST_TEXT_MAX_CHARS } from '../../src/options/lib.js';

/** @type {ReturnType<typeof createHarness>} */
let harness;
/** @type {Record<string, any>} */
let fixtures;

beforeEach(async () => {
  harness = createHarness();
  await saveSettings({ targetLang: 'zh', sourceLang: 'auto', logLevel: 'info' });
  const deepseek = await createInstance({ type: 'openai', preset: 'deepseek', name: 'DeepSeek' });
  await writeCredentials(deepseek.id, { apiKey: 'sk-test' });
  await saveSettings({ activeInstanceId: deepseek.id });
  const baidu = await createInstance({ type: 'baidu', name: '百度翻译' });
  fixtures = { deepseek, baidu };
});

afterEach(async () => {
  await unmountOptions(harness);
});

/** 测试输入文本域。 */
function textarea(container) {
  return container.querySelector('textarea');
}

/** 测试输入区块里的按钮（避免命中导航项）。 */
function inputBlock(container) {
  return container.querySelector('section[aria-label="测试输入"]');
}

/** 执行测试。 */
async function runTest(container) {
  await click(findButton('测试翻译', inputBlock(container)));
}

describe('测试翻译', () => {
  it('默认选中当前实例并列出全部已保存实例（含未配置密钥原因）', async () => {
    const container = await mountOptions(harness, '#/test');
    const select = findSelect('翻译实例', container);
    expect(select.querySelector('summary').textContent).toContain('DeepSeek');
    await act(async () => {
      select.open = true;
      select.dispatchEvent(new Event('toggle'));
    });
    await flush(1);
    const labels = [...select.querySelectorAll('button[role="radio"]')].map((button) =>
      button.textContent
    );
    expect(labels[0]).toContain('DeepSeek');
    expect(labels[0]).toContain('OpenAI 兼容 · DeepSeek');
    expect(labels[1]).toContain('百度翻译');
    expect(labels[1]).toContain('未配置');
    expect(container.textContent).toContain('自动检测 → 中文');
    expect(container.textContent).toContain('选择实例并输入文本后测试');
  });

  it('测试成功显示译文、耗时、用量与实例信息', async () => {
    const container = await mountOptions(harness, '#/test');
    await runTest(container);

    const text = container.textContent;
    expect(text).toContain('测试成功');
    expect(text).toContain('你好，世界');
    expect(text).toContain('耗时 42 ms');
    expect(text).toContain('18 tokens');
    expect(text).toContain('OpenAI 兼容 · DeepSeek');
    expect(text).toContain('deepseek-chat');
  });

  it('结果摘要显示已启用的生成参数', async () => {
    await updateInstance(fixtures.deepseek.id, {
      params: {
        temperature: { enabled: true, value: 0.7 },
        topP: { enabled: true, value: 0.9 },
      },
    });
    const container = await mountOptions(harness, '#/test');
    await runTest(container);

    expect(container.textContent).toContain('temperature 0.7');
    expect(container.textContent).toContain('top_p 0.9');
  });

  it('测试失败显示错误码与下一步建议', async () => {
    harness.replies.testEngine = () => ({
      ok: false,
      error: { code: 'CONFIG', message: '未授权访问该接口域名，请到设置页重新授权' },
    });
    const container = await mountOptions(harness, '#/test');
    await runTest(container);

    expect(container.textContent).toContain('测试失败');
    expect(container.textContent).toContain('错误码 CONFIG');
    expect(container.textContent).toContain('请先授权该实例的接口域名');
  });

  it('超过字符上限时提示并禁用测试按钮', async () => {
    const container = await mountOptions(harness, '#/test');
    await setValue(textarea(container), 'x'.repeat(TEST_TEXT_MAX_CHARS + 1));

    expect(container.textContent).toContain(`超过 ${TEST_TEXT_MAX_CHARS} 字符上限`);
    const button = findButton('测试翻译', inputBlock(container));
    expect(button.disabled).toBe(true);
  });

  it('清空按钮清除输入与结果', async () => {
    const container = await mountOptions(harness, '#/test');
    await runTest(container);
    expect(container.textContent).toContain('你好，世界');

    await click(findButton('清空', inputBlock(container)));
    expect(textarea(container).value).toBe('');
    expect(container.textContent).not.toContain('你好，世界');
    expect(container.textContent).toContain('选择实例并输入文本后测试');
  });

  it('离开分区后返回仍保留本次测试结果（会话内）', async () => {
    const container = await mountOptions(harness, '#/test');
    await runTest(container);
    expect(container.textContent).toContain('你好，世界');

    await click(findButton('概览', container));
    expect(container.textContent).toContain('当前翻译方式');
    await click(findButton('测试翻译', container));

    expect(container.textContent).toContain('你好，世界');
    expect(container.textContent).toContain('测试成功');
    expect(textarea(container).value).toBe('Hello world');
  });

  it('未配置密钥与未授权实例提示会失败，并提供去授权入口', async () => {
    const custom = await createInstance({
      type: 'openai',
      preset: 'custom',
      name: 'Local',
      endpoint: {
        baseUrl: 'https://example.com/v1',
        path: '/chat/completions',
        query: [],
        stream: true,
      },
      model: 'qwen',
    });
    const container = await mountOptions(harness, '#/test');
    await chooseOption('翻译实例', 'Local', container);

    expect(container.textContent).toContain('该实例尚未配置密钥');
    expect(findButton('去授权', container)).toBeTruthy();
  });

  it('没有实例时引导到新增实例', async () => {
    await harness.chrome.storage.sync.set({ engineInstances: [] });
    await saveSettings({ activeInstanceId: null });
    const container = await mountOptions(harness, '#/test');

    expect(container.textContent).toContain('还没有翻译实例');
    expect(findButton('新增翻译实例', container)).toBeTruthy();
  });
});
