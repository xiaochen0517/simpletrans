/**
 * B2 命令下发 / 测试页入口
 *
 * 模块：工具栏弹窗（B）/ B2 命令下发
 * 职责：拼出扩展内翻译测试页地址并在新标签页打开；把不可用与失败归一为可读提示。
 * 依赖：chrome.runtime.getURL、chrome.tabs.create。
 * 实现阶段：P6.5
 */

/** 测试页在扩展内的路径；与 vite 的 web 入口保持一致。 */
export const TEST_PAGE_PATH = 'testpage/index.html';

/**
 * 在新标签页打开翻译测试页。
 * @returns {Promise<{ ok: true, url: string } | { ok: false, message: string }>}
 */
export async function openTestPage() {
  const runtime = globalThis.chrome?.runtime;
  const tabs = globalThis.chrome?.tabs;

  if (!runtime?.getURL || !tabs?.create) {
    return { ok: false, message: '扩展未就绪，请重新打开弹窗' };
  }

  try {
    const url = runtime.getURL(TEST_PAGE_PATH);
    await tabs.create({ url });
    return { ok: true, url };
  } catch {
    return { ok: false, message: '无法打开测试页，请稍后重试' };
  }
}
