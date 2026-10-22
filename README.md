# 兔狲 · 公众号助手（wx-publish-studio）

一个自托管的微信公众号图文工作台：写正文、配正文样式与封面、生成完整预览，确认后存入**你自己的公众号草稿箱**。

- **只写草稿箱，不群发。** 本项目不提供群发、定时群发或数据统计；它只负责把文章安全地放进草稿箱，发布与否由你在公众号后台决定。
- 四个容器：应用（app）、排版发布 Worker、PostgreSQL、**微信中转**（默认随栈一起起，也可以换成你自己的中转）。
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
| 公共镜像 | **已发布**。本仓库把**应用、Worker、微信中转**三个镜像发布到 GHCR（`ghcr.io/k7airos/…`），**多架构**（linux/amd64 与 linux/arm64 都有），公开可拉，**不需要镜像仓库账号、不需要登录**。默认路径仍可从源码构建；镜像拉不到时 compose 会自动退回源码构建。 |
| Worker 镜像 | npm 包 `@akairos/pipeline` **不含 `services/` 目录**，只装 npm 包无法启动 Worker。compose 用 `services/cloud-worker/Dockerfile` 从 Pipeline 仓库的固定提交构建；已经自建好镜像时可用 `PIPELINE_WORKER_IMAGE` 覆盖。 |
| 微信中转 | 默认**随栈一起起**（模式 A），compose 用公开仓库 `bun-wx-server` 的固定提交构建并运行它；也可以指向你自己的中转（模式 B）。该中转已实现 Pipeline 需要的全部 **7 个**微信端点（`cgi-bin/token`、`material/add_material`、`draft/add`、`draft/update`、`draft/get`、`draft/delete`、`draft/batchget`），并支持 `Idempotency-Key` 幂等去重（按调用方隔离，默认保留 24 小时）——「改稿后覆盖同一篇草稿」与「重复提交不产生重复草稿」都可用。 |
| 正文图片 | 正文图片依赖对象存储（COS 一类）的图片上传与公开 HTTPS 地址，**不是**开箱即用能力。 |
| 实例数量 | app 与 Worker 均为**单实例**。Worker 使用本地 JSON 队列，不支持多副本共享数据卷。 |
| 鉴权 | 默认 **bootstrap 单用户**（一个访问口令）。**通用 OIDC 可选接入已可用**：填环境变量即可对接任意标准 OIDC 服务（Keycloak / Authentik / Zitadel / Authelia 等），但自助开通成员仍只有 bootstrap 语义，成员需由管理员预先绑定（见「接入统一身份（可选）」）。 |
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
- **一个微信中转服务**：默认**不需要自己准备**——compose 会从公开仓库的固定提交构建并起一个（第 4 个容器），也可以直接用已发布的公开镜像。也可以用你自己的中转（模式 B），要求实现 `/api/v1/wx/*` 契约，下面「当前状态」列出的 **7 个**微信端点都要实现。
- **对象存储（COS 一类）**：如果你要发布带图片的正文，需要配置图片上传与公开 HTTPS 地址。

## 快速开始

默认是**模式 A（同栈自带中转）**：一条命令起四个容器（应用、Worker、PostgreSQL、微信中转）。
不需要手工构建镜像、不需要镜像仓库账号、不需要另外起一个中转服务。

下面 6 步是从零到「第一篇草稿进草稿箱」的完整路径。每步末尾都写了**这一步做砸了会看到什么**。

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

至少要填 6 项，每一项的生成方式：

```sh
openssl rand -hex 32   # POSTGRES_PASSWORD（用十六进制，避免 URL 编码歧义）
openssl rand -hex 32   # CREDENTIAL_ENCRYPTION_KEY（必须是 64 位 hex）
openssl rand -hex 32   # BOOTSTRAP_SECRET（bootstrap 模式至少 32 字符）
openssl rand -hex 32   # PIPELINE_WORKER_TOKEN
openssl rand -hex 32   # RELAY_JWT_SECRET（同栈中转的签名密钥，模式 A 必填）
```

