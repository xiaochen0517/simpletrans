/**
 * E3 引擎实例与密钥测试
 *
 * 覆盖 P6.2：默认实例字段、旧实例读取补齐与并发迁移、updateInstance 合并/校验/失败不写入。
 */

import { beforeEach, describe, expect, it } from 'vitest';
import { installChrome } from '../helpers/load.js';
import {
  createDefaultInstance,
  getActiveInstance,
  getFullSettings,
  getInstances,
  getKey,
  getOrCreateDefaultInstance,
  getPublicSettings,
  hasKey,
  keyName,
  normalizeInstance,
  updateInstance,
  writeKey,
} from '../../src/shared/config/instances.js';
import {
  DEFAULT_BATCH_MAX_CHARS,
  DEFAULT_BATCH_SIZE,
  DEFAULT_MAX_CONCURRENCY,
  DEFAULT_SYSTEM_PROMPT,
} from '../../src/shared/config/registry.js';
import { saveSettings } from '../../src/shared/settings.js';

/** 读原始实例列表，用于确认没有发生隐式写回。 */
async function rawInstances() {
  const data = await chrome.storage.sync.get('engineInstances');
  return data.engineInstances ?? [];
}

describe('E3 引擎实例与密钥', () => {
  beforeEach(() => installChrome());

  it('getOrCreateDefaultInstance 惰性创建默认实例，不重复创建', async () => {
    expect(await getInstances()).toEqual([]);
    const instance = await getOrCreateDefaultInstance();
    expect(instance.type).toBe('deepseek');
    expect(instance.model).toBeTruthy();
    expect(await getInstances()).toHaveLength(1);

    await getOrCreateDefaultInstance();
    expect(await getInstances()).toHaveLength(1);
  });

  it('getActiveInstance 默认取第一个实例，并按 activeInstanceId 切换', async () => {
    await chrome.storage.sync.set({
      engineInstances: [
        { id: 'a', type: 'deepseek', name: 'A', model: 'deepseek-chat' },
        { id: 'b', type: 'deepseek', name: 'B', model: 'deepseek-reasoner' },
      ],
    });

    expect((await getActiveInstance()).id).toBe('a');

    await saveSettings({ activeInstanceId: 'b' });
    expect((await getActiveInstance()).id).toBe('b');

    // 记录的首选实例不存在时回退第一个，不抛错。
    await saveSettings({ activeInstanceId: 'missing' });
    expect((await getActiveInstance()).id).toBe('a');
  });

  it('getActiveInstance 只读：没有实例时返回 null 且不创建', async () => {
    expect(await getActiveInstance()).toBeNull();
    expect(await getInstances()).toHaveLength(0);

    const created = await getActiveInstance({ create: true });
    expect(created.id).toBe('default');
    expect(await getInstances()).toHaveLength(1);
  });

  it('createDefaultInstance 写入 P6.2 的默认参数', () => {
    const instance = createDefaultInstance();
    expect(instance).toMatchObject({
      reasoningEffort: 'off',
      batchSize: DEFAULT_BATCH_SIZE,
      batchMaxChars: DEFAULT_BATCH_MAX_CHARS,
      maxConcurrency: DEFAULT_MAX_CONCURRENCY,
      systemPrompt: DEFAULT_SYSTEM_PROMPT,
    });
  });

  it('旧实例读取时补齐默认字段，但不主动写回', async () => {
    const legacy = {
      id: 'legacy',
      type: 'deepseek',
      name: '旧实例',
      model: 'deepseek-chat',
      baseUrl: 'https://api.deepseek.com',
    };
    await chrome.storage.sync.set({ engineInstances: [legacy] });

    const [instance] = await getInstances();
    expect(instance).toMatchObject({
      id: 'legacy',
      name: '旧实例',
      reasoningEffort: 'off',
      batchSize: DEFAULT_BATCH_SIZE,
      batchMaxChars: DEFAULT_BATCH_MAX_CHARS,
      systemPrompt: DEFAULT_SYSTEM_PROMPT,
    });
    // 默认设置 concurrency=3，旧实例缺 maxConcurrency 时按它迁移。
    expect(instance.maxConcurrency).toBe(3);

    const raw = await rawInstances();
    expect(raw[0]).toEqual(legacy);
    expect(raw[0]).not.toHaveProperty('systemPrompt');
  });

  it('旧实例并发迁移优先取 settings.concurrency，非法值回退 4', async () => {
    await chrome.storage.sync.set({
      engineInstances: [{ id: 'legacy', type: 'deepseek', name: '旧', model: 'deepseek-chat' }],
    });
    await saveSettings({ concurrency: 2 });
    expect((await getInstances())[0].maxConcurrency).toBe(2);

    await saveSettings({ concurrency: 0 });
    expect((await getInstances())[0].maxConcurrency).toBe(DEFAULT_MAX_CONCURRENCY);

    await saveSettings({ concurrency: 8 });
    expect((await getInstances())[0].maxConcurrency).toBe(8);
  });

  it('已有 maxConcurrency 的实例不受 settings.concurrency 影响', async () => {
    await saveSettings({ concurrency: 2 });
    const instance = await getOrCreateDefaultInstance();
    expect(instance.maxConcurrency).toBe(DEFAULT_MAX_CONCURRENCY);
  });

  it('normalizeInstance 归一非法值，空提示词保留为空交给校验', () => {
    const normalized = normalizeInstance({
      id: 'x',
      type: 'deepseek',
      model: '  m  ',
      reasoningEffort: 'turbo',
      batchSize: 99,
      batchMaxChars: 0,
      maxConcurrency: -1,
      systemPrompt: '   ',
    });
    expect(normalized.model).toBe('m');
    expect(normalized.reasoningEffort).toBe('off');
    expect(normalized.batchSize).toBe(99);
    expect(normalized.batchMaxChars).toBe(DEFAULT_BATCH_MAX_CHARS);
    expect(normalized.maxConcurrency).toBe(DEFAULT_MAX_CONCURRENCY);
    expect(normalized.systemPrompt).toBe('');
  });

  it('updateInstance 合并、归一并写回完整字段', async () => {
    const instance = await getOrCreateDefaultInstance();
    const prompt = '自定义 {{targetLang}} 模板，{{outputFormat}}';

    const next = await updateInstance(instance.id, {
      model: '  deepseek-chat-v2  ',
      reasoningEffort: 'low',
      batchSize: 4,
      batchMaxChars: 300,
      maxConcurrency: 2,
      systemPrompt: prompt,
    });

    expect(next).toMatchObject({
      model: 'deepseek-chat-v2',
      reasoningEffort: 'low',
      batchSize: 4,
      batchMaxChars: 300,
      maxConcurrency: 2,
      systemPrompt: prompt,
    });

    const stored = (await rawInstances())[0];
    expect(stored).toMatchObject({
      id: instance.id,
      model: 'deepseek-chat-v2',
      reasoningEffort: 'low',
      batchSize: 4,
      batchMaxChars: 300,
      maxConcurrency: 2,
      systemPrompt: prompt,
    });
  });

  it('updateInstance 不限制单批段数上限', async () => {
    const instance = await getOrCreateDefaultInstance();
    const next = await updateInstance(instance.id, { batchSize: 20 });
    expect(next.batchSize).toBe(20);
    expect((await rawInstances())[0].batchSize).toBe(20);
  });

  it('updateInstance 校验失败时抛错且不写入', async () => {
    const instance = await getOrCreateDefaultInstance();
    const before = await rawInstances();

    await expect(updateInstance(instance.id, { model: '   ' })).rejects.toThrow();
    await expect(
      updateInstance(instance.id, { systemPrompt: '缺少两个占位符' })
    ).rejects.toThrow();
    await expect(updateInstance('missing', { model: 'm' })).rejects.toThrow('实例不存在');

    expect(await rawInstances()).toEqual(before);
  });

  it('密钥键名与读写：默认存 local，hasKey 不暴露明文', async () => {
    const instance = await getOrCreateDefaultInstance();
    expect(keyName(instance.id)).toBe(`engineKey:${instance.id}`);
    expect(await hasKey(instance.id)).toBe(false);

    await writeKey(instance.id, 'sk-test');
    expect(await getKey(instance.id)).toBe('sk-test');
    expect(await hasKey(instance.id)).toBe(true);
  });

  it('公开设置不含密钥，完整设置含密钥', async () => {
    const instance = await getOrCreateDefaultInstance();
    await writeKey(instance.id, 'sk-secret');

    const pub = await getPublicSettings();
    expect(pub.instances[0]).not.toHaveProperty('apiKey');
    expect(pub.instances[0].hasKey).toBe(true);

    const full = await getFullSettings();
    expect(full.instances[0].apiKey).toBe('sk-secret');
  });

  it('更新实例参数不影响密钥', async () => {
    const instance = await getOrCreateDefaultInstance();
    await writeKey(instance.id, 'sk-keep');

    await updateInstance(instance.id, { batchSize: 2 });

    expect(await getKey(instance.id)).toBe('sk-keep');
    expect(await hasKey(instance.id)).toBe(true);
  });
});
