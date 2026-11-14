/**
 * E2 存储读写测试
 */

import { beforeEach, describe, expect, it } from 'vitest';
import { installChrome } from '../helpers/load.js';
import { clearArea, read, removeKeys, write } from '../../src/shared/storage.js';

describe('E2 存储读写', () => {
  beforeEach(() => installChrome());

  it('三个分区相互隔离', async () => {
    await write('local', { a: 1 });
    await write('sync', { a: 2 });
    expect((await read('local', 'a')).a).toBe(1);
    expect((await read('sync', 'a')).a).toBe(2);
    expect((await read('session', 'a')).a).toBeUndefined();
  });

  it('get 支持字符串、数组、对象带默认值三种入参', async () => {
    await write('local', { a: 1, b: 2 });
    expect(await read('local', 'a')).toEqual({ a: 1 });
    expect(await read('local', ['a', 'b'])).toEqual({ a: 1, b: 2 });
    // 对象入参合并默认值：存在的取存储值，缺失的取默认值
    expect(await read('local', { a: 0, c: 9 })).toEqual({ a: 1, c: 9 });
  });

  it('数组入参省略缺失键', async () => {
    await write('local', { a: 1 });
    expect(await read('local', ['a', 'missing'])).toEqual({ a: 1 });
  });

  it('set 合并、remove 删除、clear 清空', async () => {
    await write('local', { a: 1 });
    await write('local', { b: 2 });
    expect(await read('local', ['a', 'b'])).toEqual({ a: 1, b: 2 });
    await removeKeys('local', 'a');
    expect((await read('local', 'a')).a).toBeUndefined();
    await clearArea('local');
    expect(await read('local', ['b'])).toEqual({});
  });
});
