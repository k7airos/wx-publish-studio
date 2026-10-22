import { expect, test } from "bun:test";
import { createHash, randomUUID } from "node:crypto";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { SQL } from "bun";
import { createApp } from "../src/server/app";
import { openDatabase, OWNER_ID } from "../src/server/db/schema";
import { loadAuthConfig, type AppConfig } from "../src/server/config";
import { claimOwner, disableMember } from "../src/server/auth/access";
import { membershipEntitlement } from "../src/server/auth/oauth";
import { lockOwner } from "../src/server/services/owner-limits";
import { AccountStore } from "../src/server/services/account-store";
import { applyWorkerJob } from "../src/server/services/job-execution";
import { pruneTerminalJobs } from "../src/server/services/job-retention";

const databaseUrl = process.env.TEST_DATABASE_URL;
if (!databaseUrl || !/^\/[a-zA-Z0-9_]+_test$/.test(new URL(databaseUrl).pathname)) throw new Error("Invite access test requires a disposable *_test database");

const DAY = 24 * 60 * 60 * 1000;
const TABLES = "owner_configuration_defaults,cover_template_assets,account_admin_audit,account_bindings,identity_admin_audit,oauth_pending_states,product_memberships,identities,body_assets,cover_template_revisions,cover_templates,cover_assets,article_style_revisions,article_styles,account_credentials,accounts,app_settings,schema_migrations,jobs,documents,sessions,owners";

async function freshDatabase() {
  const initial = new SQL(databaseUrl!);
  await initial.unsafe(`DROP TABLE IF EXISTS ${TABLES} CASCADE`);
  await initial.close();
  return openDatabase(databaseUrl!);
}

test("self-provision configuration and membership entitlement fail closed", () => {
  const origin = "http://127.0.0.1:18889";
  const oauthEnv = { PUBLISHING_AUTH_MODE: "oauth", PUBLISHING_OAUTH_ISSUER: "https://auth.example.test", PUBLISHING_OAUTH_BASE_URL: "https://auth.example.test", PUBLISHING_OAUTH_PORTAL_URL: "https://auth.example.test/oauth/authorize", PUBLISHING_OAUTH_CLIENT_ID: "zp_test", PUBLISHING_OAUTH_CLIENT_SECRET: "secret", PUBLISHING_OAUTH_REDIRECT_URI: `${origin}/api/auth/oauth/callback` };
  expect(loadAuthConfig(oauthEnv, origin).selfProvision).toBeUndefined();
  expect(loadAuthConfig({ ...oauthEnv, PUBLISHING_SELF_PROVISION: "0" }, origin).selfProvision).toBeUndefined();
  expect(loadAuthConfig({ ...oauthEnv, PUBLISHING_SELF_PROVISION: "1" }, origin).selfProvision).toBe(true);
  expect(() => loadAuthConfig({ ...oauthEnv, PUBLISHING_SELF_PROVISION: "yes" }, origin)).toThrow();
  expect(() => loadAuthConfig({ PUBLISHING_SELF_PROVISION: "1" }, origin)).toThrow("requires OAuth");

  const now = Date.parse("2026-10-20T00:00:00.000Z");
  const future = "2026-11-20T00:00:00.000Z";
  expect(membershipEntitlement({ status: "active", expiresAt: future }, now)?.toISOString()).toBe(future);
  expect(membershipEntitlement({ status: "trial", expiresAt: future }, now)).toBeNull();
  expect(membershipEntitlement({ status: "active", expiresAt: "2026-10-19T00:00:00.000Z" }, now)).toBeNull();
  expect(membershipEntitlement({ status: "active" }, now)).toBeNull();
  expect(membershipEntitlement({ status: "active", expiresAt: "not-a-date" }, now)).toBeNull();
  expect(membershipEntitlement(null, now)).toBeNull();
});

