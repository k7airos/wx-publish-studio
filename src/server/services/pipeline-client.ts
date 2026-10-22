import type { AccountConfig, AppConfig } from "../config";
import type { ArticleStyleSnapshot } from "@akairos/pipeline/article-style";
import type { CoverSnapshot } from "@akairos/pipeline/cover-snapshot";
import { ARTICLE_COVER_FONT } from "@akairos/typeset-studio/cover";
import type { ArticleSnapshot } from "@akairos/pipeline/article-snapshot";

// Worker 响应仅在此边界解析，原始错误、路径与凭据不进入用户 DTO。
export class PipelineError extends Error {
  constructor(readonly code: string) { super(code); }
}

export interface DraftInput {
  idempotencyKey: string;
  title: string;
  body: string;
  contentForm: "article";
  account: string;
  articleStyle?: ArticleStyleSnapshot;
  coverSnapshot?: CoverSnapshot;
  operation?: "preview";
  articleSnapshot?: ArticleSnapshot;
}

export class PipelineClient {
  constructor(private config: AppConfig) {}

  private async request(path: string, method = "GET", body?: unknown): Promise<any> {
    let response: Response;
    try {
      response = await fetch(`${this.config.workerUrl}${path}`, {
        method,
        headers: { Authorization: `Bearer ${this.config.workerToken}`, "Content-Type": "application/json" },
        ...(body ? { body: JSON.stringify(body) } : {}), signal: AbortSignal.timeout(10_000),
      });
    } catch { throw new PipelineError("worker_result_unknown"); }
    if (!response.ok) throw new PipelineError(response.status === 409 ? "worker_conflict" : "worker_unavailable");
    try { return await response.json(); }
    catch { throw new PipelineError("worker_result_unknown"); }
  }

  async register(account: AccountConfig) {
    await this.request(`/v1/accounts/${encodeURIComponent(account.workerAccount || account.id)}`, "PUT", {
      appId: account.appId, appSecret: account.appSecret, pat: this.config.relayPat || account.pat,
    });
  }

  submit(input: DraftInput) { return this.request("/v1/jobs", "POST", input); }

  async requireArticleStyle(version = 1) {
    const health = await this.request("/health");
    if (!Array.isArray(health.capabilities?.articleStyleSchemaVersions) || !health.capabilities.articleStyleSchemaVersions.includes(version)) throw new PipelineError("worker_article_style_unsupported");
  }

  async requireCover(version = 1) {
    const health = await this.request("/health");
    if (!Array.isArray(health.capabilities?.coverSnapshotSchemaVersions) || !health.capabilities.coverSnapshotSchemaVersions.includes(version)
      || version === 1 && (!Array.isArray(health.capabilities?.articleCoverFonts) || !health.capabilities.articleCoverFonts.some((font: any) => font.id === ARTICLE_COVER_FONT.id && font.sha256 === ARTICLE_COVER_FONT.sha256))) throw new PipelineError("worker_cover_unsupported");
  }

  get(id: string) { return this.request(`/v1/jobs/${encodeURIComponent(id)}`); }

  async lookup(idempotencyKey: string, account: string) {
    let response: Response;
    try { response = await fetch(`${this.config.workerUrl}/v1/jobs/by-idempotency-key?${new URLSearchParams({ idempotencyKey, account })}`, { headers: { Authorization: `Bearer ${this.config.workerToken}` }, signal: AbortSignal.timeout(10_000) }); }
    catch { throw new PipelineError("worker_result_unknown"); }
    if (response.status === 404) return null;
    if (!response.ok) throw new PipelineError(response.status === 409 ? "worker_conflict" : "worker_result_unknown");
    try { return await response.json(); } catch { throw new PipelineError("worker_result_unknown"); }
  }

  async requirePreview() {
    const health = await this.request("/health");
    if (!Array.isArray(health.capabilities?.articleSnapshotSchemaVersions) || !health.capabilities.articleSnapshotSchemaVersions.includes(1)
      || health.capabilities.previewConfirm !== true || health.capabilities.bodyAssetUpload !== true) throw new PipelineError("worker_preview_unsupported");
  }

  async requireLookup() {
    const health = await this.request("/health");
    if (health.capabilities?.jobLookupByIdempotencyKey !== true) throw new PipelineError("worker_lookup_unsupported");
  }

  async uploadAsset(asset: { identity: { sha256: string; contentType: string; byteLength: number }; bytes: Buffer }) {
    let response: Response;
    try {
      response = await fetch(`${this.config.workerUrl}/v1/assets/${asset.identity.sha256}`, { method: "PUT", headers: { Authorization: `Bearer ${this.config.workerToken}`, "Content-Type": asset.identity.contentType }, body: new Uint8Array(asset.bytes), signal: AbortSignal.timeout(30_000) });
    } catch { throw new PipelineError("worker_asset_unavailable"); }
    if (!response.ok) throw new PipelineError("worker_asset_unavailable");
    const result = await response.json() as any;
    if (result.sha256 !== asset.identity.sha256 || result.contentType !== asset.identity.contentType || result.byteLength !== asset.identity.byteLength) throw new PipelineError("worker_asset_unavailable");
  }

  async requireDiscard() {
    const health = await this.request("/health");
    if (health.capabilities?.previewDiscard !== true) throw new PipelineError("worker_preview_discard_unsupported");
  }

  discard(id: string) { return this.request(`/v1/jobs/${encodeURIComponent(id)}/discard`, "POST"); }

  confirm(id: string, snapshotHash: string, artifactManifestHash: string) { return this.request(`/v1/jobs/${encodeURIComponent(id)}/publish`, "POST", { snapshotHash, artifactManifestHash }); }

  async artifact(id: string, key: string, byteLength: number) {
    let response: Response;
    try { response = await fetch(`${this.config.workerUrl}/v1/jobs/${encodeURIComponent(id)}/artifacts/${encodeURIComponent(key)}`, { headers: { Authorization: `Bearer ${this.config.workerToken}` }, signal: AbortSignal.timeout(30_000) }); }
    catch { throw new PipelineError("worker_artifact_unavailable"); }
    if (!response.ok || !response.body || Number(response.headers.get("content-length") || 0) > byteLength) throw new PipelineError("worker_artifact_unavailable");
    const reader = response.body.getReader(); const chunks: Uint8Array[] = []; let length = 0;
    try {
      while (true) {
        const item = await reader.read(); if (item.done) break;
        length += item.value.byteLength; if (length > byteLength) throw new PipelineError("worker_artifact_unavailable"); chunks.push(item.value);
      }
    } finally { await reader.cancel().catch(() => {}); }
    if (length !== byteLength) throw new PipelineError("worker_artifact_unavailable");
    return Buffer.concat(chunks);
  }
}
