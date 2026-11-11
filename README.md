# SimpleTrans

基于 React + Vite 的 Chrome 插件（Manifest V3），用于网页双语对照翻译（DeepSeek）。

## 目录结构

```
public/
  manifest.json        插件清单（权限、入口、commands、content script + CSS）
  icons/               插件图标（可运行 npm run icons 重新生成占位图标）
src/
  popup/               点击工具栏图标弹出的页面（React）
  options/             设置页（React，含密钥保存位置选择与翻译测试）
  background/          Service Worker
    index.js           事件注册入口
    router.js          控制面路由 + content 注入兜底
    gateway.js         数据面流式网关（P0 仅连通性，流式在 P3 接入）
    commands.js        快捷键
    context-menu.js    右键菜单「翻译此段」
  content/             注入网页的 content script（P0 仅握手）
    index.js           入口
    content.css        译文样式（manifest 静态注入）
  shared/
    protocol.js        消息协议与载荷上限（唯一协议源）
    constants.js       超时、并发、心跳等常量
    storage.js         chrome.storage 分区读写
    settings.js        设置与密钥存放位置
    translate/         provider 契约 + DeepSeek 实现（只允许 background 引用）
    global.css         全局样式
scripts/
  build.mjs            三模式构建编排（web / background / content）
  smoke.mjs            无浏览器冒烟测试（基于 dist 产物）
  gen-icons.js         生成占位图标
vite.config.js         构建配置（按模式切换产物格式）
dist/                  构建产物（加载到 Chrome 的目录，已在 .gitignore 中忽略）
```

## 构建为什么分三次

Content Script **不是 ES Module**，产物必须是自包含单文件（IIFE）；而 Popup / Options
是 HTML 页面、Background 可以是 ESM。Vite 无法在一次构建里按入口指定 `format`，因此
`scripts/build.mjs` 分别以 `web` / `background` / `content` 三种模式调用 Vite：

| 产物 | 格式 | 说明 |
| --- | --- | --- |
| `content.js` + `content.css` | IIFE | 内联全部依赖，CSS 固定文件名 |
| `background.js` | ESM | `type: module` |
| `popup/` `options/` | ESM + HTML | React + Tailwind |

因此 content 可以放心 `import` `shared/protocol.js` 等纯模块，构建时会内联。

## 开发

```bash
npm install
npm run dev     # 并行监听构建三个产物到 dist/
npm run build   # 生产构建
npm run smoke   # 无浏览器冒烟测试（先 build）
```

> 当前环境的文件系统策略禁止删除文件，构建会退化为“覆盖同名产物”，`dist/` 里可能残留旧哈希资源，不影响加载。

## 在 Chrome 中加载

1. 打开 `chrome://extensions`
2. 打开右上角「开发者模式」
3. 点击「加载已解压的扩展程序」，选择项目下的 `dist` 目录
4. 修改代码后（`npm run dev` 会自动重新构建），在扩展页点击刷新按钮即可
