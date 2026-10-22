# 自托管说明

本文面向已经克隆本仓库、准备在自己服务器上部署的使用者。快速上手与已知限制见 [README](../README.md)，本文只讲部署细节与不可逆操作。

## 需要准备什么

- Docker Engine 24+ 与 `docker compose` v2。
- 一个具备管理员权限的微信公众号（能扫码登录微信公众平台）。
- 一个兼容 `/api/v1/wx/*` 的微信中转服务。公开实现见 `bun-wx-server`（<https://github.com/k7airos/bun-wx-server>）；**该服务当前只实现 3 个微信端点，Pipeline 需要 7 个**，缺口见 README「当前状态」。中转是独立部署的服务，不在本仓库的 compose 里。
- 如果要发布带图片的正文，还需要对象存储（COS 一类）与公开 HTTPS 地址。

本仓库不包含中转服务，也不发布 Docker 镜像。

## 首次启动

1. `cp .env.example .env`，生成独立随机值填入 `POSTGRES_PASSWORD`、`CREDENTIAL_ENCRYPTION_KEY`、`PIPELINE_WORKER_TOKEN`，以及 bootstrap 模式至少 32 字符的 `BOOTSTRAP_SECRET`。建议 `openssl rand -hex 32`；数据库密码用十六进制，避免 URL 编码歧义。
2. 明确 `APP_ORIGIN`。SSH 转发使用 `http://127.0.0.1:18889`，浏览器实际访问端口须一致；独立 HTTPS 入口填完整 origin。只接受 HTTPS 或 HTTP loopback，不接受路径、userinfo 或通配 origin。Cookie 的 Secure 由此固定配置决定，不信任 `X-Forwarded-*`。应用容器内部监听 `0.0.0.0`，宿主仍只暴露 `127.0.0.1`，数据库与 Worker 不映射端口。
3. 填写 `ZZHUB_WX_BASE_URL`，它必须是实现 `/api/v1/wx/*` 的受控中转服务，不能填微信官方 API。
4. 准备 Worker 镜像。npm 包 `@akairos/pipeline` 不含 `services/` 目录，不能仅安装 npm 包后启动 Worker；须从 Pipeline 仓库的固定提交构建镜像，并设置 `PIPELINE_WORKER_IMAGE`。具体命令见 README「获取 Worker 镜像」：

   ```sh
   git clone https://github.com/k7airos/zzhub-pipeline.git
   cd zzhub-pipeline
   git checkout 4cf5725f35758fa5fada8786cb57cd9960388c7f
   docker build -f services/cloud-worker/Dockerfile -t wx-pipeline-worker:0.24.0 .
   ```

   构建上下文必须是 Pipeline 仓库根目录；镜像内已装 Chromium 与 Noto CJK 字体，不需要额外 build args。构建完回到本仓库，把镜像引用写进 `.env` 的 `PIPELINE_WORKER_IMAGE`。
5. 准备微信中转：按 `bun-wx-server` 的公开说明单独起一个服务，取一个带 `wx` scope 的 PAT，把地址写进 `ZZHUB_WX_BASE_URL`。缺中转时 app 仍能启动，但所有发布动作都会失败。
6. `docker compose up -d --build --wait`，打开配置的 origin，按所选模式使用访问口令。修改本机端口时同步 `.env` 的 `APP_PORT` 与 `APP_ORIGIN`。

`docker compose` 对 7 项必填配置（`APP_ORIGIN`、`POSTGRES_PASSWORD`、`CREDENTIAL_ENCRYPTION_KEY`、`BOOTSTRAP_SECRET`、`PIPELINE_WORKER_TOKEN`、`PIPELINE_WORKER_IMAGE`、`ZZHUB_WX_BASE_URL`）用 `:?` 直接报错并指出缺哪一项；填了但不合规的值由应用启动时校验并给出明确原因（例如 `BOOTSTRAP_SECRET must contain at least 32 characters`）。新安装不需要账号文件，空连接可以编辑保存文章，发布按钮会提示添加连接。

> `BOOTSTRAP_SECRET` 在 compose 里是硬性必填（compose 不做条件判断）。用 `PUBLISHING_AUTH_MODE=oauth` 且不需要口令登录时，也要给出一个占位值；应用本身只在 bootstrap 模式下校验它的长度。

## 配置公众号

在「公众号」页打开连接向导，填写名称、公众号 AppID、AppSecret：

- **中转访问令牌（PAT）**：仅当部署**没有**配置 `PUBLISHING_RELAY_PAT` 时才需要填写，这是你自己中转服务的访问令牌。保存后直接可选，无需重启。
- **IP 白名单**：部署配置了 `PUBLISHING_WX_WHITELIST_IP` 时向导直接显示该值；否则由你填写自己中转服务的出口公网 IP。填错不会在保存时报错，而是在第一次存入草稿箱时暴露。

