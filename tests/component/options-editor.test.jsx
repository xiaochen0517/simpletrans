// @vitest-environment jsdom
/**
 * 设置页实例编辑抽屉的组件测试（P8-3）
 *
 * 覆盖：字段回填与凭据不回填明文、字段级校验、名称唯一、保存写入实例与凭据、
 *       生成参数开关、认证方式切换（无认证）、百度部分配置、域名权限申请与拒绝、
 *       清除凭据确认、未保存离开提示。
 */

import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import {
  click,
  createHarness,
  findButton,
  flush,
  mountOptions,
  readInstances,
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
  await writeCredentials(baidu.id, { appId: 'app-1', secretKey: '' });

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

/** 按实例名取卡片。 */
function card(name) {
  return [...document.querySelectorAll('.op-instance')].find((item) =>
    item.getAttribute('aria-label')?.includes(name)
  );
}

/** 打开某实例的编辑抽屉。 */
async function openEditor(container, name) {
  const target = card(name);
  const edit = [...target.querySelectorAll('button')].find((button) =>
    button.textContent.includes('编辑')
  );
  await click(edit);
  await flush();
  return container.querySelector('.op-drawer');
}

/** 点击抽屉底部保存。 */
async function save(container) {
  const footer = container.querySelector('.op-drawer-footer');
  const button = [...footer.querySelectorAll('button')].find((item) =>
    item.textContent.includes('保存')
  );
  await click(button);
}

describe('编辑抽屉字段', () => {
  it('回填连接与模型字段，凭据输入框不回填明文', async () => {
    const container = await mountOptions(harness, '#/instances');
    const drawer = await openEditor(container, 'DeepSeek');

    expect(drawer.querySelector('#ed-name').value).toBe('DeepSeek');
    expect(drawer.querySelector('#ed-baseurl').value).toBe('https://api.deepseek.com');
    expect(drawer.querySelector('#ed-model').value).toBe('deepseek-chat');
    expect(drawer.querySelector('#ed-apikey').value).toBe('');
    expect(drawer.textContent).toContain('已配置');
    expect(drawer.textContent).toContain('已授权');
    expect(drawer.textContent).toContain('OpenAI 兼容 · DeepSeek');
    expect(drawer.textContent).not.toContain('sk-deepseek');
  });

  it('字段校验失败时不写入存储', async () => {
    const container = await mountOptions(harness, '#/instances');
    const drawer = await openEditor(container, 'DeepSeek');

    await setValue(drawer.querySelector('#ed-model'), '');
    await setValue(drawer.querySelector('#ed-baseurl'), 'ftp://nope.example.com');
    await save(container);

    expect(drawer.textContent).toContain('请填写模型名称');
    expect(drawer.textContent).toContain('接口地址需为 HTTPS 或本地回环');
    const stored = await readInstances(harness);
    expect(stored.find((item) => item.id === fixtures.deepseek.id).model).toBe('deepseek-chat');
  });

  it('名称重复时给出字段错误', async () => {
    const container = await mountOptions(harness, '#/instances');
    const drawer = await openEditor(container, 'DeepSeek');

    await setValue(drawer.querySelector('#ed-name'), '百度翻译');
    await save(container);
    expect(drawer.textContent).toContain('实例名称已存在');
    expect(container.querySelector('.op-drawer')).toBeTruthy();
  });

  it('保存成功后写入实例、关闭抽屉并提示', async () => {
    const container = await mountOptions(harness, '#/instances');
    const drawer = await openEditor(container, 'DeepSeek');

    await setValue(drawer.querySelector('#ed-model'), 'deepseek-reasoner');
    await setValue(drawer.querySelector('#ed-name'), 'DeepSeek V3');
    await save(container);

    const stored = await readInstances(harness);
    const saved = stored.find((item) => item.id === fixtures.deepseek.id);
    expect(saved.model).toBe('deepseek-reasoner');
    expect(saved.name).toBe('DeepSeek V3');
    expect(container.querySelector('.op-drawer')).toBeNull();
    expect(container.textContent).toContain('已保存');
  });

  it('生成参数开关与值写入实例 params', async () => {
    const container = await mountOptions(harness, '#/instances');
    const drawer = await openEditor(container, 'DeepSeek');

    const temperature = drawer.querySelector('input[aria-label="启用 temperature"]');
    await click(temperature);
    await setValue(drawer.querySelector('input[aria-label="temperature 值"]'), '0.7');
    await save(container);

    const stored = await readInstances(harness);
    expect(stored.find((item) => item.id === fixtures.deepseek.id).params.temperature).toEqual({
      enabled: true,
      value: 0.7,
    });
  });

  it('思考强度取值写入 params.reasoning', async () => {
    const container = await mountOptions(harness, '#/instances');
    const drawer = await openEditor(container, 'DeepSeek');

    await setValue(drawer.querySelector('#ed-reasoning-value'), 'high');
    await save(container);

    const stored = await readInstances(harness);
    const reasoning = stored.find((item) => item.id === fixtures.deepseek.id).params.reasoning;
    expect(reasoning.mode).toBe('effort');
    expect(reasoning.value).toBe('high');
  });

  it('插入提示词占位符后保存到 storage.local', async () => {
    const container = await mountOptions(harness, '#/instances');
    const drawer = await openEditor(container, 'DeepSeek');

    await click(findButton('插入目标语言', drawer));
    await save(container);

    const local = await harness.chrome.storage.local.get(`systemPrompt:${fixtures.deepseek.id}`);
    const prompt = local[`systemPrompt:${fixtures.deepseek.id}`];
    expect(prompt.match(/\{\{targetLang\}\}/g)).toHaveLength(2);
  });
});

describe('凭据与认证', () => {
  it('保存 API Key 后只显示已配置，不回填明文', async () => {
    const container = await mountOptions(harness, '#/instances');
    let drawer = await openEditor(container, 'DeepSeek');

    await setValue(drawer.querySelector('#ed-apikey'), 'sk-new-key');
    await save(container);

    const local = await harness.chrome.storage.local.get(`engineKey:${fixtures.deepseek.id}`);
    expect(local[`engineKey:${fixtures.deepseek.id}`]).toEqual({ apiKey: 'sk-new-key' });

    drawer = await openEditor(container, 'DeepSeek');
    expect(drawer.querySelector('#ed-apikey').value).toBe('');
    expect(drawer.querySelector('#ed-apikey').placeholder).toContain('已配置');
    expect(container.textContent).not.toContain('sk-new-key');
  });

  it('切换到无认证后不再需要密钥，卡片显示无需密钥', async () => {
    const container = await mountOptions(harness, '#/instances');
    const drawer = await openEditor(container, 'DeepSeek');

    await setValue(drawer.querySelector('#ed-auth'), 'none');
    expect(drawer.textContent).toContain('该实例不使用认证');
    await save(container);

    const stored = await readInstances(harness);
    expect(stored.find((item) => item.id === fixtures.deepseek.id).auth.type).toBe('none');
    await flush();
    expect(card('DeepSeek')?.textContent).toContain('无需密钥');
  });

  it('清除凭据需确认，确认后凭据被删除', async () => {
    const container = await mountOptions(harness, '#/instances');
    const drawer = await openEditor(container, 'DeepSeek');

    await click(findButton('清除凭据', drawer));
    expect(container.textContent).toContain('清除该实例的凭据？');
    const confirm = [...container.querySelectorAll('.op-dialog button')].find(
      (button) => button.textContent.trim() === '清除凭据'
    );
    await click(confirm);

    const local = await harness.chrome.storage.local.get(`engineKey:${fixtures.deepseek.id}`);
    expect(local[`engineKey:${fixtures.deepseek.id}`]).toBeUndefined();
    await flush();
    expect(card('DeepSeek')?.textContent).toContain('未配置');
  });

  it('百度只配置 APPID 时显示部分配置与字段级状态', async () => {
    const container = await mountOptions(harness, '#/instances');
    const drawer = await openEditor(container, '百度翻译');

    expect(drawer.textContent).toContain('部分配置');
    expect(drawer.querySelector('#ed-appid').placeholder).toContain('已配置');
    const appIdField = drawer.querySelector('#ed-appid').closest('.op-field');
    const secretField = drawer.querySelector('#ed-secret').closest('.op-field');
    expect(appIdField.textContent).toContain('已配置');
    expect(secretField.textContent).toContain('未配置');
  });
});

describe('域名权限', () => {
  it('未授权时显示未授权并可申请，授权后状态更新', async () => {
    const container = await mountOptions(harness, '#/instances');
    const drawer = await openEditor(container, 'Local');

    expect(drawer.textContent).toContain('未授权');
    await click(findButton('授权访问', drawer));

    const request = harness.chrome.permissions.__calls.find((call) => call.api === 'request');
    expect(request.origins).toEqual(['https://example.com/*']);
    await flush();
    expect(container.querySelector('.op-drawer').textContent).toContain('已授权');
  });

  it('拒绝授权时提示、实例保留且仍标记未授权', async () => {
    harness.chrome.permissions.__requestResult = false;
    const container = await mountOptions(harness, '#/instances');
    const drawer = await openEditor(container, 'Local');

    await click(findButton('授权访问', drawer));
    expect(container.textContent).toContain('未获得域名授权');
    expect(container.querySelector('#ed-baseurl')).toBeTruthy();
    expect(drawer.textContent).toContain('未授权');
  });

  it('保存未授权实例时在保存手势里申请权限', async () => {
    const container = await mountOptions(harness, '#/instances');
    const drawer = await openEditor(container, 'Local');

    await setValue(drawer.querySelector('#ed-model'), 'qwen3');
    await save(container);

    expect(harness.chrome.permissions.__calls.some((call) => call.api === 'request')).toBe(true);
    const stored = await readInstances(harness);
    expect(stored.find((item) => item.id === fixtures.custom.id).model).toBe('qwen3');
  });
});

describe('未保存离开', () => {
  it('修改后取消会提示，可以继续编辑或放弃', async () => {
    const container = await mountOptions(harness, '#/instances');
    const drawer = await openEditor(container, 'DeepSeek');

    await setValue(drawer.querySelector('#ed-name'), '改名中');
    await click(findButton('取消', drawer));
    expect(container.textContent).toContain('放弃未保存的修改？');

    await click(findButton('继续编辑', container));
    expect(container.querySelector('#ed-name').value).toBe('改名中');

    await click(findButton('取消', container.querySelector('.op-drawer')));
    await click(findButton('放弃修改', container));
    expect(container.querySelector('.op-drawer')).toBeNull();
    const stored = await readInstances(harness);
    expect(stored.find((item) => item.id === fixtures.deepseek.id).name).toBe('DeepSeek');
  });
});
