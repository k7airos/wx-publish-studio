import { expect, test } from "bun:test";
import { createHash, randomUUID } from "node:crypto";
import { mkdtemp, rm } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { SQL } from "bun";
import { createCanvas } from "@napi-rs/canvas";
import { createArtifactManifest, hashArtifactManifest } from "@akairos/pipeline/article-snapshot";
import { createApp } from "../src/server/app";
import { openDatabase } from "../src/server/db/schema";
import type { AppConfig } from "../src/server/config";
import { BodyAssetStore } from "../src/server/services/body-asset-store";

const databaseUrl = process.env.TEST_DATABASE_URL;
if (!databaseUrl || !/^\/[a-zA-Z0-9_]+_test$/.test(new URL(databaseUrl).pathname)) throw new Error("Preview test requires a disposable *_test database");

test("C1 preview waits across restart, confirms original artifacts once and preserves accepted identity after document edits", async () => {
  const initial = new SQL(databaseUrl);
  await initial.unsafe("DROP TABLE IF EXISTS owner_configuration_defaults,cover_template_assets,account_admin_audit,account_bindings,identity_admin_audit,oauth_pending_states,product_memberships,identities,body_assets,cover_template_revisions,cover_templates,cover_assets,article_style_revisions,article_styles,account_credentials,accounts,app_settings,schema_migrations,jobs,documents,sessions,owners CASCADE");
  await initial.close();
  const directory = await mkdtemp(join(tmpdir(), "studio-preview-"));
  let confirmations = 0; let submissions = 0; let loseConfirm = true; let tamper = false;
  const jobs = new Map<string, any>(); const assets = new Map<string, Buffer>(); const artifacts = new Map<string, Buffer>();
  const sha = (bytes: Buffer) => createHash("sha256").update(bytes).digest("hex");
  const png = await createCanvas(30, 15).encode("png");
  const worker = Bun.serve({ hostname: "127.0.0.1", port: 0, async fetch(request) {
    const url = new URL(request.url); const path = url.pathname;
    if (path === "/health") return Response.json({ capabilities: { jobLookupByIdempotencyKey: true, articleSnapshotSchemaVersions: [1], previewConfirm: true, bodyAssetUpload: true } });
    if (path.startsWith("/v1/accounts/")) return Response.json({ active: true });
    const assetKey = /^\/v1\/assets\/([a-f\d]{64})$/.exec(path)?.[1];
    if (assetKey) { const bytes = Buffer.from(await request.arrayBuffer()); assets.set(assetKey, bytes); return Response.json({ sha256: assetKey, contentType: request.headers.get("Content-Type"), byteLength: bytes.length, width: 30, height: 15 }); }
    if (path === "/v1/jobs/by-idempotency-key") {
      const item = jobs.get(url.searchParams.get("idempotencyKey")!);
      return item && item.input.account === url.searchParams.get("account") ? Response.json(item) : new Response("missing", { status: 404 });
    }
    if (path === "/v1/jobs" && request.method === "POST") {
      const input = await request.json() as any; submissions++;
      if (!jobs.has(input.idempotencyKey)) {
        const id = randomUUID();
        const bodyAsset = input.articleSnapshot?.bodyAssets[0];
        const html = Buffer.from(`<section><p>冻结正文</p><img src="asset:${bodyAsset.id}" alt="原说明" title="原图注"></section>`);
        const mediaKey = `media_${bodyAsset.id}`;
        artifacts.set(`${id}:article`, html); artifacts.set(`${id}:cover`, png); artifacts.set(`${id}:${mediaKey}`, assets.get(bodyAsset.sha256)!);
        const snapshotHash = "b".repeat(64);
        const artifactManifest = createArtifactManifest({ snapshotHash, artifacts: [
          { key: "article", kind: "html", contentType: "text/html", byteLength: html.length, sha256: sha(html) },
          { key: "cover", kind: "cover", contentType: "image/png", byteLength: png.length, sha256: sha(png) },
          { key: mediaKey, kind: "media", contentType: "image/png", byteLength: png.length, sha256: sha(png) },
        ], runtime: { pipeline: "0.22.0", myno: "0.4.0", typeset: "0.4.0" } });
        jobs.set(input.idempotencyKey, { id, input, bodyHash: createHash("sha256").update(input.body).digest("hex"), status: "preview_ready", step: "preview_ready", result: { inputHash: input.articleSnapshot.inputHash, snapshotHash, artifactManifest, artifactManifestHash: hashArtifactManifest(artifactManifest) } });
      }
      return Response.json(jobs.get(input.idempotencyKey));
    }
    const job = [...jobs.values()].find(job => path.startsWith(`/v1/jobs/${job.id}`));
    if (!job) return new Response("missing", { status: 404 });
    if (path.endsWith("/publish")) {
      const input = await request.json() as any;
      if (input.snapshotHash !== job.result.snapshotHash || input.artifactManifestHash !== job.result.artifactManifestHash) return new Response("conflict", { status: 409 });
      if (!job.publicationRequested) { job.publicationRequested = true; confirmations++; job.status = "succeeded"; job.step = "done"; job.result.publishResults = [{ account: job.input.account, status: "success", external_id: "SIMULATED_PREVIEW_DRAFT" }]; }
      if (loseConfirm) { loseConfirm = false; return new Response("accepted response lost", { status: 502 }); }
      return Response.json(job);
    }
    if (path.includes("/artifacts/")) {
      const key = decodeURIComponent(path.split("/artifacts/")[1]!); const bytes = artifacts.get(`${job.id}:${key}`);
      return bytes ? new Response(new Uint8Array(tamper ? Buffer.alloc(bytes.length) : bytes)) : new Response("missing", { status: 404 });
    }
    return Response.json(job);
  } });
  let sql = await openDatabase(databaseUrl);
  const config: AppConfig = { databaseUrl, appOrigin: "http://127.0.0.1:18889", bootstrapSecret: "preview-test-secret-at-least-thirty-two", credentialEncryptionKey: "ab".repeat(32), workerToken: "fake", workerUrl: worker.url.origin, simulation: true, dataDir: directory };
  let app = createApp(config, sql); let cookie = "";
  const request = (path: string, method = "GET", input?: unknown) => app.request(`http://127.0.0.1:18889/api${path}`, { method, headers: { Cookie: cookie, Origin: config.appOrigin, "Content-Type": "application/json" }, ...(input ? { body: JSON.stringify(input) } : {}) });
  try {
    expect((await request("/previews", "POST", {})).status).toBe(401);
    const login = await request("/auth/login", "POST", { secret: config.bootstrapSecret }); cookie = login.headers.get("Set-Cookie")!.split(";")[0];
    const data = new FormData(); data.set("image", new File([new Uint8Array(png)], "body.png", { type: "image/png" }));
    const uploaded = await app.request("http://127.0.0.1:18889/api/assets/body", { method: "POST", headers: { Cookie: cookie, Origin: config.appOrigin }, body: data });
    expect(uploaded.status).toBe(201); const asset = await uploaded.json() as any; expect(asset.width).toBe(30); expect(asset.height).toBe(15);
    const account = await (await request("/accounts", "POST", { label: "连接", appId: "wx-preview", appSecret: "secret", pat: "pat" })).json() as any;
    const doc = await (await request("/documents", "POST", { title: "完整预览", body: `前文\n\n![原说明](${asset.url} "原图注")\n` })).json() as any;
    const input = { documentId: doc.id, revision: doc.revision, accountId: account.id };
    const previewResponse = await request("/previews", "POST", input); expect(previewResponse.status).toBe(201);
    const preview = await previewResponse.json() as any; expect(preview.status).toBe("preview_ready"); expect(preview.publicationRequested).toBe(false); expect(confirmations).toBe(0);
    expect((await request("/jobs", "POST", input)).status).toBe(409);
    const html = await request(`/jobs/${preview.id}/artifacts/article`); expect(html.status).toBe(200); expect(await html.text()).toContain(`asset:${asset.id}`);
    expect(html.headers.get("Content-Security-Policy")).toContain("sandbox");
    expect((await request(`/jobs/${preview.id}/artifacts/other`)).status).toBe(404);
    tamper = true; expect((await request(`/jobs/${preview.id}/artifacts/article`)).status).toBe(502); tamper = false;
    await sql.close(); sql = await openDatabase(databaseUrl); app = createApp(config, sql);
    expect((await (await request(`/jobs/${preview.id}`)).json() as any).status).toBe("preview_ready"); expect(confirmations).toBe(0); expect(submissions).toBe(1);
    const confirmedInput = { snapshotHash: preview.snapshotHash, artifactManifestHash: preview.artifactManifestHash };
    const unknown = await (await request(`/jobs/${preview.id}/publish`, "POST", confirmedInput)).json() as any;
    expect(unknown.status).toBe("unknown"); expect(unknown.publicationRequested).toBe(true); expect(confirmations).toBe(1);
    await request(`/documents/${doc.id}`, "PUT", { expectedRevision: doc.revision, title: doc.title, body: "确认后继续编辑" });
    const repeated = await Promise.all([request(`/jobs/${preview.id}/publish`, "POST", confirmedInput), request(`/jobs/${preview.id}/publish`, "POST", confirmedInput)]);
    for (const response of repeated) { expect(response.status).toBe(200); const job = await response.json() as any; expect(job.id).toBe(preview.id); expect(job.status).toBe("succeeded"); }
    expect(confirmations).toBe(1); expect(submissions).toBe(1);
    expect((await request(`/jobs/${preview.id}/publish`, "POST", { ...confirmedInput, snapshotHash: "c".repeat(64) })).status).toBe(409);
    const secondDoc = await (await request("/documents", "POST", { title: "冲突", body: `![说明](${asset.url})` })).json() as any;
    const second = await (await request("/previews", "POST", { documentId: secondDoc.id, revision: secondDoc.revision, accountId: account.id })).json() as any;
    await request(`/documents/${secondDoc.id}`, "PUT", { expectedRevision: secondDoc.revision, title: "新修订", body: secondDoc.body });
    expect((await request(`/jobs/${second.id}/publish`, "POST", { snapshotHash: second.snapshotHash, artifactManifestHash: second.artifactManifestHash })).status).toBe(409); expect(confirmations).toBe(1);
    const foreignOwner = randomUUID(); await sql`INSERT INTO owners(id) VALUES (${foreignOwner})`;
    const foreign = await new BodyAssetStore(sql, directory).save(foreignOwner, png, "image/png");
    expect((await request(`/assets/body/${foreign.id}`)).status).toBe(400);
    const external = await (await request("/documents", "POST", { title: "外图", body: "![外图](https://other.invalid/image.png)" })).json() as any;
    expect((await request("/previews", "POST", { documentId: external.id, revision: external.revision, accountId: account.id })).status).toBe(400);
    const [stored] = await sql`SELECT * FROM jobs WHERE id=${preview.id}`;
    expect(stored.body).toContain(`asset:${asset.id}`); expect(stored.article_snapshot.inputHash).toBe(preview.inputHash); expect(stored.account_revision).toBe(1);
  } finally { worker.stop(true); await sql.close(); await rm(directory, { recursive: true, force: true }); }
}, 20_000);
