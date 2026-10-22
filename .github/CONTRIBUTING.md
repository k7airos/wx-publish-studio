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

## 其它

- 仓库内的 `AGENTS.md` 记录了工程约定，修改本仓库前请先读它。
- 遇到部署问题请先看 [README](README.md) 的「故障排查」一节。
