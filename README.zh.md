# SimpleTrans

[English](README.md) | 简体中文

SimpleTrans 是一个 Chrome 扩展（Manifest V3），在网页原位置完成翻译并保持双语对照：译文插入原文段落之后，而不是替换原文。整页翻译会先提交当前视口附近的段落，滚动时增量提交新段落；也可以把鼠标停在某一段上按 `Ctrl` 单键，只翻译这一段。翻译能力来自用户自行配置的引擎实例：OpenAI 兼容的大模型接口（DeepSeek 预设或任意兼容端点）或百度翻译，每个实例独立保存凭据、批次、流式与 QPS 参数；译文写入本地缓存，重复段落直接回显。

## 安装

### 下载 Release（推荐）

1. 打开 [Releases](https://github.com/xiaochen0517/simpletrans/releases)，下载 `SimpleTrans-vX.Y.Z.zip`（需要校验时同时下载 `.sha256`）。
2. 可选校验：`sha256sum -c SimpleTrans-vX.Y.Z.zip.sha256`。Release 产物由 GitHub Actions 从 tag 对应的提交构建，并带构建来源证明（`gh attestation verify SimpleTrans-vX.Y.Z.zip --repo xiaochen0517/simpletrans`）。
3. 解压到一个目录。
4. 打开 `chrome://extensions`，开启右上角「开发者模式」，点击「加载已解压的扩展程序」，选择解压后的目录。
5. 打开扩展弹窗，进入「设置 → 翻译实例」，新增实例（OpenAI 兼容或百度翻译），填写凭据与接口地址，授予该域名的访问权限，并设为当前实例。

### 从源码构建

前置条件：Node.js 20.19+ 或 22.12+（Vite 8）、Chrome 116+。

```bash
npm install
npm run build
```

`npm run build` 会把可加载的扩展产物写到 `dist/`，再按「下载 Release」中的第 4、5 步加载并配置。

修改代码后运行 `npm run dev` 重新构建，再到扩展管理页刷新扩展。

## 开发

```bash
npm run dev     # 监听构建 web、background、content 三种产物到 dist/
npm test        # Vitest 单元测试与组件测试
npm run build   # 生产构建（先清空 dist/）
npm run smoke   # 基于 dist/ 的产物契约检查
npm run gate    # test -> build -> smoke
```

- `src/` 与 [`docs/项目架构.md`](docs/项目架构.md) 3.1 的目录树必须一致，`tests/unit/architecture.test.js` 会强制校验。
- 新增或修改行为时同批补 `tests/` 下的测试；提交审核前 `npm run gate` 必须通过。
- 可见界面改动需要在 Chrome 中由人工验收；自动化检查只是质量门禁，不作为验收结论。

## 发布（维护者）

发布由 [`.github/workflows/build-release.yml`](.github/workflows/build-release.yml) 完成：

1. 把 `package.json` 与 `public/manifest.json` 的 `version` 改成同一个 `X.Y.Z`。
2. 运行 `npm ci && npm run gate`，提交并推送到 `master`。
3. 创建并推送 tag：`git tag vX.Y.Z && git push origin vX.Y.Z`。
4. 流水线执行门禁，打包 `SimpleTrans-vX.Y.Z.zip` 与 `.sha256`，生成构建来源证明，并创建带自动 notes 的 GitHub Release。

tag 必须严格为 `vX.Y.Z`，与两处 `version` 一致，且 tag 对应的提交必须包含该 workflow 文件。只想验证打包流程而不发布时，打开 **Actions → Build and Release → Run workflow**，选择分支运行，下载 `simpletrans-build` Artifact 即可；不会创建 Release。

## 项目结构

```text
.github/           GitHub Actions workflow 与 Dependabot
public/            扩展清单与图标
src/
  background/      后台 Service Worker：消息路由、请求网关、翻译队列、缓存
  popup/           工具栏弹窗：当前实例与页面命令
  options/         设置页：概览、翻译实例、通用设置、测试翻译、数据管理、关于
  testpage/        内置英文翻译测试页，用于人工验证
  content/         页面注入：段落提取、悬停检测、译文渲染、任务调度
  shared/          消息协议、存储与设置、引擎配置、适配器、缓存、日志、共享展示组件
scripts/           构建编排、冒烟检查、图标生成
tests/             单元测试与组件测试
docs/              架构文档、模块细节、实现需求与缺陷记录
```

主要功能：

- **两种模式**：整页翻译（首次提交视口附近段落，滚动后增量提交）与悬停单段翻译（鼠标停在段落上按 `Ctrl`）。
- **多引擎实例**：支持 OpenAI 兼容的大模型接口（DeepSeek 预设或自定义端点）与百度翻译；每个实例独立保存凭据、生成参数与提示词。
- **批量与流式**：一次请求翻译多段；OpenAI 兼容实例边生成边显示。
- **异常恢复**：网络与限流错误自动重试，百度按实例 QPS 限速，批量对不上时二分拆批，失败段可单段刷新。
- **本地缓存**：段落级译文存在 IndexedDB，有字节数与条数上限，设置页可查看与清空。
- **统一日志**：四个运行部分共用一个日志模块，只输出浏览器控制台，级别可调。

## 许可证

SimpleTrans 以 [MIT 许可证](LICENSE)发布。扩展图标使用 Lucide `languages`（ISC）；第三方组件与许可见 [`THIRD_PARTY_NOTICES.md`](THIRD_PARTY_NOTICES.md)。
