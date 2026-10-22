# 兔狲 · 公众号助手（wx-publish-studio）

一个自托管的微信公众号图文工作台：写正文、配正文样式与封面、生成完整预览，确认后存入**你自己的公众号草稿箱**。

- **只写草稿箱，不群发。** 本项目不提供群发、定时群发或数据统计；它只负责把文章安全地放进草稿箱，发布与否由你在公众号后台决定。
- 三个容器：应用（app）、排版发布 Worker、PostgreSQL。
- 请求微信的走**中转 API**：你的 Worker 通过一个兼容 `/api/v1/wx/*` 的中转服务访问微信，而不是直接持有微信接口地址。

## 30 秒理解

1. **写正文** —— 用编辑器写文章，粘贴的 Markdown 和图片会原样保留。
2. **配样式与封面** —— 调整正文排版（字号、间距、提示块等），封面按标题自动生成或上传自己的图片。
3. **生成预览** —— 产出完整预览（手机尺寸），正文与封面所见即所发。
4. **存入草稿箱** —— 确认后写入你已连接的公众号草稿箱，回到公众号后台自行发表。

## 当前状态（请先读这一节）

这是一个**可以自己跑起来**、但仍有明确缺口的状态。诚实说明如下：

| 项目 | 当前状态 |
| --- | --- |
| 公共镜像 | **还没有**。本仓库不发布 Docker 镜像。应用镜像用 `docker compose build` 自建；Worker 镜像按「获取 Worker 镜像」一节自行构建。 |
| Worker 镜像 | npm 包 `@akairos/pipeline` **不含 `services/` 目录**，只装 npm 包无法启动 Worker。必须从 Pipeline 仓库的固定提交构建，见「获取 Worker 镜像」。 |
| 微信中转端点 | 公开可用的中转服务当前只实现 **3 个**微信端点（`cgi-bin/token`、`material/add_material`、`draft/add`），而 Pipeline 需要 **7 个**（另需 `draft/update`、`draft/get`、`draft/delete`、`draft/batchget`）。**缺 `draft/update` 等写回端点，也未实现 `Idempotency-Key` 去重**，因此「改稿后覆盖同一篇草稿」和「重复提交去重」当前不可靠。 |
| 正文图片 | 正文图片依赖对象存储（COS 一类）的图片上传与公开 HTTPS 地址，**不是**开箱即用能力。 |
| 实例数量 | app 与 Worker 均为**单实例**。Worker 使用本地 JSON 队列，不支持多副本共享数据卷。 |
| 鉴权 | 默认 **bootstrap 单用户**（一个访问口令）。通用 OIDC 接入尚未提供。 |
| 注册与群发 | 无注册、无群发、无多用户配额管理。 |
| 分发产物里的默认文案 | 上游编辑器包 `@akairos/myno` 等的默认主题与插件示例里带有**某个具体公众号的名称**。这些名称**曾随本项目的分发产物一起发布**，现在由**构建期通用中性化**清成中性文案（见「分发产物里的默认文案」）。规则写在 `scripts/brand-copy.ts`，上游包升级后必须复核。运行镜像内 `/app/dist` 已 0 命中。 |

### 分发产物里的默认文案

- **改了什么**：构建时把上游默认文案里的示例名称替换为中性文案（例如页脚默认文案改为「你的公众号」）。本仓库**不写死任何具体名称**：构建期从上游包的产物里**自动发现**这些名称，再按通用规则中性化。
- **为什么需要**：本项目正文页脚来自服务端保存的排版快照，**不使用**上游的默认主题文案；但上游包把这些名称打进了前端产物，跟着镜像分发就会带出别人的品牌。
- **怎么保证不再出现**：中性化之后，产物里只要还残留任何上游默认名称、或残留「公众号 + 分隔符/引号」的品牌结构，**构建直接失败**；找不到上游包（无法完成发现）时同样失败。自查用一条命令：

  ```sh
  bun run build && bun run check:brand
  ```

