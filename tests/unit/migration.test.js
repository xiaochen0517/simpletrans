/**
 * E3 配置迁移 v1 → v2 测试
 *
 * 覆盖旧 DeepSeek 映射、提示词搬家、旧单字符串密钥对象化、当前实例改选、
 * 不支持类型保留、空配置默认实例、幂等与失败重试。
 */

import { beforeEach, describe, expect, it, vi } from 'vitest';
import { installChrome } from '../helpers/load.js';
import {
  getInstanceCredentials,
  getInstances,
  getPublicSettings,
  migrateConfig,
} from '../../src/shared/config/instances.js';
import { getSettings } from '../../src/shared/settings.js';
import { STORAGE_KEYS } from '../../src/shared/storage.js';
import { DEFAULT_SYSTEM_PROMPT } from '../../src/shared/config/registry.js';

beforeEach(() => {
  installChrome();
});

/** 旧版 DeepSeek 实例。 */
function legacyDeepSeek(patch = {}) {
  return {
    id: 'default',
    type: 'deepseek',
    name: 'DeepSeek',
    model: 'deepseek-reasoner',
    baseUrl: 'https://api.deepseek.com',
    reasoningEffort: 'high',
    batchSize: 6,
    batchMaxChars: 1200,
    maxConcurrency: 5,
    systemPrompt: '旧提示词 {{targetLang}} {{outputFormat}}',
    ...patch,
  };
}

/** 读原始 sync 实例。 */
async function rawInstances() {
  const data = await chrome.storage.sync.get(STORAGE_KEYS.instances);
  return data[STORAGE_KEYS.instances] ?? [];
}

