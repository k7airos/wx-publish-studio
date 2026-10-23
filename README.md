# 兔狲 · 公众号助手（wx-publish-studio）

自托管的微信公众号图文工作台：写正文、配样式与封面、看手机预览，确认后存入**你自己的公众号草稿箱**。一条 `docker compose up` 起全套。

[![License: MIT](https://img.shields.io/github/license/k7airos/wx-publish-studio)](LICENSE)
[![Release](https://img.shields.io/github/v/release/k7airos/wx-publish-studio)](https://github.com/k7airos/wx-publish-studio/releases)
[![GHCR](https://img.shields.io/badge/GHCR-wx--publish--studio-2496ED?logo=docker&logoColor=white)](https://github.com/k7airos/wx-publish-studio/pkgs/container/wx-publish-studio)
![Platforms](https://img.shields.io/badge/platform-linux%2Famd64%20%7C%20linux%2Farm64-lightgrey)

[它能做什么](#它能做什么) · [架构](#架构) · [快速开始](#快速开始) · [配置](#配置) · [微信与中转](#微信与中转) · [备份与升级](#数据备份与升级) · [已知限制](#已知限制) · [故障排查](#故障排查) · [相关项目](#相关项目) · [需要协助部署](#需要协助部署)

## 它能做什么

1. **写正文**：在编辑器里写文章，粘贴的 Markdown 和图片原样保留。
2. **配样式与封面**：调整正文排版（字号、间距、提示块等）；封面按标题自动生成，也可以上传自己的图片。
3. **生成预览**：产出手机尺寸的完整预览，正文与封面所见即所发。
4. **存入草稿箱**：确认后写入你已连接的公众号草稿箱，回到公众号后台自行发表。改稿后可以覆盖同一篇草稿，重复提交不会产生重复草稿。

**只写草稿箱，不群发。** 本项目不提供群发、定时群发或数据统计，也不读取已发布内容；发布与否由你在公众号后台决定。

## 架构

```mermaid
flowchart LR
  B[浏览器] --> A[app 应用]
  A <--> P[(PostgreSQL)]
  A -- 任务 --> W[Worker]
  W -- /api/v1/wx/* --> R[微信中转 relay]
  R --> WX[微信公众平台 API]
```

`docker compose up` 会起四个容器：

| 服务 | 作用 | 镜像 | 对应项目 |
| --- | --- | --- | --- |
| `app` | 编辑器、排版、预览、账号与任务管理 | `ghcr.io/k7airos/wx-publish-studio:0.7.2` | 本仓库；正文编辑器用 [myno](https://github.com/k7airos/myno)，封面用 [typeset-studio](https://github.com/k7airos/typeset-studio) |
| `worker` | 渲染封面与预览（内含 Chromium），按任务调用微信 | `ghcr.io/k7airos/wx-pipeline-worker:0.24.0` | [zzhub-pipeline](https://github.com/k7airos/zzhub-pipeline) |
| `relay` | 微信中转：持有账号与令牌，代理微信草稿与素材接口 | `ghcr.io/k7airos/wx-relay:0.2.2` | [bun-wx-server](https://github.com/k7airos/bun-wx-server) |
| `db` | PostgreSQL 16 | `postgres:16-alpine`（固定 digest） | 官方镜像 |

三个自有镜像都发布在 GHCR，多架构（linux/amd64 与 linux/arm64），公开可拉，不需要镜像仓库账号，也不需要 `docker login`。

## 快速开始

默认是**模式 A（同栈自带中转）**：不需要自己准备中转服务。想用自己的中转见[模式 B](#模式-b用自己的中转)。

**前置条件**

- 一台 2 核 4G 起步的服务器。Worker 内含 Chromium，建议给它单独留 1G 以上内存；宿主不需要装 Chromium。
- Docker Engine 24+，`docker compose` v2.2 以上（`--wait` 从 v2.2.0 才有）。
- 一个具备管理员权限、能扫码登录微信公众平台的公众号。
- Worker 能访问外网：正文里引用的外链图片由它在发布时抓取并转存到微信。

### 方式一：用已发布镜像（推荐）

```sh
# 1. 获取代码
git clone https://github.com/k7airos/wx-publish-studio.git
cd wx-publish-studio

# 2. 准备 .env，并生成 5 个密钥（每条命令输出一个值，分别填入对应变量）
cp .env.example .env
openssl rand -hex 32   # POSTGRES_PASSWORD
openssl rand -hex 32   # CREDENTIAL_ENCRYPTION_KEY（必须是 64 位 hex）
openssl rand -hex 32   # BOOTSTRAP_SECRET（登录口令，至少 32 字符）
openssl rand -hex 32   # PIPELINE_WORKER_TOKEN
openssl rand -hex 32   # RELAY_JWT_SECRET（同栈中转的签名密钥）

# 3. 编辑 .env：填上面 5 项，并设置 APP_ORIGIN（见下方说明）

# 4. 起栈（拉取三个公开镜像，等到四个容器全部健康）
docker compose up -d --wait

# 5. 初始化同栈中转：创建中转管理员，生成访问令牌并写回 .env
bash scripts/relay-init.sh

# 6. 重新起栈，让应用加载刚写入的令牌
docker compose up -d --wait
```

第 3 步里的 `APP_ORIGIN` 是你打算在浏览器里访问的 origin，**必须与浏览器地址栏完全一致**（协议、域名、端口）：

- 本机或 SSH 隧道：`http://127.0.0.1:18889`
- 自建 HTTPS 反代：`https://studio.example.com`

其余变量保持 `.env.example` 的默认值。**尤其不要改动 `ZZHUB_WX_BASE_URL`（留空即模式 A）和它下面两行派生变量 `RELAY_MODE` / `RELAY_REPLICAS`。**

镜像拉不到时，compose 会自动退回从源码构建，不会把部署卡死。

### 方式二：从源码构建

想自己编译，或 GHCR 不可达时，把第 4 步和第 6 步的命令换成带 `--build` 的版本：

```sh
docker compose up -d --build --wait
```

它会用本地代码构建应用镜像，从 `k7airos/zzhub-pipeline` 的固定提交构建 Worker，从 `k7airos/bun-wx-server` 的固定提交构建中转，并等到四个容器全部健康。首次构建要联网，冷构建约 10-20 分钟（Worker 最重，要装 Chromium 与 Noto CJK 字体）。镜像大小：应用约 1GB、Worker 约 2.1GB、中转约 250MB。有构建缓存时后续启动是秒级。

> 源码构建出的镜像会盖掉同名的 `ghcr.io/k7airos/…` 标签。之后再跑不带 `--build` 的 `up`，compose 会继续用本地那份；想换回官方镜像，先 `docker compose pull`。

### 访问

应用只绑定回环地址 `127.0.0.1:18889`，这是刻意的安全边界。远程访问二选一：

- **SSH 隧道**：`ssh -L 18889:127.0.0.1:18889 user@your-server`，然后浏览器打开 `http://127.0.0.1:18889`。
- **自建 HTTPS 反代**：用 Nginx / Caddy 等终止 TLS 并转发到 `127.0.0.1:18889`，同时把 `.env` 的 `APP_ORIGIN` 改成你的 `https://` 域名，再重启。

换了端口要同步改 `.env` 的 `APP_PORT` 与 `APP_ORIGIN`。

### 连接公众号并发出第一篇草稿

1. **登录**：打开地址，输入 `BOOTSTRAP_SECRET`。
2. **连接公众号**：进「公众号」页 → 「添加公众号」，按向导填公众号名称、AppID、AppSecret（在微信公众平台的开发设置里）。模式 A 下不用填中转令牌。
3. **配置 IP 白名单**：向导会要你把**实际调用微信的那个中转的出口公网 IP** 加进公众号后台的「API IP 白名单」。模式 A 下中转就跑在这台服务器上，所以填**这台服务器的公网 IP**（例如 `203.0.113.10`）。白名单生效有等待期，第一次存入草稿箱时才会真正验证。
4. **写第一篇**：进「文章」页 → 新建 → 在编辑器里写正文，可以直接粘贴现成的 Markdown。
5. **配排版与封面**：右侧面板调样式；封面可按标题自动生成，也可以上传自己的图。
6. **预览**：点「预览」，看手机尺寸下的完整效果。
7. **存入草稿箱**：确认无误后点「存入草稿箱」，回到公众号后台的草稿箱就能看到。

上面某一步出错，先看[故障排查](#故障排查)。更完整的部署细节见 [自托管说明](docs/self-host.md)。

### 模式 B：用自己的中转

不想用随栈的中转，就用你自己的（需要实现 `/api/v1/wx/*` 契约，见[微信与中转](#微信与中转)里的 7 个端点）：

1. 在 `.env` 里**就地修改** `ZZHUB_WX_BASE_URL` 那一行，填你的中转地址（例如 `https://relay.example.com`）。**不要把它追加到文件末尾**，下面两行派生变量依赖它的取值。
2. `RELAY_MODE` 与 `RELAY_REPLICAS` 保持原样：它们是派生变量，模式 B 下自动把中转副本数置 0。
3. 执行 `docker compose up -d --wait`（用已发布镜像）或 `docker compose up -d --build --wait`（从源码构建）。compose 不会起中转容器，Worker 指向你的地址。
4. `PUBLISHING_RELAY_PAT` 留空，使用者在连接向导里填自己中转的 PAT；`RELAY_JWT_SECRET` 与 `scripts/relay-init.sh` 都用不到。IP 白名单填你自己中转的出口 IP。

模式 B 下 compose 仍会准备中转镜像（只是不运行），这样不必维护第二套构建分支；不想准备就删掉或注释掉 compose 里的 `relay` 服务。

## 配置

所有配置都在**启动时读取一次**，所以改任何环境变量都必须重启（重建）容器才生效：用已发布镜像是 `docker compose up -d --wait`，从源码构建是 `docker compose up -d --build --wait`。

`docker compose` 对下面 5 项用 `:?` 直接报错并指出缺哪一项，不会静默使用默认值：

| 变量 | 含义 | 怎么得到 |
| --- | --- | --- |
| `APP_ORIGIN` | 受信浏览器 origin，必须与浏览器实际 origin 完全一致 | 手填，例如 `http://127.0.0.1:18889` 或 `https://studio.example.com` |
| `POSTGRES_PASSWORD` | 数据库密码（用十六进制，避免 URL 编码歧义） | `openssl rand -hex 32` |
| `CREDENTIAL_ENCRYPTION_KEY` | 公众号凭据加密主密钥，64 位 hex。**更换后旧凭据无法解密**，必须先备份并从备份恢复，或重新连接全部公众号 | `openssl rand -hex 32` |
| `BOOTSTRAP_SECRET` | 登录口令，bootstrap 模式至少 32 字符 | `openssl rand -hex 32` |
| `PIPELINE_WORKER_TOKEN` | app 与 Worker 共用的令牌 | `openssl rand -hex 32` |

另有一项**按模式必填**：`RELAY_JWT_SECRET`，仅模式 A 需要（同栈中转的签名密钥，`openssl rand -hex 32`）；模式 B 下中转不启动，不需要它。

compose 只检查「有没有填」。填了但不合规的值由应用启动时校验并报明确原因，例如 `BOOTSTRAP_SECRET must contain at least 32 characters`、`CREDENTIAL_ENCRYPTION_KEY must be 32-byte hexadecimal`、`APP_ORIGIN must be an HTTPS origin, or an explicit HTTP loopback origin`。

<details>
<summary>可选配置一览</summary>

| 变量 | 含义 |
| --- | --- |
| `ZZHUB_WX_BASE_URL` | 留空 = 同栈自带中转（模式 A）；填写 = 外部中转地址（模式 B） |
| `PUBLISHING_RELAY_PAT` | 部署统一持有的中转访问令牌。模式 A 由 `scripts/relay-init.sh` 写入 |
| `PUBLISHING_WX_WHITELIST_IP` | 微信 API 白名单需要的出口公网 IP；配置后界面直接显示该值 |
| `PUBLISHING_AUTH_MODE` | `bootstrap`（默认）或 `oauth`，见[接入统一身份](#接入统一身份可选) |
| `PUBLISHING_OAUTH_*` | oauth 模式下的身份源配置：issuer、client id/secret、redirect，以及标准发现或三个显式端点 |
| `PUBLISHING_COPY_MODE` | 客户可见文案形态：`neutral`（默认）/ `hosted`，见[部署形态与客户可见文案](#部署形态与客户可见文案) |
| `PUBLISHING_BODY_IMAGE_SOURCE_ORIGIN` / `PUBLISHING_BODY_IMAGE_SOURCE_PREFIX` | 正文里**从外部地址导入图片**时允许的来源域名与路径前缀，例如 `https://img.example.com` + `/owner/hash/`。留空 = 不允许导入外部图片，正文图片只能靠编辑器上传 |
| `PUBLISHING_BODY_IMAGE_OWNER_SOURCES` | 按使用者（owner）单独授权的图片来源，JSON 形式：`{"<owner-uuid>":[{"origin":"https://img.example.com","pathPrefix":"/their/files/"}]}`。用于迁移既有素材 |
| `APP_PORT` | 宿主端口，默认 `18889`；改了要同步改 `APP_ORIGIN` |
| `APP_IMAGE` | 覆盖应用镜像引用，默认 `ghcr.io/k7airos/wx-publish-studio:0.7.2`。固定到别的版本或自己的 registry 时填它，必须写完整 registry 路径 |
| `PIPELINE_WORKER_IMAGE` | 覆盖 Worker 镜像引用，默认 `ghcr.io/k7airos/wx-pipeline-worker:0.24.0` |
| `RELAY_IMAGE` | 覆盖中转镜像引用，默认 `ghcr.io/k7airos/wx-relay:0.2.2` |
| `RELAY_ADMIN_USERNAME` / `RELAY_ADMIN_PASSWORD` | 同栈中转的管理员账号，供 `scripts/relay-init.sh` 使用，脚本自己读写 `.env`；没有口令时会随机生成，请自行妥善保管 |

`RELAY_MODE` 与 `RELAY_REPLICAS` 是由 `ZZHUB_WX_BASE_URL` 推导的**派生变量**，请保留它们，并保持它们位于 `ZZHUB_WX_BASE_URL` 之后。

如果配置了 `PUBLISHING_RELAY_PAT`，使用者在界面上只需填 AppID 与 AppSecret；不配置时，需要在连接向导里填写自己中转服务的访问令牌（PAT）。如果之后把 `PUBLISHING_RELAY_PAT` 从环境变量里撤掉，早先建立的连接会缺少 PAT，连接列表会提示「这个连接没有中转访问令牌（PAT）」，需要逐个在「更新密钥」里补齐。

</details>

## 微信与中转

- **两种模式**：模式 A（默认）由 compose 起第 4 个容器 `relay`，地址是 `http://relay:3001`，只在容器网络内可达，不映射宿主端口；模式 B 指向你自己的中转地址，compose 不起中转容器。
- **中转从哪来**：模式 A 用已发布的 `ghcr.io/k7airos/wx-relay`（源码为 [bun-wx-server](https://github.com/k7airos/bun-wx-server)，也可让 compose 从它的固定提交现场构建）；模式 B 可以自己实现 `/api/v1/wx/*` 契约。
- **覆盖范围**：随栈中转已实现 Pipeline 需要的全部 7 个微信端点：`cgi-bin/token`、`material/add_material`、`draft/add`、`draft/update`、`draft/get`、`draft/delete`、`draft/batchget`。并支持 `Idempotency-Key` 幂等去重：同一把 PAT 下同 key 的重复请求不会重复写微信，直接返回首次结果；默认保留 24 小时，可用 `WX_IDEMPOTENCY_TTL_SECONDS` 调整。模式 B 请自行确认你的中转实现了同样的契约。
- **PAT**：PAT 是中转服务签发的访问令牌，代表你调用中转接口，与微信 AppID / AppSecret 是两回事。scope 里 `wx` 对应 `/api/v1/wx/`。模式 A 下 `bash scripts/relay-init.sh` 会创建管理员、生成带 `wx` scope 的 PAT 并写回 `.env` 的 `PUBLISHING_RELAY_PAT`；重复跑是安全的：已有令牌仍有效就沿用，需要换新令牌时旧的同名令牌会被吊销，不会越积越多。
- **IP 白名单**：在公众号后台的「API IP 白名单」里填**实际调用微信的那个中转的出口公网 IP**：模式 A 是这台服务器的公网 IP，模式 B 才是你自己中转的出口 IP。白名单生效有等待期，填错不会在保存连接时报错，而是在第一次存入草稿箱时暴露。
- **正文图片**：不需要自备对象存储。在编辑器里上传的图片存在应用自己的数据卷，发布时随任务交给 Worker，由 Worker 上传到微信，草稿里的图片地址是微信自己的 CDN。正文里直接引用的外链图片，Worker 会在发布时从公网抓取并转存到微信，所以 Worker 要能访问外网。只有主题里的固定素材指向远程地址时，才需要另外准备一个公网可达的 HTTPS 地址。

## 数据、备份与升级

四个卷各存不同的东西：

| 卷 | 内容 |
| --- | --- |
| `app-data` | 应用私有数据：上传的封面与正文素材（`assets/`、`body-assets/`） |
| `database-data` | PostgreSQL 数据：文章、排版、封面模板、公众号连接、加密凭据修订、任务映射 |
| `worker-data` | Worker 的账号登记、任务队列与运行结果 |
| `relay-data` | 同栈中转的数据：管理员、访问令牌、审计日志（模式 B 下没有这个卷） |

**备份要包含**这四个卷，以及 `CREDENTIAL_ENCRYPTION_KEY`。少任何一项，恢复后都无法完整还原。

> **不要执行 `docker compose down -v`。** `-v` 会删除上述四个卷，用户数据不可恢复。

**升级**（数据库迁移由应用在启动时自动执行，记录在 `schema_migrations` 表里）。用已发布镜像：

```sh
git pull
docker compose pull
docker compose up -d --wait
```

用源码构建：

```sh
git pull
docker compose up -d --build --wait
```

- **换版本时要重新拉镜像**：compose 里的默认标签是写死的版本号，标签没变时 `up` 不会重新拉。升级后先 `docker compose pull`，再 `up`。
- 源码构建路径下，Worker 与中转镜像来自两个公开仓库的固定提交，compose 会复用构建缓存；缓存失效时耗时按上面「方式二」估计。
- 如果把 `APP_IMAGE` 指向了**自己的** registry（如 `registry.example.com/wx-publish-studio:1.2.3`），就改成先推再拉：

  ```sh
  docker build -t registry.example.com/wx-publish-studio:1.2.3 .
  docker push registry.example.com/wx-publish-studio:1.2.3
  docker compose pull && docker compose up -d --wait
  ```

## 已知限制

- **单实例**：app 与 Worker 都不能跑多副本。Worker 是本地 JSON 队列，共享卷多副本会互相覆盖。
- **同栈中转只在容器网络内可达**：模式 A 的中转不映射宿主端口，只能被同栈 Worker 通过 `http://relay:3001` 访问。
- **默认是 bootstrap 单用户**：只有一个访问口令。通用 OIDC 可以接入，但多用户配额、邀请制与自助开通成员仍未提供，OIDC 登录的用户需要管理员预先绑定成员。
- **无注册、无群发**：不提供账号体系，也不提供任何群发能力。
- **只写草稿箱**：不读取公众号已发布内容，不做数据统计。
- **默认文案已中性化**：上游编辑器包 `@akairos/myno` 的默认主题与插件示例里带有某个具体公众号的名称，这些名称曾随分发产物发布，现在由构建期通用中性化清成中性文案（例如页脚默认文案为「你的公众号」），运行镜像内 `/app/dist` 已 0 命中。规则在 `scripts/brand-copy.ts`，**升级上游包后必须复核**；残留任何上游默认名称时构建直接失败。自查：`bun run build && bun run check:brand`。

## 故障排查

<details>
<summary>展开故障排查表</summary>

| 现象 | 排查方向 |
| --- | --- |
| `git clone` 404 | 确认克隆地址是 `https://github.com/k7airos/wx-publish-studio.git`。 |
| `docker compose` 报 `required variable ... is missing` | `.env` 里漏填或填成了空行，compose 会指出缺哪一个。模式 A 下常漏的是 `RELAY_JWT_SECRET`。 |
| `manifest unknown` / `pull access denied` | 镜像标签写错了（多半是 `.env` 里手抄错了），或镜像还没发布。先直接 `docker pull <标签>`，报错信息最准；也可以在 [GHCR 页面](https://github.com/k7airos/wx-publish-studio/pkgs/container/wx-publish-studio)看已发布的标签。不存在就改回 compose 默认值，或改走源码构建。 |
| `unknown flag: --wait` | Compose 版本太旧（`--wait` 从 v2.2.0 才有）。升级后重试；实在升不了就去掉 `--wait`，改用 `docker compose up -d` 再用 `docker compose ps` 自己看健康状态。 |
| 端口已被占用（`Bind for 127.0.0.1:18889 failed`） | 宿主上这个端口已有别的进程或另一套栈。改 `.env` 的 `APP_PORT`（例如 `18890`），并把 `APP_ORIGIN` 同步改成同一个端口。 |
| 登录总是失败 / 提示来源不合法 | `APP_ORIGIN` 与浏览器地址栏的 origin 必须完全一致（协议、域名、端口）。最常见是协议写成 `https` 而实际是 `http`，或 SSH 隧道换端口后没同步 `APP_PORT` 与 `APP_ORIGIN`。 |
| 首启后改了 `POSTGRES_PASSWORD`，应用连不上库 | 数据库卷里已经用旧密码建好的角色还在。改密码要用数据库自身的口令修改方式，或清掉 `database-data` 卷重来（**会丢数据**）。 |
| 构建时卡在拉公开仓库 / `could not read from remote repository` | Worker 与中转镜像从 GitHub 公开仓库以 git context 构建，检查网络、代理与 DNS。 |
| 一直卡在 `waiting for ... to be healthy` | 看 `docker compose logs worker`、`docker compose logs relay` 的具体报错。 |
| Worker 起不来 / 一直不健康 | `docker compose logs worker`：先看是不是连不上 `ZZHUB_WX_BASE_URL`，再看中转是否已启动。 |
| Worker 镜像拉不到 | 默认是公开镜像 `ghcr.io/k7airos/wx-pipeline-worker:0.24.0`，拉不动多半是网络问题。也可以用 `PIPELINE_WORKER_IMAGE` 指向自己构建的镜像，或改走源码构建。 |
| 中转起不来 / 一直不健康 | `docker compose logs relay`：模式 A 下先确认 `.env` 里有 `RELAY_JWT_SECRET`。 |
| `scripts/relay-init.sh` 报 `中转容器没有在运行` | 先执行 `docker compose up -d --wait`。 |
| `scripts/relay-init.sh` 报 `登录中转失败` | `.env` 的 `RELAY_ADMIN_PASSWORD` 与中转里已有管理员的口令不一致（改过口令会这样）。清掉 `relay-data` 卷重新初始化，或改回原口令。 |
| `scripts/relay-init.sh` 报 `生成 PAT 失败` | `docker compose logs relay` 看中转自己的报错。 |
| 存入草稿箱报 IP 白名单错误 / 提示白名单未生效 | 白名单生效有等待期，等几分钟再试；同时确认填的是**实际调用微信的那个中转的出口公网 IP**（模式 A 下就是这台服务器的公网 IP）。 |
| 存入草稿箱报 401 | 中转 PAT 不对、已过期，或 scope 里没有 `wx`。 |
| 存入草稿箱报封面字体 hash 不符 / 封面渲染失败、字体不可用 | 封面渲染依赖固定的 Noto CJK 字体文件，字节必须与封面合同一致；镜像内已固定安装，自建镜像时请勿改 Dockerfile。 |
| 正文里的外链图片不显示 | Worker 在发布时要能访问那个图片地址（确认服务器能出网）；更省事的是在编辑器里上传图片，走应用自己的存储。 |
| 草稿箱里出现重复文章 | 中转按 `Idempotency-Key` 去重：同一把 PAT 下同 key 的重复请求会返回首次结果。出现重复多半是**换了不同的 PAT 或不同部署**，请先确认草稿箱实际结果，**不要重复发布**。 |
| 连接列表提示「这个连接没有中转访问令牌（PAT）」 | 部署没有统一持有中转令牌，或之前持有过、后来被撤掉了。点「更新密钥」给这个连接补一个 PAT。 |

</details>

## 接入统一身份（可选）

默认仍然是 bootstrap 单用户：一个访问口令管一个部署。要多人共用一个实例时，可以把登录换成任意标准 OIDC 服务（Keycloak、Authentik、Zitadel、Authelia、Cloudflare Access 等），只填环境变量，不需要改代码。

<details>
<summary>OIDC 配置说明</summary>

开启方式是把 `PUBLISHING_AUTH_MODE` 改成 `oauth`，并按下面**三种端点来源**之一配好：

| 端点来源 | 什么时候用 | 需要填什么 | 行为 |
| --- | --- | --- | --- |
| **标准发现**（推荐） | 你的 IdP 提供 `/.well-known/openid-configuration` | `PUBLISHING_OAUTH_ISSUER` + client id/secret + redirect | 启动时读一次发现文档，取 `authorization_endpoint`／`token_endpoint`／`userinfo_endpoint`。**发现失败就是启动失败**，不会悄悄换到别的端点 |
| **显式端点** | 你的 IdP 不提供发现文档，或不想让服务启动时访问外网 | 三个 `*_ENDPOINT` 变量 + client id/secret + redirect | 完全按你填的地址调用，**不发任何发现请求**。三个端点必须写全，缺一个就启动失败 |
| **既有形态**（默认） | 保持原有的私有授权服务形态 | `PUBLISHING_OAUTH_PORTAL_URL`（固定 `/oauth/authorize`）+ `PUBLISHING_OAUTH_BASE_URL` + client id/secret + redirect | 与改动前完全一致，现有部署不需要改任何配置 |

Keycloak / Authentik 风格的配置示例（全部用占位地址）：

```dotenv
PUBLISHING_AUTH_MODE=oauth

# 方式一：标准发现（只填 issuer，端点自动获取）
PUBLISHING_OAUTH_ISSUER=https://idp.example.com/realms/main
PUBLISHING_OAUTH_CLIENT_ID=REGISTERED_CLIENT_ID
PUBLISHING_OAUTH_CLIENT_SECRET=SERVER_ONLY_SECRET
PUBLISHING_OAUTH_REDIRECT_URI=https://studio.example.com/api/auth/oauth/callback

# 方式二：显式端点（三个都要填；不用时可以整段删掉）
# PUBLISHING_OAUTH_AUTHORIZATION_ENDPOINT=https://idp.example.com/realms/main/protocol/openid-connect/auth
# PUBLISHING_OAUTH_TOKEN_ENDPOINT=https://idp.example.com/realms/main/protocol/openid-connect/token
# PUBLISHING_OAUTH_USERINFO_ENDPOINT=https://idp.example.com/realms/main/protocol/openid-connect/userinfo

# 发现开关：auto（默认，只给 issuer 时用发现）/ 1（强制发现）/ 0（永不访问外网）
# PUBLISHING_OAUTH_DISCOVERY=auto
```

要点：

- **issuer 可以带路径**（如 `/realms/main`），但必须是精确受信值：HTTPS（或显式回环 HTTP 用于本地调试），不带 query/fragment，尾部斜杠会被规范化。issuer 带路径时只允许在标准发现与显式端点两种方式下使用。
- **redirect 必须精确等于** `${APP_ORIGIN}/api/auth/oauth/callback`，并与 IdP 里登记的回调地址一字不差。
- **端点地址不带 query、fragment 或凭据**，也不能用非回环的明文 HTTP。
- **令牌交换用标准表单**（`grant_type=authorization_code` 等），**用户信息用 `Authorization: Bearer <access_token>`**。只支持「客户端密钥放在请求体」这一种客户端认证方式；要求 `client_secret_basic` 的 IdP 需要换一种方式接入。
- **会话策略仍是本项目自己的**：上游令牌最长可到一天，但登录会话固定 7 天，不随上游令牌变长。
- **成员要管理员先绑定**：OIDC 登录的用户不会自动成为成员。用受控命令按 `issuer`/`subject` 绑定（`subject` 就是 IdP 的 `sub`，标准 OIDC 里它不一定是 UUID，大小写按原样保留）。`PUBLISHING_SELF_PROVISION` 的会员自动开通是托管部署专属，开源默认关闭。
- 发现请求只在启动时发生一次；不想让服务启动时依赖外网，就用显式端点，或把 `PUBLISHING_OAUTH_DISCOVERY` 设成 `0`。

</details>

## 部署形态与客户可见文案

<details>
<summary>PUBLISHING_COPY_MODE 说明</summary>

客户可见文案按部署形态分流，由环境变量 `PUBLISHING_COPY_MODE` 控制：

- `neutral`（**默认**）：开源自托管用的中性文案，不出现任何私有品牌或会员体系用语。
- `hosted`：线上托管部署用的原有文案（含原来的续期指引与顾问说法）。

线上托管部署要保持原有文案，只需在部署环境里加 `PUBLISHING_COPY_MODE=hosted`。改这一项同样需要重启容器。**注意**：app 与前端由同一个镜像提供，必须整体同版本上线，不要只换前端。

</details>

## 相关项目

兔狲由下面几个独立开源的项目组成，也都可以单独使用：

- [bun-wx-server](https://github.com/k7airos/bun-wx-server)：微信公众号 API 中转，持有账号与令牌，代理 7 个微信草稿 / 素材接口，即这里的 `relay` 服务。
- [zzhub-pipeline](https://github.com/k7airos/zzhub-pipeline)：发布流水线 CLI 与云端 Worker（npm 包 `@akairos/pipeline`），即这里的 `worker` 服务。
- [myno](https://github.com/k7airos/myno)：基于 Milkdown 的 Markdown 编辑器 / 渲染器（`@akairos/myno`），用于文章正文。
- [typeset-studio](https://github.com/k7airos/typeset-studio)：封面与排版渲染器（`@akairos/typeset-studio`），用于文章封面。

## 需要协助部署？

按上面的步骤多数情况下可以自己跑通。如果卡住了，或者想让我帮你部署、接入公众号、做定制，欢迎联系：

- **作者微信**：`akairos`，部署、接入与使用问题都可以问。
- **问题反馈**：请优先提交 [issue](https://github.com/k7airos/wx-publish-studio/issues)，附上版本号、部署方式与现象描述。
- **讨论区**：[Discussions](https://github.com/k7airos/wx-publish-studio/discussions)，安装与配置类问题可以在那里问；开头的「开始之前」贴里有最省事的部署路径。

## 开发与贡献

```sh
bun install --frozen-lockfile
bun run check   # tsc --noEmit
bun run build   # vite build
```

测试需要两个环境变量，缺一不可：

- `TEST_DATABASE_URL`：**必须**指向专用的 `*_test` 数据库，**不得**指向正式业务库（测试会清理目标库的应用表）。
- `TYPESET_ARTICLE_COVER_FONT_PATH`：封面字体文件路径，字节必须与封面合同一致（容器内是 `/usr/share/fonts/opentype/noto/NotoSansCJK-Regular.ttc`；宿主可用 `apt install fonts-noto-cjk` 装同款）。

```sh
TEST_DATABASE_URL=postgres://USER:PASS@127.0.0.1:5432/wxstudio_test \
TYPESET_ARTICLE_COVER_FONT_PATH=/usr/share/fonts/opentype/noto/NotoSansCJK-Regular.ttc \
bun run test
```

- 贡献指南：[AGENTS.md](AGENTS.md)
- 部署细节：[自托管说明](docs/self-host.md)
- 公开发布口径与发版流程（含开源前的清理说明）：[开源发布说明](docs/open-source-release.md)
- 第三方许可清单：[THIRD_PARTY_NOTICES.md](THIRD_PARTY_NOTICES.md)

## 许可

本项目以 [MIT](LICENSE) 许可发布，Copyright (c) 2026 Kairos (k7airos)。第三方许可见 [THIRD_PARTY_NOTICES.md](THIRD_PARTY_NOTICES.md)。
