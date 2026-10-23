import { coverSnapshotIdentity } from "@akairos/pipeline/cover-snapshot";
import { ARTICLE_COVER_FONT } from "@akairos/typeset-studio/cover";
import { expect, test } from "bun:test";
import { createHash, randomUUID } from "node:crypto";
import { SQL } from "bun";
import { createApp } from "../src/server/app";
import { openDatabase } from "../src/server/db/schema";
import type { AppConfig } from "../src/server/config";
import { StyleStore } from "../src/server/services/style-store";
import { createArticleStyleSnapshot } from "@akairos/pipeline/article-style";

const databaseUrl = process.env.TEST_DATABASE_URL;
if (!databaseUrl || !/^\/[a-zA-Z0-9_]+_test$/.test(new URL(databaseUrl).pathname)) throw new Error("Article-style test requires a disposable *_test database");

test("B1 immutable styles apply to document revisions and remain frozen across unknown-job recovery", async () => {
  const initial = new SQL(databaseUrl);
  await initial.unsafe("DROP TABLE IF EXISTS owner_configuration_defaults,cover_template_assets,account_admin_audit,account_bindings,identity_admin_audit,oauth_pending_states,product_memberships,identities,body_assets,cover_template_revisions,cover_templates,cover_assets,article_style_revisions,article_styles,account_credentials,accounts,app_settings,schema_migrations,jobs,documents,sessions,owners CASCADE");
  await initial.close();
  let supported = false;
  let loseResponse = false;
  let wrongHash = false;
  const submissions: any[] = [];
  const workerJobs = new Map<string, any>();
  const worker = Bun.serve({ hostname: "127.0.0.1", port: 0, async fetch(request) {
    const url = new URL(request.url); const path = url.pathname;
    if (path === "/health") return Response.json({ capabilities: { jobLookupByIdempotencyKey: true, articleStyleSchemaVersions: supported ? [1, 2] : [], coverSnapshotSchemaVersions: [1], articleCoverFonts: [ARTICLE_COVER_FONT] } });
    if (path.startsWith("/v1/accounts/")) return Response.json({ active: true });
    if (path === "/v1/jobs/by-idempotency-key") {
      const item = workerJobs.get(url.searchParams.get("idempotencyKey")!);
      return item && item.input.account === url.searchParams.get("account") ? Response.json(item) : new Response("missing", { status: 404 });
    }
    if (path === "/v1/jobs" && request.method === "POST") {
      const input = await request.json() as any;
      submissions.push(input);
      if (!workerJobs.has(input.idempotencyKey)) workerJobs.set(input.idempotencyKey, { id: randomUUID(), input, bodyHash: createHash("sha256").update(input.body).digest("hex"), status: "succeeded", step: "done",
        result: { articleStyleHash: input.articleStyle?.hash, articleThemeHash: "a".repeat(64), ...(input.coverSnapshot ? coverSnapshotIdentity(input.coverSnapshot) : {}), publishResults: [{ account: input.account, status: "success", external_id: "SIMULATED_STYLE_DRAFT", article_theme_hash: "a".repeat(64) }] } });
      if (loseResponse) { loseResponse = false; return new Response("accepted but response lost", { status: 502 }); }
      return Response.json(workerJobs.get(input.idempotencyKey));
    }
    const job = [...workerJobs.values()].find(job => path === `/v1/jobs/${job.id}`);
    return job ? Response.json(wrongHash ? { ...job, result: { ...job.result, articleStyleHash: "wrong-hash" } } : job) : new Response("missing", { status: 404 });
  } });
  let sql = await openDatabase(databaseUrl);
  const config: AppConfig = { databaseUrl, appOrigin: "http://127.0.0.1:18889", bootstrapSecret: "test-secret-32-characters-long-for-styles", credentialEncryptionKey: "ab".repeat(32), workerToken: "test-worker-token", workerUrl: worker.url.origin, simulation: true };
  let app = createApp(config, sql);
  let cookie = "";
  const request = (path: string, method = "GET", input?: unknown) => app.request(`http://127.0.0.1:18889/api${path}`, { method,
    headers: { Cookie: cookie, Origin: config.appOrigin, "Content-Type": "application/json" }, ...(input ? { body: JSON.stringify(input) } : {}) });
  const controls = (color = "#26738c") => ({ editorVars: { "--brand": color }, exportTheme: { bodyFontSize: "20px", bodyLineHeight: "2", primaryColor: color, h2Color: color }, syntaxPresets: { h2: "plain" } });
  try {
    expect((await request("/styles")).status).toBe(401);
    const login = await request("/auth/login", "POST", { secret: config.bootstrapSecret });
    cookie = login.headers.get("Set-Cookie")!.split(";")[0];
    const account = await (await request("/accounts", "POST", { label: "测试连接", appId: "wx-style", appSecret: "original-secret", pat: "original-pat" })).json() as any;
    const style = await (await request("/styles", "POST", { name: "明显正文样式", config: controls() })).json() as any;
    expect(style.revision).toBe(1); expect(style.articleStyle.manifest.exportTheme.bodyFontSize).toBe("20px");
    expect(style.articleStyle.schemaVersion).toBe(2);
    for (const invalid of [{ ...controls(), css: "p{background:url(https://invalid)}" }, { ...controls(), structure: { numberedHeadings: "invalid" } }, { ...controls(), schemaVersion: 99 }, { ...controls(), editorVars: { "--brand": "url(https://invalid)" } }]) {
      expect((await request("/styles", "POST", { name: "拒绝输入", config: invalid })).status).toBe(400);
    }
    const complete = { editorVars: { "--brand": "#6366f1", "--text": "#292526" },
      exportTheme: { bodyFontSize: "15px", bodyLineHeight: "1.82", bodyColor: "#292526", h2Color: "#171721", h3Color: "#4338ca", bodyLetterSpacing: "0.03em", bodyParagraphSpacing: "1.18em", footerText: "本人署名" },
      syntaxPresets: { h2: "gradient-pill", h3: "tag-style", blockquote: "left-bar", divider: "dots", "article-card": "plain" },
      structure: { numberedHeadings: true, headingLabel: "章节", quoteLabel: "引用" }, css: ".milkdown .editor p { text-align: justify; }" };
    const full = await (await request("/styles", "POST", { name: "完整 myno 配置", config: complete })).json() as any;
    expect(full.articleStyle.schemaVersion).toBe(2);
    expect(full.articleStyle.manifest.exportTheme).toEqual(complete.exportTheme);
    expect(full.articleStyle.manifest.syntaxPresets).toEqual(complete.syntaxPresets);
    expect(full.articleStyle.manifest.structure).toMatchObject(complete.structure);
    expect(full.articleStyle.manifest.css).toBe(complete.css);
    const [styleOwner] = await sql`SELECT owner_id FROM article_styles WHERE id=${style.id}`;
    const legacyId = randomUUID();
    const legacy = createArticleStyleSnapshot({ schemaVersion: 1, engineVersion: 1, id: legacyId, name: "旧版样式", version: "1.0.0", css: "", ...controls() }, legacyId, 1);
    await sql`INSERT INTO article_styles (id,owner_id,name) VALUES (${legacyId},${styleOwner.owner_id},'旧版样式')`;
    await sql`INSERT INTO article_style_revisions (owner_id,style_id,revision,article_style) VALUES (${styleOwner.owner_id},${legacyId},1,${legacy}::jsonb)`;
    expect((await new StyleStore(sql).get(styleOwner.owner_id, legacyId)).hash).toBe(legacy.hash);
    // 旧 direct 合同使用历史 v1 修订，新建 v2 的预览门禁由 configuration.test 验证。
    style.articleStyle = createArticleStyleSnapshot({ schemaVersion: 1, engineVersion: 1, id: style.id, name: style.name, version: "1.0.0", css: "", ...controls() }, style.id, 1);
    await sql`UPDATE article_style_revisions SET article_style=${style.articleStyle}::jsonb WHERE style_id=${style.id} AND revision=1`;
    const doc = await (await request("/documents", "POST", { title: "样式文章", body: "## 标题\n\n不可变正文\n" })).json() as any;
    const applied = await (await request(`/documents/${doc.id}/style`, "PUT", { expectedRevision: doc.revision, styleId: style.id, styleRevision: 1 })).json() as any;
    expect(applied.revision).toBe(2); expect(applied.articleStyle.hash).toBe(style.articleStyle.hash);
    const again = await (await request(`/documents/${doc.id}/style`, "PUT", { expectedRevision: 2, styleId: style.id, styleRevision: 1 })).json() as any;
    expect(again.revision).toBe(2);
    const publish = { documentId: doc.id, revision: 2, accountId: account.id };
    expect((await request("/jobs", "POST", publish)).status).toBe(502); expect(submissions.length).toBe(0);
    supported = true; loseResponse = true;
    const unknown = await (await request("/jobs", "POST", publish)).json() as any;
    expect(unknown.status).toBe("unknown"); const original = { ...submissions.at(-1) };
    const updated = await (await request(`/styles/${style.id}`, "PUT", { name: "样式新版", config: controls("#a84634"), expectedRevision: 1 })).json() as any;
    expect(updated.revision).toBe(2);
    expect((await request(`/styles/${style.id}`, "PUT", { name: "过期输入", config: controls(), expectedRevision: 1 })).status).toBe(409);
    const selected = await (await request(`/documents/${doc.id}`)).json() as any;
    expect(selected.styleRevision).toBe(1); expect(selected.articleStyle.hash).toBe(style.articleStyle.hash);
    const saved = await (await request(`/documents/${doc.id}`, "PUT", { expectedRevision: selected.revision, title: selected.title, body: "后续正文", styleId: style.id, styleRevision: 2 })).json() as any;
    expect(saved.styleRevision).toBe(1);
    await request(`/documents/${doc.id}/style`, "PUT", { expectedRevision: saved.revision, styleId: style.id, styleRevision: 2 });
    await request(`/accounts/${account.id}`, "PUT", { label: "测试连接", pat: "updated-pat", appSecret: "", expectedVersion: account.version });
    await request(`/accounts/${account.id}`, "DELETE");
    await sql.close(); sql = await openDatabase(databaseUrl); app = createApp(config, sql);
    const restored = await (await request("/jobs", "POST", publish)).json() as any;
    expect(restored.id).toBe(unknown.id); expect(restored.status).toBe("succeeded");
    expect(restored.articleStyleHash).toBe(style.articleStyle.hash); expect(submissions.at(-1)).toEqual(original); expect(workerJobs.size).toBe(1);
    const repeated = await Promise.all([request("/jobs", "POST", publish), request("/jobs", "POST", publish)]);
    for (const response of repeated) expect((await response.json() as any).id).toBe(restored.id);
    expect(workerJobs.size).toBe(1);
    const [stored] = await sql`SELECT * FROM jobs WHERE id=${restored.id}`;
    expect(stored.account_revision).toBe(1); expect(stored.article_style.hash).toBe(style.articleStyle.hash);
    expect(stored.body).toBe(doc.body);
    const second = await (await request("/documents", "POST", { title: "复用文章", body: "另一篇" })).json() as any;
    expect((await request(`/documents/${second.id}/style`, "PUT", { expectedRevision: 1, styleId: style.id, styleRevision: 2 })).status).toBe(200);
    const foreignOwner = randomUUID(); await sql`INSERT INTO owners (id) VALUES (${foreignOwner})`;
    const foreign = await new StyleStore(sql).create(foreignOwner, { name: "其他用户样式", config: controls() });
    expect((await request(`/documents/${second.id}/style`, "PUT", { expectedRevision: 2, styleId: foreign.id, styleRevision: 1 })).status).toBe(400);
    expect((await (await request("/styles")).json() as any).styles.some((item: any) => item.id === foreign.id)).toBe(false);
    const [migrations] = await sql`SELECT count(*)::integer AS count FROM schema_migrations`; expect(migrations.count).toBe(12);
    // 已保存的 hash 错误时不得把任务重新解释为成功。
    await sql`UPDATE jobs SET status='running' WHERE id=${restored.id}`;
    wrongHash = true;
    expect((await (await request(`/jobs/${restored.id}`)).json() as any).status).toBe("unknown");
    wrongHash = false;
    expect((await (await request(`/jobs/${restored.id}`)).json() as any).status).toBe("succeeded");
  } finally { worker.stop(true); await sql.close(); }
}, 15_000);
