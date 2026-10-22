import { Hono } from "hono";
import type { AppEnv } from "../auth/bootstrap";
import type { Database } from "../db/schema";
import { StyleError, StyleStore, styleDto } from "../services/style-store";
import { UUID } from "./documents";

export function styleRoutes(sql: Database) {
  const router = new Hono<AppEnv>();
  const store = new StyleStore(sql);
  router.onError((error, c) => c.json({ error: error instanceof StyleError ? error.code : "style_operation_failed" }, error instanceof StyleError ? error.code === "style_revision_conflict" ? 409 : 400 : 500));
  router.get("/", async c => c.json({ styles: (await store.list(c.get("ownerId"))).map(styleDto) }));
  router.post("/", async c => c.json(await store.create(c.get("ownerId"), await c.req.json().catch(() => null)), 201));
  router.get("/:id/revisions/:revision", async c => {
    if (!UUID.test(c.req.param("id")) || !/^\d+$/.test(c.req.param("revision"))) return c.json({ error: "style_not_found" }, 404);
    return c.json(await store.get(c.get("ownerId"), c.req.param("id"), Number(c.req.param("revision"))));
  });
  router.put("/:id", async c => {
    if (!UUID.test(c.req.param("id"))) return c.json({ error: "style_not_found" }, 404);
    return c.json(await store.update(c.get("ownerId"), c.req.param("id"), await c.req.json().catch(() => null)));
  });
  return router;
}
