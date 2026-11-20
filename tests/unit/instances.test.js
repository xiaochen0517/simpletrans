/**
 * E3 引擎实例测试（P8-2）
 *
 * 覆盖实例 CRUD、名称唯一、数量/字节上限、启停与当前实例改选、每实例凭据、
 * `keyStorage` 迁移、提示词存储、公开字段与不支持类型保留。
 */

import { beforeEach, describe, expect, it, vi } from 'vitest';
import { installChrome } from '../helpers/load.js';
import {
  createDefaultInstance,
  createInstance,
  duplicateInstance,
  getActiveInstance,
  getCredentialInfo,
  getFullSettings,
  getInstanceCredentials,
  getInstances,
  getPublicSettings,
  hasKey,
  isInstancePermitted,
  removeCredentials,
  removeInstance,
  resolveActiveInstance,
  saveInstances,
  setActiveInstance,
  setInstanceEnabled,
  setKeyStorage,
  updateInstance,
  writeCredentials,
} from '../../src/shared/config/instances.js';
import { STORAGE_KEYS } from '../../src/shared/storage.js';
import {
  BAIDU_BATCH_MAX_CHARS,
  BAIDU_BATCH_SIZE,
  BAIDU_MAX_CONCURRENCY,
  BAIDU_QPS,
  DEFAULT_QUICK_PROMPT,
  DEFAULT_SYSTEM_PROMPT,
  MAX_INSTANCES,
} from '../../src/shared/config/registry.js';
import { getSettings } from '../../src/shared/settings.js';

beforeEach(() => {
  installChrome();
});

/** 读原始实例数组（不合并提示词）。 */
async function rawInstances() {
  const data = await chrome.storage.sync.get(STORAGE_KEYS.instances);
  return data[STORAGE_KEYS.instances] ?? [];
}

/** 读本地存储两个键。 */
async function readLocal(keys) {
  return chrome.storage.local.get(keys);
}

/**
 * 创建带凭据的 OpenAI 实例。
 * @param {{ name?: string, apiKey?: string, preset?: string }} [options]
 */
async function createWithKey({ name, apiKey = 'sk-test', preset = 'deepseek' } = {}) {
  const created = await createInstance({ type: 'openai', preset, name });
  await writeCredentials(created.id, { apiKey });
  return (await getInstances()).find((instance) => instance.id === created.id);
}

