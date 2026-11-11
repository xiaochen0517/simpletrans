/**
 * @deprecated 兼容层，仅保留旧路径的再导出。
 *
 * 实现已迁移到 `src/shared/translate/deepseek.js`（Provider 契约在
 * `src/shared/translate/provider.js`）。新代码请直接引用新模块。
 *
 * 说明：workspace 处于不允许删除文件的沙箱策略下，本文件暂时无法移除，
 * 因此改为纯再导出，避免出现两份实现。
 */

export * from './translate/deepseek.js';