- **升级上游包时**：复核 `scripts/brand-copy.ts` 里的中性化规则是否仍然覆盖上游的新写法（规则本身与具体品牌无关，正常情况下不需要改动）；上游新增了同类写法会导致构建失败，不会静默漏出去。

## 前置条件

- **服务器**：2 核 4G 起步；需要能运行 Docker 容器与 Chromium（Worker 渲染用）。
- **Docker 与 Compose**：Docker Engine 24+，`docker compose` v2。
- **PostgreSQL**：由 Compose 内置（`postgres:16-alpine`，固定 digest）。
- **一个公众号账号**：具备管理员权限，可扫码登录微信公众平台。
- **一个微信中转服务**：实现 `/api/v1/wx/*` 契约的可信服务。可参考公开的 `bun-wx-server`，但注意上面列出的端点缺口。
- **对象存储（COS 一类）**：如果你要发布带图片的正文，需要配置图片上传与公开 HTTPS 地址。

## 快速开始

下面 8 步是从零到「第一篇草稿进草稿箱」的完整路径。每步末尾都写了**这一步做砸了会看到什么**。

### 1. 获取代码

```sh
git clone https://github.com/k7airos/wx-publish-studio.git
cd wx-publish-studio
```

> 失败现象：仓库是私有的 / 404。确认克隆地址是上面的公开地址。

### 2. 准备 `.env`

```sh
cp .env.example .env
```

至少要填 7 项，每一项的生成方式：

```sh
openssl rand -hex 32   # POSTGRES_PASSWORD（用十六进制，避免 URL 编码歧义）
openssl rand -hex 32   # CREDENTIAL_ENCRYPTION_KEY（必须是 64 位 hex）
openssl rand -hex 32   # BOOTSTRAP_SECRET（bootstrap 模式至少 32 字符）
openssl rand -hex 32   # PIPELINE_WORKER_TOKEN
```

| 变量 | 填什么 |
| --- | --- |
| `APP_ORIGIN` | 你打算用浏览器访问的 origin，例如 `http://127.0.0.1:18889`（SSH 隧道）或 `https://studio.example.com`（自建反代）。**必须与浏览器地址栏完全一致。** |
| `POSTGRES_PASSWORD` | 上面生成的十六进制串 |
| `CREDENTIAL_ENCRYPTION_KEY` | 上面生成的 64 位 hex |
| `BOOTSTRAP_SECRET` | 上面生成的串，之后用它登录 |
| `PIPELINE_WORKER_TOKEN` | 上面生成的串，app 与 Worker 共用 |
| `PIPELINE_WORKER_IMAGE` | 第 3 步构建出来的 Worker 镜像引用 |
| `ZZHUB_WX_BASE_URL` | 第 4 步启动的中转服务地址 |

> 失败现象：`docker compose` 报 `required variable ... is missing`。`.env` 里漏填或填成了空行；compose 会直接指出缺哪一个。

### 3. 获取 Worker 镜像

本项目**不发布**公共镜像，Worker 镜像要自己构建。

- 仓库：<https://github.com/k7airos/zzhub-pipeline>（公开仓库）
- 固定提交：`4cf5725f35758fa5fada8786cb57cd9960388c7f`（`main`，对应版本 `0.24.0`）

```sh
git clone https://github.com/k7airos/zzhub-pipeline.git
cd zzhub-pipeline
git checkout 4cf5725f35758fa5fada8786cb57cd9960388c7f
docker build -f services/cloud-worker/Dockerfile -t wx-pipeline-worker:0.24.0 .
```

要点：

- **构建上下文必须是 Pipeline 仓库根目录**。该 Dockerfile 会 `COPY package.json bun.lock ./` 和 `COPY . .`，所以 `-f services/cloud-worker/Dockerfile` 后面那个 `.` 不能换成子目录。
- 镜像内已装 Chromium 与 Noto CJK 字体（封面渲染用），**不需要**额外 build args；首次构建要联网，耗时较长。
- 镜像 tag 建议用 `<项目>-<pipeline 版本>`（例如 `wx-pipeline-worker:0.24.0`），**不要用 `latest`**：Worker 与 app 之间有渲染合同，版本漂移会让预览和实际发布结果对不上。
- 构建完回到本项目目录，把镜像引用填进 `.env`：

