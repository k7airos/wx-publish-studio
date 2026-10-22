#!/usr/bin/env bash
# 初始化同栈自带的中转服务（模式 A）。
#
# 做三件事：
# 1. 在 relay 容器里执行 init-admin，创建中转管理员（已初始化时会跳过并复用已有账号）。
# 2. 用管理员登录中转，拿到一个带 wx scope 的访问令牌（PAT）。
# 3. 把 PAT 写回 .env 的 PUBLISHING_RELAY_PAT，让应用统一持有中转令牌。
#
# 重复执行是安全的：中转里只剩一枚本脚本生成的同名令牌、且 .env 里记着它时就直接沿用，
# 不再重新生成；否则铸一枚新的，并把此前由本脚本生成的同名令牌全部吊销，
# 免得每次重跑都在中转里留下一把仍然有效的令牌（PAT 默认有效期很长）。
#
# 用法：
#   bash scripts/relay-init.sh            # 生成管理员口令与 PAT 并写入 .env
#   RELAY_ADMIN_USERNAME=admin RELAY_ADMIN_PASSWORD=... bash scripts/relay-init.sh
#
# 前提：中转容器已在运行（docker compose up -d --build --wait），且 .env 里的
# ZZHUB_WX_BASE_URL 留空（模式 A）。模式 B 下本脚本不做任何事。

set -euo pipefail

root="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
cd "$root"

env_file=".env"

fail() {
  echo "错误：$*" >&2
  exit 1
}

note() {
  echo "$*"
}

[ -f "$env_file" ] || fail "缺少 ${env_file}，先执行 cp .env.example .env 并填写必填项。"

# 读取 .env 里的某个键（取最后一条非注释定义）。
read_env() {
  local key="$1"
  [ -f "$env_file" ] || return 0
  sed -n "s/^${key}=//p" "$env_file" | tail -n 1
}

# 写入 .env 的某个键（存在则替换，不存在则追加）。
write_env() {
  local key="$1" value="$2" tmp
  tmp="$(mktemp)"
  RELAY_KEY="$key" RELAY_VALUE="$value" awk '
    BEGIN { k = ENVIRON["RELAY_KEY"]; v = ENVIRON["RELAY_VALUE"]; seen = 0 }
    index($0, k "=") == 1 { if (!seen) { print k "=" v; seen = 1 } next }
    { print }
    END { if (!seen) print k "=" v }
  ' "$env_file" > "$tmp"
  mv "$tmp" "$env_file"
  chmod 600 "$env_file" 2>/dev/null || true
}

# 模式判定：ZZHUB_WX_BASE_URL 留空 = 模式 A（同栈自带中转）。
base_url="${ZZHUB_WX_BASE_URL:-$(read_env ZZHUB_WX_BASE_URL)}"
if [ -n "${base_url//[[:space:]]/}" ]; then
  note "当前 .env 的 ZZHUB_WX_BASE_URL 已填写（模式 B：使用外部中转），无需初始化同栈中转。"
  exit 0
fi

compose=(docker compose)

relay_state="$("${compose[@]}" ps --status running --services 2>/dev/null | grep -x relay || true)"
if [ -z "$relay_state" ]; then
  # 用户可能用 `-p` 起了别的项目名（compose 文件里的 name 只是默认值）。
  # 跟随正在运行的那一套，避免脚本与实际部署对不上。
  project="$(docker ps --filter 'label=com.docker.compose.service=relay' --format '{{.Label "com.docker.compose.project"}}' 2>/dev/null | head -n 1)"
  if [ -n "$project" ]; then
    compose+=(--project-name "$project")
    relay_state="$("${compose[@]}" ps --status running --services 2>/dev/null | grep -x relay || true)"
  fi
fi
if [ -z "$relay_state" ]; then
  fail "中转容器没有在运行，先执行 docker compose up -d --wait（从源码构建则用 docker compose up -d --build --wait）。"
fi

# 管理员账号与口令。
username="${RELAY_ADMIN_USERNAME:-$(read_env RELAY_ADMIN_USERNAME)}"
username="${username:-admin}"
password="${RELAY_ADMIN_PASSWORD:-$(read_env RELAY_ADMIN_PASSWORD)}"
if [ -z "$password" ]; then
  if command -v openssl >/dev/null 2>&1; then
    password="$(openssl rand -hex 16)"
  else
    password="$(head -c 32 /dev/urandom | od -An -tx1 | tr -d ' \n')"
  fi
  write_env RELAY_ADMIN_USERNAME "$username"
  write_env RELAY_ADMIN_PASSWORD "$password"
  note "已生成中转管理员口令并写入 ${env_file} 的 RELAY_ADMIN_PASSWORD，请自行妥善保管。"
fi

