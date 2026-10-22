import { expect, test } from "bun:test";
import { SQL } from "bun";
import { createApp } from "../src/server/app";
import { openDatabase, OWNER_ID } from "../src/server/db/schema";
import { loadAuthConfig, type AppConfig } from "../src/server/config";
import { resolveOAuthEndpoints } from "../src/server/auth/oidc";
import { claimOwner } from "../src/server/auth/access";
import { tokenHash } from "../src/server/auth/session";

const databaseUrl = process.env.TEST_DATABASE_URL;
if (!databaseUrl || !/^\/[a-zA-Z0-9_]+_test$/.test(new URL(databaseUrl).pathname)) throw new Error("OIDC test requires a disposable *_test database");

const origin = "http://127.0.0.1:18889";
const redirectUri = `${origin}/api/auth/oauth/callback`;
const baseEnv = { PUBLISHING_AUTH_MODE: "oauth", PUBLISHING_OAUTH_CLIENT_ID: "zp_test", PUBLISHING_OAUTH_CLIENT_SECRET: "server-only-secret", PUBLISHING_OAUTH_REDIRECT_URI: redirectUri };
const explicitEnv = { ...baseEnv, PUBLISHING_OAUTH_ISSUER: "https://idp.example.com/realms/main", PUBLISHING_OAUTH_AUTHORIZATION_ENDPOINT: "https://idp.example.com/realms/main/protocol/openid-connect/auth", PUBLISHING_OAUTH_TOKEN_ENDPOINT: "https://idp.example.com/realms/main/protocol/openid-connect/token", PUBLISHING_OAUTH_USERINFO_ENDPOINT: "https://idp.example.com/realms/main/protocol/openid-connect/userinfo" };

async function freshDatabase() {
  const initial = new SQL(databaseUrl!);
  await initial.unsafe("DROP TABLE IF EXISTS owner_configuration_defaults,cover_template_assets,account_admin_audit,account_bindings,identity_admin_audit,oauth_pending_states,product_memberships,identities,body_assets,cover_template_revisions,cover_templates,cover_assets,article_style_revisions,article_styles,account_credentials,accounts,app_settings,schema_migrations,jobs,documents,sessions,owners CASCADE");
  await initial.close();
  return openDatabase(databaseUrl!);
}

/** 统一的登录流程断言：跳转参数、握手 cookie、state 一次性消费。 */
function loginFlow(config: AppConfig, sql: Awaited<ReturnType<typeof openDatabase>>) {
  const app = createApp(config, sql);
  const request = (path: string, cookie = "", method = "GET") => app.request(`${origin}/api${path}`, { method, headers: { Cookie: cookie, Origin: origin } });
  const begin = async () => {
    const response = await request("/auth/oauth/start"); const location = new URL(response.headers.get("Location")!);
    const cookieHeader = response.headers.get("Set-Cookie")!;
    expect(cookieHeader).toContain("HttpOnly"); expect(cookieHeader).toContain("SameSite=Lax"); expect(cookieHeader).not.toContain("Domain=");
    expect([...location.searchParams.keys()].sort()).toEqual(["client_id", "redirect_uri", "response_type", "scope", "state"]);
    expect(location.searchParams.get("response_type")).toBe("code");
    expect(location.searchParams.get("scope")).toBe("openid profile");
    expect(location.searchParams.get("client_id")).toBe("zp_test");
    expect(location.searchParams.get("redirect_uri")).toBe(redirectUri);
    return { state: location.searchParams.get("state")!, cookie: cookieHeader.split(";")[0]! };
  };
  const callback = (pending: { state: string; cookie: string }, code = "test-code") => request(`/auth/oauth/callback?state=${pending.state}&code=${code}`, pending.cookie);
  const sessionCookie = (response: Response) => response.headers.getSetCookie().find(item => item.startsWith("studio_session="))!.split(";")[0]!;
  return { app, request, begin, callback, sessionCookie };
}

