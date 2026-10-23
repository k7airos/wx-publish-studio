import { ARTICLE_COVER_FONT } from "@akairos/typeset-studio/cover";
import { expect, test } from "bun:test";
import { createHash, randomUUID } from "node:crypto";
import { SQL } from "bun";
import { createArtifactManifest, hashArtifactManifest } from "@akairos/pipeline/article-snapshot";
import { createApp } from "../src/server/app";
import { openDatabase, OWNER_ID } from "../src/server/db/schema";
import { AccountStore } from "../src/server/services/account-store";
import { administerAccount } from "../src/server/auth/account-admin";
import { issueSession } from "../src/server/auth/session";
import type { AppConfig } from "../src/server/config";

const databaseUrl = process.env.TEST_DATABASE_URL;
if (!databaseUrl || !/^\/[a-zA-Z0-9_]+_test$/.test(new URL(databaseUrl).pathname)) throw new Error("Account lifecycle requires a dedicated *_test database");

test("2B AppID reservation, historical read-only handoff, unknown lookup and confirm/pause linearization", async () => {
  const initial = new SQL(databaseUrl);
  await initial.unsafe("DROP TABLE IF EXISTS owner_configuration_defaults,cover_template_assets,account_admin_audit,account_bindings,identity_admin_audit,oauth_pending_states,product_memberships,identities,body_assets,cover_template_revisions,cover_templates,cover_assets,article_style_revisions,article_styles,account_credentials,accounts,app_settings,schema_migrations,jobs,documents,sessions,owners CASCADE"); await initial.close();
  const sql = await openDatabase(databaseUrl); const b = randomUUID(); const other = randomUUID();
  for (const id of [b, other]) { await sql`INSERT INTO owners (id) VALUES (${id})`; await sql`INSERT INTO product_memberships (owner_id,status,role) VALUES (${id},'active','member')`; }
  const jobs = new Map<string, any>(); let writes = 0; let loseSubmit = false; let loseConfirm = false; let lateAcceptance = false;
  let confirmEntered: (() => void) | undefined; let continueConfirm: Promise<void> | undefined;
  const worker = Bun.serve({ hostname: "127.0.0.1", port: 0, async fetch(request) {
    const url = new URL(request.url); const path = url.pathname;
    if (path === "/health") return Response.json({ capabilities: { articleStyleSchemaVersions: [1], coverSnapshotSchemaVersions: [1], articleCoverFonts: [ARTICLE_COVER_FONT], jobLookupByIdempotencyKey: true, articleSnapshotSchemaVersions: [1], previewConfirm: true, bodyAssetUpload: true } });
    if (path.startsWith("/v1/accounts/")) { writes++; return Response.json({ active: true }); }
    if (path === "/v1/jobs/by-idempotency-key") {
      const job = jobs.get(url.searchParams.get("idempotencyKey")!);
      return job && job.input.account === url.searchParams.get("account") ? Response.json(job) : new Response("missing", { status: 404 });
    }
    if (path === "/v1/jobs" && request.method === "POST") {
      writes++; const input = await request.json() as any; const id = randomUUID(); const snapshotHash = "a".repeat(64);
      const manifest = createArtifactManifest({ snapshotHash, artifacts: [{ key: "article", kind: "html", contentType: "text/html", byteLength: 1, sha256: "b".repeat(64) }, { key: "cover", kind: "cover", contentType: "image/png", byteLength: 1, sha256: "c".repeat(64) }], runtime: { pipeline: "0.23.0", myno: "0.4.1", typeset: "0.4.0" } });
      const job = { id, input, bodyHash: createHash("sha256").update(input.body).digest("hex"), status: input.operation ? "preview_ready" : "queued", step: input.operation ? "preview_ready" : "queued", publicationRequested: false,
        result: input.operation ? { inputHash: input.articleSnapshot.inputHash, snapshotHash, artifactManifest: manifest, artifactManifestHash: hashArtifactManifest(manifest) } : {} };
      jobs.set(input.idempotencyKey, job);
      if (loseSubmit) { loseSubmit = false; return new Response("lost", { status: 502 }); }
      return Response.json(job);
    }
    const job = [...jobs.values()].find(job => path.startsWith(`/v1/jobs/${job.id}`));
    if (!job) return new Response("missing", { status: 404 });
    if (path.endsWith("/publish")) {
      writes++; confirmEntered?.(); if (continueConfirm) await continueConfirm;
      if (lateAcceptance) return new Response("request still pending elsewhere", { status: 502 });
      job.publicationRequested = true; job.status = "queued"; job.step = "queued";
      if (loseConfirm) { loseConfirm = false; return new Response("lost", { status: 502 }); }
    }
    return Response.json(job);
  } });
  const config: AppConfig = { databaseUrl, appOrigin: "http://127.0.0.1:18889", bootstrapSecret: "account-test-thirty-two-characters-bootstrap", workerUrl: worker.url.origin, workerToken: "fake", credentialEncryptionKey: "ab".repeat(32), simulation: true };
  const app = createApp(config, sql); const session = await issueSession(sql, OWNER_ID, "bootstrap");
  const request = (path: string, method = "GET", input?: unknown) => app.request(`${config.appOrigin}/api${path}`, { method, headers: { Cookie: `studio_session=${session.token}`, Origin: config.appOrigin, "Content-Type": "application/json" }, ...(input ? { body: JSON.stringify(input) } : {}) });
  const store = new AccountStore(sql, config); const controlled = { operator: "test", confirm: true };
  const fields = { label: "古一", appId: "wx-physical-one", appSecret: "a-secret", pat: "a-only-pat" };
  try {
    const a = await store.create(OWNER_ID, fields);
    const [before] = await sql`SELECT * FROM account_credentials WHERE account_id=${a.id}`;
    const historicDoc = await (await request("/documents", "POST", { title: "交接前预览", body: "历史冻结产物" })).json() as any;
    const historic = await (await request("/previews", "POST", { documentId: historicDoc.id, revision: 1, accountId: a.id })).json() as any;
    expect(historic.status).toBe("preview_ready");
    await expect(store.create(b, { ...fields, pat: "b-only-pat" })).rejects.toMatchObject({ code: "account_app_id_reserved" });
    await store.deactivate(OWNER_ID, a.id);
    await expect(store.create(b, { ...fields, pat: "b-only-pat" })).rejects.toMatchObject({ code: "account_app_id_reserved" });
    await administerAccount(sql, "pause-account", { ...controlled, accountId: a.id });
    await administerAccount(sql, "release-account", { ...controlled, accountId: a.id, targetOwnerId: b });
    await expect(store.create(other, fields)).rejects.toMatchObject({ code: "account_app_id_reserved" });
    await expect(store.update(OWNER_ID, a.id, { label: "不能改", expectedVersion: 3, pat: "overwrite" })).rejects.toMatchObject({ code: "account_authorization_released" });
    const writesBefore = writes;
    expect((await request(`/accounts/${a.id}/sync`, "POST")).status).toBe(400); expect(writes).toBe(writesBefore);
    const bound = await store.create(b, { ...fields, pat: "b-only-pat" });
    expect((await store.credentials(b, bound.id)).pat).toBe("b-only-pat");
    await administerAccount(sql, "pause-account", { ...controlled, accountId: bound.id });
    await administerAccount(sql, "release-account", { ...controlled, accountId: bound.id, targetOwnerId: OWNER_ID, restoreAccountId: a.id });
    const [after] = await sql`SELECT * FROM account_credentials WHERE account_id=${a.id}`; expect(after.encrypted_secret).toBe(before.encrypted_secret); expect(after.worker_account).toBe(before.worker_account);
    const historicWrites = writes;
    const denied = await request(`/jobs/${historic.id}/publish`, "POST", { snapshotHash: historic.snapshotHash, artifactManifestHash: historic.artifactManifestHash });
    expect(denied.status).toBe(400); expect(writes).toBe(historicWrites);
    const historicRead = await (await request(`/jobs/${historic.id}`)).json() as any; expect(historicRead.authorizationRevoked).toBe(true); expect(historicRead.artifactManifestHash).toBe(historic.artifactManifestHash);
    await request(`/documents/${historicDoc.id}`, "PUT", { title: historicDoc.title, body: "明确新修订", expectedRevision: 1 });
    expect((await (await request("/previews", "POST", { documentId: historicDoc.id, revision: 2, accountId: a.id })).json() as any).status).toBe("preview_ready");

    const doc = await (await request("/documents", "POST", { title: "unknown恢复", body: "原文" })).json() as any;
    loseSubmit = true;
    const unknown = await (await request("/jobs", "POST", { documentId: doc.id, revision: 1, accountId: a.id })).json() as any; expect(unknown.status).toBe("unknown");
    await store.deactivate(OWNER_ID, a.id); const originalWrites = writes;
    const restored = await (await request("/jobs", "POST", { documentId: doc.id, revision: 1, accountId: a.id })).json() as any; expect(restored.status).toBe("queued"); expect(writes).toBe(originalWrites);
    const [job] = await sql`SELECT * FROM jobs WHERE id=${restored.id}`;
    const original = jobs.get(job.idempotency_key); original.input.account = "wrong";
    expect((await (await request(`/jobs/${restored.id}`)).json() as any).status).toBe("unknown"); expect(writes).toBe(originalWrites); original.input.account = job.worker_account;
    await administerAccount(sql, "pause-account", { ...controlled, accountId: a.id });
    await expect(administerAccount(sql, "release-account", { ...controlled, accountId: a.id, targetOwnerId: b })).rejects.toMatchObject({ code: "account_handoff_pending_jobs" });
    original.status = "failed"; await request(`/jobs/${restored.id}`);
    await administerAccount(sql, "release-account", { ...controlled, accountId: a.id, targetOwnerId: b });
    await administerAccount(sql, "release-account", { ...controlled, accountId: a.id, targetOwnerId: OWNER_ID, restoreAccountId: a.id });

    const previewDoc = await (await request("/documents", "POST", { title: "确认竞态", body: "冻结正文" })).json() as any;
    const preview = await (await request("/previews", "POST", { documentId: previewDoc.id, revision: 1, accountId: a.id })).json() as any; expect(preview.status).toBe("preview_ready");
    let resume!: () => void; const entered = new Promise<void>(resolve => { confirmEntered = resolve; }); continueConfirm = new Promise<void>(resolve => { resume = resolve; }); loseConfirm = true;
    const confirming = request(`/jobs/${preview.id}/publish`, "POST", { snapshotHash: preview.snapshotHash, artifactManifestHash: preview.artifactManifestHash });
    await entered;
    let paused = false; const pausing = administerAccount(sql, "pause-account", { ...controlled, accountId: a.id }).then(() => { paused = true; });
    await Bun.sleep(20); expect(paused).toBe(false); resume();
    const lost = await (await confirming).json() as any; expect(lost.status).toBe("unknown"); await pausing;
    const beforeRecovery = writes;
    const confirmed = await (await request(`/jobs/${preview.id}/publish`, "POST", { snapshotHash: preview.snapshotHash, artifactManifestHash: preview.artifactManifestHash })).json() as any;
    expect(confirmed.status).toBe("queued"); expect(writes).toBe(beforeRecovery);
    const [accepted] = await sql`SELECT * FROM jobs WHERE id=${preview.id}`; expect(accepted.worker_publication_requested).toBe(true); expect(accepted.publication_requested).toBe(true);
    await expect(administerAccount(sql, "release-account", { ...controlled, accountId: a.id, targetOwnerId: b })).rejects.toMatchObject({ code: "account_handoff_pending_jobs" });
    jobs.get(accepted.idempotency_key).status = "failed"; await request(`/jobs/${preview.id}`);
    await administerAccount(sql, "release-account", { ...controlled, accountId: a.id, targetOwnerId: b });
    await administerAccount(sql, "release-account", { ...controlled, accountId: a.id, targetOwnerId: OWNER_ID, restoreAccountId: a.id });
    continueConfirm = undefined; confirmEntered = undefined; lateAcceptance = true;
    const lateDoc = await (await request("/documents", "POST", { title: "迟到接受", body: "冻结正文2" })).json() as any;
    const late = await (await request("/previews", "POST", { documentId: lateDoc.id, revision: 1, accountId: a.id })).json() as any;
    const hashes = { snapshotHash: late.snapshotHash, artifactManifestHash: late.artifactManifestHash };
    expect((await (await request(`/jobs/${late.id}/publish`, "POST", hashes)).json() as any).status).toBe("unknown");
    const lateWrites = writes;
    expect((await (await request(`/jobs/${late.id}`)).json() as any).status).toBe("unknown");
    await administerAccount(sql, "pause-account", { ...controlled, accountId: a.id });
    expect((await (await request(`/jobs/${late.id}/publish`, "POST", hashes)).json() as any).status).toBe("unknown"); expect(writes).toBe(lateWrites);
    await expect(administerAccount(sql, "release-account", { ...controlled, accountId: a.id, targetOwnerId: b })).rejects.toMatchObject({ code: "account_handoff_pending_jobs" });
    const [lateStored] = await sql`SELECT idempotency_key FROM jobs WHERE id=${late.id}`;
    const lateWorker = jobs.get(lateStored.idempotency_key); lateWorker.publicationRequested = true; lateWorker.status = "queued";
    expect((await (await request(`/jobs/${late.id}/publish`, "POST", hashes)).json() as any).status).toBe("queued"); expect(writes).toBe(lateWrites);
  } finally { worker.stop(true); await sql.close(); }
}, 30_000);
