/**
 * B 弹窗实例选项助手
 *
 * 模块：工具栏弹窗（B）
 * 职责：把后台公开实例字段转成可选项：判断是否可在弹窗选用、生成「类型/预设 · 模型」次要文案。
 * 依赖：无。
 *
 * 只读公开字段，不读写存储、不发消息。
 */

/**
 * 判断实例是否可在弹窗中选用：已启用且凭据完整（无认证实例 `hasKey` 为 true）。
 * @param {Record<string, unknown>} instance
 * @returns {boolean}
 */
export function isUsableInstance(instance) {
  return instance?.enabled !== false && instance?.hasKey === true;
}

/**
 * 取弹窗可用的实例列表。
 * @param {Array<Record<string, unknown>>} instances
 * @returns {Array<Record<string, unknown>>}
 */
export function usableInstances(instances) {
  return Array.isArray(instances) ? instances.filter(isUsableInstance) : [];
}

/**
 * 引擎下拉的次要信息：`类型/预设 · 模型`；缺字段时退化。
 * @param {Record<string, unknown>} instance
 * @returns {string}
 */
export function engineOptionDetail(instance) {
  const typeLabel = String(instance.typeLabel ?? '').trim();
  const preset = String(instance.preset ?? '').trim();
  const model = String(instance.model ?? '').trim();
  const kind = typeLabel && preset ? `${typeLabel}/${preset}` : typeLabel;
  return [kind, model].filter(Boolean).join(' · ');
}

/**
 * 把实例数组转成 E5 `Select` 的选项。
 * @param {Array<Record<string, unknown>>} instances
 * @returns {Array<{ value: string, label: string, detail: string }>}
 */
export function engineOptionsOf(instances) {
  return (Array.isArray(instances) ? instances : [])
    .filter(isUsableInstance)
    .map((instance) => ({
      value: String(instance.id),
      label: String(instance.name ?? '').trim() || '未命名实例',
      detail: engineOptionDetail(instance),
    }));
}
