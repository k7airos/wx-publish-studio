import { coverSnapshotIdentity } from "@akairos/pipeline/cover-snapshot";
import { ARTICLE_COVER_FONT } from "@akairos/typeset-studio/cover";
import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { createHash, randomUUID } from "node:crypto";
import { SQL } from "bun";
import { createApp } from "../src/server/app";
import { openDatabase, type Database } from "../src/server/db/schema";
import type { AppConfig } from "../src/server/config";
import { AccountStore, initializeAccounts } from "../src/server/services/account-store";

const databaseUrl = process.env.TEST_DATABASE_URL;
if (!databaseUrl) throw new Error("TEST_DATABASE_URL must point to a disposable PostgreSQL database");
if (!/^\/[a-zA-Z0-9_]+_test$/.test(new URL(databaseUrl).pathname)) {
  throw new Error("Refusing destructive setup outside an explicit *_test database");
}
const workerToken = "test-only-worker-token-never-return";
const bootstrapSecret = "test-only-bootstrap-secret-never-return-32";
const appSecret = "test-only-app-secret-never-return";
const pat = "test-only-relay-pat-never-return";
const workerJobs = new Map<string, any>();
const submissions: any[] = [];
const registrations: any[] = [];
const registeredSecrets = new Map<string, any>();
let loseNextResponse = false;
let nextStatus = "queued";
let includeDraft = true;
let failRegistration = false;
let worker: ReturnType<typeof Bun.serve>;
let sql: Database;
let app: ReturnType<typeof createApp>;
let cookie = "";
let config: AppConfig;
let document: any;
let firstJob: any;

function request(path: string, method = "GET", body?: unknown, authenticated = true, origin = "http://127.0.0.1:18889") {
  return app.request(`http://127.0.0.1:18889/api${path}`, {
    method, headers: { "Content-Type": "application/json", Origin: origin, ...(authenticated ? { Cookie: cookie } : {}) },
    ...(body !== undefined ? { body: JSON.stringify(body) } : {}),
  });
}
async function postJob(doc = document) {
  return request("/jobs", "POST", { documentId: doc.id, revision: doc.revision, accountId: "writing" });
}

beforeAll(async () => {
  const initial = new SQL(databaseUrl!);
  await initial.unsafe("DROP TABLE IF EXISTS owner_configuration_defaults,cover_template_assets,account_admin_audit,account_bindings,identity_admin_audit,oauth_pending_states,product_memberships,identities,body_assets,cover_template_revisions,cover_templates,cover_assets,article_style_revisions,article_styles,account_credentials,accounts,app_settings,schema_migrations,jobs,documents,sessions,owners CASCADE");
  await initial.close();
  worker = Bun.serve({ hostname: "127.0.0.1", port: 0, async fetch(request) {
    if (request.headers.get("Authorization") !== `Bearer ${workerToken}`) return new Response("Unauthorized", { status: 401 });
    const url = new URL(request.url); const path = url.pathname;
    if (path === "/health") return Response.json({ capabilities: { articleStyleSchemaVersions: [1], coverSnapshotSchemaVersions: [1], articleCoverFonts: [ARTICLE_COVER_FONT], jobLookupByIdempotencyKey: true } });
    if (path.startsWith("/v1/accounts/") && request.method === "PUT") {
      const credentials = await request.json();
      registrations.push(credentials);
      registeredSecrets.set(decodeURIComponent(path.slice("/v1/accounts/".length)), credentials);
      if (failRegistration) return new Response("unavailable", { status: 503 });
      return Response.json({ account: "writing", active: true });
    }
    if (path === "/v1/jobs/by-idempotency-key") {
      const item = workerJobs.get(url.searchParams.get("idempotencyKey")!);
      return item && item.input.account === url.searchParams.get("account") ? Response.json(item) : new Response("missing", { status: 404 });
    }
    if (path === "/v1/jobs" && request.method === "POST") {
      const input = await request.json() as any;
      submissions.push(input);
      let job = workerJobs.get(input.idempotencyKey);
      if (!job) {
        job = {
          id: randomUUID(), status: nextStatus, step: nextStatus === "succeeded" ? "done" : nextStatus,
          statePath: "/private/worker/secret/workflow-state.json", error: `raw error contains ${pat}`,
          input: { ...input, title: input.title.trim(), pat, appSecret }, bodyHash: createHash("sha256").update(input.body).digest("hex"),
          result: { ...(nextStatus === "succeeded" && input.articleStyle ? { articleStyleHash: input.articleStyle.hash, articleThemeHash: "a".repeat(64) } : {}), ...(nextStatus === "succeeded" && input.coverSnapshot ? coverSnapshotIdentity(input.coverSnapshot) : {}), publishResults: includeDraft ? [{ account: input.account, status: "success", external_id: "SIMULATED_DRAFT_ID", ...(input.articleStyle ? { article_theme_hash: "a".repeat(64) } : {}) }] : [] },
        };
        workerJobs.set(input.idempotencyKey, job);
      }
      if (loseNextResponse) {
        loseNextResponse = false;
        return new Response("lost response after accepted", { status: 502 });
      }
      return Response.json(job, { status: 202 });
    }
    const job = [...workerJobs.values()].find(job => path === `/v1/jobs/${job.id}`);
    return job ? Response.json(job) : new Response("missing", { status: 404 });
  } });
  config = {
    databaseUrl: databaseUrl!, bootstrapSecret, appOrigin: "http://127.0.0.1:18889",
    workerUrl: worker.url.origin, workerToken, simulation: true, credentialEncryptionKey: "ab".repeat(32), importAccountsOnce: true,
    accounts: [{ id: "writing", label: "测试公众号", appId: "wx-test", appSecret, pat }],
  };
  sql = await openDatabase(databaseUrl!);
  await initializeAccounts(sql, config);
  app = createApp(config, sql);
});

