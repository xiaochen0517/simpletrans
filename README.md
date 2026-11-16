# SimpleTrans

基于 React + Vite 的 Chrome 扩展（Manifest V3），把网页内容翻译成目标语言，并以双语对照方式显示。目标支持传统 MT 与 AI LLM 多引擎。

> **当前状态：P0–P4 已完成**。后台已统一翻译出口，页面注入通过 `st-gateway` 长连接发批与收帧；页面已支持悬停单段翻译：任意文字标签可作为宿主，译文内嵌宿主末尾并按计算样式换行或空格分隔。设置页测试翻译经后台执行，并可调整日志级别。P5 起继续实现缓存、整页任务、弹窗与设置页。P0–P10 版本号固定为 `0.1.0`，全部需求完成后正式发布。结构设计见 [`docs/项目架构.md`](docs/项目架构.md)。

## 目录结构

```
public/
  manifest.json        扩展清单（入口、注入、权限、commands）
  icons/               扩展图标（可运行 npm run icons 重新生成占位图标）
src/
  background/          后台服务（A）
    index.js           入口：监听器注册（P2）
    router.js          A1 控制面：引擎列表与测试翻译（P2）
    commands.js        A1 快捷键入口（P4/P7）
    context-menu.js    A1 右键菜单入口（P7）
    gateway.js         A2 请求网关：校验、并发、取消、断线（P2）
  popup/               工具栏弹窗（B，静态占位）
    index.html
    main.jsx
    Popup.jsx
    popup.css
  options/             设置页（C，P2 最小测试表单经后台）
    index.html
    main.jsx
    Options.jsx
  content/             页面注入（D）
    index.js           入口：建立桥单例、处理业务帧与命令（P2/P4）
    bridge.js          D4 与后台通信：连接、心跳、重连（P2）
    hover.js           D2 悬停检测（P4）
    task.js            D5 单段任务（P4）/ 状态上报与整页调度（P6）
    dom/scanner.js     D1 任意标签宿主提取（P4）
    dom/renderer.js    D3 译文渲染（P4）
    content.css        译文样式（P4）
  shared/              公共模块（E）与引擎/缓存目录
    protocol.js        E1 消息协议：错误码、消息名、失败原因
    constants.js       超时、并发、心跳等数值
    storage.js         E2 存储读写
    settings.js        E2 设置与密钥
    config/            E3 引擎类型目录与实例（registry / instances）
    translate/         A3 适配器契约与批量编码（adapter / batch）
    cache/             A4 缓存 key 与存取（key / store）
    log/               E4 日志（levels / record / logger，P3 创建）
    global.css         弹窗与设置页的全局样式
scripts/
  build.mjs            三模式构建编排（web / background / content）
  smoke.mjs            无浏览器冒烟门禁（基于 dist 产物）
  gen-icons.js         生成占位图标
tests/
  unit/structure.test.js        结构、依赖边界与空壳约定
  unit/architecture.test.js     架构 3.1 目录树与仓库一致性
  unit/*.test.js                P1/P2 行为测试（协议、存储、设置、实例、适配器、网关、路由、桥、入口）、P3 日志与 P4 悬停/渲染测试
  helpers/chrome.js             chrome API stub（storage / storage.onChanged / runtime / Port / commands / tabs / scripting）
  helpers/load.js               安装 stub 与动态导入
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
npm test        # 单元测试（结构 + 架构一致性 + 行为）
npm run dev     # 并行监听构建三个产物到 dist/
npm run build   # 生产构建（先清空 dist）
npm run smoke   # 无浏览器冒烟检查（先 build）
npm run gate    # 单元测试 → 构建 → 冒烟，一条命令跑完
```

## 日志

日志只输出到浏览器控制台，不落盘、不收集、不上传。设置页可调整级别：详细（Verbose）/ 信息（Info）/ 警告（Warning）/ 错误（Error）/ 关闭（Off），默认信息。日志记录不保存，刷新或关闭页面即丢失；问题反馈直接复制对应控制台。

| 上下文 | 控制台入口 |
| ---- | ---- |
| 页面注入 | 网页 DevTools → Console |
| 工具栏弹窗 | 右键弹窗 → 检查 |
| 设置页 | 右键设置页 → 检查 |
| 后台服务 | `chrome://extensions` → Service Worker → 检查 |

级别调整后，后台、弹窗、设置页按各自打开/更新时机生效；已打开的网页需刷新或重连后生效。日志不含密钥、请求头/体、页面正文与完整 URL。需要跨刷新查看时，可在 DevTools Console 设置中勾选 Preserve log；扩展本身不保存日志。

## 在 Chrome 中加载

1. 打开 `chrome://extensions`
2. 打开右上角「开发者模式」
3. 点击「加载已解压的扩展程序」，选择项目下的 `dist` 目录
4. 修改代码后（`npm run dev` 会自动重新构建），在扩展页点击刷新按钮即可