# 1. 创建管理员。重复执行会被中转拒绝，属正常情况。
note "创建中转管理员（${username}）……"
init_output="$("${compose[@]}" exec -T relay blog-wx-bun-service init-admin --username "$username" --password "$password" 2>&1 || true)"
if printf '%s' "$init_output" | grep -q "已初始化"; then
  note "中转管理员已存在，跳过创建（沿用已有口令）。"
else
  printf '%s\n' "$init_output" | sed 's/^/  /'
fi

# 2. 登录并生成带 wx scope 的 PAT。口令通过 stdin 传入，不出现在命令行里。
# 应用容器在运行时直接 exec；没运行时用一次性容器，两者都在 compose 网络内。
app_state="$("${compose[@]}" ps --status running --services 2>/dev/null | grep -x app || true)"
if [ -n "$app_state" ]; then
  app_run=("${compose[@]}" exec -T app)
else
  app_run=("${compose[@]}" run --rm --no-deps -T app)
fi

note "生成 wx scope 的中转访问令牌（PAT）……"
# 口令里的引号与反斜杠要转义后再拼 JSON。
json_escape() {
  printf '%s' "$1" | sed -e 's/\\/\\\\/g' -e 's/"/\\"/g'
}
existing_pat="$(read_env PUBLISHING_RELAY_PAT)"
pat="$(
  printf '{"username":"%s","password":"%s","existingPat":"%s","note":"wx-publish-studio"}' \
    "$(json_escape "$username")" "$(json_escape "$password")" "$(json_escape "$existing_pat")" |
    "${app_run[@]}" bun -e '
      const payload = JSON.parse(await Bun.stdin.text());
      const base = "http://relay:3001";
      const note = payload.note || "wx-publish-studio";

      // 1. 登录中转（管理员）。
      const login = await fetch(base + "/api/v1/user/login", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ username: payload.username, password: payload.password }),
      });
      const loginBody = await login.json();
      if (!login.ok) {
        console.error("登录中转失败：" + JSON.stringify(loginBody));
        process.exit(1);
      }
      const accessToken = loginBody?.data?.accessToken;
      if (!accessToken) {
        console.error("中转没有返回访问令牌：" + JSON.stringify(loginBody));
        process.exit(1);
      }

      // 2. 列出中转里当前仍然有效的同名令牌。
      //    wx scope 的令牌打不到任何本地端点（只有 /api/v1/wx/ 归它管），所以用
      //    「中转里恰好只剩一枚同名令牌」来判断 .env 里那把是不是它。
      const listed = await fetch(base + "/api/v1/token/list", {
        headers: { authorization: "Bearer " + accessToken },
      });
      const listBody = listed.ok ? await listed.json() : null;
      const live = (Array.isArray(listBody?.data) ? listBody.data : []).filter(t => t?.note === note);

      // 3. .env 里已有令牌、且中转里恰好只有这一枚同名令牌 → 沿用，不重复铸。
      if (payload.existingPat && live.length === 1) {
        console.log("REUSE:" + payload.existingPat);
        process.exit(0);
      }

      // 4. 吊销所有旧同名令牌再铸新的，保持「恰好一枚有效令牌」的不变式。
      for (const old of live) {
        if (!old?.id) continue;
        await fetch(base + "/api/v1/token/" + encodeURIComponent(old.id), {
          method: "DELETE",
          headers: { authorization: "Bearer " + accessToken },
        });
      }

      const generated = await fetch(base + "/api/v1/token/generate", {
        method: "POST",
        headers: { authorization: "Bearer " + accessToken, "content-type": "application/json" },
        body: JSON.stringify({ note: note, scopes: ["wx"] }),
      });
      const generatedBody = await generated.json();
      if (!generated.ok) {
        console.error("生成 PAT 失败：" + JSON.stringify(generatedBody));
        process.exit(1);
      }
      const token = generatedBody?.data?.token;
      if (!token) {
        console.error("中转没有返回 PAT：" + JSON.stringify(generatedBody));
        process.exit(1);
      }
      console.log("NEW:" + token);
    '
)"

[ -n "$pat" ] || fail "没有拿到 PAT，请检查中转容器日志：docker compose logs relay。"

# 3. 写回 .env。
case "$pat" in
  REUSE:*)
    pat="${pat#REUSE:}"
    write_env PUBLISHING_RELAY_PAT "$pat"
    note "沿用 ${env_file} 里已有的中转访问令牌（pat_****${pat: -4}）——它仍然有效，没有重复生成。"
    ;;
  NEW:*)
    pat="${pat#NEW:}"
    write_env PUBLISHING_RELAY_PAT "$pat"
    note "已把中转访问令牌写入 ${env_file} 的 PUBLISHING_RELAY_PAT（pat_****${pat: -4}），此前同名的旧令牌已吊销。"
    ;;
  *)
    fail "没有拿到 PAT，请检查中转容器日志：docker compose logs relay。"
    ;;
esac
note "接下来执行 docker compose up -d --wait 让应用加载该令牌。"
