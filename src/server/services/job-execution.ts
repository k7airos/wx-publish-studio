import { createHash } from "node:crypto";
import type { Database } from "../db/schema";
import { PipelineClient, PipelineError, type DraftInput } from "./pipeline-client";
import { validateArtifactManifest } from "@akairos/pipeline/article-snapshot";
import { storedArticleSnapshot, storedArticleStyle, storedCoverSnapshot, storedBodyAssets } from "./job-snapshot";
import type { AppConfig } from "../config";
import { AccountStore } from "./account-store";
import { lockOwner } from "./owner-limits";
import { coverSnapshotIdentity } from "@akairos/pipeline/cover-snapshot";
import { BodyAssetStore } from "./body-asset-store";
import { sanitizeFailure } from "./failure-detail";
const UUID = /^[a-f\d]{8}(-[a-f\d]{4}){3}-[a-f\d]{12}$/i;

// 只有目标公众号的成功草稿身份齐全时，才能向用户确认完成。
export async function applyWorkerJob(sql: Database, row: any, worker: any) {
  if (!worker || typeof worker.id !== "string" || !UUID.test(worker.id)) throw new PipelineError("worker_result_unknown");
  if (row.worker_job_id && row.worker_job_id !== worker.id) throw new PipelineError("worker_result_unknown");
  const input = worker.input;
  if (!input || input.idempotencyKey !== row.idempotency_key || input.account !== (row.worker_account || row.account_id)
    || input.title !== row.title.trim() || (input.operation || null) !== (row.operation || null)
    || worker.bodyHash !== createHash("sha256").update(row.body).digest("hex")
    || (input.articleStyle?.hash || null) !== (row.article_style_hash || null)
    || (input.coverSnapshot?.hash || null) !== (row.cover_snapshot_hash || null)
    || (input.articleSnapshot?.inputHash || null) !== (row.input_hash || null)) throw new PipelineError("worker_result_unknown");
  const allowed = ["accepting", "queued", "running", "succeeded", "failed", "interrupted", ...(row.operation === "preview" ? ["preview_ready"] : [])];
  const draft = Array.isArray(worker.result?.publishResults)
    ? worker.result.publishResults.find((item: any) => item.account === (row.worker_account || row.account_id) && item.status === "success" && typeof item.external_id === "string" && item.external_id)
    : undefined;
  const styleConfirmed = !row.article_style_hash || worker.input?.articleStyle?.hash === row.article_style_hash
    && (worker.status !== "succeeded" || worker.result?.articleStyleHash === row.article_style_hash
      && typeof worker.result?.articleThemeHash === "string" && /^[a-f\d]{64}$/.test(worker.result.articleThemeHash)
      && draft?.article_theme_hash === worker.result.articleThemeHash);
  const coverIdentity = worker.input?.coverSnapshot ? coverSnapshotIdentity(worker.input.coverSnapshot) : null;
  const coverConfirmed = !row.cover_snapshot_hash || coverIdentity?.coverSnapshotHash === row.cover_snapshot_hash
    && (worker.status !== "succeeded" || worker.result?.coverSnapshotHash === row.cover_snapshot_hash
      && worker.result?.coverAssetHash === row.cover_asset_hash && worker.result?.coverFontHash === row.cover_font_hash);
  let manifest = row.artifact_manifest ?? null;
  let snapshotHash = row.snapshot_hash ?? null;
  let manifestHash = row.artifact_manifest_hash ?? null;
  let previewConfirmed = row.operation !== "preview" || worker.input?.articleSnapshot?.inputHash === row.input_hash;
  if (row.operation === "preview" && ["preview_ready", "succeeded"].includes(worker.status)) {
    try {
      if (!/^[a-f\d]{64}$/.test(worker.result?.snapshotHash || "") || !/^[a-f\d]{64}$/.test(worker.result?.artifactManifestHash || "")) throw new Error("missing preview identity");
      const validated = validateArtifactManifest(worker.result?.artifactManifest, worker.result?.artifactManifestHash);
      if (worker.result?.inputHash !== row.input_hash || validated.snapshotHash !== worker.result?.snapshotHash
        || row.snapshot_hash && row.snapshot_hash !== validated.snapshotHash
        || row.artifact_manifest_hash && row.artifact_manifest_hash !== worker.result?.artifactManifestHash) throw new Error("preview identity mismatch");
      manifest = validated; snapshotHash = validated.snapshotHash; manifestHash = worker.result.artifactManifestHash;
    } catch { previewConfirmed = false; }
  }
  const status = allowed.includes(worker.status) && styleConfirmed && coverConfirmed && previewConfirmed && (worker.status !== "succeeded" || draft) ? worker.status : "unknown";
  const steps = ["queued", "starting", "attach-body", "prepare", "review-content", "prepare-finalize", "render", "publish", "done"];
  const step = steps.includes(worker.step) ? worker.step : status;
  // Worker 放弃或过期的预览保留原因，界面据此区分"预览已关闭"与"发布失败"。
  const closedPreview = row.operation === "preview" && status === "failed" && ["preview_expired", "preview_discarded"].includes(worker.error) ? worker.error as string : null;
  const error = closedPreview ?? (status === "failed" ? "worker_failed" : status === "interrupted" ? "worker_interrupted" : status === "unknown" ? "worker_result_unknown" : null);
  // 失败原因只在失败或中断时保留，已脱敏限长；其余状态清空。
  const errorDetail = !closedPreview && (status === "failed" || status === "interrupted") ? sanitizeFailure(worker.error) : null;
  const [updated] = await sql`UPDATE jobs SET worker_job_id=${worker.id},status=${status},step=${step},worker_publication_requested=worker_publication_requested OR ${worker.publicationRequested === true},
    error_code=${error},error_detail=${errorDetail},draft_media_id=${draft?.external_id ?? null},article_theme_hash=${typeof worker.result?.articleThemeHash === "string" ? worker.result.articleThemeHash : row.article_theme_hash ?? null},
    snapshot_hash=${snapshotHash},artifact_manifest=${manifest}::jsonb,artifact_manifest_hash=${manifestHash},updated_at=now() WHERE id=${row.id} RETURNING *`;
  return updated;
}