test("endpoint sources keep the legacy shape, accept explicit endpoints and pick discovery from the issuer alone", () => {
  // 既有形态：六个变量齐全时行为不变，不产生任何新端点。
  const legacy = loadAuthConfig({ ...baseEnv, PUBLISHING_OAUTH_ISSUER: "https://auth.example.test", PUBLISHING_OAUTH_BASE_URL: "https://auth.example.test", PUBLISHING_OAUTH_PORTAL_URL: "https://auth.example.test/oauth/authorize" }, origin);
  expect(legacy.oauth!.endpointMode).toBe("legacy");
  expect(legacy.oauth!.issuer).toBe("https://auth.example.test");
  expect(legacy.oauth!.tokenEndpoint).toBeUndefined();
  expect(legacy.oauth!.userinfoEndpoint).toBeUndefined();

  // 显式端点：三个端点都给出时不发发现请求。
  const explicit = loadAuthConfig(explicitEnv, origin);
  expect(explicit.oauth!.endpointMode).toBe("explicit");
  expect(explicit.oauth!.issuer).toBe("https://idp.example.com/realms/main");
  expect(explicit.oauth!.tokenEndpoint).toBe("https://idp.example.com/realms/main/protocol/openid-connect/token");

  // 只给 issuer：按标准 OIDC 发现。
  expect(loadAuthConfig({ ...baseEnv, PUBLISHING_OAUTH_ISSUER: "https://idp.example.com/realms/main" }, origin).oauth!.endpointMode).toBe("discovery");
  // 显式端点优先于自动发现；但只给一个端点不算完整配置，会直接报错而不是悄悄发现。
  expect(() => loadAuthConfig({ ...baseEnv, PUBLISHING_OAUTH_ISSUER: "https://idp.example.com", PUBLISHING_OAUTH_TOKEN_ENDPOINT: "https://idp.example.com/token" }, origin)).toThrow("PUBLISHING_OAUTH_AUTHORIZATION_ENDPOINT");
  // 发现可以显式关掉：关掉后回到既有形态。
  expect(loadAuthConfig({ ...baseEnv, PUBLISHING_OAUTH_DISCOVERY: "0", PUBLISHING_OAUTH_ISSUER: "https://auth.example.test", PUBLISHING_OAUTH_BASE_URL: "https://auth.example.test", PUBLISHING_OAUTH_PORTAL_URL: "https://auth.example.test/oauth/authorize" }, origin).oauth!.endpointMode).toBe("legacy");
  expect(() => loadAuthConfig({ ...baseEnv, PUBLISHING_OAUTH_DISCOVERY: "maybe" }, origin)).toThrow("PUBLISHING_OAUTH_DISCOVERY");
});

test("illegal endpoint and issuer configurations fail at startup instead of degrading", () => {
  // 显式端点模式缺一个端点就说清缺哪个。
  expect(() => loadAuthConfig({ ...baseEnv, PUBLISHING_OAUTH_ISSUER: "https://idp.example.com", PUBLISHING_OAUTH_TOKEN_ENDPOINT: "https://idp.example.com/token" }, origin)).toThrow("PUBLISHING_OAUTH_AUTHORIZATION_ENDPOINT");
  expect(() => loadAuthConfig({ ...baseEnv, PUBLISHING_OAUTH_ISSUER: "https://idp.example.com", PUBLISHING_OAUTH_TOKEN_ENDPOINT: "https://idp.example.com/token", PUBLISHING_OAUTH_USERINFO_ENDPOINT: "https://idp.example.com/userinfo" }, origin)).toThrow("PUBLISHING_OAUTH_AUTHORIZATION_ENDPOINT");
  // 端点不得带 query、fragment、凭据，也不得用非回环明文。
  expect(() => loadAuthConfig({ ...explicitEnv, PUBLISHING_OAUTH_TOKEN_ENDPOINT: "https://idp.example.com/token?x=1" }, origin)).toThrow();
  expect(() => loadAuthConfig({ ...explicitEnv, PUBLISHING_OAUTH_USERINFO_ENDPOINT: "https://idp.example.com/userinfo#frag" }, origin)).toThrow();
  expect(() => loadAuthConfig({ ...explicitEnv, PUBLISHING_OAUTH_AUTHORIZATION_ENDPOINT: "http://idp.example.com/auth" }, origin)).toThrow();
  expect(() => loadAuthConfig({ ...explicitEnv, PUBLISHING_OAUTH_AUTHORIZATION_ENDPOINT: "https://user:pass@idp.example.com/auth" }, origin)).toThrow();
  // 回环明文只允许显式 loopback。
  expect(loadAuthConfig({ ...explicitEnv, PUBLISHING_OAUTH_AUTHORIZATION_ENDPOINT: "http://127.0.0.1:9/auth" }, origin).oauth!.endpointMode).toBe("explicit");
  // issuer 带路径只在通用形态下允许；既有形态仍要求精确 origin。
  expect(() => loadAuthConfig({ ...baseEnv, PUBLISHING_OAUTH_ISSUER: "https://idp.example.com/realms/main", PUBLISHING_OAUTH_BASE_URL: "https://idp.example.com", PUBLISHING_OAUTH_PORTAL_URL: "https://idp.example.com/oauth/authorize" }, origin)).toThrow();
  expect(() => loadAuthConfig({ ...baseEnv, PUBLISHING_OAUTH_ISSUER: "https://idp.example.com/realms/main?x=1" }, origin)).toThrow();
  // 回调地址仍必须精确匹配。
  expect(() => loadAuthConfig({ ...explicitEnv, PUBLISHING_OAUTH_REDIRECT_URI: "https://evil.invalid/callback" }, origin)).toThrow();
  // 通用形态下 Portal 路径不再固定，也不要求 base。
  expect(loadAuthConfig({ ...baseEnv, PUBLISHING_OAUTH_ISSUER: "https://idp.example.com/realms/main", PUBLISHING_OAUTH_PORTAL_URL: "https://idp.example.com/realms/main/protocol/openid-connect/auth" }, origin).oauth!.endpointMode).toBe("discovery");
});

