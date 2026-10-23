# 开源发布说明

本文说明这个仓库**以什么口径对外发布**，以及后续发版怎么继续。

## 公开仓库

- 仓库名：`k7airos/wx-publish-studio`
- 仓库与镜像名统一为 `wx-publish-studio`。
- 本项目**不发布 npm 包**；依赖全部走公共 `@akairos/*`。
- **Docker 镜像公开发布到 GHCR**：`ghcr.io/k7airos/wx-publish-studio`、`wx-pipeline-worker`、`wx-relay`，均为 `linux/amd64` 与 `linux/arm64` 多架构，**公开可匿名拉取**，不需要镜像仓库账号。镜像由打 `v*` tag 触发的工作流构建（见下文「后续发版怎么继续」）。
- 同时保留**从源码构建**的路径：Worker 与微信中转镜像由 compose 从两个公开仓库的固定提交以 git context 构建（见 README「快速开始」的「方式二」），同样不需要镜像仓库账号；compose 在镜像拉不到时会自动退回本地构建。

## 干净历史

公开仓库以**单一根提交**建立，不携带内部开发历史：

- 内部仓库的开发提交、评审讨论、临时分支都不进入公开历史。
- 公开仓库只有「初始提交 + 之后的增量提交」，便于外部贡献者看清每一处改动。
- 公开仓库的提交作者邮箱统一为 GitHub 的 noreply 形式（`k7airos@users.noreply.github.com`），作者署名保留为 `Kairos`；不把个人邮箱写进公开历史。
- 内部仓库 `k7airos/publishing-studio` 按作者决定**不做归档**，继续作为内部开发仓库使用；它不是公开仓库的镜像，两者不要求同步。

## 这次清理掉了什么

对外发布前，从树里清掉了以下几类**本人资产**：

| 类别 | 具体内容 |
| --- | --- |
| 服务器 IP 与出口白名单 | 硬编码的发布服务出口 IP（原先写在前端常量里），改为部署可选配置 `PUBLISHING_WX_WHITELIST_IP`，未配置时由使用者自己在连接向导里填 |
| 私有域名与私有 registry | 内部部署使用的域名、镜像仓库地址、对象存储来源配置，改为部署侧环境变量，示例一律用 `example.com` 与文档保留地址 `203.0.113.10` |
| 个人品牌字面量 | 前端产物里来自上游编辑器包默认主题的示例品牌文案，改为**构建期通用中性化**（规则见 `scripts/brand-copy.ts`，不写死任何具体名称；残留时构建直接失败） |
| 内部编排说明 | 内部生产环境的编排细节、私有服务的调用约定与客户话术，改为按部署形态分流的中性文案（`PUBLISHING_COPY_MODE`，默认 `neutral`） |

### 关于 `hosted` 文案分支

`src/web/copy.ts` 里保留了一套**线上托管部署的原有文案**（含会员续期指引），由 `PUBLISHING_COPY_MODE=hosted` 触发，默认不启用。

- 这是**有意保留**的：线上托管部署与开源部署共用同一套代码，切开关即可恢复原有措辞，不需要维护两份代码。
- 开源默认路径（`neutral`）不出现任何私有产品名或会员体系用语。
- 公开仓库里因此仍能搜到少量历史文案字样；这是「线上行为不变」的必要条件，不是清理遗漏。

清理后的仓库里**不含**：真实密钥、真实 AppID/AppSecret、真实 IP、真实私有域名、账号文件、素材目录。

## 后续发版怎么继续

1. 在**公开仓库**上按功能分批提交，一个提交只做一件事，提交信息说明动机。
   - 提交前先确认用的是 noreply 邮箱（`git config user.email k7airos@users.noreply.github.com`），**不要把个人邮箱带进公开历史**。历史一旦推上去再改写会影响已发布的镜像与 tag，成本远高于提交前确认。
2. 每次提交前跑 `bun run check` 与 `bun run build`；涉及接口、配置或数据库的改动要在提交信息里说明兼容性与迁移影响。
3. 依赖变更走 `bun install` 并提交 lockfile 差异，同时更新 `THIRD_PARTY_NOTICES.md`。
4. 升级上游 `@akairos/*` 包时，**复核 `scripts/brand-copy.ts` 的中性化规则是否仍然覆盖上游写法**；上游新增同类写法会让构建失败，需要更新规则而不是绕过。
5. 发布新版本时更新 `package.json` 版本、compose 里三个镜像的默认 tag、README 与 `.env.example` 里的镜像示例。
6. 打 `v*` tag 触发镜像发布工作流，产出三个镜像的 amd64+arm64 产物并推到 GHCR；每个镜像同时带发布版本与组件版本标签。**Worker 与中转的构建来源是固定提交**，分别在 `compose.yaml` 的 `build.context` 与发布工作流的 `matrix.ref`，升级其中之一时**两处必须同步改**。

## 许可

- 本项目自身许可：见 [LICENSE](../LICENSE)（MIT）。
- 第三方依赖许可：见 [THIRD_PARTY_NOTICES.md](../THIRD_PARTY_NOTICES.md)。

两个文件都随 Docker 镜像分发。