describe('E3 实例 CRUD 与默认值', () => {
  it('createInstance 生成默认 OpenAI 实例：启用、DeepSeek 预设、时间戳、提示词入 local', async () => {
    const created = await createInstance({ type: 'openai' });

    expect(created).toMatchObject({
      type: 'openai',
      preset: 'deepseek',
      name: 'DeepSeek',
      enabled: true,
      requiresKey: true,
      hasKey: false,
      credentialStatus: false,
    });
    expect(typeof created.id).toBe('string');
    expect(Number.isFinite(created.createdAt)).toBe(true);
    expect(Number.isFinite(created.updatedAt)).toBe(true);
    expect(created.endpoint.baseUrl).toBe('https://api.deepseek.com');
    expect(created.model).toBe('deepseek-chat');

    const raw = await rawInstances();
    expect(raw).toHaveLength(1);
    expect(raw[0]).not.toHaveProperty('systemPrompt');
    expect(raw[0]).not.toHaveProperty('apiKey');
    const local = await readLocal([
      `systemPrompt:${created.id}`,
      `quickPrompt:${created.id}`,
    ]);
    expect(local[`systemPrompt:${created.id}`]).toBe(DEFAULT_SYSTEM_PROMPT);
    expect(local[`quickPrompt:${created.id}`]).toBe(DEFAULT_QUICK_PROMPT);
    expect(created.quickPrompt).toBe(DEFAULT_QUICK_PROMPT);
  });

  it('createInstance 百度实例使用固定地址/模型并夹取批次范围', async () => {
    const created = await createInstance({
      type: 'baidu',
      batchSize: 99,
      batchMaxChars: 9999,
      maxConcurrency: 99,
      qps: 500,
    });

    expect(created).toMatchObject({
      type: 'baidu',
      typeLabel: '百度翻译',
      kind: 'traditional',
      baseUrl: 'https://fanyi-api.baidu.com',
      model: 'general',
      batchSize: BAIDU_BATCH_SIZE.max,
      batchMaxChars: BAIDU_BATCH_MAX_CHARS.max,
      maxConcurrency: BAIDU_MAX_CONCURRENCY.max,
      qps: BAIDU_QPS.max,
      requiresKey: true,
      hasKey: false,
    });
    const local = await readLocal([`systemPrompt:${created.id}`]);
    expect(local[`systemPrompt:${created.id}`]).toBeUndefined();
  });

  it('旧百度实例缺 qps 时读取默认 1；OpenAI 实例没有该字段', async () => {
    await chrome.storage.sync.set({
      [STORAGE_KEYS.instances]: [
        {
          id: 'inst-legacy-baidu',
          type: 'baidu',
          name: '旧百度',
          enabled: true,
          baseUrl: 'https://fanyi-api.baidu.com',
          model: 'general',
          batchSize: 8,
          batchMaxChars: 1000,
          maxConcurrency: 1,
        },
      ],
    });
    const [legacy] = await getInstances();
    expect(legacy.qps).toBe(BAIDU_QPS.default);

    const openai = await createInstance({ type: 'openai' });
    expect(openai).not.toHaveProperty('qps');

    const { instances } = await getPublicSettings();
    const baiduItem = instances.find((item) => item.type === 'baidu');
    const openaiItem = instances.find((item) => item.type === 'openai');
    expect(baiduItem.qps).toBe(BAIDU_QPS.default);
    expect(openaiItem).not.toHaveProperty('qps');
  });

  it('实例名称唯一（忽略大小写与首尾空白），默认名自动加序号', async () => {
    await createInstance({ type: 'openai', name: 'DeepSeek' });
    await expect(createInstance({ type: 'openai', name: ' deepseek ' })).rejects.toThrow(
      '实例名称已存在'
    );

    const second = await createInstance({ type: 'openai' });
    expect(second.name).toBe('DeepSeek 2');
    await expect(
      createInstance({ type: 'baidu', name: 'x'.repeat(41) })
    ).rejects.toThrow('实例名称必须是');
  });

  it('实例数量上限 20', async () => {
    for (let index = 0; index < MAX_INSTANCES; index += 1) {
      await createInstance({ type: 'baidu' });
    }
    await expect(createInstance({ type: 'baidu' })).rejects.toThrow(
      `最多只能创建 ${MAX_INSTANCES} 个翻译实例`
    );
    expect(await rawInstances()).toHaveLength(MAX_INSTANCES);
  });

  it('实例字节上限：超限时抛错且不写入', async () => {
    const created = await createInstance({ type: 'openai' });
    const headers = Array.from({ length: 40 }, (_, index) => ({
      name: `X-Test-${index}`,
      value: 'v'.repeat(200),
    }));
    await expect(updateInstance(created.id, { headers })).rejects.toThrow('实例配置过大');
    const stored = await getInstances();
    expect(stored[0].headers).toEqual([]);
  });

  it('不支持的类型保留，只允许查看与删除', async () => {
    await chrome.storage.sync.set({
      [STORAGE_KEYS.instances]: [
        { id: 'future', type: 'deepl', name: 'Future', enabled: false, extraField: 'keep' },
      ],
    });

    const [instance] = await getInstances();
    expect(instance).toMatchObject({ id: 'future', type: 'deepl', name: 'Future' });
    expect(instance.extraField).toBe('keep');

    const { instances } = await getPublicSettings();
    expect(instances[0]).toMatchObject({
      typeLabel: '不支持',
      kind: 'unsupported',
      hasKey: false,
      permission: 'unsupported',
    });

    await expect(updateInstance('future', { name: 'X' })).rejects.toThrow('不支持的实例类型');
    await expect(setInstanceEnabled('future', true)).rejects.toThrow('不支持的实例类型');
    await expect(setActiveInstance('future')).rejects.toThrow();
    await expect(duplicateInstance('future')).rejects.toThrow('不支持的实例类型');
    await removeInstance('future');
    expect(await rawInstances()).toEqual([]);
  });
});

