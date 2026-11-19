# 第三方许可说明

SimpleTrans 以 MIT 许可发布，见仓库根目录 `LICENSE`。本文件列出随扩展分发或用于构建的第三方组件及其许可。

## 扩展图标（随扩展分发）

- 图标：Lucide `languages`
- 来源：https://lucide.dev/icons/languages
- 版权：Copyright (c) 2026 Lucide Icons and Contributors
- 许可：ISC License

```text
ISC License

Copyright (c) 2026 Lucide Icons and Contributors

Permission to use, copy, modify, and/or distribute this software for any
purpose with or without fee is hereby granted, provided that the above
copyright notice and this permission notice appear in all copies.

THE SOFTWARE IS PROVIDED "AS IS" AND THE AUTHOR DISCLAIMS ALL WARRANTIES
WITH REGARD TO THIS SOFTWARE INCLUDING ALL IMPLIED WARRANTIES OF
MERCHANTABILITY AND FITNESS. IN NO EVENT SHALL THE AUTHOR BE LIABLE FOR
ANY SPECIAL, DIRECT, INDIRECT, OR CONSEQUENTIAL DAMAGES OR ANY DAMAGES
WHATSOEVER RESULTING FROM LOSS OF USE, DATA OR PROFITS, WHETHER IN AN
ACTION OF CONTRACT, NEGLIGENCE OR OTHER TORTIOUS ACTION, ARISING OUT OF
OR IN CONNECTION WITH THE USE OR PERFORMANCE OF THIS SOFTWARE.
```

同一份许可文本随扩展产物放在 `dist/icons/NOTICE.txt`。

## 界面组件与图标

- **daisyUI 5.8.1**：MIT License，Copyright (c) 2020 Pouya Saadeghi；作为 Tailwind CSS 插件在构建期使用，组件样式随页面产物分发。
- **lucide-react**：ISC License，Copyright (c) Lucide Icons and Contributors；按名导入的界面图标随页面产物分发。

## 运行时依赖

- **React / React DOM**：MIT License，Copyright (c) Meta Platforms, Inc. and affiliates。
- **eventsource-parser**：MIT License，用于后台 SSE 分帧。
- **js-md5**：MIT License，用于后台百度翻译签名。

## 构建期依赖

- **@resvg/resvg-js 2.6.2**：MPL-2.0，仅用于 `npm run icons` 渲染 SVG，不随扩展分发。
- **Tailwind CSS、Vite、Vitest** 等开发依赖的许可证见各自 npm 包。
