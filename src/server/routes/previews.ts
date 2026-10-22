import { createHash } from "node:crypto";
import { Hono } from "hono";
import { validateArtifactManifest } from "@akairos/pipeline/article-snapshot";
import type { AppEnv } from "../auth/bootstrap";
import type { AppConfig } from "../config";
import type { Database } from "../db/schema";
import { AccountError, AccountStore } from "../services/account-store";
import { PipelineClient, PipelineError } from "../services/pipeline-client";
import { PreviewError } from "../services/body-asset-store";
import { CoverError } from "../services/asset-store";
import { StyleError } from "../services/style-store";
import { jobDto } from "./jobs";
import { createJob } from "../services/job-create";
import { applyWorkerJob, dispatchNewJob, refreshJob, unknownJob } from "../services/job-execution";
import { LimitError, lockOwner, requireJobCapacity } from "../services/owner-limits";
import { UUID } from "./documents";

export function previewRoutes(sql: Database, config: AppConfig) {
  const router = new Hono<AppEnv>();
  const client = new PipelineClient(config); const accounts = new AccountStore(sql, config);
  router.onError((error, c) => c.json({ error: error instanceof PreviewError || error instanceof PipelineError || error instanceof AccountError || error instanceof CoverError || error instanceof StyleError || error instanceof LimitError ? error.code : "preview_operation_failed", ...(error instanceof PreviewError && error.details ? { images: error.details } : {}) }, error instanceof LimitError ? 429 : error instanceof PipelineError ? 502 : error instanceof PreviewError && ["revision_conflict", "preview_confirmation_conflict", "preview_already_confirmed", "preview_not_ready"].includes(error.code) ? 409 : error instanceof PreviewError || error instanceof AccountError || error instanceof CoverError || error instanceof StyleError ? 400 : 500));

  router.post("/previews", async c => {
    const input = await c.req.json().catch(() => null); const owner = c.get("ownerId");
    if (!UUID.test(input?.documentId || "") || !Number.isInteger(input?.revision) || typeof input?.accountId !== "string") return c.json({ error: "invalid_document" }, 400);
    const created = await createJob(sql, config, owner, input, true); let row = created.row;
    if (row.operation !== "preview") return c.json({ error: "job_operation_conflict", job: jobDto(row) }, 409);
    if (row.simulated !== (config.simulation === true)) return c.json({ error: "execution_environment_mismatch" }, 409);
    row = created.inserted ? await dispatchNewJob(sql, config, row) : await refreshJob(sql, client, row);
    return c.json(jobDto(row), created.inserted ? 201 : 200);
  });

  // 产品确认与 Worker 接受分别落账；停用后只读取原接受身份。
  router.post("/jobs/:id/publish", async c => {
    const input = await c.req.json().catch(() => null); const owner = c.get("ownerId");
    if (!UUID.test(c.req.param("id")) || !/^[a-f\d]{64}$/.test(input?.snapshotHash || "") || !/^[a-f\d]{64}$/.test(input?.artifactManifestHash || "") || Object.keys(input).some(key => !["snapshotHash", "artifactManifestHash"].includes(key))) return c.json({ error: "preview_confirmation_conflict" }, 409);
    const confirmation = await sql.begin(async transaction => {
      await lockOwner(transaction as Database, owner);
      const [identity] = await transaction`SELECT document_id,account_id FROM jobs WHERE id=${c.req.param("id")} AND owner_id=${owner}`;
      if (!identity) throw new PreviewError("preview_not_found");
      // 先锁账号但暂不要求 active，历史结果仍可读取。
      await transaction`SELECT id FROM accounts WHERE id=${identity.account_id} AND owner_id=${owner} FOR UPDATE`;
      const [doc] = await transaction`SELECT revision FROM documents WHERE id=${identity.document_id} AND owner_id=${owner} FOR UPDATE`;
      const [job] = await transaction`SELECT * FROM jobs WHERE id=${c.req.param("id")} AND owner_id=${owner} FOR UPDATE`;
      if (!job || job.operation !== "preview" || !job.worker_job_id || job.snapshot_hash !== input.snapshotHash || job.artifact_manifest_hash !== input.artifactManifestHash) throw new PreviewError("preview_confirmation_conflict");
      if (job.simulated !== (config.simulation === true)) throw new PreviewError("execution_environment_mismatch");
      try { validateArtifactManifest(job.artifact_manifest, job.artifact_manifest_hash); } catch { throw new PreviewError("invalid_article_snapshot"); }
      if (job.publication_requested) return { row: job, first: false };
      if (job.authorization_revoked) throw new AccountError("account_authorization_released");
      await accounts.writable(transaction as Database, owner, job.account_id);
      if (job.status !== "preview_ready" || doc?.revision !== job.document_revision) throw new PreviewError("revision_conflict");
      await requireJobCapacity(transaction as Database, owner, false);
      const [accepted] = await transaction`UPDATE jobs SET publication_requested=true,updated_at=now() WHERE id=${job.id} RETURNING *`;
      return { row: accepted, first: true };
    });
    let row = confirmation.row;
    if (!confirmation.first) return c.json(jobDto(await refreshJob(sql, client, row)));
    if (row.status !== "succeeded") {
      row = await sql.begin(async transaction => {
        await lockOwner(transaction as Database, owner);
        await transaction`SELECT id FROM accounts WHERE id=${row.account_id} AND owner_id=${owner} FOR UPDATE`;
        await transaction`SELECT id FROM documents WHERE id=${row.document_id} AND owner_id=${owner} FOR UPDATE`;
        const [current] = await transaction`SELECT * FROM jobs WHERE id=${row.id} AND owner_id=${owner} FOR UPDATE`;
        if (["succeeded", "failed"].includes(current.status)) return current;
        try {
          const worker = await client.get(current.worker_job_id);
          const refreshed = await applyWorkerJob(transaction as Database, current, worker);
          if (refreshed.worker_publication_requested || ["succeeded", "failed"].includes(refreshed.status)) return refreshed;
          // 只有拿到首次确认占位的请求能发送一次；重复请求永远只读。
          if (worker.status !== "preview_ready") return refreshed;
          try { await accounts.writable(transaction as Database, owner, current.account_id); }
          catch (error) {
            if (!(error instanceof AccountError)) throw error;
            const [failed] = await transaction`UPDATE jobs SET status='failed',step='failed',error_code='account_disabled',updated_at=now() WHERE id=${current.id} RETURNING *`;
            return failed;
          }
          return await applyWorkerJob(transaction as Database, refreshed, await client.confirm(current.worker_job_id, current.snapshot_hash, current.artifact_manifest_hash));
        } catch { return unknownJob(transaction as Database, current); }
      });
    }
    return c.json(jobDto(row));
  });

  // 放弃本人未确认的预览：与确认使用同一锁序线性化，Worker 关闭后按 failed 同步，不再占额度。
  router.post("/jobs/:id/discard", async c => {
    const owner = c.get("ownerId");
    if (!UUID.test(c.req.param("id"))) return c.json({ error: "preview_not_found" }, 404);
    const row = await sql.begin(async transaction => {
      await lockOwner(transaction as Database, owner);
      const [identity] = await transaction`SELECT document_id,account_id FROM jobs WHERE id=${c.req.param("id")} AND owner_id=${owner}`;
      if (!identity) return null;
      await transaction`SELECT id FROM accounts WHERE id=${identity.account_id} AND owner_id=${owner} FOR UPDATE`;
      await transaction`SELECT id FROM documents WHERE id=${identity.document_id} AND owner_id=${owner} FOR UPDATE`;
      const [job] = await transaction`SELECT * FROM jobs WHERE id=${c.req.param("id")} AND owner_id=${owner} FOR UPDATE`;
      if (!job || job.operation !== "preview") return null;
      if (job.simulated !== (config.simulation === true)) throw new PreviewError("execution_environment_mismatch");
      if (job.status === "failed" && ["preview_discarded", "preview_expired"].includes(job.error_code)) return job;
      if (job.publication_requested) throw new PreviewError("preview_already_confirmed");
      if (!job.worker_job_id || !["accepting", "queued", "preview_ready"].includes(job.status)) throw new PreviewError("preview_not_ready");
      await client.requireDiscard();
      let worker;
      try { worker = await client.discard(job.worker_job_id); }
      catch (error) { throw error instanceof PipelineError && error.code === "worker_conflict" ? new PreviewError("preview_not_ready") : error; }
      return applyWorkerJob(transaction as Database, job, worker);
    });
    // 不存在与他人任务一致返回 404，不泄露归属。
    return row ? c.json(jobDto(row)) : c.json({ error: "preview_not_found" }, 404);
  });

  router.get("/jobs/:id/artifacts/:key", async c => {
    if (!UUID.test(c.req.param("id"))) return c.json({ error: "preview_not_found" }, 404);
    const [row] = await sql`SELECT * FROM jobs WHERE id=${c.req.param("id")} AND owner_id=${c.get("ownerId")}`;
    if (!row || row.operation !== "preview" || !row.worker_job_id || row.simulated !== (config.simulation === true)) return c.json({ error: "preview_not_found" }, 404);
    if (row.pruned_at) return c.json({ error: "preview_pruned" }, 410);
    const manifest = validateArtifactManifest(row.artifact_manifest, row.artifact_manifest_hash);
    const artifact = manifest.artifacts.find(item => item.key === c.req.param("key"));
    if (!artifact) return c.json({ error: "preview_not_found" }, 404);
    const bytes = await client.artifact(row.worker_job_id, artifact.key, artifact.byteLength);
    if (createHash("sha256").update(bytes).digest("hex") !== artifact.sha256) throw new PipelineError("worker_artifact_unavailable");
    return new Response(new Uint8Array(bytes), { headers: { "Content-Type": artifact.contentType, "Cache-Control": "private, no-store", "Content-Security-Policy": "default-src 'none'; script-src 'none'; style-src 'unsafe-inline'; img-src 'none'; base-uri 'none'; form-action 'none'; sandbox" } });
  });
  return router;
}
