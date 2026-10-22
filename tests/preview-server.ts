import { createHash, randomUUID } from "node:crypto";
import { createArtifactManifest, hashArtifactManifest } from "@akairos/pipeline/article-snapshot";
import { createCanvas } from "@napi-rs/canvas";
import { imageSize } from "image-size";
import { createApp } from "../src/server/app";
import { openDatabase } from "../src/server/db/schema";
import type { AppConfig } from "../src/server/config";
import { initializeAccounts } from "../src/server/services/account-store";
import { ARTICLE_COVER_FONT } from "@akairos/typeset-studio/cover";
import { coverSnapshotIdentity } from "@akairos/pipeline/cover-snapshot";
import { DocumentImages } from "../src/server/services/document-images";
import { loadConfig } from "../src/server/config";

if (process.env.PUBLISHING_TEST_MODE !== "fake-worker") throw new Error("Preview harness requires explicit fake-worker mode");
const workerJobs = new Map<string, any>();
const assets = new Map<string, Buffer>();
const artifacts = new Map<string, Buffer>();
const sha = (bytes: Buffer) => createHash("sha256").update(bytes).digest("hex");
const worker = Bun.serve({ hostname: "127.0.0.1", port: 0, async fetch(request) {
  if (request.headers.get("Authorization") !== `Bearer ${process.env.PIPELINE_WORKER_TOKEN}`) return new Response("Unauthorized", { status: 401 });
  const url = new URL(request.url); const path = url.pathname;
  if (path === "/health") return Response.json({ capabilities: { jobLookupByIdempotencyKey: true, articleStyleSchemaVersions: [1, 2], coverSnapshotSchemaVersions: [1, 2], articleCoverFonts: [{ id: ARTICLE_COVER_FONT.id, sha256: ARTICLE_COVER_FONT.sha256 }], articleSnapshotSchemaVersions: [1], previewConfirm: true, bodyAssetUpload: true } });
  const assetKey = /^\/v1\/assets\/([a-f\d]{64})$/.exec(path)?.[1];
  if (assetKey) {
    const bytes = Buffer.from(await request.arrayBuffer()); assets.set(assetKey, bytes);
    const dimensions = imageSize(bytes);
    return Response.json({ sha256: assetKey, contentType: request.headers.get("Content-Type"), byteLength: bytes.length, width: dimensions.width, height: dimensions.height });
  }
  if (path.startsWith("/v1/accounts/") && request.method === "PUT") return Response.json({ active: true });
  if (path === "/v1/jobs/by-idempotency-key") {
    const job = workerJobs.get(url.searchParams.get("idempotencyKey")!);
    return job && job.input.account === url.searchParams.get("account") ? Response.json(job) : new Response("missing", { status: 404 });
  }
  if (path === "/v1/jobs" && request.method === "POST") {
    const input = await request.json() as any;
    if (input.operation === "preview") {
      if (!workerJobs.has(input.idempotencyKey)) {
        const id = randomUUID(); const cover = input.coverSnapshot?.schemaVersion === 2 ? assets.get(input.coverSnapshot.renderedAsset.sha256)! : await createCanvas(3350, 1000).encode("png");
        const escape = (value: string) => value.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/"/g, "&quot;");
        const images = new DocumentImages(sql, config).scan(input.body);
        // 明确的 UI 替身保留图片顺序/说明；正式排版效果只由真实 Worker 验收。
        const html = Buffer.from(`<section><h2>模拟完整预览（不会创建微信草稿）</h2><p>修订 ${input.articleSnapshot.documentRevision}</p>${images.map(image => `<figure><img style="max-width:100%;height:auto" src="${escape(image.source)}" alt="${escape(image.alt)}" title="${escape(image.title || "")}">${image.title ? `<figcaption>${escape(image.title)}</figcaption>` : ""}</figure>`).join("")}</section>`);
        artifacts.set(`${id}:article`, html); artifacts.set(`${id}:cover`, cover);
        const media = input.articleSnapshot.bodyAssets.map((asset: any) => { artifacts.set(`${id}:media_${asset.id}`, assets.get(asset.sha256)!); return { key: `media_${asset.id}`, kind: "media" as const, contentType: asset.contentType, byteLength: asset.byteLength, sha256: asset.sha256 }; });
        const snapshotHash = "b".repeat(64);
        const artifactManifest = createArtifactManifest({ snapshotHash, artifacts: [
          { key: "article", kind: "html", contentType: "text/html", byteLength: html.length, sha256: sha(html) },
          { key: "cover", kind: "cover", contentType: "image/png", byteLength: cover.length, sha256: sha(cover) }, ...media,
        ], runtime: { pipeline: "fake-worker", myno: "0.4.0", typeset: "0.4.0" } });
        workerJobs.set(input.idempotencyKey, { id, input, bodyHash: sha(Buffer.from(input.body)), status: "preview_ready", step: "preview_ready", result: { inputHash: input.articleSnapshot.inputHash, snapshotHash, artifactManifest, artifactManifestHash: hashArtifactManifest(artifactManifest) } });
      }
      return Response.json(workerJobs.get(input.idempotencyKey));
    }
    if (!workerJobs.has(input.idempotencyKey)) workerJobs.set(input.idempotencyKey, {
      id: randomUUID(), status: "succeeded", step: "done",
      input, bodyHash: sha(Buffer.from(input.body)),
      result: { ...(input.articleStyle ? { articleStyleHash: input.articleStyle.hash, articleThemeHash: "a".repeat(64) } : {}),
        ...(input.coverSnapshot ? coverSnapshotIdentity(input.coverSnapshot) : {}),
        publishResults: [{ account: input.account, status: "success", external_id: "SIMULATED_NOT_A_WECHAT_DRAFT", ...(input.articleStyle ? { article_theme_hash: "a".repeat(64) } : {}) }] },
    });
    return Response.json(workerJobs.get(input.idempotencyKey));
  }
  const job = [...workerJobs.values()].find(job => path.startsWith(`/v1/jobs/${job.id}`));
  if (job && path.endsWith("/publish")) {
    job.status = "succeeded"; job.step = "done"; job.publicationRequested = true;
    job.result.publishResults = [{ account: job.input.account, status: "success", external_id: "SIMULATED_PREVIEW_NOT_A_REAL_DRAFT" }];
    if (job.input.articleStyle) { Object.assign(job.result, { articleStyleHash: job.input.articleStyle.hash, articleThemeHash: "a".repeat(64) }); job.result.publishResults[0].article_theme_hash = "a".repeat(64); }
    if (job.input.coverSnapshot) Object.assign(job.result, coverSnapshotIdentity(job.input.coverSnapshot));
    return Response.json(job);
  }
  if (job && path.includes("/artifacts/")) {
    const bytes = artifacts.get(`${job.id}:${decodeURIComponent(path.split("/artifacts/")[1]!)}`);
    return bytes ? new Response(new Uint8Array(bytes)) : new Response("missing", { status: 404 });
  }
  return job ? Response.json(job) : new Response("missing", { status: 404 });
} });
const config: AppConfig = {
  ...await loadConfig(),
  databaseUrl: process.env.DATABASE_URL!, bootstrapSecret: process.env.BOOTSTRAP_SECRET!,
  appOrigin: process.env.APP_ORIGIN!, workerUrl: worker.url.origin,
  workerToken: process.env.PIPELINE_WORKER_TOKEN!, simulation: true, staticRoot: "./dist",
  credentialEncryptionKey: process.env.CREDENTIAL_ENCRYPTION_KEY!, importAccountsOnce: true,
  dataDir: process.env.PUBLISHING_DATA_DIR, coverFontPath: process.env.TYPESET_ARTICLE_COVER_FONT_PATH,
  bodyImageSources: process.env.PUBLISHING_BODY_IMAGE_SOURCE_ORIGIN ? [{ origin: process.env.PUBLISHING_BODY_IMAGE_SOURCE_ORIGIN, pathPrefix: process.env.PUBLISHING_BODY_IMAGE_SOURCE_PREFIX! }] : [],
  relayPat: "FAKE_SERVICE_PAT",
  accounts: [{ id: "simulated", label: "模拟公众号（不会创建微信草稿）", appId: "FAKE_APP_ID", appSecret: "FAKE_SECRET", pat: "FAKE_PAT" }],
};
const sql = await openDatabase(config.databaseUrl);
await initializeAccounts(sql, config);
const app = createApp(config, sql);
// 人工验收时延迟保存，确认输入和导航在响应到达前被保护。
const server = Bun.serve({ hostname: "0.0.0.0", port: Number(process.env.PORT || 18891), async fetch(request) {
  if (request.method === "PUT" && new URL(request.url).pathname.startsWith("/api/documents/")) await Bun.sleep(1500);
  return app.fetch(request);
} });
console.info(`Explicit fake-worker preview at ${server.url.origin}; no real WeChat calls`);
