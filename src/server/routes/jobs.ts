import { Hono } from "hono";
import type { AppEnv } from "../auth/bootstrap";
import type { AppConfig } from "../config";
import type { Database } from "../db/schema";
import { PipelineClient, PipelineError } from "../services/pipeline-client";
import { UUID } from "./documents";
import { AccountError } from "../services/account-store";
import { StyleError } from "../services/style-store";
import { CoverError } from "../services/asset-store";
import { PreviewError } from "../services/body-asset-store";
import { LimitError } from "../services/owner-limits";
import { createJob } from "../services/job-create";
import { dispatchNewJob, refreshJob } from "../services/job-execution";
export { applyWorkerJob } from "../services/job-execution";

export const jobDto = (row: any) => ({
  id: row.id, documentId: row.document_id, documentRevision: row.document_revision,
  accountId: row.account_id, status: row.status, step: row.step,
  error: row.error_code, draftMediaId: row.draft_media_id,
  simulated: row.simulated === true,
  articleStyleHash: row.article_style_hash ?? null,
  articleThemeHash: row.article_theme_hash ?? null,
  coverSnapshotHash: row.cover_snapshot_hash ?? null, coverAssetHash: row.cover_asset_hash ?? null, coverFontHash: row.cover_font_hash ?? null,
  operation: row.operation || "direct", inputHash: row.input_hash ?? null, snapshotHash: row.snapshot_hash ?? null,
  artifactManifestHash: row.artifact_manifest_hash ?? null, artifactManifest: row.artifact_manifest ?? null, publicationRequested: row.publication_requested === true,
  authorizationRevoked: row.authorization_revoked === true,
  createdAt: row.created_at, updatedAt: row.updated_at,
});

export function jobRoutes(sql: Database, config: AppConfig) {
  const router = new Hono<AppEnv>(); const client = new PipelineClient(config);
  router.onError((error, c) => c.json({ error: error instanceof AccountError || error instanceof PipelineError || error instanceof StyleError || error instanceof CoverError || error instanceof PreviewError || error instanceof LimitError ? error.code : "job_operation_failed" }, error instanceof LimitError ? 429 : error instanceof PipelineError ? 502 : error instanceof PreviewError && error.code === "revision_conflict" ? 409 : error instanceof AccountError || error instanceof StyleError || error instanceof CoverError || error instanceof PreviewError ? 400 : 500));
  router.get("/", async c => c.json({ jobs: (await sql`SELECT * FROM jobs WHERE owner_id=${c.get("ownerId")} ORDER BY created_at DESC LIMIT 100`).map(jobDto) }));
  router.post("/", async c => {
    const input = await c.req.json().catch(() => null);
    if (typeof input?.accountId !== "string") return c.json({ error: "invalid_account" }, 400);
    if (!UUID.test(input?.documentId ?? "") || !Number.isInteger(input?.revision)) return c.json({ error: "invalid_document" }, 400);
    const created = await createJob(sql, config, c.get("ownerId"), input, false); let row = created.row;
    if (row.operation === "preview") return c.json({ error: "job_operation_conflict", job: jobDto(row) }, 409);
    if (row.simulated !== (config.simulation === true)) return c.json({ error: "execution_environment_mismatch" }, 409);
    row = created.inserted ? await dispatchNewJob(sql, config, row) : await refreshJob(sql, client, row);
    return c.json(jobDto(row), created.inserted ? 201 : 200);
  });
  router.get("/:id", async c => {
    if (!UUID.test(c.req.param("id"))) return c.json({ error: "not_found" }, 404);
    let [row] = await sql`SELECT * FROM jobs WHERE id=${c.req.param("id")} AND owner_id=${c.get("ownerId")}`;
    if (!row) return c.json({ error: "not_found" }, 404);
    if (row.simulated !== (config.simulation === true)) return c.json(jobDto({ ...row, error_code: "execution_environment_mismatch" }));
    row = await refreshJob(sql, client, row);
    return c.json(jobDto(row));
  });
  return router;
}
