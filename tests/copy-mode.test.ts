import { expect, test } from "bun:test";
import { SQL } from "bun";
import { createApp } from "../src/server/app";
import { openDatabase } from "../src/server/db/schema";
import type { AppConfig } from "../src/server/config";

const databaseUrl = process.env.TEST_DATABASE_URL;
if (!databaseUrl || !/^\/[a-zA-Z0-9_]+_test$/.test(new URL(databaseUrl).pathname)) throw new Error("Copy mode test requires a disposable *_test database");

// 部署形态只影响客户可见文案：默认中性，hosted 保留线上托管部署的原有措辞。
test("copy mode defaults to neutral and is served with the session and auth options", async () => {
  const initial = new SQL(databaseUrl!);
  await initial.unsafe("DROP TABLE IF EXISTS owner_configuration_defaults,cover_template_assets,account_admin_audit,account_bindings,identity_admin_audit,oauth_pending_states,product_memberships,identities,body_assets,cover_template_revisions,cover_templates,cover_assets,article_style_revisions,article_styles,account_credentials,accounts,app_settings,schema_migrations,jobs,documents,sessions,owners CASCADE");
  await initial.close();
  const sql = await openDatabase(databaseUrl!);
  const base: AppConfig = { databaseUrl: databaseUrl!, appOrigin: "http://127.0.0.1:18889", bootstrapSecret: "test-bootstrap-secret-at-least-thirty-two", credentialEncryptionKey: "ab".repeat(32), workerToken: "w", workerUrl: "http://127.0.0.1:1", simulation: true, coverFontPath: process.env.TYPESET_ARTICLE_COVER_FONT_PATH };
  try {
    const app = createApp(base, sql);
    const options = await (await app.request(`${base.appOrigin}/api/auth/options`)).json() as any;
    expect(options.copyMode).toBe("neutral");
    const login = await app.request(`${base.appOrigin}/api/auth/login`, { method: "POST", headers: { Origin: base.appOrigin, "Content-Type": "application/json" }, body: JSON.stringify({ secret: base.bootstrapSecret }) });
    const cookie = login.headers.get("Set-Cookie")!.split(";")[0]!;
    const session = await (await app.request(`${base.appOrigin}/api/auth/session`, { headers: { Cookie: cookie, Origin: base.appOrigin } })).json() as any;
    expect(session.copyMode).toBe("neutral");
    // 托管部署形态随接口下发，前端据此切回原有文案。
    const hosted = createApp({ ...base, copyMode: "hosted" }, sql);
    expect(((await (await hosted.request(`${base.appOrigin}/api/auth/options`)).json()) as any).copyMode).toBe("hosted");
    expect(((await (await hosted.request(`${base.appOrigin}/api/auth/session`, { headers: { Cookie: cookie, Origin: base.appOrigin } })).json()) as any).copyMode).toBe("hosted");
  } finally { await sql.close(); }
}, 30_000);

test("copy module picks the copy that matches the deployment shape", async () => {
  const { setCopyMode, errorText, loginReasonText, loginCopy, supportCopy, renewalText } = await import("../src/web/copy");
  setCopyMode("neutral");
  expect(errorText("access_expired")).toContain("请联系作者");
  expect(errorText("access_expired")).not.toContain("Nezus");
  expect(loginReasonText("membership_required")).not.toContain("Nezus");
  expect(loginCopy().foot).not.toContain("Nezus");
  expect(supportCopy().title).toBe("联系作者");
  expect(renewalText()).not.toContain("Nezus");
  setCopyMode("hosted");
  expect(errorText("access_expired")).toContain("Nezus");
  expect(loginReasonText("membership_required")).toContain("Nezus");
  expect(loginCopy().oauthButton).toContain("Nezus");
  expect(supportCopy().title).toBe("你的专属顾问");
  expect(renewalText()).toContain("Nezus");
  // 未知形态按开源自托管的中性文案处理。
  setCopyMode("something-else");
  expect(errorText("access_expired")).toContain("请联系作者");
  expect(errorText("unknown_code")).toBeUndefined();
});