| 变量 | 填什么 |
| --- | --- |
| `APP_ORIGIN` | 你打算用浏览器访问的 origin，例如 `http://127.0.0.1:18889`（SSH 隧道）或 `https://studio.example.com`（自建反代）。**必须与浏览器地址栏完全一致。** |
| `POSTGRES_PASSWORD` | 上面生成的十六进制串 |
| `CREDENTIAL_ENCRYPTION_KEY` | 上面生成的 64 位 hex |
| `BOOTSTRAP_SECRET` | 上面生成的串，之后用它登录 |
| `PIPELINE_WORKER_TOKEN` | 上面生成的串，app 与 Worker 共用 |
| `RELAY_JWT_SECRET` | 上面生成的串，同栈中转的签名密钥（模式 A 用，模式 B 不需要） |

其余保持 `.env.example` 的默认值即可。**尤其不要改动 `ZZHUB_WX_BASE_URL`（留空 = 模式 A）和它下面两行派生变量 `RELAY_MODE` / `RELAY_REPLICAS`。**

> 失败现象：`docker compose` 报 `required variable ... is missing`。`.env` 里漏填或填成了空行；compose 会直接指出缺哪一个。

### 3. 一条命令起栈

默认就是**用已发布镜像**起栈，**不需要改 `.env`**：

```sh
docker compose up -d --wait
```

这条命令会拉取三个公开镜像（应用、Worker、微信中转，都是 `linux/amd64` 与 `linux/arm64` 多架构），起四个容器并等到全部健康。**不需要镜像仓库账号，不需要 `docker login`。** 镜像拉不到时 compose 会**自动退回从源码构建**（方式二），不会把部署卡死。

> 失败现象：`manifest unknown` / `pull access denied` —— 标签写错了，或镜像还没发布。先跑 `docker manifest inspect ghcr.io/k7airos/wx-publish-studio:0.7.1` 确认标签存在；确认存在却拉不动，就直接用方式二。

#### 方式二：从源码构建

想自己编译、或镜像仓库不可达，用带 `--build` 的命令：

```sh
docker compose up -d --build --wait
```

这一条命令会：

- 用本地代码构建**应用**镜像；
- 从公开仓库 `k7airos/zzhub-pipeline` 的固定提交 `4cf5725f…` 构建 **Worker** 镜像（`services/cloud-worker/Dockerfile`）；
- 从公开仓库 `k7airos/bun-wx-server` 的固定提交 `3a9864cb…` 构建**微信中转**镜像；
- 起四个容器，并等到全部健康。

首次构建要联网（拉基础镜像、克隆上面两个公开仓库），**冷构建大约 10-20 分钟**，其中 Worker 最重（要装 Chromium 与 Noto CJK 字体，镜像约 2.1GB），中转约 250MB，应用约 1GB。有构建缓存时后续启动是秒级。构建完 `docker compose ps` 应当四个服务都是 `healthy`。

> **源码构建过的镜像会盖掉同名标签**：本地构建产物用的就是 `ghcr.io/k7airos/…` 这个标签名。之后再跑不带 `--build` 的 `up`，compose 会继续用本地那份。想换回官方镜像，先 `docker compose pull`。
>
> 失败现象：
> - `git clone` / `could not read from remote repository` —— 构建 Worker 与中转时要拉公开仓库，检查网络、代理与 DNS。
> - `required variable ... is missing` —— `.env` 少填（见第 2 步）。
> - `pull access denied` —— 容器标签指向了一个不存在的镜像；确认标签拼写，或确认启动命令带 `--build`。
> - 一直卡在 `waiting for ... to be healthy` —— `docker compose logs worker`、`docker compose logs relay` 看具体报错。

### 4. 初始化同栈中转（拿中转令牌）

中转刚起来时还没有管理员，也就没有可用令牌。跑一条脚本把它建好：

```sh
bash scripts/relay-init.sh
docker compose up -d --wait
```

脚本做三件事：在中转容器里创建管理员（已存在则跳过）、用管理员登录换一个带 `wx` scope 的访问令牌（PAT）、把 PAT 写回 `.env` 的 `PUBLISHING_RELAY_PAT`。之后部署统一持有这个令牌，使用者在连接向导里只填 AppID 与 AppSecret。

管理员口令会写进 `.env` 的 `RELAY_ADMIN_PASSWORD`（没有就随机生成一个），请自行妥善保管。

