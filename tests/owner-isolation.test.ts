import { expect, test } from "bun:test";
import { randomUUID, createHash } from "node:crypto";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { SQL } from "bun";
import { createCanvas } from "@napi-rs/canvas";
import { ARTICLE_COVER_FONT, DEFAULT_ARTICLE_COVER_CONTROLS } from "@akairos/typeset-studio/cover";
import { createApp } from "../src/server/app";
import { openDatabase, OWNER_ID } from "../src/server/db/schema";
import { addMember, disableMember } from "../src/server/auth/access";
import { issueSession } from "../src/server/auth/session";
import { AccountStore } from "../src/server/services/account-store";
import { BodyAssetStore } from "../src/server/services/body-asset-store";
import { AssetStore } from "../src/server/services/asset-store";
import { StyleStore } from "../src/server/services/style-store";
import { CoverStore } from "../src/server/services/cover-store";
import type { AppConfig } from "../src/server/config";

const databaseUrl = process.env.TEST_DATABASE_URL;
if (!databaseUrl || !/^\/[a-zA-Z0-9_]+_test$/.test(new URL(databaseUrl).pathname)) throw new Error("Owner isolation requires a dedicated *_test database");

test("2B explicit identities, cross-owner DB/API isolation and new-owner neutral defaults", async () => {
  const initial = new SQL(databaseUrl);
  await initial.unsafe("DROP TABLE IF EXISTS owner_configuration_defaults,cover_template_assets,account_admin_audit,account_bindings,identity_admin_audit,oauth_pending_states,product_memberships,identities,body_assets,cover_template_revisions,cover_templates,cover_assets,article_style_revisions,article_styles,account_credentials,accounts,app_settings,schema_migrations,jobs,documents,sessions,owners CASCADE"); await initial.close();
  const sql = await openDatabase(databaseUrl); const directory = await mkdtemp(join(tmpdir(), "studio-owner-"));
  const submissions: any[] = []; let registrations = 0;
  const worker = Bun.serve({ hostname: "127.0.0.1", port: 0, async fetch(request) {
    const url = new URL(request.url);
    if (url.pathname === "/health") return Response.json({ capabilities: { jobLookupByIdempotencyKey: true, articleStyleSchemaVersions: [1], coverSnapshotSchemaVersions: [1], articleCoverFonts: [ARTICLE_COVER_FONT], articleSnapshotSchemaVersions: [1], previewConfirm: true, bodyAssetUpload: true } });
    if (url.pathname.startsWith("/v1/accounts/")) { registrations++; return Response.json({ active: true }); }
    if (url.pathname === "/v1/jobs" && request.method === "POST") {
      const input = await request.json() as any; submissions.push(input);
      return Response.json({ id: randomUUID(), input, bodyHash: createHash("sha256").update(input.body).digest("hex"), status: "queued", step: "queued" });
    }
    return new Response("missing", { status: 404 });
  } });
  const config: AppConfig = { databaseUrl, appOrigin: "http://127.0.0.1:18889", bootstrapSecret: "explicit-test-bootstrap-thirty-two-characters", workerUrl: worker.url.origin, workerToken: "fake", credentialEncryptionKey: "ab".repeat(32), simulation: true, dataDir: directory,
    bodyImageSources: [{ origin: "https://img.example.test", pathPrefix: "/a/private/" }], oauth: { issuer: "https://identity.test", portalUrl: "https://portal.test/oauth/authorize", baseUrl: "https://identity.test", clientId: "test", clientSecret: "test", redirectUri: "http://127.0.0.1:18889/api/auth/oauth/callback" } };
  const app = createApp(config, sql); const subject = randomUUID();
  const cookies = new Map<string, string>();
  const request = (owner: string, path: string, method = "GET", input?: unknown) => app.request(`${config.appOrigin}/api${path}`, { method, headers: { Cookie: cookies.get(owner) || "", Origin: config.appOrigin, "Content-Type": "application/json" }, ...(input ? { body: JSON.stringify(input) } : {}) });
  const controls = { editorVars: { "--brand": "#26738c" }, exportTheme: { bodyFontSize: "20px", bodyLineHeight: "2", primaryColor: "#26738c", h2Color: "#26738c" }, syntaxPresets: { h2: "plain" } };
  try {
    const members = await Promise.all([1, 2].map(() => addMember(sql, config, { issuer: config.oauth!.issuer, subject, operator: "test", confirm: true })));
    const b = members[0]!.ownerId; expect(members[1]!.ownerId).toBe(b); expect(b).not.toBe(OWNER_ID);
    const [audit] = await sql`SELECT count(*)::integer AS total FROM identity_admin_audit WHERE action='add-member'`; expect(audit.total).toBe(1);
    for (const owner of [OWNER_ID, b]) {
      const [identity] = await sql`SELECT id FROM identities WHERE owner_id=${owner}`;
      const session = await issueSession(sql, owner, owner === OWNER_ID ? "bootstrap" : "oauth", identity?.id);
      cookies.set(owner, `studio_session=${session.token}`);
    }
    const documents = await Promise.all([OWNER_ID, b].map(async owner => (await (await request(owner, "/documents", "POST", { title: "同名文章", body: "自己的正文" })).json()) as any));
    const [aDoc, bDoc] = documents;
    expect((await request(b, `/documents/${aDoc.id}`)).status).toBe(404);
    expect((await request(OWNER_ID, `/documents/${bDoc.id}`, "PUT", { title: "越权", body: "x", expectedRevision: 1 })).status).toBe(409);
    const styles = await Promise.all([OWNER_ID, b].map(owner => new StyleStore(sql).create(owner, { name: "同名样式", config: controls })));
    expect((await request(b, `/styles/${styles[0]!.id}/revisions/1`)).status).toBe(400);
    expect((await request(b, `/documents/${bDoc.id}/style`, "PUT", { expectedRevision: 1, styleId: styles[0]!.id, styleRevision: 1 })).status).toBe(400);
    await expect((async () => await sql`UPDATE documents SET style_id=${styles[0]!.id},style_revision=1 WHERE id=${bDoc.id}`)()).rejects.toThrow();
    const bytes = await createCanvas(20, 10).encode("png");
    const body = await new BodyAssetStore(sql, directory).save(OWNER_ID, bytes, "image/png");
    expect((await request(b, `/assets/body/${body.id}`)).status).toBe(400);
    expect((await request(b, "/documents", "POST", { title: "拒外部素材", body: `![x](${body.url})` })).status).toBe(400);
    const coverAsset = await new AssetStore(sql, directory).upload(OWNER_ID, new File([new Uint8Array(bytes)], "cover.png", { type: "image/png" }));
    expect((await request(b, "/documents", "POST", { title: "拒外部封面素材", body: `![x](${coverAsset.url})` })).status).toBe(400);
    expect((await request(b, "/documents", "POST", { title: "拒绝对封面素材", body: `![x](${config.appOrigin}${coverAsset.url})` })).status).toBe(400);
    const aCover = await new CoverStore(sql, config).create(OWNER_ID, { name: "同名封面", controls: DEFAULT_ARTICLE_COVER_CONTROLS, assetId: coverAsset.id });
    expect((await request(b, "/cover-templates", "POST", { name: "越权封面", controls: DEFAULT_ARTICLE_COVER_CONTROLS, assetId: coverAsset.id })).status).toBe(400);
    await expect((async () => await sql`UPDATE documents SET cover_template_id=${aCover.id},cover_template_revision=1 WHERE id=${bDoc.id}`)()).rejects.toThrow();
    const store = new AccountStore(sql, config);
    const accountA = await store.create(OWNER_ID, { label: "同名连接", appId: "wx-a", appSecret: "a", pat: "a-own-pat" });
    const accountB = await store.create(b, { label: "同名连接", appId: "wx-b", appSecret: "b", pat: "b-own-pat" });
    const bJob = await (await request(b, "/jobs", "POST", { documentId: bDoc.id, revision: 1, accountId: accountB.id })).json() as any;
    expect(bJob.status).toBe("queued"); expect(submissions[0].articleStyle.manifest.name).toBe("清晰阅读"); expect(submissions[0].coverSnapshot.name).toBe("清晰阅读公共封面");
    expect(JSON.stringify(submissions[0])).not.toContain("/a/private/");
    expect((await request(OWNER_ID, `/jobs/${bJob.id}`)).status).toBe(404);
    expect((await request(OWNER_ID, `/jobs/${bJob.id}/artifacts/article`)).status).toBe(404);
    expect((await request(OWNER_ID, `/jobs/${bJob.id}/publish`, "POST", { snapshotHash: "a".repeat(64), artifactManifestHash: "b".repeat(64) })).status).toBe(400);
    expect((await request(b, "/jobs", "POST", { documentId: aDoc.id, revision: 1, accountId: accountB.id })).status).toBe(409);
    expect((await request(b, "/jobs", "POST", { documentId: bDoc.id, revision: 2, accountId: accountA.id })).status).toBe(400);
    await expect((async () => await sql`UPDATE jobs SET account_id=${accountA.id} WHERE id=${bJob.id}`)()).rejects.toThrow();
    await sql`UPDATE jobs SET status='failed' WHERE id=${bJob.id}`;
    for (const bodyText of ["![x](https://img.example.test/a/private/logo.png)", "![x][ref]\n\n[ref]: https://other.test/i.png", '<img src="https://other.test/i.png">']) {
      const doc = await (await request(b, "/documents", "POST", { title: "图片需完整预览", body: bodyText })).json() as any;
      const before = registrations;
      const response = await request(b, "/jobs", "POST", { documentId: doc.id, revision: 1, accountId: accountB.id });
      expect((await response.json() as any).error).toBe("body_image_requires_preview"); expect(registrations).toBe(before);
      const scanned = await (await request(b, `/documents/${doc.id}/images`)).json() as any; expect(scanned.items.some((item: any) => item.importable)).toBe(false);
    }
    const code = await (await request(b, "/documents", "POST", { title: "代码可发布", body: "```md\n![example](https://other.test/i.png)\n```\n\n[普通链接](https://other.test)" })).json() as any;
    expect((await (await request(b, "/previews", "POST", { documentId: code.id, revision: 1, accountId: accountB.id })).json() as any).status).toBe("queued");
    expect(submissions.at(-1).articleStyle.hash).toBe(submissions[0].articleStyle.hash); expect(submissions.at(-1).coverSnapshot.hash).toBe(submissions[0].coverSnapshot.hash);
    await disableMember(sql, { ownerId: b, operator: "test", confirm: true });
    expect((await addMember(sql, config, { issuer: config.oauth!.issuer, subject, operator: "test", confirm: true })).status).toBe("disabled");
    expect((await request(b, "/documents")).status).toBe(401);
  } finally { worker.stop(true); await sql.close(); await rm(directory, { recursive: true, force: true }); }
}, 30_000);
