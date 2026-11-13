# SimpleTrans

基于 React + Vite 的 Chrome 扩展（Manifest V3），把网页内容翻译成目标语言，并以双语对照方式显示。目标支持传统 MT 与 AI LLM 多引擎。

> **当前状态：P0 已完成（0.1.0 空骨架）**。代码里只有目录、文件头与静态占位页，没有任何翻译、存储或监听行为。功能从 P1 起按 `docs/PLAN.md` 逐阶段实现，P0–P9 版本号固定为 `0.1.0`，全部需求完成后正式发布。结构设计见 [`docs/项目架构.md`](docs/项目架构.md)。

## 目录结构

```
public/
  manifest.json        扩展清单（入口、注入、权限、commands）
  icons/               扩展图标（可运行 npm run icons 重新生成占位图标）
src/
  background/          后台服务（A）
    index.js           入口：监听器注册（P2）
    router.js          A1 消息路由
    commands.js        A1 快捷键入口
    context-menu.js    A1 右键菜单入口
    gateway.js         A2 请求网关
  popup/               工具栏弹窗（B，静态占位）
    index.html
    main.jsx
    Popup.jsx
    popup.css
  options/             设置页（C，静态占位）
    index.html
    main.jsx
    Options.jsx
  content/             页面注入（D）
    index.js           入口（只引用 content.css）
    bridge.js          D4 与后台通信
    hover.js           D2 悬停检测
    task.js            D5 状态上报与任务调度
    dom/scanner.js     D1 段落提取
    dom/renderer.js    D3 译文渲染
    content.css        译文样式（P3 前只有注释）
  shared/              公共模块（E）与引擎/缓存目录
    protocol.js        E1 消息协议
    constants.js       超时、并发、心跳等数值
    storage.js         E2 存储读写
    settings.js        E2 设置与密钥
    config/            E3 引擎类型目录与实例（registry / instances）
    translate/         A3 适配器契约与批量编码（adapter / batch）
    cache/             A4 缓存 key 与存取（key / store）
    global.css         弹窗与设置页的全局样式
scripts/
  build.mjs            三模式构建编排（web / background / content）
  smoke.mjs            无浏览器冒烟门禁（基于 dist 产物）
  gen-icons.js         生成占位图标
tests/
  unit/structure.test.js        骨架结构与空壳约定
  unit/architecture.test.js     架构 3.1 目录树与仓库一致性
vitest.config.js       单元测试配置
vite.config.js         构建配置（按模式切换产物格式）
dist/                  构建产物（加载到 Chrome 的目录，已在 .gitignore 中忽略）
```

新增或删除 `src/` 文件前先改架构 3.1 目录树；`tests/unit/architecture.test.js` 会强制两者一致。

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
npm test        # 单元测试（结构 + 架构一致性）
npm run dev     # 并行监听构建三个产物到 dist/
npm run build   # 生产构建（先清空 dist）
npm run smoke   # 无浏览器冒烟检查（先 build）
npm run gate    # 单元测试 → 构建 → 冒烟，一条命令跑完
```

## 在 Chrome 中加载

1. 打开 `chrome://extensions`
2. 打开右上角「开发者模式」
3. 点击「加载已解压的扩展程序」，选择项目下的 `dist` 目录
4. 修改代码后（`npm run dev` 会自动重新构建），在扩展页点击刷新按钮即可