describe('E3 实例更新、复制与删除', () => {
  it('updateInstance 合并字段、更新提示词并保留 created/updated 语义', async () => {
    const created = await createInstance({ type: 'openai' });
    const updated = await updateInstance(created.id, {
      model: 'deepseek-reasoner',
      batchSize: 3,
      systemPrompt: '自定义 {{targetLang}} {{outputFormat}}',
    });

    expect(updated.model).toBe('deepseek-reasoner');
    expect(updated.batchSize).toBe(3);
    expect(updated.createdAt).toBe(created.createdAt);
    expect(updated.updatedAt).toBeGreaterThanOrEqual(created.updatedAt);

    const local = await readLocal([`systemPrompt:${created.id}`]);
    expect(local[`systemPrompt:${created.id}`]).toBe('自定义 {{targetLang}} {{outputFormat}}');
    const raw = await rawInstances();
    expect(raw[0]).not.toHaveProperty('systemPrompt');
  });

  it('updateInstance 校验失败或名称冲突时抛错且不写入', async () => {
    const first = await createInstance({ type: 'openai', name: 'One' });
    await createInstance({ type: 'baidu', name: 'Two' });

    await expect(updateInstance(first.id, { model: '' })).rejects.toThrow();
    await expect(updateInstance(first.id, { name: 'two' })).rejects.toThrow('实例名称已存在');
    const stored = (await getInstances()).find((instance) => instance.id === first.id);
    expect(stored.model).toBe('deepseek-chat');
    expect(stored.name).toBe('One');
  });

  it('预设切换：DeepSeek 套用预设默认连接配置，自定义保留当前配置', async () => {
    const custom = await createInstance({
      type: 'openai',
      preset: 'custom',
      name: 'Local',
      endpoint: { baseUrl: 'https://llm.example.com', path: '/v1/chat/completions' },
      model: 'local-model',
    });
    expect(custom.preset).toBe('custom');

    const switched = await updateInstance(custom.id, { preset: 'deepseek' });
    expect(switched.preset).toBe('deepseek');
    expect(switched.endpoint.baseUrl).toBe('https://api.deepseek.com');
    expect(switched.model).toBe('deepseek-chat');

    const customAgain = await updateInstance(custom.id, { preset: 'custom' });
    expect(customAgain.preset).toBe('custom');
    expect(customAgain.endpoint.baseUrl).toBe('https://api.deepseek.com');
  });

  it('duplicateInstance：默认停用、不复制凭据、名称加「副本」、提示词一并复制', async () => {
    const source = await createWithKey({ name: 'Primary' });
    await updateInstance(source.id, { systemPrompt: '复制我 {{targetLang}} {{outputFormat}}' });

    const copy = await duplicateInstance(source.id);
    expect(copy.name).toBe('Primary 副本');
    expect(copy.enabled).toBe(false);
    expect(copy.hasKey).toBe(false);
    expect(copy.requiresKey).toBe(true);
    expect(copy.id).not.toBe(source.id);

    const localSource = await readLocal([`systemPrompt:${source.id}`]);
    const localCopy = await readLocal([`systemPrompt:${copy.id}`]);
    expect(localCopy[`systemPrompt:${copy.id}`]).toBe(
      localSource[`systemPrompt:${source.id}`]
    );

    const settings = await getSettings();
    expect(settings.activeInstanceId).toBe(source.id);
  });

  it('removeInstance：先删凭据与提示词，再改选当前实例', async () => {
    const first = await createWithKey({ name: 'First' });
    const second = await createWithKey({ name: 'Second', apiKey: 'sk-2' });
    expect((await getSettings()).activeInstanceId).toBe(first.id);

    const result = await removeInstance(first.id);
    expect(result).toMatchObject({ removed: first.id, activeInstanceId: second.id });
    expect((await getSettings()).activeInstanceId).toBe(second.id);

    const local = await readLocal([`systemPrompt:${first.id}`, `engineKey:${first.id}`]);
    expect(local[`systemPrompt:${first.id}`]).toBeUndefined();
    expect(local[`engineKey:${first.id}`]).toBeUndefined();
    expect(await rawInstances()).toHaveLength(1);
  });
});

