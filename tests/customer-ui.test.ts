import { expect, test } from "bun:test";
import { SQL } from "bun";
import { createCanvas } from "@napi-rs/canvas";
import { createApp } from "../src/server/app";
import { openDatabase } from "../src/server/db/schema";
import type { AppConfig } from "../src/server/config";
import { documentExcerpt } from "../src/server/routes/documents";
import { profileDisplayName } from "../src/server/auth/oauth";

const databaseUrl = process.env.TEST_DATABASE_URL;
if (!databaseUrl || !/^\/[a-zA-Z0-9_]+_test$/.test(new URL(databaseUrl).pathname)) throw new Error("Customer UI test requires a disposable *_test database");

test("article excerpts read as plain text and display names never come from authorization fields", () => {
  expect(documentExcerpt("## 小节\n\n> [!TIP] 提示\n> 正文**加粗**与[链接](https://x.test)。\n\n![图](a.png)\n\n```ts\ncode()\n```\n\n- 列表项")).toBe("小节 提示 正文加粗与链接。 列表项");
  expect(documentExcerpt("字".repeat(200))).toHaveLength(90);
  expect(profileDisplayName({ username: "  作者  ", email: "a@b.c" })).toBe("作者");
  expect(profileDisplayName({ email: "writer@example.test" })).toBe("writer");
  expect(profileDisplayName({ role: "super_admin" })).toBeNull();
});

