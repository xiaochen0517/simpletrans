/**
 * E3 引擎实例与密钥测试
 */

import { beforeEach, describe, expect, it } from 'vitest';
import { installChrome } from '../helpers/load.js';
import {
  getFullSettings,
  getInstances,
  getKey,
  getOrCreateDefaultInstance,
  getPublicSettings,
  hasKey,
  keyName,
  writeKey,
} from '../../src/shared/config/instances.js';

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
});
