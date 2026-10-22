import { expect, test } from "bun:test";
import { createHash, randomUUID } from "node:crypto";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { SQL } from "bun";
import { createCanvas } from "@napi-rs/canvas";
import { imageSize } from "image-size";
import { ARTICLE_COVER_FONT, DEFAULT_ARTICLE_COVER_CONTROLS } from "@akairos/typeset-studio/cover";
import { createApp } from "../src/server/app";
import { openDatabase } from "../src/server/db/schema";
import type { AppConfig } from "../src/server/config";
import { AssetStore } from "../src/server/services/asset-store";
import { CoverStore } from "../src/server/services/cover-store";
import { createArticleStyleSnapshot } from "@akairos/pipeline/article-style";

const databaseUrl = process.env.TEST_DATABASE_URL;
if (!databaseUrl || !/^\/[a-zA-Z0-9_]+_test$/.test(new URL(databaseUrl).pathname)) throw new Error("Cover test requires a disposable *_test database");

test("B2 persistent image and template revisions freeze cover/style/body/key across unknown recovery", async () => {
  const initial = new SQL(databaseUrl);
  await initial.unsafe("DROP TABLE IF EXISTS owner_configuration_defaults,cover_template_assets,account_admin_audit,account_bindings,identity_admin_audit,oauth_pending_states,product_memberships,identities,body_assets,cover_template_revisions,cover_templates,cover_assets,article_style_revisions,article_styles,account_credentials,accounts,app_settings,schema_migrations,jobs,documents,sessions,owners CASCADE");
  await initial.close();
  const directory = await mkdtemp(join(tmpdir(), "studio-cover-"));
  let supported = false;
  let loseResponse = false;
  let wrongHash = false;
  const submissions: any[] = [];
  const workerJobs = new Map<string, any>();
  const worker = Bun.serve({ hostname: "127.0.0.1", port: 0, async fetch(request) {
    const url = new URL(request.url); const path = url.pathname;
    if (path === "/health") return Response.json({ capabilities: { jobLookupByIdempotencyKey: true, articleStyleSchemaVersions: [1, 2], coverSnapshotSchemaVersions: supported ? [1] : [], articleCoverFonts: [{ id: ARTICLE_COVER_FONT.id, sha256: ARTICLE_COVER_FONT.sha256 }] } });
    if (path.startsWith("/v1/accounts/")) return Response.json({ active: true });
    if (path === "/v1/jobs/by-idempotency-key") {
      const item = workerJobs.get(url.searchParams.get("idempotencyKey")!);
      return item && item.input.account === url.searchParams.get("account") ? Response.json(item) : new Response("missing", { status: 404 });
    }
    if (path === "/v1/jobs" && request.method === "POST") {
      const input = await request.json() as any; submissions.push(input);
      if (!workerJobs.has(input.idempotencyKey)) workerJobs.set(input.idempotencyKey, { id: randomUUID(), input, bodyHash: createHash("sha256").update(input.body).digest("hex"), status: "succeeded", step: "done", result: {
        ...(input.articleStyle ? { articleStyleHash: input.articleStyle.hash, articleThemeHash: "a".repeat(64) } : {}),
        ...(input.coverSnapshot ? { coverSnapshotHash: input.coverSnapshot.hash, coverAssetHash: input.coverSnapshot.asset.sha256, coverFontHash: input.coverSnapshot.font.sha256 } : {}),
        publishResults: [{ account: input.account, status: "success", external_id: "SIMULATED_COVER_DRAFT", ...(input.articleStyle ? { article_theme_hash: "a".repeat(64) } : {}) }],
      } });
      if (loseResponse) { loseResponse = false; return new Response("accepted, response lost", { status: 502 }); }
      return Response.json(workerJobs.get(input.idempotencyKey));
    }
    const job = [...workerJobs.values()].find(job => path === `/v1/jobs/${job.id}`);
    return job ? Response.json(wrongHash ? { ...job, result: { ...job.result, coverAssetHash: "wrong" } } : job) : new Response("missing", { status: 404 });
  } });
  let sql = await openDatabase(databaseUrl);
  const config: AppConfig = { databaseUrl, appOrigin: "http://127.0.0.1:18889", bootstrapSecret: "test-secret-32-characters-long-for-cover", credentialEncryptionKey: "ab".repeat(32), workerToken: "fake", workerUrl: worker.url.origin, simulation: true,
    dataDir: directory, coverFontPath: process.env.TYPESET_ARTICLE_COVER_FONT_PATH };
  let app = createApp(config, sql);
  let cookie = "";
  const request = (path: string, method = "GET", input?: unknown) => app.request(`http://127.0.0.1:18889/api${path}`, { method, headers: { Cookie: cookie, Origin: config.appOrigin, "Content-Type": "application/json" }, ...(input ? { body: JSON.stringify(input) } : {}) });
  const upload = async (file: File) => { const data = new FormData(); data.set("image", file); return app.request("http://127.0.0.1:18889/api/assets", { method: "POST", headers: { Cookie: cookie, Origin: config.appOrigin }, body: data }); };
  const source = createCanvas(1600, 800); const context = source.getContext("2d"); context.fillStyle = "#b4d7ce"; context.fillRect(0, 0, 1600, 800);
  const png = new Uint8Array(await source.encode("png"));
  try {
    expect((await upload(new File([png], "cover.png", { type: "image/png" }))).status).toBe(401);
    const login = await request("/auth/login", "POST", { secret: config.bootstrapSecret }); cookie = login.headers.get("Set-Cookie")!.split(";")[0];
    expect((await upload(new File([png], "mismatch.jpg", { type: "image/jpeg" }))).status).toBe(400);
    expect((await upload(new File([new Uint8Array(5 * 1024 * 1024 + 1)], "big.png", { type: "image/png" }))).status).toBe(400);
    const giantHeader = Buffer.from(png); giantHeader.writeUInt32BE(8000, 16); giantHeader.writeUInt32BE(8000, 20);
    const giantResponse = await upload(new File([giantHeader], "giant.png", { type: "image/png" }));
    expect(giantResponse.status).toBe(400); expect((await giantResponse.json() as any).error).toBe("cover_image_dimensions");
    const asset = await (await upload(new File([png], "cover.png", { type: "image/png" }))).json() as any;
    expect(asset.width).toBe(1000); expect(asset.height).toBe(1000); expect(asset.byteLength).toBeLessThanOrEqual(1024 * 1024);
    const assetResponse = await app.request(`http://127.0.0.1:18889${asset.url}`, { headers: { Cookie: cookie } });
    const normalized = Buffer.from(await assetResponse.arrayBuffer());
    expect(imageSize(normalized)).toMatchObject({ width: 1000, height: 1000, type: "jpg" });
    expect(createHash("sha256").update(normalized).digest("hex")).toBe(asset.sha256);
    expect(await readFile(join(directory, "assets", "00000000-0000-4000-8000-000000000001", `${asset.id}.jpg`))).toEqual(normalized);
    const controls = { ...DEFAULT_ARTICLE_COVER_CONTROLS, backgroundColor: "#ddeedd", titleColor: "#164d43" };
    const template = await (await request("/cover-templates", "POST", { name: "持久封面", controls, assetId: asset.id })).json() as any;
    expect(template.revision).toBe(1);
    for (const extra of [{ path: "/private/image.jpg" }, { config: {} }, { schemaVersion: 99 }, { controls: { ...controls, fontSize: 999 } }, { assetId: "https://invalid/image.jpg" }]) {
      expect((await request("/cover-templates", "POST", { name: "拒绝", controls, assetId: asset.id, ...extra })).status).toBe(400);
    }
    const account = await (await request("/accounts", "POST", { label: "连接", appId: "wx-cover", appSecret: "original", pat: "original" })).json() as any;
    const style = await (await request("/styles", "POST", { name: "正文保留", config: { editorVars: { "--brand": "#26738c" }, exportTheme: { bodyFontSize: "20px", bodyLineHeight: "2", primaryColor: "#26738c", h2Color: "#26738c" }, syntaxPresets: { h2: "plain" } } })).json() as any;
    // 保留历史 v1 direct 恢复用例，完整 v2 配置单独走预览确认。
    const { editorVars, exportTheme, syntaxPresets } = style.articleStyle.manifest;
    style.articleStyle = createArticleStyleSnapshot({ schemaVersion: 1, engineVersion: 1, id: style.id, name: style.name, version: "1.0.0", css: "", editorVars, exportTheme, syntaxPresets }, style.id, 1);
    await sql`UPDATE article_style_revisions SET article_style=${style.articleStyle}::jsonb WHERE style_id=${style.id} AND revision=1`;
    let doc = await (await request("/documents", "POST", { title: "封面标题", body: "## 保留正文\n\n![图](https://example.invalid/image.png)\n" })).json() as any;
    doc = await (await request(`/documents/${doc.id}/style`, "PUT", { expectedRevision: doc.revision, styleId: style.id, styleRevision: 1 })).json();
    const appliedResponse = await request(`/documents/${doc.id}/cover`, "PUT", { expectedRevision: doc.revision, templateId: template.id, templateRevision: 1 });
    expect(appliedResponse.status).toBe(200); doc = await appliedResponse.json();
    expect(doc.revision).toBe(3); expect(doc.coverTemplateRevision).toBe(1); expect(doc.styleRevision).toBe(1);
    const again = await (await request(`/documents/${doc.id}/cover`, "PUT", { expectedRevision: doc.revision, templateId: template.id, templateRevision: 1 })).json() as any;
    expect(again.revision).toBe(3);
    const preview = await request(`/cover-templates/${template.id}/revisions/1/preview`, "POST", { title: doc.title });
    expect(preview.status).toBe(200); expect(imageSize(Buffer.from(await preview.arrayBuffer()))).toMatchObject({ width: 3350, height: 1000, type: "png" });
    const long = await request(`/cover-templates/${template.id}/revisions/1/preview`, "POST", { title: "长标题".repeat(80) });
    expect(long.status).toBe(400);
    const coverStore = new CoverStore(sql, config);
    const canonicalTitle = await coverStore.layout("00000000-0000-4000-8000-000000000001", template.id, 1, "AI");
    for (const title of ["#AI", "  #AI", "### AI", "# #AI"]) {
      expect((await coverStore.layout("00000000-0000-4000-8000-000000000001", template.id, 1, title)).pages).toEqual(canonicalTitle.pages);
    }
    const onlyHashes = await request(`/cover-templates/${template.id}/revisions/1/preview`, "POST", { title: " # # " });
    expect(onlyHashes.status).toBe(400); expect((await onlyHashes.json() as any).error).toBe("cover_preview_failed");
    const publish = { documentId: doc.id, revision: doc.revision, accountId: account.id };
    expect((await request("/jobs", "POST", publish)).status).toBe(502); expect(submissions.length).toBe(0);
    supported = true; loseResponse = true;
    const unknown = await (await request("/jobs", "POST", publish)).json() as any; expect(unknown.status).toBe("unknown");
    const original = structuredClone(submissions.at(-1));
    const secondAsset = await (await upload(new File([png], "second.png", { type: "image/png" }))).json() as any;
    const changed = await (await request(`/cover-templates/${template.id}`, "PUT", { name: "换图新版", controls: { ...controls, titleColor: "#aa4422" }, assetId: secondAsset.id, expectedRevision: 1 })).json() as any;
    expect(changed.revision).toBe(2);
    expect((await request(`/cover-templates/${template.id}`, "PUT", { name: "冲突", controls, assetId: asset.id, expectedRevision: 1 })).status).toBe(409);
    const still = await (await request(`/documents/${doc.id}`)).json() as any;
    expect(still.coverTemplateRevision).toBe(1); expect(still.articleStyle.hash).toBe(style.articleStyle.hash);
    const saved = await (await request(`/documents/${doc.id}`, "PUT", { title: doc.title, body: "后续正文", expectedRevision: doc.revision, coverTemplateId: template.id, coverTemplateRevision: 2 })).json() as any;
    expect(saved.coverTemplateRevision).toBe(1);
    await request(`/documents/${doc.id}/cover`, "PUT", { expectedRevision: saved.revision, templateId: template.id, templateRevision: 2 });
    await request(`/accounts/${account.id}`, "PUT", { label: "连接", appSecret: "", pat: "rotated", expectedVersion: account.version });
    await request(`/accounts/${account.id}`, "DELETE");
    await sql.close(); sql = await openDatabase(databaseUrl); app = createApp(config, sql);
    const restored = await (await request("/jobs", "POST", publish)).json() as any;
    expect(restored.id).toBe(unknown.id); expect(restored.status).toBe("succeeded"); expect(submissions.at(-1)).toEqual(original);
    expect(restored.coverAssetHash).toBe(asset.sha256); expect(restored.articleStyleHash).toBe(style.articleStyle.hash);
    const concurrent = await Promise.all([request("/jobs", "POST", publish), request("/jobs", "POST", publish)]);
    for (const response of concurrent) expect((await response.json() as any).id).toBe(restored.id);
    expect(workerJobs.size).toBe(1);
    const [stored] = await sql`SELECT * FROM jobs WHERE id=${restored.id}`;
    expect(stored.account_revision).toBe(1); expect(stored.body).toBe(doc.body); expect(stored.cover_snapshot.hash).toBe(original.coverSnapshot.hash);
    await sql`UPDATE jobs SET status='running' WHERE id=${restored.id}`; wrongHash = true;
    expect((await (await request(`/jobs/${restored.id}`)).json() as any).status).toBe("unknown");
    const foreignOwner = randomUUID(); await sql`INSERT INTO owners(id) VALUES (${foreignOwner})`;
    const foreign = await new AssetStore(sql, directory).upload(foreignOwner, new File([png], "foreign.png", { type: "image/png" }));
    expect((await request("/cover-templates", "POST", { name: "越权", controls, assetId: foreign.id })).status).toBe(400);
    expect((await app.request(`http://127.0.0.1:18889${foreign.url}`, { headers: { Cookie: cookie } })).status).toBe(400);
    const foreignTemplate = await new CoverStore(sql, config).create(foreignOwner, { name: "外部模板", controls, assetId: foreign.id });
    const other = await (await request("/documents", "POST", { title: "复用", body: "内容" })).json() as any;
    expect((await request(`/documents/${other.id}/cover`, "PUT", { expectedRevision: 1, templateId: template.id, templateRevision: 2 })).status).toBe(200);
    expect((await request(`/documents/${other.id}/cover`, "PUT", { expectedRevision: 2, templateId: foreignTemplate.id, templateRevision: 1 })).status).toBe(400);
    const missingFontApp = createApp({ ...config, coverFontPath: join(directory, "missing.ttc") }, sql);
    const missing = await missingFontApp.request(`http://127.0.0.1:18889/api/cover-templates/${template.id}/revisions/1/preview`, { method: "POST", headers: { Cookie: cookie, Origin: config.appOrigin, "Content-Type": "application/json" }, body: JSON.stringify({ title: "标题" }) });
    expect(missing.status).toBe(400); expect((await missing.json() as any).error).toBe("cover_font_unavailable");
  } finally { worker.stop(true); await sql.close(); await rm(directory, { recursive: true, force: true }); }
}, 30_000);