test("standard OIDC discovery and login keep the state, cookie and session invariants", async () => {
  let discoveryHits = 0; let tokenHits = 0; let userinfoHits = 0;
  let tokenContentType = ""; let tokenBody = ""; let userinfoAuthorization = "";
  const subject = "Oidc-User-1";
  let currentSubject = subject;
  let providerOrigin = "";
  const provider = Bun.serve({ hostname: "127.0.0.1", port: 0, async fetch(request: Request): Promise<Response> {
    const url = new URL(request.url);
    if (url.pathname === "/realms/main/.well-known/openid-configuration") {
      discoveryHits++;
      return Response.json({ issuer: `${providerOrigin}/realms/main`, authorization_endpoint: `${providerOrigin}/realms/main/protocol/openid-connect/auth`, token_endpoint: `${providerOrigin}/realms/main/protocol/openid-connect/token`, userinfo_endpoint: `${providerOrigin}/realms/main/protocol/openid-connect/userinfo` });
    }
    if (url.pathname === "/realms/main/protocol/openid-connect/token") {
      tokenHits++; tokenContentType = request.headers.get("content-type") || ""; tokenBody = await request.text();
      return Response.json({ access_token: "standard-upstream-token", token_type: "Bearer", expires_in: 3600 });
    }
    if (url.pathname === "/realms/main/protocol/openid-connect/userinfo") {
      userinfoHits++; userinfoAuthorization = request.headers.get("authorization") || "";
      return Response.json({ sub: currentSubject, preferred_username: "标准用户", email: "oidc-user@example.test" });
    }
    return new Response("missing", { status: 404 });
  } });
  providerOrigin = provider.url.origin;
  let sql = await freshDatabase();
  try {
    const configured = loadAuthConfig({ ...baseEnv, PUBLISHING_OAUTH_ISSUER: `${providerOrigin}/realms/main` }, origin);
    const oauth = await resolveOAuthEndpoints(configured.oauth!);
    expect(discoveryHits).toBe(1);
    expect(oauth.endpointMode).toBe("discovery");
    expect(oauth.authorizationEndpoint).toBe(`${providerOrigin}/realms/main/protocol/openid-connect/auth`);
    expect(oauth.tokenEndpoint).toBe(`${providerOrigin}/realms/main/protocol/openid-connect/token`);
    expect(oauth.userinfoEndpoint).toBe(`${providerOrigin}/realms/main/protocol/openid-connect/userinfo`);
    const config: AppConfig = { databaseUrl: databaseUrl!, appOrigin: origin, bootstrapSecret: "", credentialEncryptionKey: "ab".repeat(32), workerToken: "worker-must-not-leak", workerUrl: "http://127.0.0.1:1", simulation: true, authMode: "oauth", oauth };
    const { request, begin, callback, sessionCookie } = loginFlow(config, sql);
    // 未绑定身份一律拒绝：通用 OIDC 不自助开通成员。
    const unknown = await begin();
    expect((await callback(unknown)).headers.get("Location")).toBe("/?auth=access_denied");
    // 通用形态接受非 UUID 的 sub，并原样保存大小写。
    await claimOwner(sql, config, { ownerId: OWNER_ID, issuer: oauth.issuer, subject, operator: "controlled-test", confirm: true });
    const [identity] = await sql`SELECT * FROM identities WHERE issuer=${oauth.issuer}`;
    expect(identity.subject).toBe("Oidc-User-1");
    const flow = await begin();
    const parallel = await Promise.all([callback(flow), callback(flow)]);
    expect(parallel.filter(item => item.headers.get("Location") === "/").length).toBe(1);
    expect(parallel.filter(item => item.headers.get("Location") === "/?auth=oauth_failed").length).toBe(1);
    expect(tokenHits).toBe(2); expect(userinfoHits).toBe(2);
    expect(tokenContentType).toContain("application/x-www-form-urlencoded");
    const form = new URLSearchParams(tokenBody);
    expect(form.get("grant_type")).toBe("authorization_code"); expect(form.get("code")).toBe("test-code");
    expect(form.get("client_id")).toBe("zp_test"); expect(form.get("client_secret")).toBe("server-only-secret");
    expect(form.get("redirect_uri")).toBe(redirectUri);
    expect(userinfoAuthorization).toBe("Bearer standard-upstream-token");
    const success = parallel.find(item => item.headers.get("Location") === "/")!;
    const cookie = sessionCookie(success);
    expect(success.headers.get("Set-Cookie")).toContain("SameSite=Strict"); expect(success.headers.get("Set-Cookie")).toContain("Max-Age=604800");
    // 上游令牌有效期放宽不改变本产品自己的会话有效期。
    const [storedSession] = await sql`SELECT *,extract(epoch FROM (expires_at-created_at)) AS lifetime FROM sessions WHERE token_hash=${tokenHash(cookie.split("=")[1]!)}`;
    expect(Number(storedSession.lifetime)).toBeLessThanOrEqual(604801);
    expect(JSON.stringify(storedSession)).not.toContain("standard-upstream-token");
    expect((await request("/documents", cookie)).status).toBe(200);
    // state 只能消费一次。
    expect((await callback(flow)).headers.get("Location")).toBe("/?auth=oauth_failed");
    expect(tokenHits).toBe(2);
    // 过期与重复参数仍然直接失败。
    const expired = await begin(); await sql`UPDATE oauth_pending_states SET expires_at=now()-interval '1 second' WHERE state_hash=${tokenHash(expired.state)}`;
    expect((await callback(expired)).headers.get("Location")).toBe("/?auth=oauth_failed");
    const duplicate = await begin();
    expect((await request(`/auth/oauth/callback?state=${duplicate.state}&state=${duplicate.state}&code=test`, duplicate.cookie)).headers.get("Location")).toBe("/?auth=oauth_failed");
    // 会员自动开通是托管部署专属：通用 OIDC 没有会员语义就不会自助开通。
    currentSubject = "Unknown-User-2";
    const selfProvision = createApp({ ...config, selfProvision: true }, sql);
    const pending = await begin();
    const selfProvisioned = await selfProvision.request(`${origin}/api/auth/oauth/callback?state=${pending.state}&code=test-code`, { headers: { Cookie: pending.cookie, Origin: origin } });
    expect(selfProvisioned.headers.get("Location")).toBe("/?auth=membership_required");
    currentSubject = subject;
  } finally { provider.stop(true); await sql.close(); }
}, 20_000);

