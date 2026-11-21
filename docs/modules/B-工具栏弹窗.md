# B 工具栏弹窗

> 模块级代码索引：只写代码文件位置、模块描述与功能清单；具体数值、枚举、报文、错误码与边界以代码和测试为准。模块划分见 [项目架构](../项目架构.md)。

## B1 状态显示

**代码文件**：`src/popup/Popup.jsx`、`src/popup/popup.css`。

**模块描述**：显示弹窗壳、初始页与当前翻译方式、实例和密钥状态；负责标签切换、主题与整页会话状态查询。

**功能**

| 功能 | 代码位置 |
| --- | --- |
| 弹窗壳与标签栏 | `Popup.jsx` |
| 按初始页设置选择默认页或快速翻译页 | `Popup.jsx` |
| 读取并展示实例、语言与密钥状态 | `Popup.jsx` |
| 切换翻译方式并持久化当前实例 | `Popup.jsx` |
| 主题解析与应用 | `Popup.jsx` |
| 整页会话状态查询 | `Popup.jsx` |
| 弹窗样式 | `popup.css` |

## B2 命令下发

**代码文件**：`src/popup/Popup.jsx`、`src/popup/open-test-page.js`。

**模块描述**：把弹窗中的整页操作转成后台命令，并按页面会话状态切换按钮与提示；不持有任务。

**功能**

| 功能 | 代码位置 |
| --- | --- |
| 整页操作主按钮与状态切换 | `Popup.jsx` |
| 开始、清除与状态查询命令 | `Popup.jsx`、`router.js#routeCommand` |
| 快捷键显示 | `Popup.jsx` |
| 打开翻译测试页 | `Popup.jsx`、`open-test-page.js` |
| 打开设置页 | `Popup.jsx#openSettingsPage` |

## B3 快速翻译页

**代码文件**：`src/popup/quick-translate.jsx`、`src/popup/instance-option.js`。

**模块描述**：在弹窗内读取或输入文本，用临时选择的实例与目标语言翻译，并展示可复制的纯文本结果；所有状态只属于本次弹窗会话。

**功能**

| 功能 | 代码位置 |
| --- | --- |
| 读取当前网页选区并填入输入框 | `quick-translate.jsx`、`router.js#readSelection` |
| 文本输入、字符计数与提交 | `quick-translate.jsx` |
| 临时实例与目标语言选择 | `quick-translate.jsx`、`instance-option.js` |
| 调用后台快速翻译并展示结果 | `quick-translate.jsx` |
| 复制结果与错误提示 | `quick-translate.jsx` |
