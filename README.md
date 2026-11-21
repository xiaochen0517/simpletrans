# SimpleTrans

English | [简体中文](README.zh.md)

SimpleTrans is a Chrome extension (Manifest V3) that translates web pages in place and keeps the page bilingual: every translation is inserted right after the original paragraph instead of replacing it. Translate the whole page — the first batch covers the paragraphs around the current viewport and new paragraphs are submitted as you scroll — or translate a single paragraph by hovering over it and pressing the configured hover shortcut (`Ctrl` by default). Translations come from engine instances you configure yourself: OpenAI-compatible chat APIs (DeepSeek preset or any compatible endpoint) or Baidu Translate, each with its own credentials, batching, streaming and QPS settings, and results are cached locally so repeated paragraphs render instantly.

## Installation

### Download a release (recommended)

1. Open [Releases](https://github.com/xiaochen0517/simpletrans/releases) and download `SimpleTrans-vX.Y.Z.zip` (plus `.sha256` if you want to verify it).
2. Optionally verify the download: `sha256sum -c SimpleTrans-vX.Y.Z.zip.sha256`. Release assets are built by GitHub Actions from the tagged commit and carry a build provenance attestation (`gh attestation verify SimpleTrans-vX.Y.Z.zip --repo xiaochen0517/simpletrans`).
3. Unzip the archive into a folder.
4. Open `chrome://extensions`, turn on **Developer mode**, click **Load unpacked** and select the unzipped folder.
5. Open the options page from the popup and add an instance under 翻译实例 (instances): choose OpenAI 兼容 (OpenAI-compatible) or 百度翻译 (Baidu Translate), fill in its credentials and endpoint, grant the host permission, and set it as the current instance. The options page interface is currently in Chinese.

### Build from source

Requirements: Node.js 20.19+ or 22.12+ (Vite 8), Chrome 116+.

```bash
npm install
npm run build
```

`npm run build` writes the loadable extension to `dist/`; load that folder as an unpacked extension with steps 4–5 above.

After changing the code, run `npm run dev` to rebuild, then reload the extension from `chrome://extensions`.

## Development

```bash
npm run dev     # watch-build the web, background and content bundles into dist/
npm test        # Vitest unit and component tests
npm run build   # production build (clears dist/)
npm run smoke   # artifact contract checks against dist/
npm run gate    # test -> build -> smoke
```

- `src/` and the directory tree in [`docs/项目架构.md`](docs/项目架构.md) section 3.1 must stay in sync; `tests/unit/architecture.test.js` enforces it.
- Add or change behavior together with tests under `tests/`; `npm run gate` must pass before review.
- UI changes need a human review in Chrome; automated checks are only a quality gate.

## Releasing (maintainers)

Releases are produced by [`.github/workflows/build-release.yml`](.github/workflows/build-release.yml):

1. Set the same `version` in `package.json` and `public/manifest.json`.
2. Run `npm ci && npm run gate`, then commit and push to `master`.
3. Create and push the tag: `git tag vX.Y.Z && git push origin vX.Y.Z`.
4. The workflow runs the gate, packages `SimpleTrans-vX.Y.Z.zip` and `.sha256`, attests the archive, and publishes the GitHub Release with generated notes.

The tag must be exactly `vX.Y.Z` and must match both version fields; the tagged commit must contain the workflow file. To test packaging without publishing, open **Actions → Build and Release → Run workflow**, choose a branch, and download the `simpletrans-build` artifact; no Release is created.

## Project structure

```text
.github/           GitHub Actions workflows and Dependabot
public/            manifest and extension icons
src/
  background/      service worker: message routing, request gateway, translation queue, cache
  popup/           toolbar popup: active instance, page commands
  options/         options page: overview, instances, general settings, test translation, data, about
  testpage/        built-in English page for manual translation testing
  content/         page injection: paragraph scanning, hover tracking, translation rendering, task scheduling
  shared/          protocol, storage and settings, engine configs, adapters, cache, logging, UI components
scripts/           build orchestration, smoke checks, icon generation
tests/             unit and component tests
docs/              architecture and module docs
```

Main features:

- **Two modes** — whole-page translation (viewport-first, with incremental submission on scroll) and single-paragraph translation (the configured hover shortcut, `Ctrl` by default).
- **Multiple engine instances** — OpenAI-compatible chat APIs (DeepSeek preset or a custom endpoint) and Baidu Translate; each instance keeps its own credentials, parameters and prompt.
- **Batching and streaming** — one request translates several paragraphs; OpenAI-compatible instances stream results while generating.
- **Resilience** — retry on network and rate-limit errors, per-instance Baidu QPS limiting, batch-alignment split, per-paragraph retry.
- **Local cache** — paragraph-level results in IndexedDB with size and count limits, plus a clear action in the options page.
- **Diagnostics** — one logging module shared by all contexts, console-only, with a configurable level.

## License

SimpleTrans is released under the [MIT License](LICENSE). The extension icon is Lucide `languages` (ISC); third-party components and licenses are listed in [`THIRD_PARTY_NOTICES.md`](THIRD_PARTY_NOTICES.md).
