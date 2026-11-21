# C 插件独立页面

> 模块级代码索引：只写代码文件位置、模块描述与功能清单；具体数值、枚举、报文、错误码与边界以代码和测试为准。模块划分见 [项目架构](../项目架构.md)。

## C1 概览与通用设置

**代码文件**：`src/options/Options.jsx`、`src/options/lib.js`、`src/options/sections/overview.jsx`、`src/options/sections/general.jsx`。

**模块描述**：设置页壳层、导航与全局状态；概览展示当前可用性与告警，通用设置保存与引擎无关的选项。

**功能**

| 功能 | 代码位置 |
| --- | --- |
| 设置页壳、哈希路由、导航与主题 | `Options.jsx` |
| 全局状态与提示挂载 | `Options.jsx` |
| 概览状态卡片、告警与快捷操作 | `overview.jsx` |
| 启用开关、语言、快捷键、密钥存储、缓存、初始页与日志设置 | `general.jsx` |
| 设置页共享消息、格式化和实例文案工具 | `lib.js` |

## C2 引擎管理

**代码文件**：`src/options/sections/instances.jsx`、`src/options/components/instance-card.jsx`、`src/options/components/instance-editor.jsx`、`src/options/components/create-instance.jsx`、`src/options/components/confirm-dialog.jsx`、`src/options/components/empty-state.jsx`、`src/options/components/toast.jsx`。

**模块描述**：管理翻译实例的新增、编辑、复制、启停、删除与筛选；实例表单覆盖连接、认证、模型、生成参数、批次/并发、提示词与凭据。

**功能**

| 功能 | 代码位置 |
| --- | --- |
| 实例列表、筛选与操作入口 | `instances.jsx` |
| 实例卡片与状态徽标 | `instance-card.jsx` |
| 新增实例与类型/预设选择 | `create-instance.jsx` |
| 编辑连接、认证、模型、参数与提示词 | `instance-editor.jsx` |
| 凭据替换、清除与域名权限申请 | `instance-editor.jsx` |
| 危险操作确认、空状态与操作提示 | `confirm-dialog.jsx`、`empty-state.jsx`、`toast.jsx` |

## C3 当前实例

**代码文件**：`src/options/sections/instances.jsx`、`src/options/components/instance-card.jsx`、`src/shared/config/instances.js`。

**模块描述**：从可用实例中指定唯一的当前实例，并在停用、删除或凭据变化时按规则改选。

**功能**

| 功能 | 代码位置 |
| --- | --- |
| 当前实例选择与高亮 | `instances.jsx`、`instance-card.jsx` |
| 可用性筛选与改选 | `shared/config/instances.js` |
| 当前实例持久化 | `shared/config/instances.js` |

## C4 测试翻译

**代码文件**：`src/options/sections/test-translation.jsx`。

**模块描述**：用已保存实例的参数与凭据试翻一段文本，展示译文、实例信息、耗时与用量或字符数；不透传上游原始报文。

**功能**

| 功能 | 代码位置 |
| --- | --- |
| 实例选择与文本输入 | `test-translation.jsx` |
| 调用后台测试翻译 | `test-translation.jsx`、`router.js#testEngine` |
| 结果、耗时、用量与错误建议展示 | `test-translation.jsx` |

## C5 数据管理与关于

**代码文件**：`src/options/sections/data-management.jsx`、`src/options/sections/about.jsx`。

**模块描述**：管理本地缓存数据并说明版本、权限与隐私；提供诊断信息复制。

**功能**

| 功能 | 代码位置 |
| --- | --- |
| 缓存占用、刷新与清空 | `data-management.jsx`、`router.js#cacheStats`、`router.js#clearCache` |
| 缓存、密钥、提示词与日志存放说明 | `data-management.jsx` |
| 版本、配置版本、缓存版本、权限与隐私说明 | `about.jsx` |
| 复制诊断信息 | `about.jsx` |

## C6 翻译测试页

**代码文件**：`src/testpage/index.html`、`src/testpage/main.js`、`src/testpage/frame.html`、`src/testpage/frame.js`、`src/testpage/testpage.css`。

**模块描述**：提供稳定的英文翻译夹具与页内操作入口，用于人工验证整页提交、滚动增量、悬停单段、清除、frame 与重渲染；不自动翻译、不调用引擎、不读写配置。

**功能**

| 功能 | 代码位置 |
| --- | --- |
| 静态英文区块夹具 | `index.html` |
| 页内操作条与页面任务加载 | `main.js` |
| 内嵌 frame 夹具与独立操作条 | `frame.html`、`frame.js` |
| 重渲染夹具 | `index.html`、`main.js` |
| 测试页样式与主题 | `testpage.css` |