> `PUBLISHING_RELAY_PAT` 与 `PUBLISHING_WX_WHITELIST_IP` 都在**启动时读取一次**，改了环境变量必须重启容器才生效。
> 如果运维之后把 `PUBLISHING_RELAY_PAT` 从环境变量里撤掉，早先建立的连接会没有自己的 PAT，公众号连接列表会显式提示「这个连接没有中转访问令牌（PAT）」，需要逐个在「更新密钥」里补齐。

点击「同步连接」仅通过 `PUT /v1/accounts/:account` 登记凭据，不创建草稿；发布时也先自动登记，先持久化原 job 身份，登记或发送失败保留原任务为 unknown，不自动重试。

编辑时秘密输入为空保留原值，GET 不返回原值或密文；AppID 不可修改，另一公众号应新建。连接名称可修改。秘密修改后生成新 credential revision 与新 Worker key，旧任务固定原 key；停用只阻止新任务，保留历史及恢复所需凭据，不删除 Worker 的旧账号。Worker 卷里的账号登记文件为受限明文文件，并非加密保管库；业务数据库中的秘密使用 AES-256-GCM 加密，主密钥不在数据库内。

## 数据、备份与恢复

数据库卷保存文章、会话、连接、加密凭据修订与任务映射；应用卷保存上传的封面与正文素材；Worker 卷保存账号、队列和运行结果。`docker compose stop` / `down` 不删除卷；**不要使用 `down -v` 清理用户数据**。

更新前备份三个卷及 `CREDENTIAL_ENCRYPTION_KEY`。`schema_migrations` 记录已执行迁移，迁移在应用启动时自动执行，旧 job 仍用旧 key，不清空原数据。

同一文档修订和账号只有一条 job。遇到未知结果，先刷新原任务和核对草稿箱；没有 Worker ID 时按原幂等键和账号只读 lookup，核对 title/bodyHash 和全部快照身份后采用原 Worker ID；重复提交或确认只读查询，不重新登记、上传、POST 任务或 POST 确认。不要编辑正文后用新任务盲重发。当前没有取消任务或自动重试。

健康检查只证明服务可连接。真实草稿验收应独立记录：app job／Worker job／Pipeline run、账号引用及凭据修订、草稿回读、正文表格和封面比例行为。运行包由独立 Worker 配置和数据目录提供，app 不写死模板素材路径。

## 确认与恢复

```sh
docker compose ps
docker compose restart app
docker compose exec worker bun -e 'fetch("http://127.0.0.1:18887/health", {headers:{Authorization: "Bearer " + process.env.PIPELINE_WORKER_TOKEN}}).then(async r => console.log(r.status, await r.json()))'
```

## 单实例与权限边界

app 与 Worker 都只运行单副本。app 的上传／导入／Canvas 槽绑定实际请求 finally 释放；数据库 owner 行锁保护素材容量及账号配额，全局短锁保护任务 active 计数。**不要扩多 app 进程或共享 Worker 卷多副本。**

固定上限在 `src/server/services/owner-limits.ts`：每 owner 5 个连接、每连接 20 个凭据修订（含历史）；正文和封面合计 128MiB／200 文件；10 个 retained job、2 个 active／全局 8 个 active；上传、导入、Canvas 各每 owner 1／全局 2。

bootstrap 模式下的所有数据都归属同一个默认 owner（`OWNER_ID` 常量，见 `src/server/db/schema.ts`）。它是让单用户自托管开箱可用的固定值，**所有实例共享同一个默认 owner id**，不代表任何真实用户身份；多用户部署需要另行绑定身份。

## 鉴权模式

`PUBLISHING_AUTH_MODE` 只接受 `bootstrap` 或 `oauth`，默认 `bootstrap`。bootstrap 模式使用一个访问口令（`BOOTSTRAP_SECRET`），这是当前唯一可用的模式。oauth 模式要求完整配置：

```dotenv
PUBLISHING_AUTH_MODE=oauth
PUBLISHING_OAUTH_ISSUER=https://idp.example.com
PUBLISHING_OAUTH_PORTAL_URL=https://idp.example.com/oauth/authorize
PUBLISHING_OAUTH_BASE_URL=https://idp.example.com
PUBLISHING_OAUTH_CLIENT_ID=REGISTERED_CLIENT_ID
PUBLISHING_OAUTH_CLIENT_SECRET=SERVER_ONLY_SECRET
PUBLISHING_OAUTH_REDIRECT_URI=https://studio.example.com/api/auth/oauth/callback
```

