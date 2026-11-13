/**
 * C1–C5 设置页（占位）
 *
 * 模块：插件独立页面（C）
 * 职责：配置通用选项、引擎实例与首选/备用引擎，提供测试翻译与数据管理。
 * 依赖：E1、E2、E3（P7 起）。
 * 实现阶段：P7（设置页完整能力）
 *
 * P0 只渲染静态占位，不读取设置、不发消息、不调用引擎。
 */
export default function Options() {
  return (
    <main className="max-w-xl mx-auto my-10 px-4">
      <h1 className="text-2xl font-bold mb-2">SimpleTrans 设置</h1>
      <p className="text-sm text-base-content/70">设置页骨架已就绪，配置能力待接入（P7）。</p>
    </main>
  );
}
