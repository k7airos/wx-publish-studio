import { expect, test } from "bun:test";
import { randomUUID } from "node:crypto";
import { SQL } from "bun";
import { createApp } from "../src/server/app";
import { openDatabase, OWNER_ID } from "../src/server/db/schema";
import { loadAuthConfig, type AppConfig } from "../src/server/config";
import { claimOwner, disableMember, revokeSessions } from "../src/server/auth/access";
import { tokenHash } from "../src/server/auth/session";

const databaseUrl = process.env.TEST_DATABASE_URL;
if (!databaseUrl || !/^\/[a-zA-Z0-9_]+_test$/.test(new URL(databaseUrl).pathname)) throw new Error("OAuth test requires a disposable *_test database");

test("OAuth mode and fixed callback configuration fail closed", () => {
  const origin = "http://127.0.0.1:18889";
  expect(loadAuthConfig({}, origin)).toEqual({ authMode: "bootstrap" });
  expect(() => loadAuthConfig({ PUBLISHING_AUTH_MODE: "oauth" }, origin)).toThrow();
  expect(() => loadAuthConfig({ PUBLISHING_AUTH_MODE: "automatic" }, origin)).toThrow();
  const env = { PUBLISHING_AUTH_MODE: "oauth", PUBLISHING_OAUTH_ISSUER: "https://auth.example.test", PUBLISHING_OAUTH_BASE_URL: "https://auth.example.test", PUBLISHING_OAUTH_PORTAL_URL: "https://auth.example.test/oauth/authorize", PUBLISHING_OAUTH_CLIENT_ID: "zp_test", PUBLISHING_OAUTH_CLIENT_SECRET: "secret", PUBLISHING_OAUTH_REDIRECT_URI: `${origin}/api/auth/oauth/callback` };
  expect(loadAuthConfig(env, origin).authMode).toBe("oauth");
  expect(() => loadAuthConfig({ ...env, PUBLISHING_OAUTH_REDIRECT_URI: "https://evil.invalid/callback" }, origin)).toThrow();
  expect(() => loadAuthConfig({ ...env, PUBLISHING_OAUTH_PORTAL_URL: "https://auth.example.test/oauth/authorize?callback=evil" }, origin)).toThrow();
  expect(() => loadAuthConfig({ ...env, PUBLISHING_OAUTH_CLIENT_SECRET: "" }, origin)).toThrow();
});