describe('E3 启用状态与当前实例', () => {
  it('停用当前实例改选下一个可用；没有可用时为 null', async () => {
    const first = await createWithKey({ name: 'First' });
    const second = await createWithKey({ name: 'Second', apiKey: 'sk-2' });
    expect((await getSettings()).activeInstanceId).toBe(first.id);

    await setInstanceEnabled(first.id, false);
    expect((await getSettings()).activeInstanceId).toBe(second.id);

    await setInstanceEnabled(second.id, false);
    expect((await getSettings()).activeInstanceId).toBeNull();
  });

  it('启用实例时若当前为空且可用，自动设为当前', async () => {
    const created = await createWithKey({ name: 'Only' });
    await setInstanceEnabled(created.id, false);
    expect((await getSettings()).activeInstanceId).toBeNull();

    await setInstanceEnabled(created.id, true);
    expect((await getSettings()).activeInstanceId).toBe(created.id);
  });

  it('setActiveInstance 只接受受支持、启用、凭据完整且已授权的实例', async () => {
    const usable = await createWithKey({ name: 'Usable' });
    const second = await createInstance({ type: 'baidu', name: 'Baidu' });

    await expect(setActiveInstance(second.id)).rejects.toThrow('缺少凭据');
    await setInstanceEnabled(second.id, false);
    await expect(setActiveInstance(second.id)).rejects.toThrow('实例已停用');
    await expect(setActiveInstance('missing')).rejects.toThrow('实例不存在');

    const active = await setActiveInstance(usable.id);
    expect(active.id).toBe(usable.id);
  });

  it('自定义 endpoint 未授权时不可设为当前，授权后恢复', async () => {
    const created = await createInstance({
      type: 'openai',
      preset: 'custom',
      name: 'Local',
      endpoint: { baseUrl: 'https://llm.example.com', path: '/v1/chat/completions' },
      model: 'local-model',
    });
    await writeCredentials(created.id, { apiKey: 'sk-local' });

    await expect(setActiveInstance(created.id)).rejects.toThrow('接口域名未授权');
    expect(await getActiveInstance()).toBeNull();

    await chrome.permissions.request({ origins: ['https://llm.example.com/*'] });
    expect(await isInstancePermitted(await getInstances().then((list) => list[0]))).toBe(true);
    await setActiveInstance(created.id);
    expect((await getSettings()).activeInstanceId).toBe(created.id);
  });

  it('getActiveInstance 只读：没有实例时返回 null 且不写存储', async () => {
    expect(await getActiveInstance()).toBeNull();
    expect(await rawInstances()).toEqual([]);
    const resolved = await resolveActiveInstance();
    expect(resolved).toMatchObject({ instance: null, reason: 'no-instance' });
  });

  it('resolveActiveInstance 跳过被停用/缺凭据的实例并给出原因', async () => {
    const usable = await createWithKey({ name: 'Usable' });
    await setInstanceEnabled(usable.id, false);
    const resolved = await resolveActiveInstance();
    expect(resolved.instance).toBeNull();
    expect(resolved.reason).toBe('disabled');
  });
});