> 失败现象：
> - `中转容器没有在运行` —— 先执行第 3 步。
> - `登录中转失败` —— `.env` 里的 `RELAY_ADMIN_PASSWORD` 与中转中已有管理员的口令不一致（改过口令就会这样）：清掉中转数据卷重新初始化，或改回原口令。
> - `生成 PAT 失败` —— `docker compose logs relay` 看中转自己的报错。

### 5. 访问

应用只绑定回环地址（`127.0.0.1:18889`），这是刻意的安全边界。远程访问用下面两种方式之一：

- **SSH 隧道**：`ssh -L 18889:127.0.0.1:18889 user@your-server`，然后浏览器访问 `http://127.0.0.1:18889`。
- **自建 HTTPS 反代**：用 Nginx / Caddy 等终止 TLS 并转发到 `127.0.0.1:18889`，同时把 `.env` 的 `APP_ORIGIN` 改成你的 `https://` 域名。

`APP_ORIGIN` 必须与浏览器地址栏里的 origin **完全一致**（协议、域名、端口），否则登录会被拒绝。换了端口要同步改 `.env` 的 `APP_PORT` 与 `APP_ORIGIN`。

> 失败现象：登录一直失败、提示来源不合法。就是 `APP_ORIGIN` 和地址栏不一致（最常见是协议写成了 `https` 而实际是 `http`，或端口没同步）。

### 6. 第一次使用

1. **登录**：打开地址，输入 `BOOTSTRAP_SECRET`。
2. **连接公众号**：进「公众号」页 → 「添加公众号」，按向导填公众号名称、AppID、AppSecret（都在微信公众平台的开发设置里）。模式 A 下不用填中转令牌；模式 B 下要填你自己中转的 PAT。第 3 步向导会要你把**中转服务的出口公网 IP** 加进公众号后台的「API IP 白名单」。
3. **写第一篇**：进「文章」页 → 新建 → 在编辑器里写正文（可以直接粘贴现成的 Markdown）。
4. **配排版与封面**：右侧面板调样式；封面可以按标题自动生成，也可以上传自己的图。
5. **预览**：点「预览」，看手机尺寸下的完整效果。
6. **存入草稿箱**：确认无误后点「存入草稿箱」。回到公众号后台的草稿箱就能看到。

> 失败现象：
> - 存入草稿箱报 IP 白名单错误 —— 白名单生效有等待期，等几分钟再试；另外确认填的是**中转服务的出口 IP**，不是这台服务器的 IP。
> - 存入草稿箱报 401 —— PAT 不对或 scope 缺 `wx`。
> - 封面渲染失败、提示字体不可用 —— 封面渲染依赖固定的 Noto CJK 字体文件，镜像内已固定安装，别改 Dockerfile。
> - 正文里的外链图片不显示 —— 正文图片依赖对象存储，需要额外配置；先在编辑器里上传本地图片。

### 模式 B：用自己的中转

不想用随栈的中转，就用你自己的：

1. 在 `.env` 里**就地修改** `ZZHUB_WX_BASE_URL` 那一行，填你的中转地址（例如 `https://relay.example.com`）。**不要把它追加到文件末尾**——下面两行派生变量依赖它的取值。
2. `RELAY_MODE` 与 `RELAY_REPLICAS` 两行保持原样：它们是派生变量，模式 B 下自动把中转的副本数置 0。
3. `docker compose up -d --wait`（用已发布镜像时）或 `docker compose up -d --build --wait`（从源码构建时）。compose **不会**起中转容器，Worker 指向你的地址。
4. `PUBLISHING_RELAY_PAT` 留空，使用者在连接向导里填自己中转的 PAT。

模式 B 下 compose 仍会准备中转镜像（只是不运行），这样不必维护第二套构建分支；用已发布镜像时它只是拉一下，用源码构建时它会被构建出来；不想准备就把它删掉或注释掉 compose 里的 `relay` 服务。

### 收尾

改完配置后统一重启生效（配置在启动时读取，改环境变量都要重建/重启容器）：用已发布镜像是 `docker compose up -d --wait`，从源码构建是 `docker compose up -d --build --wait`。

## 必填配置

`docker compose` 对下面 5 项用 `:?` 直接报错并指出缺哪一项，不会静默使用默认值：