test("Nezus membership provisions invited members once, renews them and never revives disabled ones", async () => {
  let sql = await freshDatabase();
  let profile: { userId: string; membership: unknown } = { userId: randomUUID(), membership: null };
  const provider = Bun.serve({ hostname: "127.0.0.1", port: 0, async fetch(request) {
    const path = new URL(request.url).pathname;
    if (path === "/api/v1/oauth/token") return Response.json({ code: 0, data: { access_token: "short-lived", token_type: "Bearer", expires_in: 600 } });
    if (path === "/api/v1/oauth/userinfo") return Response.json({ code: 0, data: { userId: profile.userId, username: "邀请客户", email: "guest@example.test", role: "user", membership: profile.membership } });
    return new Response("missing", { status: 404 });
  } });
  const config: AppConfig = { databaseUrl: databaseUrl!, appOrigin: "http://127.0.0.1:18889", bootstrapSecret: "", credentialEncryptionKey: "ab".repeat(32), workerToken: "worker", workerUrl: "http://127.0.0.1:1", simulation: true, authMode: "oauth",
    oauth: { issuer: "https://auth.example.test", portalUrl: "https://auth.example.test/oauth/authorize", baseUrl: provider.url.origin, clientId: "zp_test", clientSecret: "secret", redirectUri: "http://127.0.0.1:18889/api/auth/oauth/callback" } };
  let app = createApp(config, sql);
  const request = (path: string, cookie = "", method = "GET", input?: unknown) => app.request(`${config.appOrigin}/api${path}`, { method, headers: { Cookie: cookie, Origin: config.appOrigin, "Content-Type": "application/json" }, ...(input ? { body: JSON.stringify(input) } : {}) });
  const login = async () => {
    const started = await request("/auth/oauth/start"); const state = new URL(started.headers.get("Location")!).searchParams.get("state")!;
    const pending = started.headers.get("Set-Cookie")!.split(";")[0]!;
    return request(`/auth/oauth/callback?state=${state}&code=test-code`, pending);
  };
  const sessionCookie = (response: Response) => response.headers.getSetCookie().find(item => item.startsWith("studio_session="))?.split(";")[0] ?? "";
  const active = (days: number) => ({ status: "active", planId: "plan", expiresAt: new Date(Date.now() + days * DAY).toISOString() });
  const counts = async () => (await sql`SELECT (SELECT count(*) FROM identities)::integer AS identities, (SELECT count(*) FROM owners)::integer AS owners`)[0];
  try {
    // INV02：开关关闭时保持原行为，即使会员有效也不建映射。
    profile = { userId: randomUUID(), membership: active(30) };
    expect((await login()).headers.get("Location")).toBe("/?auth=access_denied");
    expect(await counts()).toEqual({ identities: 0, owners: 1 });

    app = createApp({ ...config, selfProvision: true }, sql);
    // INV04：试用、过期、无会员、缺失到期时间都拒绝，且不留任何行。
    for (const membership of [{ status: "trial", expiresAt: new Date(Date.now() + DAY).toISOString() }, { status: "active", expiresAt: new Date(Date.now() - DAY).toISOString() }, null, { status: "active" }]) {
      profile = { userId: randomUUID(), membership };
      expect((await login()).headers.get("Location")).toBe("/?auth=membership_required");
    }
    expect(await counts()).toEqual({ identities: 0, owners: 1 });

    // INV03：有效会员首次登录自动开通并记录有效期与审计。
    const invited = randomUUID(); profile = { userId: invited, membership: active(30) };
    const first = await login();
    expect(first.headers.get("Location")).toBe("/");
    const cookie = sessionCookie(first);
    expect((await request("/documents", cookie)).status).toBe(200);
    const [member] = await sql`SELECT m.*,i.subject FROM product_memberships m JOIN identities i ON i.owner_id=m.owner_id WHERE i.subject=${invited}`;
    expect(member).toMatchObject({ status: "active", role: "member", access_source: "nezus_membership" });
    expect(new Date(member.access_until).toISOString()).toBe((profile.membership as any).expiresAt);
    const session = await (await request("/auth/session", cookie)).json() as any;
    expect(session).toMatchObject({ displayName: "邀请客户", role: "member" });
    expect(new Date(session.accessUntil).toISOString()).toBe((profile.membership as any).expiresAt);
    const [audit] = await sql`SELECT * FROM identity_admin_audit WHERE owner_id=${member.owner_id}`;
    expect(audit).toMatchObject({ action: "self-provision", operator: "oauth-login", subject: invited });

    // INV06：同一新用户并发首次登录只产生一个身份。
    const racer = randomUUID(); profile = { userId: racer, membership: active(30) };
    const pendings = await Promise.all([0, 1].map(async () => {
      const started = await request("/auth/oauth/start");
      return { state: new URL(started.headers.get("Location")!).searchParams.get("state")!, cookie: started.headers.get("Set-Cookie")!.split(";")[0]! };
    }));
    const raced = await Promise.all(pendings.map(item => request(`/auth/oauth/callback?state=${item.state}&code=test-code`, item.cookie)));
    expect(raced.map(item => item.headers.get("Location"))).toEqual(["/", "/"]);
    const [racerRows] = await sql`SELECT count(*)::integer AS identities FROM identities WHERE subject=${racer}`;
    expect(racerRows.identities).toBe(1);

    // INV07：续期刷新有效期；手工成员登录不读取、不改写有效期。
    profile = { userId: invited, membership: active(90) };
    expect((await login()).headers.get("Location")).toBe("/");
    const [renewed] = await sql`SELECT access_until FROM product_memberships WHERE owner_id=${member.owner_id}`;
    expect(new Date(renewed.access_until).toISOString()).toBe((profile.membership as any).expiresAt);
    const adminSubject = randomUUID();
    await claimOwner(sql, config, { ownerId: OWNER_ID, issuer: config.oauth!.issuer, subject: adminSubject, operator: "test", confirm: true });
    profile = { userId: adminSubject, membership: null };
    expect((await login()).headers.get("Location")).toBe("/");
    const [admin] = await sql`SELECT access_source,access_until FROM product_memberships WHERE owner_id=${OWNER_ID}`;
    expect(admin).toEqual({ access_source: "manual", access_until: null });

    // INV08：到期后已登录会话下一次请求即被拒，写入路径同样拒绝；重新兑换后可再次登录。
    await sql`UPDATE product_memberships SET access_until=now()-interval '1 second' WHERE owner_id=${member.owner_id}`;
    const expired = await request("/documents", cookie);
    expect(expired.status).toBe(403); expect((await expired.json() as any).error).toBe("access_expired");
    expect((await request("/documents", cookie, "POST", { title: "到期后", body: "不应写入" })).status).toBe(403);
    await expect(sql.begin(transaction => lockOwner(transaction, member.owner_id))).rejects.toMatchObject({ code: "access_expired" });
    profile = { userId: invited, membership: null };
    expect((await login()).headers.get("Location")).toBe("/?auth=membership_required");
    profile = { userId: invited, membership: active(30) };
    const back = await login(); expect(back.headers.get("Location")).toBe("/");
    expect((await request("/documents", sessionCookie(back))).status).toBe(200);

    // INV05：被停用的成员即使会员有效也不会被重新激活。
    await disableMember(sql, { ownerId: member.owner_id, operator: "test", confirm: true });
    expect((await login()).headers.get("Location")).toBe("/?auth=access_denied");
    const [disabled] = await sql`SELECT status FROM product_memberships WHERE owner_id=${member.owner_id}`;
    expect(disabled.status).toBe("disabled");
    expect((await counts()).identities).toBe(3);

    // INV01：迁移在已有数据的库上重启后保持幂等。
    await sql.close(); sql = await openDatabase(databaseUrl!); app = createApp({ ...config, selfProvision: true }, sql);
    const [migration] = await sql`SELECT count(*)::integer AS count FROM schema_migrations WHERE name='0010_invite_access.sql'`;
    expect(migration.count).toBe(1);
  } finally { provider.stop(true); await sql.close(); }
}, 30_000);