test("explicit endpoints are used without any discovery request", async () => {
  let discoveryHits = 0; let tokenHits = 0; let userinfoHits = 0;
  let tokenBody = ""; let userinfoAuthorization = "";
  let providerOrigin = "";
  const provider = Bun.serve({ hostname: "127.0.0.1", port: 0, async fetch(request: Request): Promise<Response> {
    const url = new URL(request.url);
    if (url.pathname === "/.well-known/openid-configuration") { discoveryHits++; return Response.json({ issuer: providerOrigin }); }
    if (url.pathname === "/token") { tokenHits++; tokenBody = await request.text(); return Response.json({ access_token: "explicit-token", token_type: "bearer", expires_in: 86_400 }); }
    if (url.pathname === "/userinfo") { userinfoHits++; userinfoAuthorization = request.headers.get("authorization") || ""; return Response.json({ sub: "explicit-subject" }); }
    return new Response("missing", { status: 404 });
  } });
  providerOrigin = provider.url.origin;
  let sql = await freshDatabase();
  try {
    const configured = loadAuthConfig({ ...baseEnv, PUBLISHING_OAUTH_ISSUER: providerOrigin, PUBLISHING_OAUTH_AUTHORIZATION_ENDPOINT: `${providerOrigin}/authorize`, PUBLISHING_OAUTH_TOKEN_ENDPOINT: `${providerOrigin}/token`, PUBLISHING_OAUTH_USERINFO_ENDPOINT: `${providerOrigin}/userinfo` }, origin);
    expect(configured.oauth!.endpointMode).toBe("explicit");
    const oauth = await resolveOAuthEndpoints(configured.oauth!);
    expect(discoveryHits).toBe(0);
    expect(oauth.tokenEndpoint).toBe(`${providerOrigin}/token`);
    const config: AppConfig = { databaseUrl: databaseUrl!, appOrigin: origin, bootstrapSecret: "", credentialEncryptionKey: "ab".repeat(32), workerToken: "w", workerUrl: "http://127.0.0.1:1", simulation: true, authMode: "oauth", oauth };
    const { begin, callback, sessionCookie } = loginFlow(config, sql);
    await claimOwner(sql, config, { ownerId: OWNER_ID, issuer: oauth.issuer, subject: "explicit-subject", operator: "controlled-test", confirm: true });
    const pending = await begin();
    const success = await callback(pending);
    expect(success.headers.get("Location")).toBe("/");
    expect(discoveryHits).toBe(0);
    expect(tokenHits).toBe(1); expect(userinfoHits).toBe(1);
    const form = new URLSearchParams(tokenBody);
    expect(form.get("grant_type")).toBe("authorization_code");
    expect(userinfoAuthorization).toBe("Bearer explicit-token");
    expect(sessionCookie(success)).toContain("studio_session=");
  } finally { provider.stop(true); await sql.close(); }
}, 20_000);