```dotenv
PIPELINE_WORKER_IMAGE=wx-pipeline-worker:0.24.0
```

> 失败现象：`docker compose up` 报 `pull access denied` 或 `no such image`。说明 `PIPELINE_WORKER_IMAGE` 没填、填错了 tag，或构建没在本机完成。先 `docker images | grep wx-pipeline-worker` 确认镜像在，再确认 `.env` 里的引用和它一致。

### 4. 准备微信中转

中转服务是一个**独立的服务**，不在本仓库里，也不在本项目的 compose 里。

- 仓库：<https://github.com/k7airos/bun-wx-server>（公开仓库）
- 它做什么：替你持有微信凭据，对外提供 `/api/v1/wx/*`；你把它的地址填进 `ZZHUB_WX_BASE_URL`。

起法要点（详见它自己的 README）：

```sh
git clone https://github.com/k7airos/bun-wx-server.git
cd bun-wx-server
cp .env.example .env          # 至少改掉 JWT_SECRET
bun run migrate
bun run init-admin --username admin --password 'change-me-now'
bun run start                 # 默认监听 3001
```

也可以用它的 `docker compose up --build -d`，再 `docker compose run --rm app migrate` 与 `docker compose run --rm app init-admin ...`。

取 PAT（中转的访问令牌）：

1. 用上面的管理员账号登录中转服务。
2. `GET /api/v1/token/scopes` 看可用 scope，微信接口对应 `wx`。
3. `POST /api/v1/token/generate` 生成一个带 `wx` scope 的 PAT（也可以用 `all`）。

拿到之后回到本项目的 `.env`：

```dotenv
ZZHUB_WX_BASE_URL=http://<中转地址>:3001
# 二选一：
PUBLISHING_RELAY_PAT=<刚生成的 PAT>     # 部署统一持有，使用者只填 AppID/AppSecret
# PUBLISHING_RELAY_PAT=                  # 不配置时，使用者在界面的连接向导里填自己的 PAT
```

> 失败现象：
> - 启动报 `required variable ZZHUB_WX_BASE_URL is missing` —— `.env` 里没填。
> - Worker 日志报连不上中转 —— 中转根本没起、端口不对、或 `ZZHUB_WX_BASE_URL` 写成了微信官方地址（必须是你自己可控的中转）。
> - 存入草稿箱报 401 —— PAT 不对、过期，或 scope 里没有 `wx`。
> - **缺中转会怎样**：app 起得来，但所有发布动作都会失败；预览可能能出，存草稿箱一定失败。

### 5. 启动

```sh
docker compose up -d --build --wait
```

> 失败现象：
> - `pull access denied` —— 见第 3 步。
> - 容器起来又退出（`docker compose logs app`）——多半是 `.env` 里的值不合法（口令少于 32 字符、加密密钥不是 64 位 hex、`APP_ORIGIN` 带了路径或不是 HTTPS/回环）。
> - 一直卡在 `waiting for ... to be healthy` —— 看 `docker compose logs worker`，多半是 Worker 连不上中转或缺字体。

### 6. 访问

应用只绑定回环地址（`127.0.0.1:18889`），这是刻意的安全边界。远程访问用下面两种方式之一：

- **SSH 隧道**：`ssh -L 18889:127.0.0.1:18889 user@your-server`，然后浏览器访问 `http://127.0.0.1:18889`。
- **自建 HTTPS 反代**：用 Nginx / Caddy 等终止 TLS 并转发到 `127.0.0.1:18889`，同时把 `.env` 的 `APP_ORIGIN` 改成你的 `https://` 域名。

`APP_ORIGIN` 必须与浏览器地址栏里的 origin **完全一致**（协议、域名、端口），否则登录会被拒绝。换了端口要同步改 `.env` 的 `APP_PORT` 与 `APP_ORIGIN`。

> 失败现象：登录一直失败、提示来源不合法。就是 `APP_ORIGIN` 和地址栏不一致（最常见是协议写成了 `https` 而实际是 `http`，或端口没同步）。