export function frozenInput(row: any): DraftInput {
  const articleStyle = storedArticleStyle(row); const coverSnapshot = storedCoverSnapshot(row);
  return { idempotencyKey: row.idempotency_key, title: row.title, body: row.body, contentForm: "article", account: row.worker_account || row.account_id,
    ...(articleStyle ? { articleStyle } : {}), ...(coverSnapshot ? { coverSnapshot } : {}),
    ...(row.operation === "preview" ? { operation: "preview" as const, articleSnapshot: storedArticleSnapshot(row) } : {}) };
}

export async function unknownJob(sql: Database, row: any, code = "worker_result_unknown") {
  const [updated] = await sql`UPDATE jobs SET status='unknown',step='unknown',error_code=${code},updated_at=now() WHERE id=${row.id} RETURNING *`;
  return updated;
}

// 恢复只读取原身份；404 不构成旧 HTTP 永不接受的证明，绝不补第一次 POST。
export async function refreshJob(sql: Database, client: PipelineClient, row: any) {
  return sql.begin(async transaction => {
    await lockOwner(transaction as Database, row.owner_id);
    await transaction`SELECT id FROM accounts WHERE id=${row.account_id} AND owner_id=${row.owner_id} FOR UPDATE`;
    await transaction`SELECT id FROM documents WHERE id=${row.document_id} AND owner_id=${row.owner_id} FOR UPDATE`;
    const [current] = await transaction`SELECT * FROM jobs WHERE id=${row.id} AND owner_id=${row.owner_id} FOR UPDATE`;
    if (["succeeded", "failed"].includes(current.status)) return current;
    if (current.status === "submitting" && !current.worker_job_id) return current;
    try {
      const worker = current.worker_job_id ? await client.get(current.worker_job_id) : await client.lookup(current.idempotency_key, current.worker_account || current.account_id);
      if (!worker) return unknownJob(transaction as Database, current);
      const refreshed = await applyWorkerJob(transaction as Database, current, worker);
      // 先前确认可能仍在 Worker await 中；一次 pubfalse 不能证明永不接受。
      if (current.publication_requested && !refreshed.worker_publication_requested && worker.status === "preview_ready") return unknownJob(transaction as Database, refreshed);
      return refreshed;
    } catch { return unknownJob(transaction as Database, current); }
  });
}

// 初次插入者独占发送；跨外部边界保留 owner/account 锁，让 pause/release 明确线性化。
export async function dispatchNewJob(sql: Database, config: AppConfig, row: any) {
  const client = new PipelineClient(config); const accounts = new AccountStore(sql, config);
  return sql.begin(async transaction => {
    await lockOwner(transaction as Database, row.owner_id, false);
    const [account] = await transaction`SELECT * FROM accounts WHERE id=${row.account_id} AND owner_id=${row.owner_id} FOR UPDATE`;
    await transaction`SELECT id FROM documents WHERE id=${row.document_id} AND owner_id=${row.owner_id} FOR UPDATE`;
    const [current] = await transaction`SELECT * FROM jobs WHERE id=${row.id} AND owner_id=${row.owner_id} FOR UPDATE`;
    if (current.worker_job_id || current.status !== "submitting") return current;
    try { await lockOwner(transaction as Database, row.owner_id); await accounts.writable(transaction as Database, row.owner_id, row.account_id); }
    catch {
      const [failed] = await transaction`UPDATE jobs SET status='failed',step='failed',error_code='account_disabled',updated_at=now() WHERE id=${row.id} RETURNING *`;
      return failed;
    }
    if (account.credential_revision !== current.account_revision) {
      const [failed] = await transaction`UPDATE jobs SET status='failed',step='failed',error_code='account_version_conflict',updated_at=now() WHERE id=${row.id} RETURNING *`;
      return failed;
    }
    try {
      const input = frozenInput(current);
      await client.requireLookup();
      if (input.operation === "preview") await client.requirePreview();
      if (input.articleStyle) await client.requireArticleStyle(input.articleStyle.schemaVersion);
      if (input.coverSnapshot) await client.requireCover(input.coverSnapshot.schemaVersion);
      const credential = await new AccountStore(transaction as Database, config).credentials(row.owner_id, row.account_id, row.account_revision);
      await client.register(credential);
      await transaction`UPDATE accounts SET synced_revision=${credential.revision!},synced_at=now() WHERE id=${account.id}`;
      if (input.articleSnapshot) for (const asset of await storedBodyAssets(transaction as Database, config, row.owner_id, input.articleSnapshot)) await client.uploadAsset(asset);
      if (input.coverSnapshot?.schemaVersion === 2) {
        const asset = await new BodyAssetStore(transaction as Database, config.dataDir).get(row.owner_id, input.coverSnapshot.renderedAsset.id);
        if (asset.identity.sha256 !== input.coverSnapshot.renderedAsset.sha256) throw new PipelineError("worker_asset_unavailable");
        await client.uploadAsset(asset);
      }
      return await applyWorkerJob(transaction as Database, current, await client.submit(input));
    } catch (error) { return unknownJob(transaction as Database, current, error instanceof PipelineError ? error.code : "worker_result_unknown"); }
  });
}
