import { expect, test } from "bun:test";
import { loadAuthConfig } from "../src/server/config";

// OSS107：bootstrap 模式下 PUBLISHING_RELAY_PAT 是可选的——配了就由服务统一持有，
// 客户端不必提交；没配则使用者必须在连接向导里填写自己中转服务的 PAT。
// 本文件不依赖数据库，只覆盖配置层口径。

const baseEnv = {
  APP_ORIGIN: "https://studio.example.test",
  DATABASE_URL: "postgres://studio:secret@127.0.0.1:5432/studio",
  PIPELINE_WORKER_URL: "http://127.0.0.1:18887",
  PIPELINE_WORKER_TOKEN: "worker-token",
  CREDENTIAL_ENCRYPTION_KEY: "ab".repeat(32),
  BOOTSTRAP_SECRET: "bootstrap-secret-at-least-thirty-two-chars",
} as Record<string, string>;

async function loadWith(extra: Record<string, string | undefined>) {
  const saved = new Map<string, string | undefined>();
  for (const [key, value] of Object.entries({ ...baseEnv, ...extra })) {
    saved.set(key, process.env[key]);
    if (value === undefined) delete process.env[key];
    else process.env[key] = value;
  }
  try {
    const { loadConfig } = await import("../src/server/config");
    return await loadConfig();
  } finally {
    for (const [key, value] of saved) value === undefined ? delete process.env[key] : process.env[key] = value;
  }
}

test("bootstrap mode accepts an optional service-held relay token", async () => {
  const without = await loadWith({ PUBLISHING_AUTH_MODE: "bootstrap", PUBLISHING_RELAY_PAT: undefined });
  expect(without.relayPat).toBeUndefined();
  const with_ = await loadWith({ PUBLISHING_AUTH_MODE: "bootstrap", PUBLISHING_RELAY_PAT: "service-relay-pat" });
  expect(with_.relayPat).toBe("service-relay-pat");
});

test("oauth mode still refuses to start without the service relay token", async () => {
  const oauth = {
    PUBLISHING_OAUTH_ISSUER: "https://auth.example.test",
    PUBLISHING_OAUTH_PORTAL_URL: "https://auth.example.test/oauth/authorize",
    PUBLISHING_OAUTH_BASE_URL: "https://auth.example.test",
    PUBLISHING_OAUTH_CLIENT_ID: "c",
    PUBLISHING_OAUTH_CLIENT_SECRET: "s",
    PUBLISHING_OAUTH_REDIRECT_URI: "https://studio.example.test/api/auth/oauth/callback",
  };
  await expect(loadWith({ PUBLISHING_AUTH_MODE: "oauth", ...oauth, PUBLISHING_RELAY_PAT: undefined })).rejects.toThrow("PUBLISHING_RELAY_PAT");
  expect((await loadWith({ PUBLISHING_AUTH_MODE: "oauth", ...oauth, PUBLISHING_RELAY_PAT: "service-relay-pat" })).relayPat).toBe("service-relay-pat");
  expect(() => loadAuthConfig({ PUBLISHING_AUTH_MODE: "oauth", ...oauth }, "https://studio.example.test")).not.toThrow();
});

test("the WeChat whitelist egress IP is optional and only accepted as an IP-shaped value", async () => {
  expect((await loadWith({ PUBLISHING_WX_WHITELIST_IP: undefined })).wxWhitelistIp).toBeUndefined();
  expect((await loadWith({ PUBLISHING_WX_WHITELIST_IP: "203.0.113.10" })).wxWhitelistIp).toBe("203.0.113.10");
  await expect(loadWith({ PUBLISHING_WX_WHITELIST_IP: "not an ip" })).rejects.toThrow("PUBLISHING_WX_WHITELIST_IP");
});