| 变量 | 含义 | 怎么生成 | 是否需要重启 |
| --- | --- | --- | --- |
| `APP_ORIGIN` | 受信浏览器 origin，例如 `http://127.0.0.1:18889` 或 `https://studio.example.com` | 手填，必须与浏览器实际 origin 完全一致 | 需要 |
| `POSTGRES_PASSWORD` | 数据库密码 | `openssl rand -hex 32` | 需要（首次初始化后改密码需改库内密码） |
| `CREDENTIAL_ENCRYPTION_KEY` | 公众号凭据加密主密钥，64 位 hex | `openssl rand -hex 32` | 需要。**更换后旧的公众号凭据无法解密**，必须先备份并从备份恢复，或重新连接全部公众号 |
| `BOOTSTRAP_SECRET` | 访问口令，bootstrap 模式至少 32 字符 | `openssl rand -hex 32` | 需要 |
| `PIPELINE_WORKER_TOKEN` | app 与 Worker 之间的共享令牌 | `openssl rand -hex 32` | 需要 |

另有 1 项**按模式必填**：

| 变量 | 什么时候必填 | 含义 | 怎么生成 |
| --- | --- | --- | --- |
| `RELAY_JWT_SECRET` | **仅模式 A**（`.env` 里 `ZZHUB_WX_BASE_URL` 留空、同栈自带中转） | 同栈中转的签名密钥 | `openssl rand -hex 32` |

模式 B（填了 `ZZHUB_WX_BASE_URL`）不需要 `RELAY_JWT_SECRET`：那时中转根本不启动。

compose 只检查「有没有填」；**填了但不合规**由应用启动时校验并报出明确原因，例如：

| 变量 | 缺省/不合法时的表现 |
| --- | --- |
| `BOOTSTRAP_SECRET` | compose 报 `required variable BOOTSTRAP_SECRET is missing a value`；填了但短于 32 字符时，应用启动报错 `BOOTSTRAP_SECRET must contain at least 32 characters` |
| `CREDENTIAL_ENCRYPTION_KEY` | compose 报缺少；不是 64 位 hex 时，应用启动报错 `CREDENTIAL_ENCRYPTION_KEY must be 32-byte hexadecimal` |
| `APP_ORIGIN` | compose 报缺少；不是 HTTPS 或回环 origin 时，应用启动报错 `APP_ORIGIN must be an HTTPS origin, or an explicit HTTP loopback origin` |
| `RELAY_JWT_SECRET` | 模式 A 下 compose 报 `required variable RELAY_JWT_SECRET is missing a value` |

可选配置：

| 变量 | 含义 | 是否需要重启 |
| --- | --- | --- |
| `ZZHUB_WX_BASE_URL`（可选） | 留空 = 同栈自带中转；填写 = 外部中转地址 | 需要 |
| `PUBLISHING_RELAY_PAT`（可选） | 服务统一持有的中转访问令牌 | **需要** |
| `PUBLISHING_WX_WHITELIST_IP`（可选） | 微信 API 白名单需要的出口公网 IP | **需要** |
| `PUBLISHING_AUTH_MODE`（可选） | `bootstrap`（默认）或 `oauth` | 需要 |
| `PUBLISHING_OAUTH_*`（可选） | oauth 模式下的身份源配置：issuer、client id/secret、redirect，以及标准发现或三个显式端点（见「接入统一身份（可选）」） | 需要 |
| `PUBLISHING_COPY_MODE`（可选） | 客户可见文案形态：`neutral`（默认）/ `hosted` | 需要 |
| `PUBLISHING_BODY_IMAGE_SOURCE_ORIGIN` / `PUBLISHING_BODY_IMAGE_SOURCE_PREFIX`（可选） | 正文里**从外部地址导入图片**时允许的来源域名与路径前缀，例如 `https://img.example.com` + `/owner/hash/`。留空 = 不允许导入外部图片，正文图片只能靠编辑器上传 | 需要 |
| `PUBLISHING_BODY_IMAGE_OWNER_SOURCES`（可选） | 按使用者（owner）单独授权的图片来源，JSON 形式：`{"<owner-uuid>":[{"origin":"https://img.example.com","pathPrefix":"/their/files/"}]}`。用于迁移既有素材 | 需要 |
| `APP_PORT`（可选） | 宿主端口，默认 `18889` | 需要 |
| `APP_IMAGE`（可选） | 覆盖应用镜像引用，默认 `ghcr.io/k7airos/wx-publish-studio:0.7.1`（公开镜像）。要固定到别的版本或自己的 registry 时填它 | 需要（改镜像要重建容器） |
| `PIPELINE_WORKER_IMAGE`（可选） | 覆盖 Worker 镜像引用，默认 `ghcr.io/k7airos/wx-pipeline-worker:0.24.0`（公开镜像） | 需要（改镜像要重建容器） |
| `RELAY_IMAGE`（可选） | 覆盖中转镜像引用，默认 `ghcr.io/k7airos/wx-relay:0.2.2`（公开镜像） | 需要 |
| `RELAY_ADMIN_USERNAME` / `RELAY_ADMIN_PASSWORD`（可选） | 同栈中转的管理员账号，供 `scripts/relay-init.sh` 使用 | 不需要（脚本自己读写 `.env`） |

