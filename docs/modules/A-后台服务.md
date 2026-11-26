# A 后台服务

> 模块级代码索引：只写代码文件位置、模块描述与功能清单；具体数值、枚举、报文、错误码与边界以代码和测试为准。模块划分见 [项目架构](../项目架构.md)。

## A1 消息路由

**代码文件**：`src/background/router.js`、`src/background/commands.js`、`src/background/context-menu.js`、`src/background/index.js`。

**模块描述**：把弹窗、设置页的请求与快捷键、右键菜单事件送到目标标签页的各个 frame；整页按钮与快捷键共用切换入口，查询页面会话后开始翻译或显示原文；快捷键命令执行前取消页面悬停手势；接收页面提交并转交 A2；转发悬停手势与范围预览广播、读取选区；不保存任务状态。

**功能**

| 功能 | 代码位置 |
| --- | --- |
| 弹窗与设置页消息分发 | `router.js#handleMessage` |
| 整页快捷键入口 | `commands.js#handleCommand` |
| 快捷键命令执行前取消悬停手势 | `commands.js#handleCommand`、`router.js#cancelHoverGesture` |
| 整页按钮与快捷键统一切换、按标签页串行 | `router.js#togglePageTranslation`、`router.js#serializeToggle` |
| 整页开始、清除与状态查询的跨 frame 发送与汇总 | `router.js#startOnTab`、`router.js#clearOnTab`、`router.js#statusOnTab` |
| 右键菜单入口 | `context-menu.js` |
| 按 frame 发送命令，无连接时补注入 | `router.js#sendToTab`、`router.js#injectFrames` |
| 页面提交的形状校验、按来源 frame 转交与回执 | `router.js#receivePageSubmit` |
| 悬停手势广播 | `router.js#forwardHoverTrigger` |
| 悬停范围开始 / 取消广播 | `router.js#forwardHoverRange` |
| 当前标签页选区读取 | `router.js#readSelection` |
| 实例列表、测试翻译、快速翻译、缓存统计与清空的消息转发 | `router.js#handleMessage` 对应分支 |
| 后台入口与监听器注册 | `index.js` |

## A2 请求网关

**代码文件**：`src/background/gateway.js`、`src/background/router.js`（提交入口 `receivePageSubmit`）、`src/background/index.js`（标签页关闭清理注册）。

**模块描述**：接收页面提交与数据面批次，按实例完成缓存预取、唯一 key 分组、切批、队列调度、结果帧回发与清理；不保存任务状态，不写存储。

**功能**

| 功能 | 代码位置 |
| --- | --- |
| 连接登记、心跳与每连接配置下发 | `gateway.js#handleConnect`、`gateway.js#sendConnectionConfig` |
| 页面提交创建、回执与结果帧路由 | `gateway.js#acceptPageSubmit`、`router.js#receivePageSubmit` |
| 缓存 profile、预取与命中回显 | `gateway.js#buildCacheProfile`、`gateway.js#fanOutCacheHit` |
| 唯一 key 分组、同 key 共享执行与订阅 | `gateway.js#createShared`、`gateway.js#subscribeGroup`、`gateway.js#resolveShared` |
| 按实例参数切批 | `gateway.js#splitBatches` |
| 批次入队、取消、超时与断线清理 | `gateway.js#beginBatch`、`gateway.js#cancelBatch`、`gateway.js#onBatchTimeout`、`gateway.js#cleanupConnection` |
| 百度实例 QPS 门控 | `gateway.js#acquireQps` |
| 批量结果不对齐时的二分拆批 | `gateway.js#splitBatch` |
| 标签页关闭兜底清理 | `gateway.js#cleanupTab` |
| 数据面批次兼容路径 | `gateway.js#beginBatch`、`gateway.js#runBatch` |
| 提交级结算、错误帧与完成帧 | `gateway.js#settleItem`、`gateway.js#finishSubmission`、`gateway.js#rejectSubmission` |

## A3 翻译引擎

**代码文件**：`src/shared/translate/adapter.js`、`src/shared/translate/adapters/openai.js`、`src/shared/translate/adapters/baidu.js`、`src/shared/translate/openai-request.js`、`src/shared/translate/openai-stream.js`、`src/shared/translate/openai-response.js`、`src/shared/translate/openai-errors.js`、`src/shared/translate/openai-profile.js`、`src/shared/translate/prompt.js`、`src/shared/translate/batch.js`、`src/shared/translate/queue.js`。

**模块描述**：把一批文本交给具体翻译服务并按段返回结果；负责适配器分发、请求构造、流式与非流式响应解析、错误映射、提示词展开、批量编解码与翻译队列。

**功能**

| 功能 | 代码位置 |
| --- | --- |
| 按实例类型分发适配器 | `adapter.js` |
| OpenAI 兼容请求构造 | `adapters/openai.js`、`openai-request.js` |
| OpenAI 流式响应解析 | `adapters/openai.js`、`openai-stream.js` |
| OpenAI 非流式响应解析 | `adapters/openai.js`、`openai-response.js` |
| OpenAI HTTP 与流内错误映射 | `openai-errors.js` |
| OpenAI 缓存 profile 与主机权限契约 | `openai-profile.js` |
| 百度翻译请求、签名、语言码与批量响应 | `adapters/baidu.js` |
| 提示词模板、占位符展开与哈希 | `prompt.js` |
| 批量请求编码与按段解析 | `batch.js` |
| 翻译队列、并发、取消与重试 | `queue.js` |
| 单段流式与多段批量执行 | `queue.js`、`adapters/openai.js`、`adapters/baidu.js` |

## A4 翻译缓存

**代码文件**：`src/shared/cache/key.js`、`src/shared/cache/store.js`。

**模块描述**：保存「源文 → 译文」，按缓存 key 命中；负责 IndexedDB 结构、读写、容量与条数上限、淘汰、统计和清空。

**功能**

| 功能 | 代码位置 |
| --- | --- |
| 缓存 key 计算 | `key.js#buildCacheKey` |
| 缓存 profile 与 key 版本契约 | `key.js` |
| IndexedDB 打开、事务与读写 | `store.js#createCacheStore` |
| 单条与批量读取、命中与最近访问更新 | `store.js` |
| 写入、来源域名元数据与 generation 校验 | `store.js` |
| 按字节与条数淘汰 | `store.js` |
| 缓存统计与清空 | `store.js` |
| 单例入口 | `store.js#getCacheStore` |

## A5 快速翻译

**代码文件**：`src/background/quick.js`。

**模块描述**：处理弹窗的一次性快速翻译请求：解析实例、选择提示词、调用 A3、返回纯文本结果；不读写缓存、不注册页面任务。

**功能**

| 功能 | 代码位置 |
| --- | --- |
| 启用状态、文本与目标语言校验 | `quick.js` |
| 临时实例或当前实例解析 | `quick.js` |
| 快速提示词选择与调用 A3 | `quick.js` |
| 复用上游并发名额与实例限流 | `quick.js`、`gateway.js#withUpstreamSlot` |
| 返回译文、耗时、用量与字符数 | `quick.js` |
