/**
 * E3 主机权限
 *
 * 模块：公共模块（E）/ E3
 * 职责：把自定义 endpoint 的 baseUrl 归一为扩展主机匹配模式，并提供 `chrome.permissions.contains` 检查。
 * 依赖：无。
 *
 * 只允许 HTTPS 或本地回环 HTTP；匹配模式不带端口、路径与尾斜杠。
 * 本文件含主机匹配逻辑但不含服务商地址、密钥字段，页面注入仍禁止引用 config/。
 */

/**
 * 取 endpoint 的 origin 权限匹配模式：HTTPS，或本地回环 HTTP（localhost / 127.0.0.1）。
 * 匹配模式不带端口、路径与尾斜杠；非法地址返回 `null`。
 * @param {unknown} baseUrl
 * @returns {string | null}
 */
export function getOriginPattern(baseUrl) {
  const text = String(baseUrl ?? '').trim();
  if (text === '') return null;
  let url;
  try {
    url = new URL(text);
  } catch {
    return null;
  }
  if (url.username !== '' || url.password !== '') return null;
  if (url.protocol === 'https:') return `https://${url.hostname}/*`;
  if (url.protocol === 'http:' && (url.hostname === 'localhost' || url.hostname === '127.0.0.1')) {
    return `http://${url.hostname}/*`;
  }
  return null;
}

/**
 * 检查 endpoint 主机权限；可注入 `contains`（`chrome.permissions.contains` 风格）便于测试。
 * 无权限 API 的环境（单元测试、非扩展页面）按已授权处理，由调用方保证实际权限。
 * @param {unknown} baseUrl
 * @param {{ contains?: (request: { origins: string[] }) => Promise<boolean> | boolean }} [options]
 * @returns {Promise<boolean>}
 */
export async function isEndpointPermitted(baseUrl, { contains } = {}) {
  const pattern = getOriginPattern(baseUrl);
  if (!pattern) return false;

  let check = contains;
  if (typeof check !== 'function') {
    const permissions = globalThis.chrome?.permissions;
    if (!permissions || typeof permissions.contains !== 'function') return true;
    check = (request) => permissions.contains(request);
  }
  try {
    return Boolean(await check({ origins: [pattern] }));
  } catch {
    return false;
  }
}