afterAll(async () => { worker?.stop(true); await sql?.close(); });

describe("1A-R1 application contract against a fake Worker (not WeChat)", () => {
  test("A1 protects documents, jobs and accounts; login sets HttpOnly SameSite cookie", async () => {
    for (const path of ["/documents", "/jobs", "/accounts"]) expect((await request(path, "GET", undefined, false)).status).toBe(401);
    expect((await request("/auth/login", "POST", { secret: "wrong" }, false)).status).toBe(401);
    const response = await request("/auth/login", "POST", { secret: bootstrapSecret }, false);
    const header = response.headers.get("Set-Cookie")!;
    expect(header).toContain("HttpOnly"); expect(header).toContain("SameSite=Strict");
    cookie = header.split(";")[0];
    expect(await (await request("/auth/session")).json()).toEqual({ authenticated: true, simulation: true, displayName: null, accessUntil: null, role: "admin", relayManaged: false, whitelistIp: null, copyMode: "neutral" });
    expect((await request("/documents", "POST", { title: "x", body: "x" }, true, "https://other.example")).status).toBe(403);
  });

  test("A2 saves exact title and Markdown bytes, optimistic revision and unchanged save", async () => {
    const input = { title: "  中文标题 👋  ", body: "## 原文\r\n\r\n| 长表头不换行 | B |\r\n| --- | --- |\r\n| 文字  | **保留** |\r\n\n尾部空行\n\n" };
    document = await (await request("/documents", "POST", input)).json();
    expect(document.title).toBe(input.title); expect(document.body).toBe(input.body);
    const unchanged = await (await request(`/documents/${document.id}`, "PUT", { ...input, expectedRevision: 1 })).json();
    expect(unchanged.revision).toBe(1);
    expect(await (await request(`/documents/${document.id}`)).json()).toEqual(unchanged);
    expect((await request(`/documents/${document.id}`, "PUT", { ...input, expectedRevision: 0 })).status).toBe(409);
  });

  test("A3 whitelist rejects foreign accounts without any Worker request", async () => {
    const before = registrations.length + submissions.length;
    expect((await request("/jobs", "POST", { documentId: document.id, revision: 1, accountId: "foreign" })).status).toBe(400);
    expect(registrations.length + submissions.length).toBe(before);
    const bindings = await (await request("/accounts")).json();
    expect(bindings.accounts[0]).toMatchObject({ id: "writing", label: "测试公众号", appId: "wx-test", active: true });
    expect(JSON.stringify(bindings)).not.toContain(appSecret); expect(JSON.stringify(bindings)).not.toContain(pat);
  });

  test("R2 online credentials are encrypted, blank fields preserve secrets, appId is stable and imports run once", async () => {
    const createdResponse = await request("/accounts", "POST", { label: "新增连接", appId: "wx-online", appSecret: "online-secret", pat: "online-pat" });
    expect(createdResponse.status).toBe(201);
    const created = await createdResponse.json();
    const [stored] = await sql`SELECT encrypted_secret FROM account_credentials WHERE account_id=${created.id}`;
    expect(stored.encrypted_secret).not.toContain("online-secret"); expect(stored.encrypted_secret).not.toContain("online-pat");
    const updated = await (await request(`/accounts/${created.id}`, "PUT", { label: "新标签", appId: created.appId, appSecret: "", pat: "", expectedVersion: created.version })).json();
    expect(updated.credentialRevision).toBe(1);
    const store = new AccountStore(sql, config);
    expect((await store.credentials("00000000-0000-4000-8000-000000000001", created.id)).appSecret).toBe("online-secret");
    expect((await request(`/accounts/${created.id}`, "PUT", { label: "更换公众号", appId: "wx-other", expectedVersion: updated.version })).status).toBe(400);
    await initializeAccounts(sql, config);
    const [legacyCount] = await sql`SELECT count(*)::integer AS count FROM accounts WHERE id='writing'`;
    expect(legacyCount.count).toBe(1);
    const rotated = await (await request(`/accounts/${created.id}`, "PUT", { label: "新标签", appSecret: "rotated-secret", expectedVersion: updated.version })).json();
    expect(rotated.credentialRevision).toBe(2);
    const one = await store.credentials("00000000-0000-4000-8000-000000000001", created.id, 1);
    const two = await store.credentials("00000000-0000-4000-8000-000000000001", created.id, 2);
    expect(one.workerAccount).not.toBe(two.workerAccount);
    expect(one.appSecret).toBe("online-secret"); expect(two.appSecret).toBe("rotated-secret");
    expect((await request(`/accounts/${created.id}/sync`, "POST")).status).toBe(200);
    const [countBefore] = await sql`SELECT count(*)::integer AS count FROM jobs`;
    failRegistration = true;
    const failedRegistrationJob = await (await request("/jobs", "POST", { documentId: document.id, revision: document.revision, accountId: created.id })).json();
    expect(failedRegistrationJob.status).toBe("unknown");
    const [countAfter] = await sql`SELECT count(*)::integer AS count FROM jobs`;
    expect(countAfter.count).toBe(countBefore.count + 1);
    failRegistration = false;
    document = await (await request(`/documents/${document.id}`, "PUT", { title: document.title, body: document.body + "新提交", expectedRevision: document.revision })).json();
    const queued = await (await request("/jobs", "POST", { documentId: document.id, revision: document.revision, accountId: created.id })).json();
    const queuedInput = submissions.at(-1);
    const newer = await (await request(`/accounts/${created.id}`, "PUT", { label: "新标签", appSecret: "third-secret", expectedVersion: rotated.version })).json();
    const [frozen] = await sql`SELECT account_revision,worker_account FROM jobs WHERE id=${queued.id}`;
    expect(frozen.account_revision).toBe(2); expect(frozen.worker_account).toBe(queuedInput.account);
    expect((await store.credentials("00000000-0000-4000-8000-000000000001", created.id, newer.credentialRevision)).workerAccount).not.toBe(frozen.worker_account);
    expect((await (await request(`/accounts/${created.id}`, "DELETE")).json()).active).toBe(false);
    expect((await (await request(`/jobs/${queued.id}`)).json()).id).toBe(queued.id);
    const fresh = await (await request("/documents", "POST", { title: "停用新任务", body: "正文" })).json();
    expect((await request("/jobs", "POST", { documentId: fresh.id, revision: fresh.revision, accountId: created.id })).status).toBe(400);
  });

  test("A4/A5 concurrent submissions register account and reuse one immutable job", async () => {
    await sql`UPDATE jobs SET status='failed' WHERE status IN ('queued','unknown')`;
    const responses = await Promise.all(Array.from({ length: 12 }, () => postJob()));
    const results = await Promise.all(responses.map(response => response.json()));
    const [first, second] = results;
    firstJob = first;
    expect(first.id).toBe(second.id);
    expect(new Set(results.map(item => item.id)).size).toBe(1);
    expect(registrations.length).toBeGreaterThan(0);
    expect(registrations).toContainEqual({ appId: "wx-test", appSecret, pat });
    const writing = submissions.filter(input => input.account === "writing");
    expect(writing[0]).toMatchObject({ title: document.title, body: document.body, contentForm: "article", account: "writing" });
    expect(new Set(writing.map(input => input.idempotencyKey)).size).toBe(1);
    expect(first.documentRevision).toBe(document.revision);
    const [row] = await sql`SELECT * FROM jobs WHERE id=${first.id}`;
    expect(row.body).toBe(document.body); expect(row.document_id).toBe(document.id);
  });

  test("A5 accepted but response lost stays unknown; retry uses same key and same Worker job", async () => {
    document = await (await request(`/documents/${document.id}`, "PUT", { title: document.title, body: document.body + "修订", expectedRevision: document.revision })).json();
    loseNextResponse = true;
    const unknown = await (await postJob()).json();
    expect(unknown.status).toBe("unknown"); expect(unknown.error).toBe("worker_unavailable");
    const key = submissions.at(-1).idempotencyKey;
    const count = workerJobs.size;
    const original = { ...document };
    app = createApp({ ...config, simulation: false }, sql);
    const submissionCount = submissions.length;
    expect((await postJob(original)).status).toBe(409);
    expect((await (await request(`/jobs/${unknown.id}`)).json()).error).toBe("execution_environment_mismatch");
    expect(submissions.length).toBe(submissionCount);
    app = createApp(config, sql);
    document = await (await request(`/documents/${document.id}`, "PUT", { title: "后续修订", body: document.body + "新内容", expectedRevision: document.revision })).json();
    const restored = await (await postJob(original)).json();
    expect(restored.id).toBe(unknown.id); expect(restored.status).toBe("queued");
    expect(submissions.at(-1).idempotencyKey).toBe(key); expect(workerJobs.size).toBe(count);
    expect(submissions.at(-1).title).toBe(original.title); expect(submissions.at(-1).body).toBe(original.body);
  });

  test("R2 original unknown job keeps its body, secrets and Worker key after PAT rotation, document revision and deactivation", async () => {
    await sql`UPDATE jobs SET status='failed' WHERE status IN ('queued','unknown')`;
    const account = await (await request("/accounts", "POST", { label: "恢复连接", appId: "wx-recovery", appSecret: "original-secret", pat: "original-pat" })).json();
    const original = await (await request("/documents", "POST", { title: "原始标题", body: "## 原始正文\n\n不可重绑的文章\n" })).json();
    const input = { documentId: original.id, revision: original.revision, accountId: account.id };
    loseNextResponse = true;
    const unknown = await (await request("/jobs", "POST", input)).json();
    expect(unknown.status).toBe("unknown");
    const submitted = { ...submissions.at(-1) };
    const workerCount = workerJobs.size;
    const workerId = workerJobs.get(submitted.idempotencyKey).id;
    const rotated = await (await request(`/accounts/${account.id}`, "PUT", { label: account.label, appSecret: "", pat: "updated-pat", expectedVersion: account.version })).json();
    expect(rotated.credentialRevision).toBe(2);
    const credentials = await new AccountStore(sql, config).credentials("00000000-0000-4000-8000-000000000001", account.id, 2);
    expect(credentials.appSecret).toBe("original-secret"); expect(credentials.pat).toBe("updated-pat");
    await request(`/accounts/${account.id}/sync`, "POST");
    await request(`/documents/${original.id}`, "PUT", { title: "后续标题", body: "完全不同的新正文", expectedRevision: original.revision });
    expect((await (await request(`/accounts/${account.id}`, "DELETE")).json()).active).toBe(false);
    const restored = await (await request("/jobs", "POST", input)).json();
    expect(restored.id).toBe(unknown.id); expect(restored.status).toBe("queued");
    expect(submissions.at(-1)).toEqual(submitted);
    expect(submissions.at(-1).body).toBe(original.body);
    expect(registeredSecrets.get(submitted.account)).toEqual({ appId: "wx-recovery", appSecret: "original-secret", pat: "original-pat" });
    expect(submitted.account).not.toBe(credentials.workerAccount);
    expect(workerJobs.size).toBe(workerCount); expect(workerJobs.get(submitted.idempotencyKey).id).toBe(workerId);
    const [stored] = await sql`SELECT worker_job_id,account_revision,worker_account,idempotency_key FROM jobs WHERE id=${restored.id}`;
    expect(stored.worker_job_id).toBe(workerId); expect(stored.account_revision).toBe(1);
    expect(stored.worker_account).toBe(submitted.account); expect(stored.idempotency_key).toBe(submitted.idempotencyKey);
  });

  test("A2/A5 application and database connection restart preserve document, key and original task", async () => {
    const [before] = await sql`SELECT idempotency_key FROM jobs WHERE id=${firstJob.id}`;
    await sql.close(); sql = await openDatabase(databaseUrl!); app = createApp(config, sql);
    const restored = await (await request(`/documents/${document.id}`)).json();
    expect(restored.body).toBe(document.body); expect(restored.revision).toBe(document.revision);
    const count = submissions.length;
    const original = await (await request(`/jobs/${firstJob.id}`)).json();
    expect(original.id).toBe(firstJob.id); expect(submissions.length).toBe(count);
    const [after] = await sql`SELECT idempotency_key FROM jobs WHERE id=${firstJob.id}`;
    expect(after.idempotency_key).toBe(before.idempotency_key);
  });

  test("A6 DTO whitelist omits credentials/paths and rejects success without draft identity", async () => {
    await sql`UPDATE jobs SET status='failed' WHERE status IN ('queued','unknown')`;
    nextStatus = "succeeded"; includeDraft = false;
    const doc = await (await request("/documents", "POST", { title: "缺草稿身份", body: "正文" })).json();
    const missing = await (await postJob(doc)).json();
    expect(missing.status).toBe("unknown"); expect(missing.draftMediaId).toBeNull();
    const json = JSON.stringify(missing);
    for (const secret of [bootstrapSecret, workerToken, appSecret, pat, "statePath", "/private/", "requestHash", "idempotencyKey"]) expect(json).not.toContain(secret);
    await sql`UPDATE jobs SET status='failed' WHERE status='unknown'`;
    includeDraft = true;
    const complete = await (await request("/documents", "POST", { title: "模拟成功", body: "正文" })).json();
    const success = await (await postJob(complete)).json();
    expect(success.status).toBe("succeeded"); expect(success.draftMediaId).toBe("SIMULATED_DRAFT_ID"); expect(success.simulated).toBe(true);
    app = createApp({ ...config, simulation: false }, sql);
    expect((await (await request(`/jobs/${success.id}`)).json()).simulated).toBe(true);
    app = createApp(config, sql);
    for (const status of ["failed", "interrupted"]) {
      nextStatus = status;
      const draft = await (await request("/documents", "POST", { title: status, body: "正文" })).json();
      const dto = await (await postJob(draft)).json();
      expect(dto.status).toBe(status);
      // 失败原因带到任务 DTO，但令牌类长串已被脱敏。
      if (status === "failed") { expect(dto.errorDetail).toBe("raw error contains [已隐藏]"); expect(dto.errorHint).toBeNull(); expect(JSON.stringify(dto)).not.toContain(pat); }
    }
  });
});
