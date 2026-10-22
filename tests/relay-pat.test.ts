import { expect, test } from "bun:test";
import { SQL } from "bun";
import { createApp } from "../src/server/app";
import { openDatabase } from "../src/server/db/schema";
import { loadAuthConfig, type AppConfig } from "../src/server/config";

const databaseUrl = process.env.TEST_DATABASE_URL;
if (!databaseUrl || !/^\/[a-zA-Z0-9_]+_test$/.test(new URL(databaseUrl).pathname)) throw new Error("Relay PAT test requires a disposable *_test database");

test("service-held relay token lets customers connect with only AppID and AppSecret", async () => {
  const initial = new SQL(databaseUrl!);
  await initial.unsafe("DROP TABLE IF EXISTS owner_configuration_defaults,cover_template_assets,account_admin_audit,account_bindings,identity_admin_audit,oauth_pending_states,product_memberships,identities,body_assets,cover_template_revisions,cover_templates,cover_assets,article_style_revisions,article_styles,account_credentials,accounts,app_settings,schema_migrations,jobs,documents,sessions,owners CASCADE");
  await initial.close();
  const registrations: any[] = [];
  const worker = Bun.serve({ port: 0, async fetch(request) {
    if (new URL(request.url).pathname.startsWith("/v1/accounts/") && request.method === "PUT") { registrations.push(await request.json()); return Response.json({ active: true }); }
    return new Response("missing", { status: 404 });
  } });
  const sql = await openDatabase(databaseUrl!);
  const config: AppConfig = { databaseUrl: databaseUrl!, appOrigin: "http://127.0.0.1:18889", bootstrapSecret: "test-bootstrap-secret-at-least-thirty-two", credentialEncryptionKey: "ab".repeat(32), workerToken: "w", workerUrl: worker.url.origin, relayPat: "service-relay-pat" };
  const app = createApp(config, sql);
  try {
    const login = await app.request(`${config.appOrigin}/api/auth/login`, { method: "POST", headers: { Origin: config.appOrigin, "Content-Type": "application/json" }, body: JSON.stringify({ secret: config.bootstrapSecret }) });
    const cookie = login.headers.get("Set-Cookie")!.split(";")[0]!;
    const request = (path: string, method = "GET", input?: unknown) => app.request(`${config.appOrigin}/api${path}`, { method, headers: { Cookie: cookie, Origin: config.appOrigin, "Content-Type": "application/json" }, ...(input ? { body: JSON.stringify(input) } : {}) });
    const created = await request("/accounts", "POST", { label: "客户公众号", appId: "wx-customer", appSecret: "customer-secret-1234" });
    expect(created.status).toBe(201);
    const account = await created.json() as any;
    expect((await request(`/accounts/${account.id}/sync`, "POST")).status).toBe(200);
    expect(registrations.at(-1)).toEqual({ appId: "wx-customer", appSecret: "customer-secret-1234", pat: "service-relay-pat" });
    // 旧前端仍提交令牌时也不写入新的凭据修订，Worker 始终使用服务令牌。
    const updated = await (await request(`/accounts/${account.id}`, "PUT", { label: "客户公众号", appId: "wx-customer", appSecret: "", pat: "customer-pat", expectedVersion: account.version })).json() as any;
    expect((await sql`SELECT credential_revision FROM accounts WHERE id=${account.id}`)[0].credential_revision).toBe(1);
    await request(`/accounts/${updated.id}/sync`, "POST");
    expect(registrations.at(-1).pat).toBe("service-relay-pat");
    expect((await request("/accounts", "POST", { label: "缺密钥", appId: "wx-other" })).status).toBe(400);
  } finally { await sql.close(); worker.stop(true); }
}, 30_000);

