import { expect, test } from "bun:test";
import { SQL } from "bun";
import { createApp } from "../src/server/app";
import { openDatabase } from "../src/server/db/schema";
import type { AppConfig } from "../src/server/config";

const databaseUrl = process.env.TEST_DATABASE_URL;
if (!databaseUrl || !/^\/[a-zA-Z0-9_]+_test$/.test(new URL(databaseUrl).pathname)) throw new Error("Relay token test requires a disposable *_test database");

test("removing the service relay token flags existing connections as missing their own PAT", async () => {
  const initial = new SQL(databaseUrl!);
  await initial.unsafe("DROP TABLE IF EXISTS owner_configuration_defaults,cover_template_assets,account_admin_audit,account_bindings,identity_admin_audit,oauth_pending_states,product_memberships,identities,body_assets,cover_template_revisions,cover_templates,cover_assets,article_style_revisions,article_styles,account_credentials,accounts,app_settings,schema_migrations,jobs,documents,sessions,owners CASCADE");
  await initial.close();
  const sql = await openDatabase(databaseUrl!);
  const config: AppConfig = { databaseUrl: databaseUrl!, appOrigin: "http://127.0.0.1:18889", bootstrapSecret: "test-bootstrap-secret-at-least-thirty-two", credentialEncryptionKey: "ab".repeat(32), workerToken: "w", workerUrl: "http://127.0.0.1:1", relayPat: "service-relay-pat" };
  try {
    const app = createApp(config, sql);
    const login = await app.request(`${config.appOrigin}/api/auth/login`, { method: "POST", headers: { Origin: config.appOrigin, "Content-Type": "application/json" }, body: JSON.stringify({ secret: config.bootstrapSecret }) });
    const cookie = login.headers.get("Set-Cookie")!.split(";")[0]!;
    const request = (path: string, method = "GET", input?: unknown) => app.request(`${config.appOrigin}/api${path}`, { method, headers: { Cookie: cookie, Origin: config.appOrigin, "Content-Type": "application/json" }, ...(input ? { body: JSON.stringify(input) } : {}) });
    const created = await request("/accounts", "POST", { label: "服务持令的连接", appId: "wx-service-pat", appSecret: "customer-secret-1234" });
    expect(created.status).toBe(201);
    const account = await created.json() as any;
    // 部署还持有服务令牌时，连接没有自己的 PAT 也不需要提示。
    const managed = (await (await request("/accounts")).json() as any).accounts.find((item: any) => item.id === account.id);
    expect(managed.patMissing).toBe(false);
    // 运维撤掉服务令牌后，这个连接就缺 PAT，界面必须能提示出来。
    const stripped = createApp({ ...config, relayPat: undefined }, sql);
    const listed = await (await stripped.request(`${config.appOrigin}/api/accounts`, { headers: { Cookie: cookie, Origin: config.appOrigin } })).json() as any;
    expect(listed.accounts.find((item: any) => item.id === account.id).patMissing).toBe(true);
  } finally { await sql.close(); }
}, 30_000);