> `RELAY_MODE` 与 `RELAY_REPLICAS` 是**派生变量**，由 `.env` 里的 `ZZHUB_WX_BASE_URL` 推导（留空 = 模式 A，填写 = 模式 B）。请保留它们，并保持它们位于 `ZZHUB_WX_BASE_URL` 之后。

> **所有配置都在启动时读取一次**（`src/server/index.ts` 只调用一次 `loadConfig()`），所以改任何一项环境变量都必须重启容器才生效，包括 `PUBLISHING_RELAY_PAT` 和 `PUBLISHING_WX_WHITELIST_IP`。

如果配置了 `PUBLISHING_RELAY_PAT`，使用者在界面上只需填 AppID 与 AppSecret；不配置时，使用者需要在连接向导里填写**自己中转服务的访问令牌（PAT）**。如果运维之后把 `PUBLISHING_RELAY_PAT` 从环境变量里撤掉，早先建立的连接会缺少 PAT，公众号连接列表会**显式提示「这个连接没有中转访问令牌（PAT）」**，需要逐个在「更新密钥」里补齐。

## 微信与中转

- **两种模式**：**模式 A**（默认）由 compose 起第 4 个容器 `relay`，地址是 `http://relay:3001`，只在本机网络内可达；**模式 B** 指向你自己的中转地址，compose 不起中转容器。
- **中转服务从哪来**：模式 A 用公开仓库 `bun-wx-server` 的固定提交构建；模式 B 可以自己实现（契约见 `/api/v1/wx/*`）。
- **PAT 的 scope**：PAT 是中转服务的访问令牌，用来代表你调用中转接口。它由中转服务签发，与微信 AppID/AppSecret 是两回事。`bun-wx-server` 的 scope 里 `wx` 对应 `/api/v1/wx/`。
- **模式 A 怎么拿 PAT**：跑 `bash scripts/relay-init.sh`，它会创建管理员、生成带 `wx` scope 的 PAT 并写回 `.env` 的 `PUBLISHING_RELAY_PAT`。
- **IP 白名单**：在公众号后台的「API IP 白名单」里，填**你自己中转服务的出口公网 IP**（不是本应用的服务器 IP）。部署配置了 `PUBLISHING_WX_WHITELIST_IP` 时界面会直接显示该值，否则请在连接向导里自行填写。白名单生效有等待期，第一次存入草稿箱时才会真正验证。
- **中转覆盖范围**：随栈的中转已实现 Pipeline 需要的全部 7 个微信端点，并支持 `Idempotency-Key` 幂等去重（同一把 PAT 下同 key 的重复请求不会重复写微信，直接返回首次结果；默认保留 24 小时，可用 `WX_IDEMPOTENCY_TTL_SECONDS` 调整）。模式 B 用自己的中转时，请自行确认它实现了同样的契约。

## 数据、备份与升级

四个卷各存不同的东西：

| 卷 | 内容 |
| --- | --- |
| `app-data` | 应用私有数据：上传的封面与正文素材（`assets/`、`body-assets/`） |
| `database-data` | PostgreSQL 数据：文章、排版、封面模板、公众号连接、加密凭据修订、任务映射 |
| `worker-data` | Worker 的账号登记、任务队列与运行结果 |
| `relay-data` | 同栈中转的数据：管理员、访问令牌、审计日志（模式 B 下没有这个卷） |

**备份要包含**：`app-data`、`database-data`、`worker-data`、`relay-data` 四个卷，以及 `CREDENTIAL_ENCRYPTION_KEY`。少任何一项，恢复后都无法完整还原。

