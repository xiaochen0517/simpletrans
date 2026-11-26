# D 页面注入

> 模块级代码索引：只写代码文件位置、模块描述与功能清单；具体数值、枚举、报文、错误码与边界以代码和测试为准。模块划分见 [项目架构](../项目架构.md)。

## D1 段落提取

**代码文件**：`src/content/dom/scanner.js`。

**模块描述**：找出页面上可翻译的文字宿主，分配段落 id，并区分块级与行内布局；不记录上下文，不判断语言。

**功能**

| 功能 | 代码位置 |
| --- | --- |
| 从指针位置解析宿主 | `scanner.js#resolveAt` |
| 悬停范围候选（基宿主到合法祖先） | `scanner.js#collectHoverRange` |
| 宿主标记与段落 id 分配 | `scanner.js#ensureHost` |
| 跳过脚本、样式、表单控件、隐藏与已翻译内容 | `scanner.js#isSkipped`、`scanner.js#isHidden` |
| 文本提取与归一 | `scanner.js#extractText`、`scanner.js#normalizeText` |
| 块级与行内宿主判定 | `scanner.js#isBlockHost` |
| 视口附近段落枚举、分片与上限 | `scanner.js`、`scanner.js#isElementInNearViewport` |
| 宿主 DOM 标记常量 | `scanner.js#HOST_ATTR`、`scanner.js#TRANSLATION_ATTR` |

## D2 悬停检测

**代码文件**：`src/content/hover.js`、`src/content/range.js`、`src/content/index.js`、`src/content/content.css`（范围边框规则）。

**模块描述**：记录指针当前所在的文字宿主，在按住快捷键期间展示待翻译范围并支持滚轮扩大到祖先宿主；除滚轮与指针移动外的操作会取消手势，取消后释放不提交；跨 frame 时广播范围开始与取消，只有持有指针的 frame 显示和调整范围。

**功能**

| 功能 | 代码位置 |
| --- | --- |
| 指针移动跟踪与宿主归位 | `hover.js#createHoverTracker` |
| 指针进入子 frame 时清空宿主 | `hover.js#createHoverTracker` |
| 范围候选导航与虚线标记 | `range.js#createHoverRange` |
| 修饰键两阶段手势与滚轮调整 | `content/index.js#installModifierTap` |
| 按住期间的操作取消（滚轮与指针移动除外） | `content/index.js#cancelFromInteraction`、`content/index.js#installModifierTap` |
| 释放时失焦、页面隐藏与取消标记判断 | `content/index.js#finishGesture`、`content/index.js#pageFocusLost` |
| 取消后拦截迟到触发 | `content/index.js#handleMessage`、`content/index.js#runHoverToggle` |
| 跨 frame 范围广播与远程会话 | `content/index.js#handleMessage`、`content/index.js` |
| 悬停触发与本地切换 | `content/index.js#runHoverToggle` |
| 跨 frame 手势广播 | `content/index.js#requestHoverTrigger` |
| 范围边框样式 | `content.css` |

## D3 译文渲染

**代码文件**：`src/content/dom/renderer.js`、`src/content/content.css`。

**模块描述**：把提交与译文状态以内嵌容器显示在原文末尾，支持更新、隐藏、清除与错误重试；不提取文本、不发请求、不读存储。

**功能**

| 功能 | 代码位置 |
| --- | --- |
| 状态容器创建与复用 | `renderer.js#createRenderer` |
| 提交、已提交、翻译中与流式状态显示 | `renderer.js#showSubmitting`、`renderer.js#showSubmitted`、`renderer.js#showLoading`、`renderer.js#update` |
| 定稿显示 | `renderer.js#showDone` |
| 提交失败与翻译失败显示 | `renderer.js#showSubmitError`、`renderer.js#showError` |
| 错误态刷新按钮与回调 | `renderer.js#RETRY_ATTR`、`renderer.js#createRenderer` 的 `onRetry` |
| 单段隐藏与全部清除 | `renderer.js#remove`、`renderer.js#clearAll` |
| 译文容器样式 | `content.css` |

## D4 与后台通信

**代码文件**：`src/content/bridge.js`。

**模块描述**：维持页面注入与后台的长连接，接收配置帧和结果帧并交给 D5；提交本身走一次性消息。

**功能**

| 功能 | 代码位置 |
| --- | --- |
| 连接、握手与端口管理 | `bridge.js#createBridge` |
| 心跳与断线重连 | `bridge.js` |
| 日志级别与内容配置帧接收 | `bridge.js` |
| 页面提交结果帧转发 | `bridge.js` 的 `onFrame` |
| 断线与扩展上下文失效通知 | `bridge.js`、`bridge.js#BridgeError` |

## D5 任务调度

**代码文件**：`src/content/task.js`、`src/content/index.js`。

**模块描述**：把取段、统一提交、结果回显、滚动增量、重试、取消与清除串成页面会话；不负责真实翻译与分批。

**功能**

| 功能 | 代码位置 |
| --- | --- |
| 创建页面任务会话 | `task.js#createTask` |
| 页面会话状态机 | `task.js` |
| 视口取段与统一提交 | `task.js`、`content/index.js#submitPage` |
| 提交记录、段落注册表与结果帧路由 | `task.js` |
| 滚动增量提交 | `task.js` |
| 单段刷新、失败重试与清除前取消 | `task.js`、`content/index.js#cancelSubmission` |
| 重连后续传与批次完成处理 | `task.js` |
| 会话状态快照与恢复接口 | `task.js#getStatus`、`task.js#restore`、`task.js#forget` |

## D6 译文自愈

**代码文件**：`src/content/heal.js`、`src/content/index.js`。

**模块描述**：页面重渲染删除译文容器后，按会话内「原文 → 译文」镜像把同一译文恢复到原文未变的宿主；原文变化只清理旧容器并注销该段，不重新提交。

**功能**

| 功能 | 代码位置 |
| --- | --- |
| 创建自愈器与镜像 | `heal.js#createHealer` |
| DOM 变更观察与去抖 | `heal.js` |
| 恢复候选收集与判定 | `heal.js` |
| 译文镜像记录、隐藏与取消隐藏 | `heal.js#remember`、`heal.js#hide`、`heal.js#unhide` |
| 恢复重挂与注销回调 | `heal.js#createHealer` 的 `restore` / `forget` 参数 |
| 反复重建的暂停与恢复 | `heal.js` |
| 生命周期与镜像重置 | `heal.js#start`、`heal.js#stop`、`heal.js#reset` |
