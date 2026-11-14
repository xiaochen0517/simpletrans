/**
 * E3 引擎类型目录
 *
 * 模块：公共模块（E）/ E3
 * 职责：维护各引擎类型的字段、默认值与校验规则，供设置页按类型生成表单、供配置模块校验实例。
 * 依赖：无（P1 起）。
 * 实现阶段：P1（引擎层与密钥配置）
 *
 * P1 只注册 DeepSeek 一个类型；传统服务商适配器与自定义地址留后续。
 * 注意：本文件含引擎地址与默认模型，属于 config/，页面注入（content）禁止引用（架构 5.1）。
 */

/** 引擎类型 id。 */
export const ENGINE_TYPE_IDS = Object.freeze({
  DEEPSEEK: 'deepseek',
});

/**
 * 引擎类型目录。每个类型：
 * - id：类型标识；
 * - label：显示名；
 * - baseUrl：接口地址（默认值）；
 * - defaultModel：默认模型；
 * - fields：实例可配置字段（P7 表单据此生成）。
 */
export const ENGINE_TYPES = Object.freeze({
  [ENGINE_TYPE_IDS.DEEPSEEK]: Object.freeze({
    id: 'deepseek',
    label: 'DeepSeek',
    baseUrl: 'https://api.deepseek.com',
    defaultModel: 'deepseek-chat',
    fields: Object.freeze(['apiKey', 'baseUrl', 'model']),
  }),
});

/**
 * 取引擎类型定义；未知类型返回 null。
 * @param {string} typeId
 * @returns {Record<string, unknown> | null}
 */
export function getEngineType(typeId) {
  return ENGINE_TYPES[typeId] ?? null;
}

/**
 * 校验引擎实例（结构层校验；密钥存在性由 instances.js 单独判断）。
 * @param {unknown} instance
 * @returns {{ ok: boolean, errors: string[] }}
 */
export function validateInstance(instance) {
  const errors = [];
  if (!instance || typeof instance !== 'object') {
    return { ok: false, errors: ['实例不能为空'] };
  }
  const type = getEngineType(instance.type);
  if (!type) {
    return { ok: false, errors: ['未知的引擎类型'] };
  }
  if (!instance.model || String(instance.model).trim() === '') {
    errors.push('缺少模型名');
  }
  return { ok: errors.length === 0, errors };
}