test("A2 explicit binding, atomic OAuth state, local access and revocation preserve the legacy owner", async () => {
  const initial = new SQL(databaseUrl);
  await initial.unsafe("DROP TABLE IF EXISTS owner_configuration_defaults,cover_template_assets,account_admin_audit,account_bindings,identity_admin_audit,oauth_pending_states,product_memberships,identities,body_assets,cover_template_revisions,cover_templates,cover_assets,article_style_revisions,article_styles,account_credentials,accounts,app_settings,schema_migrations,jobs,documents,sessions,owners CASCADE");
  await initial.close();
  let exchanges = 0; let profileSubject: unknown = randomUUID(); let redirectToken = false; let malformedToken = false;
  const provider = Bun.serve({ hostname: "127.0.0.1", port: 0, async fetch(request) {
    const path = new URL(request.url).pathname;
    if (path === "/api/v1/oauth/token") {
      exchanges++; const input = await request.json() as any;
      expect(input.client_secret).toBe("server-only-secret"); expect(input.redirect_uri).toBe("http://127.0.0.1:18889/api/auth/oauth/callback");
      if (redirectToken) return Response.redirect("https://other.invalid/token", 302);
      if (malformedToken) return Response.json({ code: 0, data: { access_token: "invalid", token_type: "Bearer", expires_in: 700 } });
      return Response.json({ code: 0, data: { access_token: "short-lived-upstream-token", token_type: "Bearer", expires_in: 600 } });
    }
    if (path === "/api/v1/oauth/userinfo") return Response.json({ code: 0, data: { userId: profileSubject, email: "not-an-ownership-key@example.test", role: "super_admin", membership: { status: "active" } } });
    return new Response("missing", { status: 404 });
  } });
  let sql = await openDatabase(databaseUrl);
  const config: AppConfig = { databaseUrl, appOrigin: "http://127.0.0.1:18889", bootstrapSecret: "test-bootstrap-secret-at-least-thirty-two", credentialEncryptionKey: "ab".repeat(32), workerToken: "worker-must-not-leak", workerUrl: "http://127.0.0.1:1", simulation: true,
    oauth: { issuer: "https://auth.example.test", portalUrl: "https://auth.example.test/oauth/authorize", baseUrl: provider.url.origin, clientId: "zp_test", clientSecret: "server-only-secret", redirectUri: "http://127.0.0.1:18889/api/auth/oauth/callback" } };
  let app = createApp(config, sql);
  const request = (path: string, cookie = "", method = "GET", input?: unknown) => app.request(`${config.appOrigin}/api${path}`, { method, headers: { Cookie: cookie, Origin: config.appOrigin, "Content-Type": "application/json" }, ...(input ? { body: JSON.stringify(input) } : {}) });
  const begin = async () => {
    const response = await request("/auth/oauth/start"); const location = new URL(response.headers.get("Location")!);
    const cookieHeader = response.headers.get("Set-Cookie")!;
    expect(cookieHeader).toContain("HttpOnly"); expect(cookieHeader).toContain("SameSite=Lax"); expect(cookieHeader).not.toContain("Domain=");
    expect([...location.searchParams.keys()].sort()).toEqual(["client_id", "redirect_uri", "scope", "state"]);
    return { state: location.searchParams.get("state")!, cookie: cookieHeader.split(";")[0]! };
  };
  const callback = (pending: { state: string; cookie: string }, code = "test-code") => request(`/auth/oauth/callback?state=${pending.state}&code=${code}`, pending.cookie);
  const sessionCookie = (response: Response) => response.headers.getSetCookie().find(item => item.startsWith("studio_session="))!.split(";")[0]!;
  try {
    const login = await request("/auth/login", "", "POST", { secret: config.bootstrapSecret }); const oldCookie = login.headers.get("Set-Cookie")!.split(";")[0]!;
    expect((await request("/auth/session", oldCookie)).status).toBe(200);
    const doc = await (await request("/documents", oldCookie, "POST", { title: "本人原文", body: "原字节与owner保留" })).json() as any;
    const options = await (await request("/auth/options")).json() as any;
    expect(options.mode).toBe("bootstrap"); expect(JSON.stringify(options)).not.toContain("server-only-secret");
    expect(await (await request("/health")).json()).toEqual({ status: "ok" });
    app = createApp({ ...config, authMode: "oauth" }, sql);
    expect((await request("/auth/login", "", "POST", { secret: config.bootstrapSecret })).status).toBe(403);
    expect((await request("/auth/session", oldCookie)).status).toBe(401);
    const wrong = await begin(); const before = exchanges;
    expect((await request(`/auth/oauth/callback?state=${"a".repeat(64)}&code=test`, wrong.cookie)).headers.get("Location")).toBe("/?auth=oauth_failed"); expect(exchanges).toBe(before);
    const unbound = await callback(wrong); expect(unbound.headers.get("Location")).toBe("/?auth=access_denied"); expect(unbound.headers.get("Set-Cookie")).not.toContain("studio_session=");
    const [noIdentity] = await sql`SELECT count(*)::integer AS count FROM identities`; expect(noIdentity.count).toBe(0);
    const subject = profileSubject as string;
    const claim = { ownerId: OWNER_ID, issuer: config.oauth!.issuer, subject, operator: "controlled-test", confirm: true };
    const linked = await claimOwner(sql, config, claim); expect(linked.ownerId).toBe(OWNER_ID);
    expect((await claimOwner(sql, config, claim)).unchanged).toBe(true);
    await expect(claimOwner(sql, config, { ...claim, subject: randomUUID() })).rejects.toMatchObject({ code: "identity_claim_conflict" });
    await expect(claimOwner(sql, config, { ...claim, confirm: false })).rejects.toMatchObject({ code: "invalid_identity_claim" });
    await expect(claimOwner(sql, config, { ...claim, issuer: "https://other.invalid" })).rejects.toMatchObject({ code: "invalid_identity_claim" });
    const flow = await begin(); const countBefore = exchanges;
    const parallel = await Promise.all([callback(flow), callback(flow)]);
    expect(exchanges).toBe(countBefore + 1); expect(parallel.filter(item => item.headers.get("Location") === "/").length).toBe(1);
    const success = parallel.find(item => item.headers.get("Location") === "/")!;
    const cookie = sessionCookie(success);
    expect(success.headers.get("Set-Cookie")).toContain("SameSite=Strict"); expect(success.headers.get("Set-Cookie")).toContain("Max-Age=604800");
    expect((await request(`/documents/${doc.id}`, cookie)).status).toBe(200);
    const [storedDoc] = await sql`SELECT * FROM documents WHERE id=${doc.id}`; expect(storedDoc.owner_id).toBe(OWNER_ID); expect(storedDoc.body).toBe(doc.body);
    const [storedSession] = await sql`SELECT *,extract(epoch FROM (expires_at-created_at)) AS lifetime FROM sessions WHERE token_hash=${tokenHash(cookie.split("=")[1]!)}`;
    expect(storedSession.auth_method).toBe("oauth"); expect(Number(storedSession.lifetime)).toBeLessThanOrEqual(604801);
    expect(JSON.stringify(storedSession)).not.toContain("short-lived-upstream-token");
    expect((await callback(flow)).headers.get("Location")).toBe("/?auth=oauth_failed"); expect(exchanges).toBe(countBefore + 1);
    const denial = await begin(); const denialCount = exchanges;
    expect((await request(`/auth/oauth/callback?state=${denial.state}&error=access_denied`, denial.cookie)).headers.get("Location")).toBe("/?auth=access_denied"); expect(exchanges).toBe(denialCount);
    const duplicate = await begin();
    expect((await request(`/auth/oauth/callback?state=${duplicate.state}&state=${duplicate.state}&code=test`, duplicate.cookie)).headers.get("Location")).toBe("/?auth=oauth_failed"); expect(exchanges).toBe(denialCount);
    const expired = await begin(); await sql`UPDATE oauth_pending_states SET expires_at=now()-interval '1 second' WHERE state_hash=${tokenHash(expired.state)}`;
    const expiredCount = exchanges; expect((await callback(expired)).headers.get("Location")).toBe("/?auth=oauth_failed"); expect(exchanges).toBe(expiredCount);
    redirectToken = true; expect((await callback(await begin())).headers.get("Location")).toBe("/?auth=oauth_failed"); redirectToken = false;
    malformedToken = true; expect((await callback(await begin())).headers.get("Location")).toBe("/?auth=oauth_failed"); malformedToken = false;
    profileSubject = "bad-subject"; expect((await callback(await begin())).headers.get("Location")).toBe("/?auth=oauth_failed"); profileSubject = subject;
    const wrongIssuerApp = createApp({ ...config, authMode: "oauth", oauth: { ...config.oauth!, issuer: "https://other.invalid" } }, sql);
    expect((await wrongIssuerApp.request(`${config.appOrigin}/api/documents`, { headers: { Cookie: cookie } })).status).toBe(401);
    await revokeSessions(sql, { sessionId: storedSession.id, operator: "controlled-test", confirm: true }); expect((await request("/documents", cookie)).status).toBe(401);
    const newFlow = await begin(); const newLogin = await callback(newFlow);
    const newCookie = sessionCookie(newLogin);
    await sql`UPDATE product_memberships SET status='disabled' WHERE owner_id=${OWNER_ID}`;
    expect((await request("/documents", newCookie)).status).toBe(403);
    await claimOwner(sql, config, claim); const [disabled] = await sql`SELECT status FROM product_memberships WHERE owner_id=${OWNER_ID}`; expect(disabled.status).toBe("disabled");
    await sql`UPDATE product_memberships SET status='active' WHERE owner_id=${OWNER_ID}`;
    const result = await disableMember(sql, { ownerId: OWNER_ID, operator: "controlled-test", confirm: true }); expect(result.disabled).toBe(true);
    expect((await request("/documents", newCookie)).status).toBe(401);
    await sql.close(); sql = await openDatabase(databaseUrl); app = createApp({ ...config, authMode: "oauth" }, sql);
    const [afterRestart] = await sql`SELECT status FROM product_memberships WHERE owner_id=${OWNER_ID}`; expect(afterRestart.status).toBe("disabled");
    expect((await callback(await begin())).headers.get("Location")).toBe("/?auth=access_denied");
    expect((await request("/auth/logout", newCookie, "POST")).status).toBe(200);
    const [audit] = await sql`SELECT count(*)::integer AS count FROM identity_admin_audit`; expect(audit.count).toBeGreaterThanOrEqual(4);
  } finally { provider.stop(true); await sql.close(); }
}, 20_000);