issuer/base 必须是精确受信 origin，Portal 固定 `/oauth/authorize` 且无额外 query；redirect 必须严格等于 `${APP_ORIGIN}/api/auth/oauth/callback` 并与注册 client 完全一致。HTTP 仅允许显式 loopback 用于本地／隧道／恢复。所有 URL 来自部署，不信任 Host/X-Forwarded 或调用方 returnTo。secret 只在受控环境文件／secret 中，禁止写 Git 或前端。

**通用 OIDC 尚未完成**：当前实现保留了对特定会员资格服务的假设，开源版以 bootstrap 为默认；接入自己的 IdP 前请先读 `src/server/auth/oauth.ts` 与 `src/server/auth/access.ts`。

## 部署形态与客户可见文案

客户可见文案按部署形态分流，由 `PUBLISHING_COPY_MODE` 控制：

| 取值 | 用途 |
| --- | --- |
| `neutral`（**默认**） | 开源自托管用的中性文案，不出现私有品牌或会员体系用语 |
| `hosted` | 线上托管部署用的原有文案（含原来的续期指引与顾问说法） |

线上托管部署要保持原有文案，只要在部署环境里加一行：

```dotenv
PUBLISHING_COPY_MODE=hosted
```

该值随 `/api/auth/options` 与 `/api/auth/session` 下发，前端据此取文案；改这一项同样需要重启容器。**app 与前端由同一个镜像提供，必须整体同版本上线，不要只换前端。**

## 正文图片

正文图片走对象存储（COS 一类）的上传与公开 HTTPS 地址，不是开箱即用能力。Worker 侧的图片渲染需要 `@napi-rs/canvas`；固定素材需要先上传到对象存储并替换为 HTTPS URL。缺配置时相关能力会明确报错，不会静默降级。

## 测试与生产的边界

本地三容器健康测试可用 `https://relay.invalid` 作为明确不可发布的占位地址，并保持空账号。它不会发起微信请求。集成测试用 `PUBLISHING_TEST_MODE=fake-worker` 标记模拟环境，前端显示「模拟测试环境」，不把模拟 `media_id` 当成真实发布证据。正式环境不设置该变量。

测试执行者使用专用 `*_test` 数据库，先 `bun run check`／`bun run build`，再分别运行对应测试文件；其中部分会清理指定测试库的应用表。不得指向正式业务库。

跑测试还需要封面字体文件路径，两个变量都要给：

```sh
TEST_DATABASE_URL=postgres://USER:PASS@127.0.0.1:5432/wxstudio_test \
TYPESET_ARTICLE_COVER_FONT_PATH=/usr/share/fonts/opentype/noto/NotoSansCJK-Regular.ttc \
bun run test
```

`TYPESET_ARTICLE_COVER_FONT_PATH` 指向的文件必须与封面合同**同字节**（宿主可用 `apt install fonts-noto-cjk` 安装同款），缺文件或 hash 不符会直接报错。

## 封面字体合同

Docker app 固定安装 `fonts-noto-cjk=1:20240730+repack1-1`。封面测量前校验 `NotoSansCJK-Regular.ttc` 的 SHA256，并通过 Typeset 注册 `Publishing Cover` 别名。默认路径 `/usr/share/fonts/opentype/noto/NotoSansCJK-Regular.ttc`；本地可用受信部署变量 `TYPESET_ARTICLE_COVER_FONT_PATH` 指向相同字节，不能由 API 调用方指定。缺文件、hash 不符或注册失败明确拒绝，不回退系统字体。字体不从浏览器下载或上传。

## 已知限制

- **没有公共镜像**：应用镜像需自行 `docker compose build`；Worker 镜像需按上文从 Pipeline 的固定提交自行构建。
- **中转端点不全**：公开的中转服务只实现 `cgi-bin/token`、`material/add_material`、`draft/add`，缺 `draft/update`、`draft/get`、`draft/delete`、`draft/batchget`，也未实现 `Idempotency-Key` 去重。缺 `draft/update` 时「改稿后覆盖同一篇草稿」不可靠。
- **正文图片依赖 COS**：见上一节。
- **单实例**：app 与 Worker 均单副本。
- **仅 bootstrap 鉴权**：无注册、无群发、无多用户配额管理。
- **分发产物里的默认文案**：上游编辑器包的默认主题带有示例品牌字面量，本项目在构建期定点替换（清单见 `vite.config.ts`）；上游包升级后需复核。详见 README「当前状态」。

## 许可

本项目 MIT，见 [LICENSE](../LICENSE)；第三方依赖许可见 [THIRD_PARTY_NOTICES.md](../THIRD_PARTY_NOTICES.md)。两个文件都随 Docker 镜像分发。