describe('E3 每实例凭据', () => {
  it('OpenAI 凭据以 JSON 存在 local，hasKey 不暴露明文', async () => {
    const created = await createInstance({ type: 'openai' });
    expect(await hasKey(created.id)).toBe(false);

    await writeCredentials(created.id, { apiKey: 'sk-secret' });
    expect(await hasKey(created.id)).toBe(true);
    expect((await getInstanceCredentials(created.id)).apiKey).toBe('sk-secret');

    const local = await readLocal([`engineKey:${created.id}`]);
    expect(local[`engineKey:${created.id}`]).toEqual({ apiKey: 'sk-secret' });

    const { instances } = await getPublicSettings();
    expect(instances[0].hasKey).toBe(true);
    expect(instances[0].credentialStatus).toBe(true);
    expect(JSON.stringify(instances[0])).not.toContain('sk-secret');
  });

  it('无认证 OpenAI 实例无需凭据，hasKey 恒为 true', async () => {
    const created = await createInstance({
      type: 'openai',
      preset: 'custom',
      name: 'NoAuth',
      auth: { type: 'none' },
      endpoint: { baseUrl: 'http://localhost:11434', path: '/v1/chat/completions' },
      model: 'local',
    });

    const info = await getCredentialInfo(created);
    expect(info.requiresKey).toBe(false);
    expect(info.hasKey).toBe(true);
    expect(info.credentialStatus).toBe(true);
  });

  it('百度凭据需要 APPID 与密钥同时完整', async () => {
    const created = await createInstance({ type: 'baidu' });
    await writeCredentials(created.id, { appId: 'app-1' });
    expect(await hasKey(created.id)).toBe(false);

    const info = await writeCredentials(created.id, { secretKey: 'secret-1' });
    expect(info).toMatchObject({ requiresKey: true, hasKey: true, credentialStatus: true });
    expect(await getInstanceCredentials(created.id)).toEqual({
      appId: 'app-1',
      secretKey: 'secret-1',
    });
  });

  it('leave 空字段表示不修改，显式空值清除全部凭据', async () => {
    const created = await createInstance({ type: 'baidu' });
    await writeCredentials(created.id, { appId: 'app', secretKey: 'secret' });

    await writeCredentials(created.id, { appId: 'app-2' });
    expect(await getInstanceCredentials(created.id)).toEqual({
      appId: 'app-2',
      secretKey: 'secret',
    });

    await writeCredentials(created.id, { appId: '', secretKey: '' });
    expect(await hasKey(created.id)).toBe(false);
  });

  it('removeCredentials 删除 local 与 sync 两区副本，并改选当前实例', async () => {
    const first = await createWithKey({ name: 'First' });
    const second = await createWithKey({ name: 'Second', apiKey: 'sk-2' });
    await chrome.storage.sync.set({ [`engineKey:${first.id}`]: { apiKey: 'sk-copy' } });

    await removeCredentials(first.id);
    const local = await readLocal([`engineKey:${first.id}`]);
    const sync = await chrome.storage.sync.get(`engineKey:${first.id}`);
    expect(local[`engineKey:${first.id}`]).toBeUndefined();
    expect(sync[`engineKey:${first.id}`]).toBeUndefined();
    expect((await getSettings()).activeInstanceId).toBe(second.id);
  });

  it('兼容旧单字符串密钥：按 OpenAI `{ apiKey }` 读取', async () => {
    const created = await createInstance({ type: 'openai' });
    await chrome.storage.local.set({ [`engineKey:${created.id}`]: 'sk-legacy' });

    expect(await getInstanceCredentials(created.id)).toEqual({ apiKey: 'sk-legacy' });
    expect(await hasKey(created.id)).toBe(true);
  });

  it('keyStorage 切换：凭据搬到目标区，源区删除', async () => {
    const created = await createWithKey({ name: 'First' });
    const result = await setKeyStorage('sync');

    expect(result).toMatchObject({ area: 'sync', migrated: 1 });
    expect((await getSettings()).keyStorage).toBe('sync');
    const sync = await chrome.storage.sync.get(`engineKey:${created.id}`);
    const local = await readLocal([`engineKey:${created.id}`]);
    expect(sync[`engineKey:${created.id}`]).toEqual({ apiKey: 'sk-test' });
    expect(local[`engineKey:${created.id}`]).toBeUndefined();
    expect(await getInstanceCredentials(created.id)).toEqual({ apiKey: 'sk-test' });
  });

  it('keyStorage 切换失败时回滚设置并保留原数据', async () => {
    const created = await createWithKey({ name: 'First' });
    const originalSet = chrome.storage.sync.set.bind(chrome.storage.sync);
    const setSpy = vi
      .spyOn(chrome.storage.sync, 'set')
      .mockImplementation(async (values) => {
        if (Object.hasOwn(values, STORAGE_KEYS.settings)) throw new Error('quota');
        return originalSet(values);
      });

    await expect(setKeyStorage('sync')).rejects.toThrow('quota');
    setSpy.mockRestore();

    expect((await getSettings()).keyStorage).toBe('local');
    const local = await readLocal([`engineKey:${created.id}`]);
    expect(local[`engineKey:${created.id}`]).toEqual({ apiKey: 'sk-test' });
    const sync = await chrome.storage.sync.get(`engineKey:${created.id}`);
    expect(sync[`engineKey:${created.id}`]).toBeUndefined();
  });
});

