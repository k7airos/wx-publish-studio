# 贡献指南

本仓库面向公开贡献者。**参与本项目即表示同意遵守 [贡献者行为准则](CODE_OF_CONDUCT.md)（如适用）与 [LICENSE](LICENSE)。**

## 上手

```sh
bun install --frozen-lockfile
bun run check   # tsc --noEmit
bun run build   # vite build
bun run check:brand   # 分发产物里的上游默认文案自查
bun test --max-concurrency=1 tests
```

数据库测试需要**专用 `*_test` 库**（`TEST_DATABASE_URL`），并需要设置 `TYPESET_ARTICLE_COVER_FONT_PATH` 指向与封面合同同字节的 `NotoSansCJK-Regular.ttc`。**不要**把测试指向任何正式库。

## 提交

- 一个提交只做一件事；提交信息说明动机，而不是罗列文件。
- 不要手工修改 `bun.lock`；依赖变更走 `bun install` 并提交 lockfile 差异。
- 不要提交 `.env`、账号文件、素材目录或任何凭据。
- 新增或升级依赖时，同步更新 `THIRD_PARTY_NOTICES.md`：写明包名、版本、`package.json` 声明的 license、是否需要随附 NOTICE 或署名，以及判定依据（以包内 `LICENSE` 原文为准，`package.json` 字段只是线索；双许可要记录选定的分支与理由）。
- 界面文案用中文，客户可见文案不出现内部术语。

## 分发产物里的上游默认文案

上游编辑器／排版／插件包的默认主题带有示例公众号名称。构建期会按通用规则自动把它们中性化，**一旦残留，构建直接失败**。升级上游包后必须复核这套机制是否仍然覆盖上游的新写法，不要把校验去掉。

## 改动影响面提示

- 应用与前端由**同一个镜像**提供，必须整体同版本上线。
- 环境变量在进程启动时读取一次，改动后需重启容器。
- 新增业务配置用 `PUBLISHING_` 前缀；部署与基础设施变量沿用既有命名（`APP_ORIGIN`、`ZZHUB_WX_BASE_URL` 等）。

## 发布与镜像

- **镜像发布**：打 `v*` tag 会触发 `.github/workflows/release-images.yml`，构建**应用／Worker／中转**三个镜像的 `linux/amd64` 与 `linux/arm64` 多架构产物，推到 GHCR（`ghcr.io/k7airos/…`，用仓库自带的 `GITHUB_TOKEN`，无需额外凭据）。仓库若配置了 `DOCKERHUB_USERNAME`／`DOCKERHUB_TOKEN` 密文，同一批产物会**同时**推到 Docker Hub。
- **标签规则**：每个镜像同时带**发布版本**（tag 里的版本号）与**组件版本**（应用与 tag 相同；Worker 取 Pipeline 包版本；中转取中转包版本），另有 `latest`。改组件版本时记得同步改 compose 里的默认镜像标签与 README。
- **构建来源固定**：Worker 镜像来自公开仓库 `k7airos/zzhub-pipeline` 的固定提交，中转镜像来自 `k7airos/bun-wx-server` 的固定提交。升级其中之一时，**同时**改 `compose.yaml` 的 `build.context` 与发布工作流的 `matrix` 里的 `ref`，两者必须一致。
- **多架构注意事项**：基础镜像的 digest 必须固定到**多架构 index**（单架构 manifest 只能构建一种架构）；`bun build --compile` 必须显式给 `--target`，否则编出来的是宿主架构二进制。
- **发布后自检**：`docker manifest inspect ghcr.io/k7airos/<镜像>:<版本>` 应当能看到 amd64 与 arm64 两个 manifest。

## 其它

- 仓库内的 `AGENTS.md` 记录了工程约定，修改本仓库前请先读它。
- 遇到部署问题请先看 [README](README.md) 的「故障排查」一节。