**升级**：两种路径二选一。

用已发布镜像（快）：

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

> 源码构建路径下，Worker 与中转镜像来自两个公开仓库的固定提交，compose 会用构建缓存复用之前的层；缓存失效时按「快速开始」第 3 步的耗时估计。

> **换版本时要重新拉镜像**：compose 里的默认标签是写死的版本号，标签没变时 `up` 不会重新拉。升级版本后先 `docker compose pull`，再 `up`。

> **源码构建过的镜像会盖掉同名标签**：本地构建产物用的就是 `ghcr.io/k7airos/…` 这个标签名。之后再跑不带 `--build` 的 `up`，compose 会继续用本地那份。想换回官方镜像，先 `docker compose pull`。

> 如果你把 `APP_IMAGE` 指向了**自己的** registry（`APP_IMAGE=registry.example.com/wx-publish-studio:1.2.3`），那就改成先推再拉：
> ```sh
> docker build -t registry.example.com/wx-publish-studio:1.2.3 .
> docker push registry.example.com/wx-publish-studio:1.2.3
> docker compose pull && docker compose up -d --wait
> ```

数据库迁移由应用在启动时自动执行（迁移记录在 `schema_migrations` 表里）。

> **不要执行 `docker compose down -v`**。`-v` 会删除上述四个卷，用户数据不可恢复。

## 已知限制

- **单实例**：app 与 Worker 都不能跑多副本。Worker 是本地 JSON 队列，共享卷多副本会互相覆盖。
- **同栈中转只在容器网络内可达**：模式 A 的中转不映射宿主端口，只能被同栈的 Worker 通过 `http://relay:3001` 访问。
- **中转端点覆盖**：随栈中转已实现全部 7 个微信端点并支持 `Idempotency-Key` 去重；模式 B 用自己的中转时，请确认它实现了同样的契约。
- **正文图片依赖 COS**：带图片正文需要配置对象存储与公开 HTTPS 地址。
- **默认仍是 bootstrap 单用户**：只有一个访问口令。通用 OIDC **可以接入**（见下节），但多用户配额、邀请制与自助开通成员仍未提供；OIDC 登录的用户需要管理员预先绑定成员。
- **无注册、无群发**：不提供账号体系，也不提供任何群发能力。
- **只写草稿箱**：不读取公众号已发布内容，不做数据统计。
- **分发产物里的默认文案**：上游默认主题的示例品牌由构建期通用中性化清掉，规则在 `scripts/brand-copy.ts`（不写死任何具体名称），升级上游包要复核（见「当前状态」）。

## 故障排查

| 现象 | 排查方向 |
| --- | --- |
| `docker compose` 报缺少变量 | compose 在缺必填项时会直接报错并指出变量名；补齐 `.env` 后重新执行。模式 A 缺的是 `RELAY_JWT_SECRET`。 |
| `docker compose pull` 报 `pull access denied` | 镜像标签指向了一个不存在的镜像（多半是 `.env` 里手抄错了标签）。用 `docker manifest inspect <标签>` 确认标签存在；不存在就改回 compose 里的默认值，或改走源码构建。 |
| 构建时卡在拉公开仓库 | Worker 与中转镜像从 GitHub 的公开仓库以 git context 构建，检查网络、代理与 DNS。 |
| 登录总是失败 | `APP_ORIGIN` 与浏览器地址栏的 origin 必须完全一致（协议、域名、端口）。SSH 隧道换端口后要同步改 `.env` 的 `APP_PORT` 与 `APP_ORIGIN`。 |
| Worker 镜像拉不到 | 默认就是公开镜像 `ghcr.io/k7airos/wx-pipeline-worker:0.24.0`；拉不动多半是网络问题。也可以用 `PIPELINE_WORKER_IMAGE` 指向自己已构建的镜像，或改走源码构建。 |
| Worker 起不来 / 一直不健康 | `docker compose logs worker`：先看是不是连不上 `ZZHUB_WX_BASE_URL`，再看中转是否已启动。 |
| 中转起不来 / 一直不健康 | `docker compose logs relay`：模式 A 下先确认 `.env` 里有 `RELAY_JWT_SECRET`。 |
| `scripts/relay-init.sh` 报登录失败 | `.env` 的 `RELAY_ADMIN_PASSWORD` 与中转里已有管理员的口令不一致；清掉 `relay-data` 卷重新初始化，或改回原口令。 |
| 存入草稿箱报 401 | 中转 PAT 不对、已过期，或 scope 里没有 `wx`。 |
| 存入草稿箱报封面字体 hash 不符 | 封面渲染依赖固定的 Noto CJK 字体文件，字节必须与封面合同一致；镜像内已固定安装该字体，自建镜像时请勿改动。 |
| 提示 IP 白名单未生效 | 微信的白名单生效有等待期，稍等几分钟再试；同时确认填的是**中转服务的出口公网 IP**。 |
| 草稿箱里出现重复文章 | 中转已按 `Idempotency-Key` 去重：同一把 PAT 下同 key 的重复请求会返回首次结果，不会再写一次微信。出现重复多半是**换了不同的 PAT 或不同部署**，请先确认草稿箱实际结果，**不要重复发布**。 |
| 连接列表提示「这个连接没有中转访问令牌（PAT）」 | 部署没有统一持有中转令牌，或之前持有过、后来被撤掉了。点「更新密钥」给这个连接补一个 PAT。 |