test("previews can be discarded, closed reasons are kept and old terminal jobs are pruned", async () => {
  const sql = await freshDatabase();
  const directory = await mkdtemp(join(tmpdir(), "studio-invite-"));
  let discardCalls = 0; let discardSupported = true; let workerConflict = false;
  const workerJobs = new Map<string, any>();
  const worker = Bun.serve({ hostname: "127.0.0.1", port: 0, async fetch(request) {
    const path = new URL(request.url).pathname;
    if (path === "/health") return Response.json({ status: "ok", capabilities: { previewDiscard: discardSupported } });
    const match = path.match(/^\/v1\/jobs\/([^/]+)\/discard$/);
    if (match && request.method === "POST") {
      discardCalls += 1;
      if (workerConflict) return Response.json({ error: "preview_not_ready" }, { status: 409 });
      const job = workerJobs.get(match[1]!);
      return Response.json({ ...job, status: "failed", step: "discarded", error: "preview_discarded" });
    }
    return new Response("missing", { status: 404 });
  } });
  const config: AppConfig = { databaseUrl: databaseUrl!, appOrigin: "http://127.0.0.1:18889", bootstrapSecret: "test-bootstrap-secret-at-least-thirty-two", credentialEncryptionKey: "ab".repeat(32), workerToken: "worker", workerUrl: worker.url.origin, simulation: true, dataDir: directory };
  const app = createApp(config, sql);
  try {
    const loginResponse = await app.request(`${config.appOrigin}/api/auth/login`, { method: "POST", headers: { Origin: config.appOrigin, "Content-Type": "application/json" }, body: JSON.stringify({ secret: config.bootstrapSecret }) });
    const cookie = loginResponse.headers.get("Set-Cookie")!.split(";")[0]!;
    const request = (path: string, method = "GET") => app.request(`${config.appOrigin}/api${path}`, { method, headers: { Cookie: cookie, Origin: config.appOrigin, "Content-Type": "application/json" } });
    const account = await new AccountStore(sql, config).create(OWNER_ID, { label: "测试号", appId: "wx-invite", appSecret: "secret", pat: "pat" });
    const inputHash = "f".repeat(64);
    const preview = async (overrides: Record<string, unknown> = {}) => {
      const doc = randomUUID(); const id = randomUUID(); const workerId = randomUUID(); const body = `正文-${id}`;
      await sql`INSERT INTO documents (id,owner_id,title,body) VALUES (${doc},${OWNER_ID},'标题',${body})`;
      await sql`INSERT INTO jobs (id,owner_id,document_id,document_revision,account_id,worker_account,idempotency_key,title,body,status,step,operation,input_hash,worker_job_id,simulated)
        VALUES (${id},${OWNER_ID},${doc},1,${account.id},${account.id},${`studio:${id}`},'标题',${body},'preview_ready','preview_ready','preview',${inputHash},${workerId},true)`;
      if (Object.keys(overrides).length) await sql`UPDATE jobs SET ${sql(overrides)} WHERE id=${id}`;
      workerJobs.set(workerId, { id: workerId, input: { idempotencyKey: `studio:${id}`, account: account.id, title: "标题", operation: "preview", articleSnapshot: { inputHash } },
        bodyHash: createHash("sha256").update(body).digest("hex"), publicationRequested: false, result: null });
      return { id, workerId };
    };

    // INV10：放弃本人未确认预览，重复调用不再请求 Worker。
    const open = await preview();
    const discarded = await request(`/jobs/${open.id}/discard`, "POST");
    expect(discarded.status).toBe(200);
    expect(await discarded.json()).toMatchObject({ id: open.id, status: "failed", error: "preview_discarded" });
    expect((await request(`/jobs/${open.id}/discard`, "POST")).status).toBe(200);
    expect(discardCalls).toBe(1);
    const confirmed = await preview({ publication_requested: true });
    expect((await (await request(`/jobs/${confirmed.id}/discard`, "POST")).json() as any).error).toBe("preview_already_confirmed");
    const running = await preview({ status: "running" });
    expect((await request(`/jobs/${running.id}/discard`, "POST")).status).toBe(409);
    expect((await request(`/jobs/${randomUUID()}/discard`, "POST")).status).toBe(404);
    const foreignOwner = randomUUID();
    await sql`INSERT INTO owners (id) VALUES (${foreignOwner})`;
    await sql`INSERT INTO product_memberships (owner_id,status,role) VALUES (${foreignOwner},'active','member')`;
    const foreignAccount = await new AccountStore(sql, config).create(foreignOwner, { label: "他人", appId: "wx-foreign", appSecret: "s", pat: "p" });
    const foreignDoc = randomUUID(); const foreignJob = randomUUID();
    await sql`INSERT INTO documents (id,owner_id,title,body) VALUES (${foreignDoc},${foreignOwner},'他人','他人')`;
    await sql`INSERT INTO jobs (id,owner_id,document_id,document_revision,account_id,idempotency_key,title,body,status,operation,worker_job_id,simulated)
      VALUES (${foreignJob},${foreignOwner},${foreignDoc},1,${foreignAccount.id},${randomUUID()},'他人','他人','preview_ready','preview',${randomUUID()},true)`;
    expect((await request(`/jobs/${foreignJob}/discard`, "POST")).status).toBe(404);
    discardSupported = false;
    const unsupported = await preview();
    expect((await (await request(`/jobs/${unsupported.id}/discard`, "POST")).json() as any).error).toBe("worker_preview_discard_unsupported");
    discardSupported = true; workerConflict = true;
    expect((await (await request(`/jobs/${unsupported.id}/discard`, "POST")).json() as any).error).toBe("preview_not_ready");
    workerConflict = false;

    // INV11：Worker 侧过期的预览在产品中保留原因。
    const expiring = await preview();
    const [expiringRow] = await sql`SELECT * FROM jobs WHERE id=${expiring.id}`;
    const synced = await applyWorkerJob(sql, expiringRow, { ...workerJobs.get(expiring.workerId), status: "failed", step: "expired", error: "preview_expired" });
    expect(synced).toMatchObject({ status: "failed", error_code: "preview_expired" });

    // INV12：终态超过 30 天的任务清空大字段，保留身份与草稿结果；其他任务不动，重复执行幂等。
    const old = new Date(Date.now() - 40 * DAY);
    const finished = await preview({ status: "succeeded", draft_media_id: "MEDIA_ID", artifact_manifest: { artifacts: [] }, article_snapshot: { inputHash } });
    await sql`UPDATE jobs SET updated_at=${old} WHERE id IN (${finished.id},${open.id},${running.id})`;
    await sql`UPDATE jobs SET status='unknown' WHERE id=${running.id}`;
    await sql`UPDATE jobs SET updated_at=${old} WHERE id=${running.id}`;
    expect(await pruneTerminalJobs(sql)).toBe(2);
    expect(await pruneTerminalJobs(sql)).toBe(0);
    const [pruned] = await sql`SELECT * FROM jobs WHERE id=${finished.id}`;
    expect(pruned).toMatchObject({ body: "", article_snapshot: null, artifact_manifest: null, draft_media_id: "MEDIA_ID", input_hash: inputHash, idempotency_key: `studio:${finished.id}`, status: "succeeded" });
    expect(new Date(pruned.updated_at).getTime()).toBe(old.getTime());
    const [untouched] = await sql`SELECT body,pruned_at FROM jobs WHERE id=${running.id}`;
    expect(untouched.pruned_at).toBeNull(); expect(untouched.body).not.toBe("");
    const [recent] = await sql`SELECT pruned_at FROM jobs WHERE id=${expiring.id}`;
    expect(recent.pruned_at).toBeNull();
    const artifact = await request(`/jobs/${finished.id}/artifacts/article`);
    expect(artifact.status).toBe(410);
  } finally { worker.stop(true); await sql.close(); await rm(directory, { recursive: true, force: true }); }
}, 30_000);
