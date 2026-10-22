import { expect, test } from "bun:test";
import { randomUUID } from "node:crypto";
import { mkdtemp, rm, mkdir, writeFile, access } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { SQL } from "bun";
import { createCanvas } from "@napi-rs/canvas";
import { openDatabase, OWNER_ID } from "../src/server/db/schema";
import { AccountStore } from "../src/server/services/account-store";
import { BodyAssetStore } from "../src/server/services/body-asset-store";
import { AssetStore } from "../src/server/services/asset-store";
import { DocumentImages } from "../src/server/services/document-images";
import { lockOwner, OWNER_LIMITS, requireJobCapacity, withOperation } from "../src/server/services/owner-limits";
import { cleanupUnreferencedAssets } from "../src/server/services/asset-cleanup";
import type { AppConfig } from "../src/server/config";

const databaseUrl = process.env.TEST_DATABASE_URL;
if (!databaseUrl || !/^\/[a-zA-Z0-9_]+_test$/.test(new URL(databaseUrl).pathname)) throw new Error("Owner limits require a dedicated *_test database");

test("2B atomic retained/active/material/account limits isolate owners and bound real operations", async () => {
  const initial = new SQL(databaseUrl);
  await initial.unsafe("DROP TABLE IF EXISTS owner_configuration_defaults,cover_template_assets,account_admin_audit,account_bindings,identity_admin_audit,oauth_pending_states,product_memberships,identities,body_assets,cover_template_revisions,cover_templates,cover_assets,article_style_revisions,article_styles,account_credentials,accounts,app_settings,schema_migrations,jobs,documents,sessions,owners CASCADE"); await initial.close();
  const sql = await openDatabase(databaseUrl); const directory = await mkdtemp(join(tmpdir(), "studio-limits-"));
  const b = randomUUID(); await sql`INSERT INTO owners(id) VALUES (${b})`; await sql`INSERT INTO product_memberships(owner_id,status,role) VALUES (${b},'active','member')`;
  const config: AppConfig = { databaseUrl, appOrigin: "http://127.0.0.1:18889", bootstrapSecret: "", workerUrl: "http://127.0.0.1:1", workerToken: "fake", credentialEncryptionKey: "ab".repeat(32), simulation: true, dataDir: directory };
  const accounts = new AccountStore(sql, config);
  const body = new BodyAssetStore(sql, directory); const bytes = await createCanvas(10, 20).encode("png");
  try {
    const creating = await Promise.allSettled(Array.from({ length: 6 }, (_, index) => accounts.create(OWNER_ID, { label: "同名", appId: `wx-${index}`, appSecret: "secret", pat: "owner-a" })));
    expect(creating.filter(item => item.status === "fulfilled").length).toBe(5);
    expect(creating.filter(item => item.status === "rejected").map(item => (item as PromiseRejectedResult).reason.code)).toEqual(["account_quota_exceeded"]);
    const aAccount = (creating.find(item => item.status === "fulfilled") as PromiseFulfilledResult<any>).value;
    let current = aAccount;
    for (let revision = 2; revision <= OWNER_LIMITS.credentials; revision++) current = await accounts.update(OWNER_ID, current.id, { label: "同名", expectedVersion: current.version, pat: `a-revision-${revision}` });
    await expect(accounts.update(OWNER_ID, current.id, { label: "同名", expectedVersion: current.version, pat: "too-many" })).rejects.toMatchObject({ code: "credential_quota_exceeded" });
    const bAccount = await accounts.create(b, { label: "同名", appId: "wx-b", appSecret: "secret-b", pat: "b-only" }); expect(bAccount.credential_revision).toBe(1);

    const filler = randomUUID();
    await sql`INSERT INTO body_assets (id,owner_id,sha256,content_type,byte_length,width,height) VALUES (${filler},${OWNER_ID},${"a".repeat(64)},'image/png',${OWNER_LIMITS.assetBytes - bytes.length},10,20)`;
    const uploads = await Promise.allSettled([body.save(OWNER_ID, bytes, "image/png"), body.save(OWNER_ID, bytes, "image/png")]);
    expect(uploads.filter(item => item.status === "fulfilled").length).toBe(1); expect(uploads.filter(item => item.status === "rejected").length).toBe(1);
    expect((await body.save(b, bytes, "image/png")).byteLength).toBe(bytes.length);
    await sql`DELETE FROM body_assets WHERE id=${filler}`;
    // 剩余不足旧最大估算，但足够实际封面／导入字节时仍应成功。
    const tinyBudget = randomUUID();
    await sql`INSERT INTO body_assets (id,owner_id,sha256,content_type,byte_length,width,height) VALUES (${tinyBudget},${OWNER_ID},${"c".repeat(64)},'image/png',${OWNER_LIMITS.assetBytes - bytes.length - 200_000},10,20)`;
    const cover = await new AssetStore(sql, directory).upload(OWNER_ID, new File([new Uint8Array(bytes)], "cover.png", { type: "image/png" })); expect(cover.byteLength).toBeLessThan(200_000);
    const importDoc = randomUUID(); await sql`INSERT INTO documents (id,owner_id,title,body) VALUES (${importDoc},${OWNER_ID},'导入','![图](https://img.example.test/a/image.png)')`;
    const fetchBefore = globalThis.fetch;
    globalThis.fetch = (async () => new Response(new Uint8Array(bytes), { headers: { "Content-Type": "image/png" } })) as unknown as typeof fetch;
    try {
      const imported = await new DocumentImages(sql, { ...config, bodyImageSources: [{ origin: "https://img.example.test", pathPrefix: "/a/" }] }).import(OWNER_ID, importDoc, 1);
      expect(imported.body).toContain("/api/assets/body/");
    } finally { globalThis.fetch = fetchBefore; }
    await sql`DELETE FROM body_assets WHERE id=${tinyBudget}`;
    const [assetCount] = await sql`SELECT count(*)::integer AS total FROM body_assets WHERE owner_id=${OWNER_ID}`;
    const [coverCount] = await sql`SELECT count(*)::integer AS total FROM cover_assets WHERE owner_id=${OWNER_ID}`;
    for (let index = assetCount.total + coverCount.total; index < 200; index++) await sql`INSERT INTO body_assets (id,owner_id,sha256,content_type,byte_length,width,height) VALUES (${randomUUID()},${OWNER_ID},${"b".repeat(64)},'image/png',1,1,1)`;
    await expect(body.save(OWNER_ID, bytes, "image/png")).rejects.toMatchObject({ code: "asset_quota_exceeded" });

    const docA = randomUUID(); const docB = randomUUID();
    await sql`INSERT INTO documents (id,owner_id,title,body) VALUES (${docA},${OWNER_ID},'A','A'),(${docB},${b},'B','B')`;
    for (let index = 1; index <= 19; index++) await sql`INSERT INTO jobs (id,owner_id,document_id,document_revision,account_id,idempotency_key,title,body,status)
      VALUES (${randomUUID()},${OWNER_ID},${docA},${index},${aAccount.id},${randomUUID()},'A','A','failed')`;
    const create = (owner: string, doc: string, account: string, revision: number, status = "submitting") => sql.begin(async transaction => {
      await lockOwner(transaction, owner); await requireJobCapacity(transaction, owner, true);
      await transaction`INSERT INTO jobs (id,owner_id,document_id,document_revision,account_id,idempotency_key,title,body,status)
        VALUES (${randomUUID()},${owner},${doc},${revision},${account},${randomUUID()},'x','x',${status})`;
    });
    // retained 只统计仍需处理的任务：19 个失败任务不占名额；当前修订下待确认的预览计入。
    const previewDocs = Array.from({ length: 9 }, () => randomUUID());
    for (const doc of previewDocs) {
      await sql`INSERT INTO documents (id,owner_id,title,body) VALUES (${doc},${OWNER_ID},'P','P')`;
      await sql`INSERT INTO jobs (id,owner_id,document_id,document_revision,account_id,idempotency_key,title,body,status,operation)
        VALUES (${randomUUID()},${OWNER_ID},${doc},1,${aAccount.id},${randomUUID()},'P','P','preview_ready','preview')`;
    }
    // 旧修订的预览已无法确认、撤销授权的预览永久只读，二者都不占名额。
    const staleDoc = randomUUID(); const revokedDoc = randomUUID();
    await sql`INSERT INTO documents (id,owner_id,title,body,revision) VALUES (${staleDoc},${OWNER_ID},'S','S',2),(${revokedDoc},${OWNER_ID},'R','R',1)`;
    await sql`INSERT INTO jobs (id,owner_id,document_id,document_revision,account_id,idempotency_key,title,body,status,operation,authorization_revoked)
      VALUES (${randomUUID()},${OWNER_ID},${staleDoc},1,${aAccount.id},${randomUUID()},'S','S','preview_ready','preview',false),
             (${randomUUID()},${OWNER_ID},${revokedDoc},1,${aAccount.id},${randomUUID()},'R','R','preview_ready','preview',true)`;
    const retained = await Promise.allSettled([create(OWNER_ID, docA, aAccount.id, 20), create(OWNER_ID, docA, aAccount.id, 21)]);
    expect(retained.filter(item => item.status === "fulfilled").length).toBe(1);
    await expect(create(OWNER_ID, docA, aAccount.id, 22, "failed")).rejects.toMatchObject({ code: "job_retained_quota_exceeded" });
    // 放弃一个预览后名额立即释放。
    await sql`UPDATE jobs SET status='failed',error_code='preview_discarded' WHERE document_id=${previewDocs[0]!}`;
    await create(OWNER_ID, docA, aAccount.id, 22, "failed");
    await create(b, docB, bAccount.id, 1); await create(b, docB, bAccount.id, 2);
    await expect(create(b, docB, bAccount.id, 3)).rejects.toMatchObject({ code: "job_active_quota_exceeded" });
    await sql`UPDATE jobs SET status='preview_ready' WHERE owner_id=${b} AND document_revision=1`;
    await create(b, docB, bAccount.id, 3);
    await sql`UPDATE jobs SET status='unknown' WHERE owner_id=${b} AND document_revision=1`;
    await expect(create(b, docB, bAccount.id, 4)).rejects.toMatchObject({ code: "job_active_quota_exceeded" });

    let finish!: () => void; const pending = new Promise<void>(resolve => { finish = resolve; });
    const first = withOperation(sql, OWNER_ID, "upload", () => pending);
    await expect(withOperation(sql, OWNER_ID, "upload", async () => 1)).rejects.toMatchObject({ code: "operation_busy" });
    const second = withOperation(sql, b, "upload", () => pending);
    await expect(withOperation(sql, randomUUID(), "upload", async () => 1)).rejects.toMatchObject({ code: "operation_busy" });
    finish(); await Promise.all([first, second]); expect(await withOperation(sql, OWNER_ID, "upload", async () => 7)).toBe(7);
    await expect(withOperation(sql, OWNER_ID, "import", async () => { throw new Error("download failed"); })).rejects.toThrow("download failed");
    expect(await withOperation(sql, OWNER_ID, "import", async () => 8)).toBe(8);

    const orphan = join(directory, "body-assets", b, randomUUID()); await mkdir(join(directory, "body-assets", b), { recursive: true }); await writeFile(orphan, bytes);
    const legacy = join(directory, "body-assets", randomUUID()); await writeFile(legacy, bytes);
    await cleanupUnreferencedAssets(sql, directory); await expect(access(orphan)).rejects.toThrow(); await access(legacy);
    const [bAsset] = await sql`SELECT id FROM body_assets WHERE owner_id=${b}`; expect((await body.get(b, bAsset.id)).bytes).toEqual(bytes);
  } finally { await sql.close(); await rm(directory, { recursive: true, force: true }); }
}, 30_000);