test("session exposes greeting fields and archiving hides articles without changing revisions", async () => {
  const initial = new SQL(databaseUrl!);
  await initial.unsafe("DROP TABLE IF EXISTS owner_configuration_defaults,cover_template_assets,account_admin_audit,account_bindings,identity_admin_audit,oauth_pending_states,product_memberships,identities,body_assets,cover_template_revisions,cover_templates,cover_assets,article_style_revisions,article_styles,account_credentials,accounts,app_settings,schema_migrations,jobs,documents,sessions,owners CASCADE");
  await initial.close();
  const sql = await openDatabase(databaseUrl!);
  const config: AppConfig = { databaseUrl: databaseUrl!, appOrigin: "http://127.0.0.1:18889", bootstrapSecret: "test-bootstrap-secret-at-least-thirty-two", credentialEncryptionKey: "ab".repeat(32), workerToken: "w", workerUrl: "http://127.0.0.1:1", simulation: true, coverFontPath: process.env.TYPESET_ARTICLE_COVER_FONT_PATH };
  const app = createApp(config, sql);
  try {
    const login = await app.request(`${config.appOrigin}/api/auth/login`, { method: "POST", headers: { Origin: config.appOrigin, "Content-Type": "application/json" }, body: JSON.stringify({ secret: config.bootstrapSecret }) });
    const cookie = login.headers.get("Set-Cookie")!.split(";")[0]!;
    const request = (path: string, method = "GET", input?: unknown) => app.request(`${config.appOrigin}/api${path}`, { method, headers: { Cookie: cookie, Origin: config.appOrigin, "Content-Type": "application/json" }, ...(input ? { body: JSON.stringify(input) } : {}) });
    expect(await (await request("/auth/session")).json()).toEqual({ authenticated: true, simulation: true, displayName: null, accessUntil: null, role: "admin", relayManaged: false, whitelistIp: null, copyMode: "neutral" });
    const doc = await (await request("/documents", "POST", { title: "归档测试", body: "## 标题\n\n正文内容" })).json() as any;
    let list = await (await request("/documents")).json() as any;
    expect(list.documents[0]).toMatchObject({ id: doc.id, archived: false, excerpt: "标题 正文内容" });
    const archived = await (await request(`/documents/${doc.id}/archive`, "PUT", { archived: true })).json() as any;
    expect(archived).toMatchObject({ archived: true, revision: doc.revision });
    expect((await (await request("/documents")).json() as any).documents).toEqual([]);
    expect((await (await request("/documents?archived=1")).json() as any).documents.map((item: any) => item.id)).toEqual([doc.id]);
    expect((await request(`/documents/${doc.id}/archive`, "PUT", { archived: "yes" })).status).toBe(400);
    await request(`/documents/${doc.id}/archive`, "PUT", { archived: false });
    const bumped = await (await request(`/documents/${doc.id}/revision`, "POST", { expectedRevision: doc.revision })).json() as any;
    expect(bumped).toMatchObject({ revision: doc.revision + 1, body: doc.body, title: doc.title });
    expect((await request(`/documents/${doc.id}/revision`, "POST", { expectedRevision: doc.revision })).status).toBe(409);
    list = await (await request("/documents")).json() as any;
    expect(list.documents.map((item: any) => item.id)).toEqual([doc.id]);
    // 未选封面时编辑页预览的就是发布用的公共默认封面。
    const cover = await request("/cover-templates/default/preview", "POST", { title: "默认封面标题" });
    expect(cover.status).toBe(200);
    expect(cover.headers.get("Content-Type")).toBe("image/png");
    expect((await cover.arrayBuffer()).byteLength).toBeGreaterThan(1000);
    expect((await request("/cover-templates/default/preview", "POST", { title: " " })).status).toBe(400);
    // 内置装饰封面：可预览、可保存为本人封面，底图不占本人素材也不写入本人素材关联。
    const catalog = await (await request("/cover-templates/catalog")).json() as any;
    const preset = catalog.presets.find((item: any) => item.id === "studio_cover_poster_cobalt");
    const decorId = preset.images[0].src.slice("asset:".length);
    const decor = await request(`/cover-templates/decor/${decorId}`);
    expect(decor.status).toBe(200); expect(decor.headers.get("Content-Type")).toBe("image/png");
    expect((await request("/cover-templates/decor/00000000-0000-4000-8000-0000000001ff")).status).toBe(404);
    const presetPreview = await request("/cover-templates/preview", "POST", { title: "内置装饰封面", config: preset });
    expect(presetPreview.status).toBe(200);
    const saved = await request("/cover-templates", "POST", { schemaVersion: 2, name: "封面 · 钴蓝信号", slot: "article_cover", config: { ...preset, name: "封面 · 钴蓝信号" } });
    expect(saved.status).toBe(201);
    const template = await saved.json() as any;
    expect(template.assets.map((asset: any) => asset.url)).toEqual([`/api/cover-templates/decor/${decorId}`]);
    expect((await sql`SELECT count(*)::integer AS total FROM cover_template_assets WHERE template_id=${template.id}`)[0].total).toBe(0);
    expect((await request(`/cover-templates/${template.id}/revisions/${template.revision}/preview`, "POST", { title: "保存后的封面" })).status).toBe(200);
    // 右侧方块放 LOGO：成员上传的图片带关联保存，内置底图仍不关联；预览照常出图。
    const logoPng = await createCanvas(200, 200).encode("png");
    const form = new FormData(); form.set("image", new File([new Uint8Array(logoPng)], "logo.png", { type: "image/png" }));
    const uploaded = await app.request(`${config.appOrigin}/api/assets/body`, { method: "POST", headers: { Cookie: cookie, Origin: config.appOrigin }, body: form });
    expect(uploaded.status).toBe(201);
    const logo = await uploaded.json() as any;
    const withLogo = { ...preset, name: "封面 · 带 LOGO", images: [...preset.images, { id: "logo", templateAssetKey: "logo", src: `asset:${logo.id}`, alt: "LOGO", isAbsolute: true, layoutPreset: "custom",
      x: 2350 + 220 - preset.algorithm.safeArea.left, y: 220 - preset.algorithm.safeArea.top, width: 560, height: 560, zIndex: 15, rotate: 0, opacity: 1, borderRadius: 56 }] };
    const savedLogo = await request("/cover-templates", "POST", { schemaVersion: 2, name: "封面 · 带 LOGO", slot: "article_cover", config: withLogo });
    expect(savedLogo.status).toBe(201);
    const logoTemplate = await savedLogo.json() as any;
    expect(logoTemplate.assets.map((asset: any) => asset.id).sort()).toEqual([decorId, logo.id].sort());
    expect((await sql`SELECT asset_id FROM cover_template_assets WHERE template_id=${logoTemplate.id}`).map((row: any) => row.asset_id)).toEqual([logo.id]);
    expect((await request(`/cover-templates/${logoTemplate.id}/revisions/${logoTemplate.revision}/preview`, "POST", { title: "带 LOGO 的封面" })).status).toBe(200);
  } finally { await sql.close(); }
}, 30_000);
