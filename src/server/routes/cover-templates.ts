import { Hono } from "hono";
import { coverDecorBytes, isCoverDecor } from "../services/cover-decor";
import type { AppEnv } from "../auth/bootstrap";
import type { Database } from "../db/schema";
import type { AppConfig } from "../config";
import { CoverStore } from "../services/cover-store";
import { CoverError } from "../services/asset-store";
import { UUID } from "./documents";
import { PreviewError } from "../services/body-asset-store";
import { LimitError, withOperation } from "../services/owner-limits";

export function coverTemplateRoutes(sql: Database, config: AppConfig) {
  const router = new Hono<AppEnv>();
  const store = new CoverStore(sql, config);
  router.onError((error, c) => c.json({ error: error instanceof CoverError || error instanceof PreviewError || error instanceof LimitError ? error.code : "cover_operation_failed" }, error instanceof LimitError ? 429 : error instanceof CoverError || error instanceof PreviewError ? error.code === "cover_revision_conflict" ? 409 : 400 : 500));
  router.get("/catalog", c => c.json(store.catalog(c.get("ownerId"))));
  router.post("/preview", async c => {
    const input = await c.req.json().catch(() => null);
    if (!input || typeof input.title !== "string" || !input.title.trim() || input.title.length > 255 || Object.keys(input).some(key => !["config", "title"].includes(key))) return c.json({ error: "invalid_cover_preview" }, 400);
    const png = await withOperation(sql, c.get("ownerId"), "canvas", () => store.previewConfig(c.get("ownerId"), input.config, input.title));
    return new Response(new Uint8Array(png), { headers: { "Content-Type": "image/png", "Cache-Control": "private, no-store" } });
  });
  // 内置装饰底图公开给本人浏览器显示，内容随 id 固定。
  router.get("/decor/:id", c => {
    if (!isCoverDecor(c.req.param("id"))) return c.json({ error: "cover_template_not_found" }, 404);
    return new Response(new Uint8Array(coverDecorBytes(c.req.param("id"))), { headers: { "Content-Type": "image/png", "Cache-Control": "private, max-age=31536000, immutable" } });
  });
  router.post("/default/preview", async c => {
    const input = await c.req.json().catch(() => null);
    if (typeof input?.title !== "string" || !input.title.trim() || input.title.length > 255 || Object.keys(input).some(key => key !== "title")) return c.json({ error: "invalid_cover_preview" }, 400);
    const png = await withOperation(sql, c.get("ownerId"), "canvas", () => store.previewDefault(input.title.trim()));
    return new Response(new Uint8Array(png), { headers: { "Content-Type": "image/png", "Cache-Control": "private, no-store" } });
  });
  router.get("/", async c => c.json({ templates: await store.list(c.get("ownerId")) }));
  router.post("/", async c => c.json(await store.create(c.get("ownerId"), await c.req.json().catch(() => null)), 201));
  router.put("/:id", async c => {
    if (!UUID.test(c.req.param("id"))) return c.json({ error: "cover_template_not_found" }, 404);
    return c.json(await store.update(c.get("ownerId"), c.req.param("id"), await c.req.json().catch(() => null)));
  });
  router.get("/:id/revisions/:revision", async c => {
    if (!UUID.test(c.req.param("id")) || !/^\d+$/.test(c.req.param("revision"))) return c.json({ error: "cover_template_not_found" }, 404);
    return c.json(await store.get(c.get("ownerId"), c.req.param("id"), Number(c.req.param("revision"))));
  });
  router.post("/:id/revisions/:revision/preview", async c => {
    const input = await c.req.json().catch(() => null);
    if (!UUID.test(c.req.param("id")) || !/^\d+$/.test(c.req.param("revision")) || typeof input?.title !== "string" || !input.title.trim() || input.title.length > 255
      || Object.keys(input).some(key => key !== "title")) return c.json({ error: "invalid_cover_preview" }, 400);
    const png = await withOperation(sql, c.get("ownerId"), "canvas", () => store.preview(c.get("ownerId"), c.req.param("id"), Number(c.req.param("revision")), input.title.trim()));
    return new Response(new Uint8Array(png), { headers: { "Content-Type": "image/png", "Cache-Control": "private, no-store" } });
  });
  return router;
}