describe('E3 配置迁移 v1 → v2', () => {
  it('旧 DeepSeek 实例、提示词、密钥、并发与当前实例完整迁移', async () => {
    await chrome.storage.sync.set({
      settings: { concurrency: 5, targetLang: 'zh', activeInstanceId: 'default' },
    });
    await chrome.storage.sync.set({ [STORAGE_KEYS.instances]: [legacyDeepSeek()] });
    await chrome.storage.local.set({ 'engineKey:default': 'sk-legacy' });

    const result = await migrateConfig();
    expect(result).toEqual({ migrated: true, reason: undefined });

    const settings = await getSettings();
    expect(settings.configVersion).toBe(2);
    expect(settings).not.toHaveProperty('concurrency');
    expect(settings.activeInstanceId).toBe('default');

    const [instance] = await getInstances();
    expect(instance).toMatchObject({
      id: 'default',
      type: 'openai',
      preset: 'deepseek',
      name: 'DeepSeek',
      enabled: true,
      model: 'deepseek-reasoner',
      batchSize: 6,
      batchMaxChars: 1200,
      maxConcurrency: 5,
    });
    expect(instance.endpoint.baseUrl).toBe('https://api.deepseek.com');
    expect(instance.params.reasoning.mode).toBe('effort');
    expect(instance.params.reasoning.value).toBe('high');
    expect(instance.systemPrompt).toBe('旧提示词 {{targetLang}} {{outputFormat}}');
    expect(instance).not.toHaveProperty('baseUrl');
    expect(instance).not.toHaveProperty('reasoningEffort');

    const raw = await rawInstances();
    expect(raw[0]).not.toHaveProperty('systemPrompt');
    const local = await chrome.storage.local.get([
      'systemPrompt:default',
      'engineKey:default',
    ]);
    expect(local['systemPrompt:default']).toBe('旧提示词 {{targetLang}} {{outputFormat}}');
    expect(local['engineKey:default']).toEqual({ apiKey: 'sk-legacy' });
  });

  it('迁移幂等：第二次执行不再改动数据', async () => {
    await chrome.storage.sync.set({ [STORAGE_KEYS.instances]: [legacyDeepSeek()] });
    await migrateConfig();

    const before = await rawInstances();
    await chrome.storage.local.set({ 'systemPrompt:default': '迁移后自定义 {{targetLang}} {{outputFormat}}' });

    const second = await migrateConfig();
    expect(second).toEqual({ migrated: false });
    expect(await rawInstances()).toEqual(before);
    const [instance] = await getInstances();
    expect(instance.systemPrompt).toBe('迁移后自定义 {{targetLang}} {{outputFormat}}');
  });

  it('空存储首次迁移创建默认 DeepSeek 实例并写入默认提示词', async () => {
    const result = await migrateConfig();
    expect(result.migrated).toBe(true);

    const instances = await getInstances();
    expect(instances).toHaveLength(1);
    expect(instances[0]).toMatchObject({ type: 'openai', preset: 'deepseek', name: 'DeepSeek' });
    expect(instances[0].systemPrompt).toBe(DEFAULT_SYSTEM_PROMPT);

    const settings = await getSettings();
    expect(settings.configVersion).toBe(2);
    expect(settings.activeInstanceId).toBe(instances[0].id);
  });

  it('不支持的类型原样保留，不参与执行', async () => {
    await chrome.storage.sync.set({
      [STORAGE_KEYS.instances]: [
        { id: 'future', type: 'deepl', name: 'Future', enabled: false, extra: 'keep' },
      ],
    });
    await migrateConfig();

    const { instances } = await getPublicSettings();
    expect(instances).toHaveLength(1);
    expect(instances[0]).toMatchObject({
      id: 'future',
      type: 'deepl',
      typeLabel: '不支持',
      kind: 'unsupported',
    });
    const settings = await getSettings();
    expect(settings.activeInstanceId).toBeNull();
  });

  it('旧百度实例保留固定字段并夹取范围', async () => {
    await chrome.storage.sync.set({
      [STORAGE_KEYS.instances]: [
        {
          id: 'baidu',
          type: 'baidu',
          name: 'Baidu',
          batchSize: 99,
          batchMaxChars: 9999,
          maxConcurrency: 99,
        },
      ],
    });
    await migrateConfig();

    const [instance] = await getInstances();
    expect(instance).toMatchObject({
      type: 'baidu',
      name: 'Baidu',
      baseUrl: 'https://fanyi-api.baidu.com',
      model: 'general',
      batchSize: 20,
      batchMaxChars: 2000,
      maxConcurrency: 10,
    });
  });

  it('已有 local 提示词时不被实例内旧提示词覆盖', async () => {
    await chrome.storage.local.set({
      'systemPrompt:default': '本地新提示词 {{targetLang}} {{outputFormat}}',
    });
    await chrome.storage.sync.set({ [STORAGE_KEYS.instances]: [legacyDeepSeek()] });

    await migrateConfig();

    const local = await chrome.storage.local.get('systemPrompt:default');
    expect(local['systemPrompt:default']).toBe('本地新提示词 {{targetLang}} {{outputFormat}}');
    const [instance] = await getInstances();
    expect(instance.systemPrompt).toBe('本地新提示词 {{targetLang}} {{outputFormat}}');
  });

  it('已有对象凭据时不覆盖，仅删除旧单字符串副本', async () => {
    await chrome.storage.sync.set({
      [STORAGE_KEYS.instances]: [legacyDeepSeek()],
      settings: { keyStorage: 'sync' },
    });
    await chrome.storage.sync.set({
      'engineKey:default': { apiKey: 'sk-new' },
    });
    await chrome.storage.local.set({ 'engineKey:default': 'sk-old' });

    await migrateConfig();

    expect(await getInstanceCredentials('default')).toEqual({ apiKey: 'sk-new' });
    const local = await chrome.storage.local.get('engineKey:default');
    expect(local['engineKey:default']).toBeUndefined();
  });

  it('提示词写入失败时不标记完成，下次重试成功', async () => {
    await chrome.storage.sync.set({ [STORAGE_KEYS.instances]: [legacyDeepSeek()] });
    const originalSet = chrome.storage.local.set.bind(chrome.storage.local);
    const spy = vi.spyOn(chrome.storage.local, 'set').mockImplementation(async (values) => {
      if (Object.keys(values).some((key) => key.startsWith('systemPrompt:'))) {
        throw new Error('quota');
      }
      return originalSet(values);
    });

    const first = await migrateConfig();
    expect(first).toEqual({ migrated: true, reason: 'incomplete' });
    spy.mockRestore();

    const raw = await rawInstances();
    expect(raw[0].systemPrompt).toBe('旧提示词 {{targetLang}} {{outputFormat}}');
    let settings = await getSettings();
    expect(settings.configVersion).toBe(0);

    const second = await migrateConfig();
    expect(second).toEqual({ migrated: true, reason: undefined });
    expect((await rawInstances())[0]).not.toHaveProperty('systemPrompt');
    settings = await getSettings();
    expect(settings.configVersion).toBe(2);
    const local = await chrome.storage.local.get('systemPrompt:default');
    expect(local['systemPrompt:default']).toBe('旧提示词 {{targetLang}} {{outputFormat}}');
  });

  it('孤立旧密钥不会导致迁移反复执行', async () => {
    await chrome.storage.sync.set({ 'engineKey:deleted': 'sk-old' });
    expect((await migrateConfig()).migrated).toBe(true);
    expect(await migrateConfig()).toEqual({ migrated: false });
    const sync = await chrome.storage.sync.get('engineKey:deleted');
    expect(sync['engineKey:deleted']).toBe('sk-old');
  });

  it('configVersion 已为 2 但仍有旧标记时继续修复', async () => {
    await chrome.storage.sync.set({
      settings: { configVersion: 2 },
      [STORAGE_KEYS.instances]: [legacyDeepSeek()],
    });

    const result = await migrateConfig();
    expect(result.migrated).toBe(true);
    const [instance] = await getInstances();
    expect(instance.type).toBe('openai');
    expect((await rawInstances())[0]).not.toHaveProperty('systemPrompt');
  });
});
