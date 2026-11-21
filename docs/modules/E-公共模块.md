# E 公共模块

> 模块级代码索引：只写代码文件位置、模块描述与功能清单；具体数值、枚举、报文、错误码与边界以代码和测试为准。模块划分见 [项目架构](../项目架构.md)。

## E1 消息协议

**代码文件**：`src/shared/protocol.js`。

**模块描述**：定义扩展内部的消息类型、端口、错误分类、失败原因、载荷校验与域名归一；所有上下文共用这一份契约。

**功能**

| 功能 | 代码位置 |
| --- | --- |
| 消息类型与端口名 | `protocol.js#MESSAGE_TYPES`、`protocol.js#PORT_NAME` |
| 错误码与分类标志 | `protocol.js#ERROR_CODES`、`protocol.js#ERROR_FLAGS` |
| 失败原因与错误构造 | `protocol.js#FAILURE_REASONS`、`protocol.js#makeError` |
| 禁止字段检查 | `protocol.js#findForbiddenField` |
| `traceId` 归一 | `protocol.js#normalizeTraceId` |
| 域名归一 | `protocol.js#normalizeDomain`、`protocol.js#MAX_DOMAIN_CHARS` |
| 载荷上限校验 | `protocol.js` |

## E2 设置与存储

**代码文件**：`src/shared/storage.js`、`src/shared/settings.js`、`src/shared/languages.js`。

**模块描述**：读写扩展设置与运行数据，定义设置 schema、默认值、归一规则、语言目录与主题解析。

**功能**

| 功能 | 代码位置 |
| --- | --- |
| 设置 schema 与默认值 | `settings.js#DEFAULT_SETTINGS`、`settings.js#CONFIG_VERSION` |
| 设置归一 | `settings.js#normalizeSettings` |
| 主题、初始页与密钥存储归一及解析 | `settings.js#normalizeTheme`、`settings.js#resolveTheme`、`settings.js#normalizePopupDefaultTab`、`settings.js#normalizeKeyStorage` |
| `storage.sync`、`storage.local`、`storage.session` 读写 | `storage.js` |
| 语言目录与百度语言码 | `languages.js` |

## E3 翻译配置与密钥

**代码文件**：`src/shared/config/registry.js`、`src/shared/config/openai.js`、`src/shared/config/instances.js`、`src/shared/config/host-permission.js`。

**模块描述**：管理引擎类型、翻译实例、当前实例、每实例凭据与提示词、配置校验与旧配置迁移。

**功能**

| 功能 | 代码位置 |
| --- | --- |
| 引擎类型、预设、标签与默认值 | `registry.js#ENGINE_TYPES`、`registry.js#TYPE_LABELS` |
| 实例名称、批次、并发与提示词校验 | `registry.js` |
| 实例归一、创建、校验与公开字段 | `instances.js#normalizeInstance`、`instances.js#createDefaultInstance`、`instances.js#toPublicInstance`、`instances.js#validateInstance` |
| 实例 CRUD、凭据、提示词与当前实例 | `instances.js` |
| 配置迁移 | `instances.js#ensureConfigMigrated` |
| OpenAI 兼容配置、预设与旧类型映射 | `openai.js` |
| endpoint 主机匹配与权限检查 | `host-permission.js` |

## E4 日志输出

**代码文件**：`src/shared/log/levels.js`、`src/shared/log/record.js`、`src/shared/log/logger.js`。

**模块描述**：为后台、弹窗、设置页与页面注入提供统一日志入口、级别过滤、记录结构与脱敏；只输出浏览器控制台，不写存储、不上报。

**功能**

| 功能 | 代码位置 |
| --- | --- |
| 日志等级、阈值与选项 | `levels.js` |
| 记录结构、字段截断与脱敏 | `record.js` |
| 上下文与模块前缀 | `record.js`、`logger.js` |
| 级别过滤与输出 | `logger.js` |
| `traceId` 绑定 | `logger.js` |
| 未捕获异常与未处理 Promise 拒绝 | `logger.js` |

## E5 共享展示组件

**代码文件**：`src/shared/ui/button.jsx`、`src/shared/ui/toggle.jsx`、`src/shared/ui/select.jsx`、`src/shared/ui/notice.jsx`、`src/shared/ui/field.jsx`、`src/shared/ui/status-badge.jsx`。

**模块描述**：为弹窗与设置页提供统一的 HyperUI 展示组件；只组合 HyperUI 与 Tailwind 类，不读写浏览器接口，不携带自定义 CSS。

**功能**

| 功能 | 代码位置 |
| --- | --- |
| 按钮变体、尺寸与加载态 | `button.jsx` |
| 开关 | `toggle.jsx` |
| 单选下拉、键盘与 ARIA | `select.jsx` |
| 成功、失败、警告与信息提示 | `notice.jsx` |
| 表单字段、帮助与错误 | `field.jsx` |
| 状态徽标 | `status-badge.jsx` |

## E6 快捷键

**代码文件**：`src/shared/shortcut.js`。

**模块描述**：统一悬停快捷键的枚举、归一、显示与平台按键映射，并提供整页命令名与浏览器命令快捷键读取。

**功能**

| 功能 | 代码位置 |
| --- | --- |
| 悬停快捷键枚举与归一 | `shortcut.js#HOVER_SHORTCUTS`、`shortcut.js#normalizeHoverShortcut` |
| 平台按键映射与显示 | `shortcut.js#resolveHoverShortcut` |
| 整页命令名 | `shortcut.js#COMMAND_TRANSLATE_PAGE` |
| 读取浏览器命令快捷键 | `shortcut.js#readCommandShortcut` |