### 7. 第一次使用

1. **登录**：打开地址，输入 `BOOTSTRAP_SECRET`。
2. **连接公众号**：进「公众号」页 → 「添加公众号」，按向导填公众号名称、AppID、AppSecret（都在微信公众平台的开发设置里），以及——如果部署没有配 `PUBLISHING_RELAY_PAT`——你自己中转的 PAT。第 3 步向导会要你把**中转服务的出口公网 IP** 加进公众号后台的「API IP 白名单」。
3. **写第一篇**：进「文章」页 → 新建 → 在编辑器里写正文（可以直接粘贴现成的 Markdown）。
4. **配排版与封面**：右侧面板调样式；封面可以按标题自动生成，也可以上传自己的图。
5. **预览**：点「预览」，看手机尺寸下的完整效果。
6. **存入草稿箱**：确认无误后点「存入草稿箱」。回到公众号后台的草稿箱就能看到。

> 失败现象：
> - 存入草稿箱报 IP 白名单错误 —— 白名单生效有等待期，等几分钟再试；另外确认填的是**中转服务的出口 IP**，不是这台服务器的 IP。
> - 存入草稿箱报 401 —— PAT 不对或 scope 缺 `wx`。
> - 封面渲染失败、提示字体不可用 —— 封面渲染依赖固定的 Noto CJK 字体文件，镜像内已固定安装，别改 Dockerfile。
> - 正文里的外链图片不显示 —— 正文图片依赖对象存储，需要额外配置；先在编辑器里上传本地图片。

### 8. 收尾

改完配置后统一 `docker compose up -d --build --wait` 生效（配置在启动时读取，改环境变量都要重建/重启容器）。

## 必填配置

`docker compose` 对下面 7 项用 `:?` 直接报错并指出缺哪一项，不会静默使用默认值：

| 变量 | 含义 | 怎么生成 | 是否需要重启 |
| --- | --- | --- | --- |
| `APP_ORIGIN` | 受信浏览器 origin，例如 `http://127.0.0.1:18889` 或 `https://studio.example.com` | 手填，必须与浏览器实际 origin 完全一致 | 需要 |
| `POSTGRES_PASSWORD` | 数据库密码 | `openssl rand -hex 32` | 需要（首次初始化后改密码需改库内密码） |
| `CREDENTIAL_ENCRYPTION_KEY` | 公众号凭据加密主密钥，64 位 hex | `openssl rand -hex 32` | 需要。**更换后旧的公众号凭据无法解密**，必须先备份并从备份恢复，或重新连接全部公众号 |
| `BOOTSTRAP_SECRET` | 访问口令，bootstrap 模式至少 32 字符 | `openssl rand -hex 32` | 需要 |
| `PIPELINE_WORKER_TOKEN` | app 与 Worker 之间的共享令牌 | `openssl rand -hex 32` | 需要 |
| `PIPELINE_WORKER_IMAGE` | Worker 镜像引用（自己构建的镜像） | 见「获取 Worker 镜像」 | 需要（改镜像要重建容器） |
| `ZZHUB_WX_BASE_URL` | 微信中转服务地址 | 你自己的中转服务地址 | 需要 |

compose 只检查「有没有填」；**填了但不合规**由应用启动时校验并报出明确原因，例如：

| 变量 | 缺省/不合法时的表现 |
| --- | --- |
| `BOOTSTRAP_SECRET` | compose 报 `required variable BOOTSTRAP_SECRET is missing a value`；填了但短于 32 字符时，应用启动报错 `BOOTSTRAP_SECRET must contain at least 32 characters` |
| `CREDENTIAL_ENCRYPTION_KEY` | compose 报缺少；不是 64 位 hex 时，应用启动报错 `CREDENTIAL_ENCRYPTION_KEY must be 32-byte hexadecimal` |
| `APP_ORIGIN` | compose 报缺少；不是 HTTPS 或回环 origin 时，应用启动报错 `APP_ORIGIN must be an HTTPS origin, or an explicit HTTP loopback origin` |

可选配置：

