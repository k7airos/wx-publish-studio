import { expect, test } from "bun:test";
import { SQL } from "bun";
import { randomUUID } from "node:crypto";
import { mkdir, mkdtemp, readdir, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { imageSize } from "image-size";
import { createArticleCoverConfig, DEFAULT_ARTICLE_COVER_CONTROLS } from "@akairos/typeset-studio/cover";
import { createApp } from "../src/server/app";
import type { AppConfig } from "../src/server/config";
import { openDatabase, OWNER_ID } from "../src/server/db/schema";
import { CoverStore } from "../src/server/services/cover-store";
import { StyleStore } from "../src/server/services/style-store";
import { createJob } from "../src/server/services/job-create";

const databaseUrl = process.env.TEST_DATABASE_URL;
if (!databaseUrl || !/^\/[a-zA-Z0-9_]+_test$/.test(new URL(databaseUrl).pathname)) throw new Error("Configuration test requires a disposable *_test database");

test("配置原子应用与新文默认、原生封面失败清理、生产导入保留后续修改", async () => {
  const initial = new SQL(databaseUrl);
  await initial.unsafe("DROP TABLE IF EXISTS owner_configuration_defaults,cover_template_assets,account_admin_audit,account_bindings,identity_admin_audit,oauth_pending_states,product_memberships,identities,body_assets,cover_template_revisions,cover_templates,cover_assets,article_style_revisions,article_styles,account_credentials,accounts,app_settings,schema_migrations,jobs,documents,sessions,owners CASCADE");
  await initial.close();
  const directory = await mkdtemp(join(tmpdir(), "studio-config-"));
  const worker = Bun.serve({ hostname: "127.0.0.1", port: 0, fetch: request => new URL(request.url).pathname === "/health"
    ? Response.json({ capabilities: { jobLookupByIdempotencyKey: false } }) : Response.json({ active: true }) });
  let sql = await openDatabase(databaseUrl);
  const config: AppConfig = { databaseUrl, appOrigin: "http://127.0.0.1:18891", bootstrapSecret: "configuration-test-secret-32-characters", credentialEncryptionKey: "ab".repeat(32),
    workerUrl: worker.url.origin, workerToken: "fake", simulation: true, dataDir: directory, coverFontPath: process.env.TYPESET_ARTICLE_COVER_FONT_PATH };
  let app = createApp(config, sql);
  let cookie = "";
  const request = (path: string, method = "GET", input?: unknown) => app.request(`${config.appOrigin}/api${path}`, { method,
    headers: { Cookie: cookie, Origin: config.appOrigin, "Content-Type": "application/json" }, ...(input ? { body: JSON.stringify(input) } : {}) });
  try {
    cookie = (await request("/auth/login", "POST", { secret: config.bootstrapSecret })).headers.get("Set-Cookie")!.split(";")[0]!;
    const createDoc = async (title: string) => (await request("/documents", "POST", { title, body: "## 正文\n\n配置验收。" })).json() as Promise<any>;
    const old = await createDoc("原有文章");
    const styles = new StyleStore(sql); const covers = new CoverStore(sql, config);
    const style = await styles.create(OWNER_ID, { name: "完整样式", config: { exportTheme: { bodyFontSize: "15px" }, syntaxPresets: { h3: "tag-style" }, css: ".milkdown .editor p { letter-spacing: 0.25px; }" } });
    const catalog = covers.catalog(OWNER_ID);
    const native = structuredClone(catalog.presets.find(preset => preset.slot === "article_cover")!);
    native.name = "完整封面";
    const template = await covers.create(OWNER_ID, { schemaVersion: 2, name: native.name, slot: native.slot, config: native });
    expect(template.schemaVersion).toBe(2);
    const png = await covers.previewConfig(OWNER_ID, native, old.title);
    expect(imageSize(png)).toMatchObject({ width: 3350, height: 1000, type: "png" });
    const themed = createArticleCoverConfig({ id: randomUUID(), name: "主题映射", controls: DEFAULT_ARTICLE_COVER_CONTROLS, assetId: randomUUID() });
    themed.images = []; themed.algorithm.targetFillRatio = 0.8; themed.coverTheme!.decoration.size = 56;
    const previousPng = await covers.previewConfig(OWNER_ID, themed, "布局与颜色");
    themed.coverTheme!.layout.textAlign = "right"; themed.coverTheme!.layout.verticalAlign = "bottom"; themed.coverTheme!.colors.text = "#bb1234";
    expect((await covers.previewConfig(OWNER_ID, themed, "布局与颜色")).equals(previousPng)).toBe(false);
    const refs = { styleId: style.id, styleRevision: style.revision, templateId: template.id, templateRevision: template.revision };
    let doc = await (await request(`/documents/${old.id}/configuration`, "PUT", { expectedRevision: 1, ...refs })).json() as any;
    expect(doc.revision).toBe(2); expect(doc.styleId).toBe(style.id); expect(doc.coverTemplateId).toBe(template.id);
    const unchanged = await (await request(`/documents/${old.id}/configuration`, "PUT", { expectedRevision: 2, ...refs })).json() as any;
    expect(unchanged.revision).toBe(2);
    const defaults = async () => (await sql`SELECT * FROM owner_configuration_defaults WHERE owner_id=${OWNER_ID}`)[0];
    const before = await defaults();
    expect((await request(`/documents/${old.id}/configuration`, "PUT", { expectedRevision: 1, styleId: null, styleRevision: null, templateId: null, templateRevision: null })).status).toBe(409);
    expect(await defaults()).toEqual(before);
    const poster = structuredClone(catalog.presets.find(preset => preset.slot === "newspic_cover")!);
    const posterTemplate = await covers.create(OWNER_ID, { schemaVersion: 2, name: poster.name, slot: poster.slot, config: poster });
    expect((await request(`/documents/${old.id}/configuration`, "PUT", { expectedRevision: 2, ...refs, styleId: null, styleRevision: null, templateId: posterTemplate.id })).status).toBe(400);
    expect((await request(`/documents/${old.id}/cover`, "PUT", { expectedRevision: 2, templateId: posterTemplate.id, templateRevision: 1 })).status).toBe(400);
    expect(await defaults()).toEqual(before);
    const foreignOwner = randomUUID(); await sql`INSERT INTO owners(id) VALUES (${foreignOwner})`;
    const foreign = await styles.create(foreignOwner, { name: "他人排版", config: {} });
    expect((await request(`/documents/${old.id}/configuration`, "PUT", { expectedRevision: 2, ...refs, styleId: foreign.id })).status).toBe(400);
    expect(await defaults()).toEqual(before);
    const next = await createDoc("继承配置");
    expect(next.styleId).toBe(style.id); expect(next.coverTemplateId).toBe(template.id);
    const snapshot = await covers.snapshot(OWNER_ID, template.id, 1, next.title);
    expect(snapshot.schemaVersion).toBe(2);
    if (snapshot.schemaVersion !== 2) throw new Error("Expected rendered cover");
    expect(snapshot.renderedAsset.sha256).toHaveLength(64);
    const files = await readdir(join(directory, "body-assets", OWNER_ID));
    const account = await (await request("/accounts", "POST", { label: "测试", appId: "wx-cfg", appSecret: "fake", pat: "fake" })).json() as any;
    await expect(createJob(sql, config, OWNER_ID, { documentId: next.id, revision: next.revision, accountId: account.id }, true)).rejects.toThrow("worker_lookup_unsupported");
    expect(await readdir(join(directory, "body-assets", OWNER_ID))).toEqual(files);
    expect((await sql`SELECT count(*)::integer AS total FROM body_assets`)[0]!.total).toBe(1);
    await expect(createJob(sql, config, OWNER_ID, { documentId: next.id, revision: next.revision, accountId: account.id }, false)).rejects.toThrow("style_requires_preview");
    const [coverOnly] = await sql`INSERT INTO documents(id,owner_id,title,body,cover_template_id,cover_template_revision) VALUES(${randomUUID()},${OWNER_ID},'封面','正文',${template.id},1) RETURNING *`;
    await expect(createJob(sql, config, OWNER_ID, { documentId: coverOnly.id, revision: 1, accountId: account.id }, false)).rejects.toThrow("cover_requires_preview");
    expect((await sql`SELECT count(*)::integer AS total FROM jobs`)[0]!.total).toBe(0);

    const sourceFile = join(directory, "source.json"); const uploads = join(directory, "uploads");
    await mkdir(uploads);
    await writeFile(sourceFile, JSON.stringify({ theme: { exportTheme: { bodyFontSize: "15px" } }, css: "", templates: Object.fromEntries(["article_cover", "newspic_cover", "newspic_content"].map(slot => {
      const preset = structuredClone(catalog.presets.find(preset => preset.slot === slot)!);
      return [slot, { id: preset.id, config: preset }];
    })) }));
    const runImport = async () => {
      const child = Bun.spawn([process.execPath, "run", "scripts/import-production-config.ts", sourceFile, uploads], { cwd: join(import.meta.dir, ".."),
        env: { ...process.env, DATABASE_URL: databaseUrl, BOOTSTRAP_SECRET: config.bootstrapSecret, APP_ORIGIN: config.appOrigin, PIPELINE_WORKER_URL: worker.url.origin, PIPELINE_WORKER_TOKEN: "fake",
          CREDENTIAL_ENCRYPTION_KEY: config.credentialEncryptionKey, PUBLISHING_AUTH_MODE: "bootstrap", IMPORT_ACCOUNTS_ONCE: "0", TYPESET_COVER_FONTS: "[]", PUBLISHING_DATA_DIR: directory }, stdout: "pipe", stderr: "pipe" });
      const [output, error, exit] = await Promise.all([new Response(child.stdout).text(), new Response(child.stderr).text(), child.exited]);
      if (exit) throw new Error(error); return JSON.parse(output);
    };
    const imported = await runImport();
    expect(await defaults()).toEqual(before);
    const countStyles = (await sql`SELECT count(*)::integer AS total FROM article_styles`)[0]!.total;
    const countCovers = (await sql`SELECT count(*)::integer AS total FROM cover_templates`)[0]!.total;
    await styles.update(OWNER_ID, imported.style.id, { name: "我已重命名", config: { exportTheme: { bodyFontSize: "18px" } }, expectedRevision: 1 });
    const importedCover = await covers.get(OWNER_ID, imported.templates.article_cover.id, 1);
    if (importedCover.schemaVersion !== 2) throw new Error("Expected native template");
    await covers.update(OWNER_ID, importedCover.id, { schemaVersion: 2, name: "我已调整封面", slot: "article_cover", expectedRevision: 1, config: { ...importedCover.config, name: "我已调整封面" } });
    const repeated = await runImport();
    expect(repeated.style.id).toBe(imported.style.id); expect(repeated.style.revision).toBe(2);
    expect(repeated.templates.article_cover.revision).toBe(2);
    expect((await sql`SELECT count(*)::integer AS total FROM article_styles`)[0]!.total).toBe(countStyles);
    expect((await sql`SELECT count(*)::integer AS total FROM cover_templates`)[0]!.total).toBe(countCovers);
    expect(await defaults()).toEqual(before);
    await sql.close(); sql = await openDatabase(databaseUrl); app = createApp(config, sql);
    doc = await (await request(`/documents/${old.id}`)).json();
    expect(doc.styleRevision).toBe(1); expect(doc.coverTemplateRevision).toBe(1);
    expect((await createDoc("重启后继承")).coverTemplateId).toBe(template.id);
    expect((await readFile(join(directory, "body-assets", OWNER_ID, snapshot.renderedAsset.id))).length).toBe(snapshot.renderedAsset.byteLength);
  } finally { worker.stop(true); await sql.close(); await rm(directory, { recursive: true, force: true }); }
}, 30_000);
