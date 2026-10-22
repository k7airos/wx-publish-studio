# 贡献指南

面向公开贡献者。项目定位与部署方式见 [README](README.md)，部署细节见 [docs/self-host.md](docs/self-host.md)。

## 环境

- Bun `1.3.14`、Docker 与 Compose。
- 技术栈：React / Vite + Bun / Hono + PostgreSQL。编辑器由 `@akairos/myno` 提供，排版与发布由 `@akairos/pipeline` 提供。

```sh
bun install --frozen-lockfile
bun run check   # tsc --noEmit
bun run build   # vite build
```

不要手工修改 `bun.lock`；依赖变更请走 `bun install` 并提交 lockfile 差异。

## 目录

| 路径 | 内容 |
| --- | --- |
| `src/web` | 前端（React）。`api.ts` 是接口与错误文案的唯一出口（文案本体在 `copy.ts`，按部署形态分流），`copy.ts` 是客户可见文案的唯一来源，`status.ts` 是任务状态的客户化表述。 |
| `src/server` | 后端（Hono）。`config.ts` 只从部署环境读配置，`routes/` 是 HTTP 接口，`services/` 是业务逻辑。 |
| `migrations` | 按编号排序的 SQL 迁移，启动时自动执行，记录在 `schema_migrations`。 |
| `tests` | Bun 测试。数据库测试需要专用 `*_test` 库，并要设 `TYPESET_ARTICLE_COVER_FONT_PATH`。 |
| `scripts` | 一次性运维脚本。 |
| `.github/workflows` | CI（每次推送与 PR）与镜像发布（打 `v*` tag，多架构 → GHCR）。 |

## 约定

- **新增业务配置用 `PUBLISHING_` 前缀**，不要另起前缀；部署与基础设施变量沿用既有命名（`APP_ORIGIN`、`POSTGRES_PASSWORD`、`DATABASE_URL`、`PIPELINE_WORKER_*`、`TYPESET_*` 等）。必填项与可选项见 `.env.example`。
- **OAuth 端点来源有三种**：`PUBLISHING_OAUTH_AUTHORIZATION_ENDPOINT`／`TOKEN_ENDPOINT`／`USERINFO_ENDPOINT`（显式端点）、`PUBLISHING_OAUTH_ISSUER` 配 `PUBLISHING_OAUTH_DISCOVERY=1`（标准发现）、以及不配这些变量时的既有形态。**既有形态的行为不得改变**（线上部署不改任何配置），新形态失败时启动即报错，不静默降级到别的端点。
- **界面文案用中文**，术语与现有产品保持一致。客户可见文案不出现内部术语（修订、快照、Worker、任务号等）。
- **共用设计令牌来自 npm 包 `@akairos/design`**（`src/web/ui.css` 引入 `family.css`）。强调色、焦点、选中态使用包内的 `--brand`、`--brand-strong`、`--brand-wash`、`--on-brand`，**不要在本仓库重新定义**。工作台保留自己的紧凑黑白中性外观（`--bg`、`--surface`、`--ink`、`--line` 等）。
- **当前只有浅色主题**。如果以后增加深色主题，给 `<html>` 加 `class="dark"`，中性覆盖写在 `html.dark` 下，并放在引入包之后。
- **分发包内上游默认文案由构建期通用中性化**（规则在 `scripts/brand-copy.ts`，插件在 `vite.config.ts`）。规则**不写死任何具体名称**：构建期从上游包产物里自动发现示例名称再按通用规则替换。上游包升级后**必须复核这套机制是否仍然覆盖上游的新写法**：残留时构建会失败，这是有意为之，不要把校验去掉。
- **仓库里不出现任何具体的第三方品牌名**（包括文档、注释、错误信息、测试数据）。本项目自身的产品名（`兔狲` / `wx-publish-studio`）与作者的联系信息除外。描述上游示例时只写「上游默认主题与插件示例里带有某个具体公众号的名称」这类通用表述。
- **不写入任何真实密钥、真实 IP、真实 AppID/AppSecret、真实域名**。示例一律用占位或 `example.com`。
- **不修改已有测试的断言语义**。修 bug 时先加能复现的用例；新增用例只增不减。
- **未知任务先查原 job 与草稿箱**，保留原修订及幂等键，不盲目换键重发。

## 提交

1. 一个提交只做一件事，提交信息说明动机而不是罗列文件。
2. 提交前跑 `bun run check` 与 `bun run build`。
3. 涉及接口、配置或数据库的改动，需要说明兼容性与迁移影响。
4. 不要提交 `.env`、账号文件、素材目录或任何凭据。

## 发布

- 打 `v*` tag 触发 `.github/workflows/release-images.yml`，构建**应用／Worker／中转**三个镜像的 `linux/amd64` 与 `linux/arm64` 产物，推到 GHCR（`ghcr.io/k7airos/…`，用仓库自带的 `GITHUB_TOKEN`，无需额外凭据）；配置了 Docker Hub 密文时同推。
- 每个镜像同时带**发布版本**与**组件版本**标签（应用与 tag 同版本；Worker 取 Pipeline 包版本；中转取中转包版本），另有 `latest`。
- **Worker 与中转的构建来源是固定提交**：分别在 `compose.yaml` 的 `build.context` 与发布工作流的 `matrix.ref`，**两者必须一致**，升级其中之一时同步改两处。
- 多架构前提：基础镜像 digest 必须固定到**多架构 index**；`bun build --compile` 必须显式给 `--target`，否则产物是宿主架构二进制。

## 许可与第三方声明

- 本项目自身许可见 [LICENSE](LICENSE)（MIT）。
- 依赖许可清单见 [THIRD_PARTY_NOTICES.md](THIRD_PARTY_NOTICES.md)。**新增或升级依赖时必须同步更新该文件**：写明包名、版本、`package.json` 声明的 license、是否需要随附 NOTICE 或署名，以及判定依据。判定口径是以包内 `LICENSE` 原文为准，`package.json` 字段只是线索。
- 双许可依赖要记录所选分支与选择理由。