| 变量 | 含义 | 是否需要重启 |
| --- | --- | --- |
| `PUBLISHING_RELAY_PAT`（可选） | 服务统一持有的中转访问令牌 | **需要** |
| `PUBLISHING_WX_WHITELIST_IP`（可选） | 微信 API 白名单需要的出口公网 IP | **需要** |
| `PUBLISHING_AUTH_MODE`（可选） | `bootstrap`（默认）或 `oauth` | 需要 |
| `PUBLISHING_COPY_MODE`（可选） | 客户可见文案形态：`neutral`（默认）/ `hosted` | 需要 |
| `APP_PORT`（可选） | 宿主端口，默认 `18889` | 需要 |

> **所有配置都在启动时读取一次**（`src/server/index.ts` 只调用一次 `loadConfig()`），所以改任何一项环境变量都必须重启容器才生效，包括 `PUBLISHING_RELAY_PAT` 和 `PUBLISHING_WX_WHITELIST_IP`。

如果配置了 `PUBLISHING_RELAY_PAT`，使用者在界面上只需填 AppID 与 AppSecret；不配置时，使用者需要在连接向导里填写**自己中转服务的访问令牌（PAT）**。如果运维之后把 `PUBLISHING_RELAY_PAT` 从环境变量里撤掉，早先建立的连接会缺少 PAT，公众号连接列表会**显式提示「这个连接没有中转访问令牌（PAT）」**，需要逐个在「更新密钥」里补齐。

## 微信与中转

- **中转服务从哪来**：可以自己实现（契约见 `/api/v1/wx/*`），也可以参考公开的 `bun-wx-server`。本仓库不包含中转服务。
- **PAT 的 scope**：PAT 是中转服务的访问令牌，用来代表你调用中转接口。它由中转服务签发，与微信 AppID/AppSecret 是两回事。`bun-wx-server` 的 scope 里 `wx` 对应 `/api/v1/wx/`。
- **IP 白名单**：在公众号后台的「API IP 白名单」里，填**你自己中转服务的出口公网 IP**（不是本应用的服务器 IP）。部署配置了 `PUBLISHING_WX_WHITELIST_IP` 时界面会直接显示该值，否则请在连接向导里自行填写。白名单生效有等待期，第一次存入草稿箱时才会真正验证。
- **中转当前缺什么**：见「当前状态」。在补齐 `draft/update`、`draft/get`、`draft/delete`、`draft/batchget` 与 `Idempotency-Key` 去重之前，「修改后覆盖同一篇草稿」不可靠。

## 数据、备份与升级

三个卷各存不同的东西：

| 卷 | 内容 |
| --- | --- |
| `app-data` | 应用私有数据：上传的封面与正文素材（`assets/`、`body-assets/`） |
| `database-data` | PostgreSQL 数据：文章、排版、封面模板、公众号连接、加密凭据修订、任务映射 |
| `worker-data` | Worker 的账号登记、任务队列与运行结果 |

**备份要包含**：`app-data`、`database-data`、`worker-data` 三个卷，以及 `CREDENTIAL_ENCRYPTION_KEY`。少任何一项，恢复后都无法完整还原。

**升级**：本项目不发布镜像，升级 = 拉新代码 + 重新构建：

```sh
git pull
docker compose build
docker compose up -d --wait
```

> **不要用 `docker compose pull`**：本仓库不发布镜像，`pull` 会直接报 `pull access denied`。
> 如果你把 `APP_IMAGE` 指向了**自己的** registry（`APP_IMAGE=registry.example.com/wx-publish-studio:1.2.3`），那就改成先推再拉：
> ```sh
> docker build -t registry.example.com/wx-publish-studio:1.2.3 .
> docker push registry.example.com/wx-publish-studio:1.2.3
> docker compose pull && docker compose up -d --wait
> ```

数据库迁移由应用在启动时自动执行（迁移记录在 `schema_migrations` 表里）。

> **不要执行 `docker compose down -v`**。`-v` 会删除上述三个卷，用户数据不可恢复。

## 已知限制

