import { randomUUID } from "node:crypto";
import type { Database } from "../db/schema";
import { OWNER_ID } from "../db/schema";
import type { AppConfig } from "../config";
import { AccountStore } from "./account-store";
import { lockOwner, requireJobCapacity, withOperation } from "./owner-limits";
import { documentArticleStyle, documentCoverSnapshot, documentPreviewInput } from "./job-snapshot";
import { DocumentImages } from "./document-images";
import { BodyAssetStore, PreviewError } from "./body-asset-store";
import { CoverStore } from "./cover-store";
import { PipelineClient } from "./pipeline-client";
import { coverSnapshotIdentity } from "@akairos/pipeline/cover-snapshot";

export async function createJob(sql: Database, config: AppConfig, owner: string, input: { documentId: string; revision: number; accountId: string }, preview: boolean) {
  const createdAssetIds: string[] = [];
  try { return await sql.begin(async transaction => {
    await lockOwner(transaction as Database, owner);
    const [existing] = await transaction`SELECT * FROM jobs WHERE document_id=${input.documentId} AND document_revision=${input.revision} AND account_id=${input.accountId} AND owner_id=${owner}`;
    if (existing) return { row: existing, inserted: false };
    const accountStore = new AccountStore(transaction as Database, config);
    const account = await accountStore.writable(transaction as Database, owner, input.accountId);
    const [doc] = await transaction`SELECT * FROM documents WHERE id=${input.documentId} AND owner_id=${owner} AND revision=${input.revision} FOR UPDATE`;
    if (!doc) throw new PreviewError("revision_conflict");
    if (!doc.body.trim()) throw new PreviewError("empty_body");
    const images = new DocumentImages(transaction as Database, config);
    await images.validateManaged(owner, doc.body);
    if (!preview && owner !== OWNER_ID && images.scan(doc.body, owner).length) throw new PreviewError("body_image_requires_preview");
    if (!preview && (await documentArticleStyle(transaction as Database, owner, doc))?.schemaVersion === 2) throw new PreviewError("style_requires_preview");
    if (!preview && doc.cover_template_id && (await new CoverStore(transaction as Database, config).get(owner, doc.cover_template_id, doc.cover_template_revision)).schemaVersion === 2) throw new PreviewError("cover_requires_preview");
    const credential = await accountStore.credentials(owner, account.id, account.credential_revision);
    const snapshot = preview ? await withOperation(transaction as Database, owner, "canvas", () => documentPreviewInput(transaction as Database, config, owner, doc, credential.workerAccount!, createdAssetIds)) : {
      body: doc.body, articleStyle: await documentArticleStyle(transaction as Database, owner, doc), coverSnapshot: await documentCoverSnapshot(transaction as Database, config, owner, doc, createdAssetIds), articleSnapshot: null,
    };
    // 能力检查只读且在占 retained 前完成，旧 Worker 不产生无法恢复的任务。
    const client = new PipelineClient(config);
    await client.requireLookup();
    if (preview) await client.requirePreview();
    if (snapshot.articleStyle) await client.requireArticleStyle(snapshot.articleStyle.schemaVersion);
    if (snapshot.coverSnapshot) await client.requireCover(snapshot.coverSnapshot.schemaVersion);
    if (doc.cover_template_id && snapshot.coverSnapshot?.schemaVersion !== 2) await withOperation(transaction as Database, owner, "canvas", () => new CoverStore(transaction as Database, config).layout(owner, doc.cover_template_id, doc.cover_template_revision, doc.title));
    await requireJobCapacity(transaction as Database, owner, true);
    const id = randomUUID(); const style = snapshot.articleStyle; const cover = snapshot.coverSnapshot;
    const coverIdentity = cover ? coverSnapshotIdentity(cover) : null;
    const [row] = await transaction`INSERT INTO jobs (id,owner_id,document_id,document_revision,account_id,account_revision,worker_account,idempotency_key,title,body,status,simulated,article_style,article_style_hash,cover_snapshot,cover_snapshot_hash,cover_asset_hash,cover_font_hash,operation,article_snapshot,input_hash)
      VALUES (${id},${owner},${doc.id},${doc.revision},${account.id},${credential.revision!},${credential.workerAccount!},${`studio:${id}`},${doc.title},${snapshot.body},'submitting',${config.simulation === true},${style}::jsonb,${style?.hash ?? null},${cover}::jsonb,${coverIdentity?.coverSnapshotHash ?? null},${coverIdentity?.coverAssetHash ?? null},${coverIdentity?.coverFontHash ?? null},${preview ? "preview" : null},${snapshot.articleSnapshot}::jsonb,${snapshot.articleSnapshot?.inputHash ?? null}) RETURNING *`;
    return { row, inserted: true };
  }); } catch (error) {
    if (createdAssetIds.length) await new BodyAssetStore(sql, config.dataDir).cleanupFailed(owner, createdAssetIds);
    throw error;
  }
}