test("bootstrap mode without a service relay token takes the user's own PAT and says so in the session", async () => {
  const initial = new SQL(databaseUrl!);
  await initial.unsafe("DROP TABLE IF EXISTS owner_configuration_defaults,cover_template_assets,account_admin_audit,account_bindings,identity_admin_audit,oauth_pending_states,product_memberships,identities,body_assets,cover_template_revisions,cover_templates,cover_assets,article_style_revisions,article_styles,account_credentials,accounts,app_settings,schema_migrations,jobs,documents,sessions,owners CASCADE");
  await initial.close();
  const registrations: any[] = [];
  const worker = Bun.serve({ port: 0, async fetch(request) {
    if (new URL(request.url).pathname.startsWith("/v1/accounts/") && request.method === "PUT") { registrations.push(await request.json()); return Response.json({ active: true }); }
    return new Response("missing", { status: 404 });
  } });
  const sql = await openDatabase(databaseUrl!);
  const config: AppConfig = { databaseUrl: databaseUrl!, appOrigin: "http://127.0.0.1:18889", bootstrapSecret: "test-bootstrap-secret-at-least-thirty-two", credentialEncryptionKey: "ab".repeat(32), workerToken: "w", workerUrl: worker.url.origin };
  const app = createApp(config, sql);
  try {
    const login = await app.request(`${config.appOrigin}/api/auth/login`, { method: "POST", headers: { Origin: config.appOrigin, "Content-Type": "application/json" }, body: JSON.stringify({ secret: config.bootstrapSecret }) });
    const cookie = login.headers.get("Set-Cookie")!.split(";")[0]!;
    const request = (path: string, method = "GET", input?: unknown) => app.request(`${config.appOrigin}/api${path}`, { method, headers: { Cookie: cookie, Origin: config.appOrigin, "Content-Type": "application/json" }, ...(input ? { body: JSON.stringify(input) } : {}) });
    // 未配置服务中转令牌时，界面必须知道要向使用者索取 PAT，并可注入白名单出口 IP。
    expect(await (await request("/auth/session")).json()).toEqual({ authenticated: true, simulation: false, displayName: null, accessUntil: null, role: "admin", relayManaged: false, whitelistIp: null, copyMode: "neutral" });
    // 没有 PAT 时连接必然失败，这正是旧 bootstrap 部署「添加公众号」失败的原因。
    expect((await request("/accounts", "POST", { label: "缺令牌", appId: "wx-no-pat", appSecret: "customer-secret-1234" })).status).toBe(400);
    // 使用者填入自己的中转令牌后即可连接，Worker 收到该令牌。
    const created = await request("/accounts", "POST", { label: "自管中转", appId: "wx-own-relay", appSecret: "customer-secret-1234", pat: "own-relay-pat" });
    expect(created.status).toBe(201);
    const account = await created.json() as any;
    const synced = await request(`/accounts/${account.id}/sync`, "POST");
    expect(synced.status).toBe(200);
    expect(registrations.at(-1)).toEqual({ appId: "wx-own-relay", appSecret: "customer-secret-1234", pat: "own-relay-pat" });
    // 令牌不落库明文。
    expect(JSON.stringify(await sql`SELECT encrypted_secret FROM account_credentials WHERE account_id=${account.id}`)).not.toContain("own-relay-pat");
  } finally { await sql.close(); worker.stop(true); }
}, 30_000);

test("production OAuth mode refuses to start without the service relay token", async () => {
  const keys = ["APP_ORIGIN", "PIPELINE_WORKER_URL", "PIPELINE_WORKER_TOKEN", "CREDENTIAL_ENCRYPTION_KEY", "DATABASE_URL", "PUBLISHING_AUTH_MODE", "PUBLISHING_RELAY_PAT"] as const;
  const saved = Object.fromEntries(keys.map(key => [key, process.env[key]]));
  const oauth = { PUBLISHING_OAUTH_ISSUER: "https://auth.example.test", PUBLISHING_OAUTH_PORTAL_URL: "https://auth.example.test/oauth/authorize", PUBLISHING_OAUTH_BASE_URL: "https://auth.example.test", PUBLISHING_OAUTH_CLIENT_ID: "c", PUBLISHING_OAUTH_CLIENT_SECRET: "s", PUBLISHING_OAUTH_REDIRECT_URI: "https://studio.example.test/api/auth/oauth/callback" };
  try {
    // 只有 OAuth 配置字段本身合法时，缺少中转令牌才是唯一的启动错误。
    expect(() => loadAuthConfig({ PUBLISHING_AUTH_MODE: "oauth", ...oauth }, "https://studio.example.test")).not.toThrow();
    Object.assign(process.env, { APP_ORIGIN: "https://studio.example.test", PIPELINE_WORKER_URL: "http://127.0.0.1:1", PIPELINE_WORKER_TOKEN: "w", CREDENTIAL_ENCRYPTION_KEY: "ab".repeat(32), DATABASE_URL: "postgres://x/y", PUBLISHING_AUTH_MODE: "oauth", ...oauth });
    delete process.env.PUBLISHING_RELAY_PAT;
    const { loadConfig } = await import("../src/server/config");
    await expect(loadConfig()).rejects.toThrow("PUBLISHING_RELAY_PAT");
    process.env.PUBLISHING_RELAY_PAT = "service-relay-pat";
    expect((await loadConfig()).relayPat).toBe("service-relay-pat");
  } finally {
    for (const [key, value] of Object.entries(saved)) value === undefined ? delete process.env[key] : process.env[key] = value;
    for (const key of Object.keys(oauth)) delete process.env[key];
  }
});