- **单实例**：app 与 Worker 都不能跑多副本。Worker 是本地 JSON 队列，共享卷多副本会互相覆盖。
- **中转端点不全**：缺 4 个草稿端点与 `Idempotency-Key` 去重（见「当前状态」）。
- **正文图片依赖 COS**：带图片正文需要配置对象存储与公开 HTTPS 地址。
- **仅 bootstrap 模式**：默认单用户访问口令。通用 OIDC、多用户配额与邀请制尚未提供。
- **无注册、无群发**：不提供账号体系，也不提供任何群发能力。
- **只写草稿箱**：不读取公众号已发布内容，不做数据统计。
- **分发产物里的默认文案**：上游默认主题的示例品牌由构建期通用中性化清掉，规则在 `scripts/brand-copy.ts`（不写死任何具体名称），升级上游包要复核（见「当前状态」）。

## 故障排查

| 现象 | 排查方向 |
| --- | --- |
| `docker compose` 报缺少变量 | compose 在缺必填项时会直接报错并指出变量名；补齐 `.env` 后重新执行。 |
| `docker compose pull` 报 `pull access denied` | 本项目不发布镜像，改用 `docker compose build && docker compose up -d --wait`。 |
| 登录总是失败 | `APP_ORIGIN` 与浏览器地址栏的 origin 必须完全一致（协议、域名、端口）。SSH 隧道换端口后要同步改 `.env` 的 `APP_PORT` 与 `APP_ORIGIN`。 |
| Worker 镜像拉不到 | `PIPELINE_WORKER_IMAGE` 必须是你本地已构建的镜像，或改用可访问的私有 registry 引用。 |
| Worker 起不来 / 一直不健康 | `docker compose logs worker`：先看是不是连不上 `ZZHUB_WX_BASE_URL`，再看中转是否已启动。 |
| 存入草稿箱报 401 | 中转 PAT 不对、已过期，或 scope 里没有 `wx`。 |
| 存入草稿箱报封面字体 hash 不符 | 封面渲染依赖固定的 Noto CJK 字体文件，字节必须与封面合同一致；镜像内已固定安装该字体，自建镜像时请勿改动。 |
| 提示 IP 白名单未生效 | 微信的白名单生效有等待期，稍等几分钟再试；同时确认填的是**中转服务的出口公网 IP**。 |
| 草稿箱里出现重复文章 | 中转尚未实现 `Idempotency-Key` 去重。确认草稿箱结果后再决定是否手动清理，**不要重复发布**。 |
| 连接列表提示「这个连接没有中转访问令牌（PAT）」 | 部署没有统一持有中转令牌，或之前持有过、后来被撤掉了。点「更新密钥」给这个连接补一个 PAT。 |

## 部署形态与客户可见文案

客户可见文案按**部署形态**分流，由环境变量 `PUBLISHING_COPY_MODE` 控制：

- `neutral`（**默认**）：开源自托管用的中性文案，不出现任何私有品牌或会员体系用语。
- `hosted`：线上托管部署用的原有文案（含原来的续期指引与顾问说法）。

线上托管部署要保持原有文案，只需在部署环境里加：

```dotenv
PUBLISHING_COPY_MODE=hosted
```

改这一项同样需要重启容器。**注意**：app 与前端由同一个镜像提供，两者是整体同版本的，**必须整体同版本上线，不要只换前端**。

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

贡献指南见 [AGENTS.md](AGENTS.md)；第三方许可清单见 [THIRD_PARTY_NOTICES.md](THIRD_PARTY_NOTICES.md)；部署细节见 [自托管说明](docs/self-host.md)；公开发布口径见 [开源发布说明](docs/open-source-release.md)。

## 联系与许可

- **作者微信**：`akairos` —— 部署、接入与使用问题都可以联系。
- **问题反馈**：请优先提交 issue，附上版本号、部署方式与现象描述。
- **本项目许可**：见 [LICENSE](LICENSE)（MIT，Copyright (c) 2026 Kairos (k7airos)）。
- **第三方许可**：见 [THIRD_PARTY_NOTICES.md](THIRD_PARTY_NOTICES.md)。