## 接入统一身份（可选）

**默认仍然是 bootstrap 单用户**：一个访问口令管一个部署。要多人共用一个实例时，可以把登录换成任意标准 OIDC 服务（Keycloak、Authentik、Zitadel、Authelia、Cloudflare Access 等），只要填环境变量即可，不需要改代码。

开启方式是把 `PUBLISHING_AUTH_MODE` 改成 `oauth`，并按下面**三种端点来源**之一配好。端点来源决定了这个实例走哪条登录链路：

| 端点来源 | 什么时候用 | 需要填什么 | 行为 |
| --- | --- | --- | --- |
| **标准发现**（推荐） | 你的 IdP 提供 `/.well-known/openid-configuration` | `PUBLISHING_OAUTH_ISSUER` + client id/secret + redirect | 启动时读一次发现文档，取 `authorization_endpoint`／`token_endpoint`／`userinfo_endpoint`。**发现失败就是启动失败**，不会悄悄换到别的端点 |
| **显式端点** | 你的 IdP 不提供发现文档，或你不想让服务在启动时访问外网 | 上面三个 `*_ENDPOINT` 变量 + client id/secret + redirect | 完全按你填的地址调用，**不发任何发现请求**。三个端点必须写全，缺一个就启动失败 |
| **既有形态**（默认） | 保持今天的私有授权服务形态 | `PUBLISHING_OAUTH_PORTAL_URL`（固定 `/oauth/authorize`）+ `PUBLISHING_OAUTH_BASE_URL` + client id/secret + redirect | 与改动前完全一致，**现有部署不需要改任何配置** |

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

- **issuer 可以带路径**（如 `/realms/main`），但必须是精确受信值：HTTPS（或显式回环 HTTP 用于本地调试），不带 query/fragment，尾部斜杠会被规范化。issuer 带路径时**只允许在标准发现与显式端点两种方式下使用**。
- **redirect 必须精确等于** `${APP_ORIGIN}/api/auth/oauth/callback`，并且与 IdP 里登记的回调地址一字不差。
- **端点地址不带 query、fragment 或凭据**，也不能用非回环的明文 HTTP。
- **令牌交换用标准表单**（`grant_type=authorization_code` 等），**用户信息用 `Authorization: Bearer <access_token>`**。只支持「客户端密钥放在请求体」这一种客户端认证方式；要求 `client_secret_basic` 的 IdP 需要换一种方式接入。
- **会话策略仍是本项目自己的**：上游令牌最长可到一天，但本产品的登录会话固定 7 天，不随上游令牌变长。
- **成员要管理员先绑定**：OIDC 登录的用户不会自动成为成员。用受控命令按 `issuer`/`subject` 绑定（`subject` 就是 IdP 的 `sub`，标准 OIDC 里它不一定是 UUID，大小写按原样保留）。`PUBLISHING_SELF_PROVISION` 的会员自动开通是托管部署专属，开源默认关闭。

发现请求只在启动时发生一次；不想让服务启动时依赖外网，就用显式端点，或把 `PUBLISHING_OAUTH_DISCOVERY` 设成 `0`。

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
