// @vitest-environment jsdom
/**
 * 设置页「翻译实例」分区的组件测试（P8-3）
 *
 * 覆盖：实例列表的类型/预设、模型或 endpoint、当前标记、凭据与权限徽标；筛选；
 *       启用/停用（含停用当前实例的确认与改选）、设为当前、复制、删除确认与后果说明、
 *       不支持类型只保留删除、空状态的快捷创建。
 * chrome 与消息由 tests/helpers 提供；实例数据走 E3 的真实存储路径。
 */

import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import {
  click,
  createHarness,
  findButton,
  flush,
  mountOptions,
  readInstances,
  readSettings,
  seedUnsupportedInstance,
  setValue,
  unmountOptions,
} from '../helpers/options.jsx';
import { createInstance, writeCredentials } from '../../src/shared/config/instances.js';
import { saveSettings } from '../../src/shared/settings.js';

/** @type {ReturnType<typeof createHarness>} */
let harness;
/** @type {Record<string, any>} */
let fixtures;

beforeEach(async () => {
  harness = createHarness();
  await saveSettings({ targetLang: 'zh', logLevel: 'info' });

  const deepseek = await createInstance({ type: 'openai', preset: 'deepseek', name: 'DeepSeek' });
  await writeCredentials(deepseek.id, { apiKey: 'sk-deepseek' });
  await saveSettings({ activeInstanceId: deepseek.id });

  const baidu = await createInstance({ type: 'baidu', name: '百度翻译' });
  await writeCredentials(baidu.id, { appId: 'app-1', secretKey: 'secret-1' });

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
    model: 'qwen2.5',
  });

  fixtures = { deepseek, baidu, custom };
});

afterEach(async () => {
  await unmountOptions(harness);
});

/** 卡片内按文字找按钮。 */
function cardButton(name, text) {
  const card = [...document.querySelectorAll('article[aria-label^="翻译实例 "]')].find((item) =>
    item.getAttribute('aria-label')?.includes(name)
  );
  if (!card) return undefined;
  return [...card.querySelectorAll('button')].find((button) => button.textContent.includes(text));
}

/** 卡片元素。 */
function card(name) {
  return [...document.querySelectorAll('article[aria-label^="翻译实例 "]')].find((item) =>
    item.getAttribute('aria-label')?.includes(name)
  );
}

describe('实例列表', () => {
  it('显示类型/预设、模型或 endpoint、当前标记、凭据与权限徽标', async () => {
    const container = await mountOptions(harness, '#/instances');
    const text = container.textContent;

    expect(text).toContain('OpenAI 兼容 · DeepSeek');
    expect(text).toContain('百度翻译');
    expect(text).toContain('通用文本翻译');
    expect(text).toContain('OpenAI 兼容 · 自定义');
    expect(text).toContain('example.com/chat/completions');
    expect(text).toContain('当前');
    expect(text).toContain('未授权');
    expect(text).not.toContain('无需密钥');
    expect(card('DeepSeek')?.className).toContain('border-primary');
    expect(card('Local')?.textContent).toContain('未配置');
    expect(text).not.toContain('sk-deepseek');
    expect(text).not.toContain('secret-1');
  });

  it('筛选「未配置密钥」只显示缺少凭据的实例', async () => {
    const container = await mountOptions(harness, '#/instances');
    const chip = [...container.querySelectorAll('button.tab')].find((item) =>
      item.textContent.includes('未配置密钥')
    );
    await click(chip);

    expect(card('Local')).toBeTruthy();
    expect(card('DeepSeek')).toBeUndefined();
    expect(card('百度翻译')).toBeUndefined();
  });

  it('百度凭据只配置一项时显示「部分配置」', async () => {
    await writeCredentials(fixtures.baidu.id, { appId: 'app-1', secretKey: '' });
    const container = await mountOptions(harness, '#/instances');
    expect(card('百度翻译')?.textContent).toContain('部分配置');
  });

  it('不支持类型只允许删除', async () => {
    await seedUnsupportedInstance(harness, { id: 'inst-future', name: '未来实例' });
    const container = await mountOptions(harness, '#/instances');

    const unsupported = card('未来实例');
    expect(unsupported?.textContent).toContain('类型不受支持');
    expect(unsupported?.textContent).toContain('删除');
    expect(unsupported?.textContent).not.toContain('编辑');
    expect(unsupported?.textContent).not.toContain('设为当前');
  });
});

