import { Hono } from "hono";
import type { AppEnv } from "../auth/bootstrap";
import type { Database } from "../db/schema";
import type { AppConfig } from "../config";
import { AssetStore, CoverError } from "../services/asset-store";
import { UUID } from "./documents";
import { BodyAssetStore, PreviewError } from "../services/body-asset-store";
import { LimitError, withOperation } from "../services/owner-limits";

export function assetRoutes(sql: Database, config: AppConfig) {
  const router = new Hono<AppEnv>();
  const store = new AssetStore(sql, config.dataDir);
  const bodyAssets = new BodyAssetStore(sql, config.dataDir);
  router.onError((error, c) => c.json({ error: error instanceof CoverError || error instanceof PreviewError || error instanceof LimitError ? error.code : "cover_asset_failed" }, error instanceof LimitError ? 429 : error instanceof CoverError || error instanceof PreviewError ? 400 : 500));
  router.post("/body", async c => {
    const data = await c.req.formData(); const file = data.get("image");
    if (!(file instanceof File) || [...data.keys()].some(key => key !== "image")) return c.json({ error: "invalid_body_image" }, 400);
    return c.json(await withOperation(sql, c.get("ownerId"), "upload", () => bodyAssets.upload(c.get("ownerId"), file)), 201);
  });
  router.get("/body/:id", async c => {
    if (!UUID.test(c.req.param("id"))) return c.json({ error: "body_asset_not_found" }, 404);
    const asset = await bodyAssets.get(c.get("ownerId"), c.req.param("id"));
    return new Response(new Uint8Array(asset.bytes), { headers: { "Content-Type": asset.identity.contentType, "Cache-Control": "private, no-store", "X-Content-Type-Options": "nosniff" } });
  });
  router.post("/", async c => {
    const data = await c.req.formData();
    const file = data.get("image");
    if (!(file instanceof File) || [...data.keys()].some(key => key !== "image")) return c.json({ error: "invalid_cover_image" }, 400);
    return c.json(await withOperation(sql, c.get("ownerId"), "upload", () => store.upload(c.get("ownerId"), file)), 201);
  });
  router.get("/:id", async c => {
    if (!UUID.test(c.req.param("id"))) return c.json({ error: "cover_asset_not_found" }, 404);
    const asset = await store.get(c.get("ownerId"), c.req.param("id"));
    return new Response(new Uint8Array(asset.bytes), { headers: { "Content-Type": "image/jpeg", "Cache-Control": "private, no-store", "X-Content-Type-Options": "nosniff" } });
  });
  return router;
}