test("a failed discovery stops startup instead of falling back to other endpoints", async () => {
  const provider = Bun.serve({ hostname: "127.0.0.1", port: 0, async fetch(): Promise<Response> { return new Response("missing", { status: 404 }); } });
  const providerOrigin = provider.url.origin;
  const keys = ["APP_ORIGIN", "PIPELINE_WORKER_URL", "PIPELINE_WORKER_TOKEN", "CREDENTIAL_ENCRYPTION_KEY", "DATABASE_URL", "PUBLISHING_AUTH_MODE", "PUBLISHING_RELAY_PAT", "PUBLISHING_OAUTH_ISSUER", "PUBLISHING_OAUTH_CLIENT_ID", "PUBLISHING_OAUTH_CLIENT_SECRET", "PUBLISHING_OAUTH_REDIRECT_URI"] as const;
  const saved = Object.fromEntries(keys.map(key => [key, process.env[key]]));
  try {
    const configured = loadAuthConfig({ ...baseEnv, PUBLISHING_OAUTH_ISSUER: `${providerOrigin}/realms/main` }, origin);
    await expect(resolveOAuthEndpoints(configured.oauth!)).rejects.toThrow(/OIDC discovery/);
    // 启动路径同样失败：不会悄悄换到别的端点。
    Object.assign(process.env, { APP_ORIGIN: origin, PIPELINE_WORKER_URL: "http://127.0.0.1:1", PIPELINE_WORKER_TOKEN: "w", CREDENTIAL_ENCRYPTION_KEY: "ab".repeat(32), DATABASE_URL: "postgres://127.0.0.1:1/none", PUBLISHING_AUTH_MODE: "oauth", PUBLISHING_RELAY_PAT: "pat", PUBLISHING_OAUTH_ISSUER: `${providerOrigin}/realms/main`, PUBLISHING_OAUTH_CLIENT_ID: "zp_test", PUBLISHING_OAUTH_CLIENT_SECRET: "server-only-secret", PUBLISHING_OAUTH_REDIRECT_URI: redirectUri });
    const { loadConfig } = await import("../src/server/config");
    await expect(loadConfig()).rejects.toThrow(/OIDC discovery/);
  } finally {
    for (const [key, value] of Object.entries(saved)) value === undefined ? delete process.env[key] : process.env[key] = value;
    provider.stop(true);
  }
});