describe('实例操作', () => {
  it('启用开关直接写入并提示', async () => {
    const container = await mountOptions(harness, '#/instances');
    const toggle = container.querySelector(`input[aria-label="启用 Local"]`);
    expect(toggle.checked).toBe(true);

    await click(toggle);
    const stored = await readInstances(harness);
    expect(stored.find((item) => item.id === fixtures.custom.id).enabled).toBe(false);
    expect(container.textContent).toContain('已停用「Local」');
  });

  it('凭据与权限不足时「设为当前」禁用并给出原因', async () => {
    const container = await mountOptions(harness, '#/instances');
    const button = cardButton('Local', '设为当前');
    expect(button.disabled).toBe(true);
    expect(button.getAttribute('title')).toContain('缺少凭据');
  });

  it('设为当前写入 activeInstanceId 并移动「当前」徽标', async () => {
    const container = await mountOptions(harness, '#/instances');
    await click(cardButton('百度翻译', '设为当前'));

    const settings = await readSettings(harness);
    expect(settings.activeInstanceId).toBe(fixtures.baidu.id);
    expect(card('百度翻译')?.className).toContain('border-primary');
    expect(card('DeepSeek')?.className).not.toContain('border-primary');
  });

  it('停用当前实例先确认，确认后改选下一个可用实例', async () => {
    const container = await mountOptions(harness, '#/instances');
    await click(container.querySelector(`input[aria-label="启用 DeepSeek"]`));

    expect(container.textContent).toContain('停用当前翻译实例？');
    expect(container.textContent).toContain('当前翻译方式会改选为下一个可用实例');

    const confirm = [...container.querySelectorAll('[role="dialog"] button')].find(
      (button) => button.textContent.trim() === '停用'
    );
    await click(confirm);

    const settings = await readSettings(harness);
    expect(settings.activeInstanceId).toBe(fixtures.baidu.id);
    const stored = await readInstances(harness);
    expect(stored.find((item) => item.id === fixtures.deepseek.id).enabled).toBe(false);
  });

  it('删除实例的确认弹窗列出全部后果，确认后列表更新', async () => {
    const container = await mountOptions(harness, '#/instances');
    await click(cardButton('Local', '删除'));

    const dialog = container.querySelector('[role="dialog"]');
    expect(dialog.textContent).toContain('删除「Local」？');
    expect(dialog.textContent).toContain('删除该实例的配置、凭据与本地提示词');
    expect(dialog.textContent).toContain('主机权限是扩展级授权，不随实例删除自动撤销');
    expect(dialog.textContent).toContain('译文缓存不会删除');
    expect(dialog.textContent).toContain('不可撤销');

    const confirm = [...dialog.querySelectorAll('button')].find(
      (button) => button.textContent.trim() === '删除实例'
    );
    await click(confirm);

    expect(card('Local')).toBeUndefined();
    const stored = await readInstances(harness);
    expect(stored.some((item) => item.id === fixtures.custom.id)).toBe(false);
  });

  it('复制实例不复制凭据、默认停用，并打开编辑抽屉', async () => {
    const container = await mountOptions(harness, '#/instances');
    await click(cardButton('DeepSeek', '复制'));

    expect(container.textContent).toContain('已复制为「DeepSeek 副本」');
    const stored = await readInstances(harness);
    const copy = stored.find((item) => item.name === 'DeepSeek 副本');
    expect(copy.enabled).toBe(false);
    const credentials = await harness.chrome.storage.local.get(`engineKey:${copy.id}`);
    expect(credentials[`engineKey:${copy.id}`]).toBeUndefined();
    expect(container.querySelector('#ed-name')).toBeTruthy();
  });
});

describe('空状态与新增流程', () => {
  it('没有实例时提供三个快捷创建入口', async () => {
    await harness.chrome.storage.sync.set({ engineInstances: [] });
    await saveSettings({ activeInstanceId: null });
    const container = await mountOptions(harness, '#/instances');

    expect(container.textContent).toContain('还没有翻译实例');
    await click(findButton('OpenAI 兼容（自定义）', container));

    expect(container.textContent).toContain('新增翻译实例');
    const nameInput = container.querySelector('#new-name');
    expect(nameInput.value).toBe('自定义');
    const customPreset = [...container.querySelectorAll('[role="dialog"] button[aria-pressed]')].find(
      (chip) => chip.textContent === '自定义'
    );
    expect(customPreset.getAttribute('aria-pressed')).toBe('true');

    await setValue(nameInput, '本地 Ollama');
    await setValue(container.querySelector('#new-baseurl'), 'http://localhost:11434/v1');
    await setValue(container.querySelector('#new-model'), 'llama3');
    await click(findButton('创建', container));

    const stored = await readInstances(harness);
    expect(stored).toHaveLength(1);
    expect(stored[0].name).toBe('本地 Ollama');
    expect(stored[0].preset).toBe('custom');
    expect(stored[0].endpoint.baseUrl).toBe('http://localhost:11434/v1');
    expect(container.querySelector('#ed-name')?.value).toBe('本地 Ollama');
  });

  it('新增对话框校验名称长度与重复', async () => {
    const container = await mountOptions(harness, '#/instances');
    await click(findButton('新增翻译实例', container));

    await setValue(container.querySelector('#new-name'), 'DeepSeek');
    await click(findButton('创建', container));
    expect(container.textContent).toContain('实例名称已存在');

    await setValue(container.querySelector('#new-name'), 'x'.repeat(41));
    await click(findButton('创建', container));
    expect(container.textContent).toContain('实例名称不能超过 40 字符');
    expect(await readInstances(harness)).toHaveLength(3);
  });
});

describe('概览与实例联动', () => {
  it('从概览快捷操作跳到实例页并打开新增对话框', async () => {
    const container = await mountOptions(harness, '#/overview');
    await click(findButton('新增翻译实例', container));
    await flush();

    expect(container.textContent).toContain('选择类型后填写名称');
    expect(container.querySelector('#new-name')).toBeTruthy();
  });
});