describe('E3 提示词与公开字段', () => {
  it('getInstances 合并 local 提示词；缺失时回退默认模板', async () => {
    const created = await createInstance({ type: 'openai' });
    let [instance] = await getInstances();
    expect(instance.systemPrompt).toBe(DEFAULT_SYSTEM_PROMPT);

    await chrome.storage.local.set({ [`systemPrompt:${created.id}`]: '自定义 {{targetLang}} {{outputFormat}}' });
    [instance] = await getInstances();
    expect(instance.systemPrompt).toBe('自定义 {{targetLang}} {{outputFormat}}');
  });

  it('快速翻译提示词：默认写入、可更新、复制与删除', async () => {
    const created = await createInstance({ type: 'openai' });
    let local = await readLocal([`quickPrompt:${created.id}`]);
    expect(local[`quickPrompt:${created.id}`]).toBe(DEFAULT_QUICK_PROMPT);

    let [instance] = await getInstances();
    expect(instance.quickPrompt).toBe(DEFAULT_QUICK_PROMPT);

    const custom = '快速模板 {{targetLang}} {{outputFormat}}';
    const updated = await updateInstance(created.id, { quickPrompt: custom });
    expect(updated.quickPrompt).toBe(custom);
    [instance] = await getInstances();
    expect(instance.quickPrompt).toBe(custom);

    await expect(updateInstance(created.id, { quickPrompt: '缺少占位符' })).rejects.toThrow(
      '快速翻译提示词'
    );

    const duplicate = await duplicateInstance(created.id);
    expect(duplicate.quickPrompt).toBe(custom);
    local = await readLocal([`quickPrompt:${duplicate.id}`]);
    expect(local[`quickPrompt:${duplicate.id}`]).toBe(custom);

    await removeInstance(created.id);
    local = await readLocal([`quickPrompt:${created.id}`]);
    expect(local[`quickPrompt:${created.id}`]).toBeUndefined();
  });

  it('迁移前旧实例内提示词作为读取回退，local 优先', async () => {
    await chrome.storage.sync.set({
      [STORAGE_KEYS.instances]: [
        {
          id: 'legacy',
          type: 'deepseek',
          name: 'Legacy',
          systemPrompt: '实例内旧提示词 {{targetLang}} {{outputFormat}}',
        },
      ],
    });

    let [instance] = await getInstances();
    expect(instance.systemPrompt).toBe('实例内旧提示词 {{targetLang}} {{outputFormat}}');

    await chrome.storage.local.set({
      'systemPrompt:legacy': '本地新提示词 {{targetLang}} {{outputFormat}}',
    });
    [instance] = await getInstances();
    expect(instance.systemPrompt).toBe('本地新提示词 {{targetLang}} {{outputFormat}}');
  });

  it('saveInstances 去掉运行时字段，不把提示词写回 sync', async () => {
    const created = await createInstance({ type: 'openai' });
    const view = { ...created, systemPrompt: 'should not persist', apiKey: 'sk-x' };
    await saveInstances([view]);
    const raw = await rawInstances();
    expect(raw[0]).not.toHaveProperty('systemPrompt');
    expect(raw[0]).not.toHaveProperty('apiKey');
  });

  it('公开列表包含类型/预设/凭据/权限状态，不含凭据明文', async () => {
    const created = await createWithKey({ name: 'Public' });
    const { instances } = await getPublicSettings();
    const item = instances[0];

    expect(item).toMatchObject({
      id: created.id,
      type: 'openai',
      typeLabel: 'OpenAI 兼容',
      kind: 'llm',
      preset: 'deepseek',
      name: 'Public',
      enabled: true,
      hasKey: true,
      credentialStatus: true,
      requiresKey: true,
      permission: 'granted',
      model: 'deepseek-chat',
    });
    expect(item.endpoint.baseUrl).toBe('https://api.deepseek.com');
    expect(item.auth).toBeTruthy();
    expect(item.params).toBeTruthy();
    expect(item.systemPrompt).toBe(DEFAULT_SYSTEM_PROMPT);
    expect(item).not.toHaveProperty('apiKey');
    expect(item).not.toHaveProperty('appId');
    expect(item).not.toHaveProperty('secretKey');
  });

  it('getFullSettings 含凭据明文，仅后台使用', async () => {
    const created = await createWithKey({ name: 'Full', apiKey: 'sk-full' });
    const { instances } = await getFullSettings();
    expect(instances[0].credentials).toMatchObject({ apiKey: 'sk-full' });
    expect(instances[0].id).toBe(created.id);
  });

  it('createDefaultInstance 返回 OpenAI + DeepSeek 预设的默认实例', () => {
    const instance = createDefaultInstance();
    expect(instance).toMatchObject({
      type: 'openai',
      preset: 'deepseek',
      name: 'DeepSeek',
      enabled: true,
    });
    expect(instance.systemPrompt).toBe(DEFAULT_SYSTEM_PROMPT);
  });
});
