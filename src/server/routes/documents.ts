import { Hono } from "hono";
import { randomUUID } from "node:crypto";
import type { AppEnv } from "../auth/bootstrap";
import type { Database } from "../db/schema";
import { documentArticleStyle, documentCover } from "../services/job-snapshot";
import { StyleError, StyleStore } from "../services/style-store";
import type { AppConfig } from "../config";
import { CoverStore } from "../services/cover-store";
import { CoverError } from "../services/asset-store";
import { DocumentImages } from "../services/document-images";
import { PreviewError } from "../services/body-asset-store";
import { LimitError, withOperation } from "../services/owner-limits";

export const UUID = /^[a-f\d]{8}(-[a-f\d]{4}){3}-[a-f\d]{12}$/i;
/** 文章卡片摘要：去掉 Markdown 标记后的前 90 个字。 */
export function documentExcerpt(body: string) {
  return body.replace(/```[\s\S]*?```/g, " ").replace(/!\[[^\]]*\]\([^)]*\)/g, " ").replace(/\[([^\]]*)\]\([^)]*\)/g, "$1")
    .replace(/\[![A-Z]+\]/g, "").replace(/^\s{0,3}(#{1,6}|>|[-*+]|\d+\.)\s+/gm, "").replace(/[*_`~|]|<[^>]+>/g, "").replace(/\s+/g, " ").trim().slice(0, 90);
}

export const documentDto = (row: any) => ({
  id: row.id, title: row.title, body: row.body, revision: row.revision, updatedAt: row.updated_at, archived: !!row.archived_at,
  styleId: row.style_id ?? null, styleRevision: row.style_revision ?? null,
  coverTemplateId: row.cover_template_id ?? null, coverTemplateRevision: row.cover_template_revision ?? null,
});

function validDocument(input: any) {
  return typeof input?.title === "string" && !!input.title.trim() && input.title.length <= 255
    && typeof input.body === "string" && Buffer.byteLength(input.body, "utf8") <= 2_000_000;
}

export function documentRoutes(sql: Database, config: AppConfig) {
  const router = new Hono<AppEnv>();
  const styles = new StyleStore(sql);
  const covers = new CoverStore(sql, config);
  router.onError((error, c) => c.json({ error: error instanceof StyleError || error instanceof CoverError || error instanceof PreviewError || error instanceof LimitError ? error.code : "document_operation_failed", ...(error instanceof PreviewError && error.details ? { images: error.details } : {}) }, error instanceof LimitError ? 429 : error instanceof PreviewError && error.code === "revision_conflict" ? 409 : error instanceof StyleError || error instanceof CoverError || error instanceof PreviewError ? 400 : 500));
  const dto = async (owner: string, row: any) => ({ ...documentDto(row), articleStyle: await documentArticleStyle(sql, owner, row), coverTemplate: await documentCover(sql, config, owner, row) });
  router.get("/", async c => {
    // 默认只列出未归档文章；?archived=1 只列已归档。
    const archived = c.req.query("archived") === "1";
    const rows = await sql`SELECT id,title,revision,updated_at,archived_at,left(body,4000) AS head FROM documents
      WHERE owner_id=${c.get("ownerId")} AND (archived_at IS NOT NULL)=${archived} ORDER BY updated_at DESC`;
    return c.json({ documents: rows.map((row: any) => ({ id: row.id, title: row.title, revision: row.revision, updatedAt: row.updated_at, archived: !!row.archived_at, excerpt: documentExcerpt(row.head) })) });
  });
  router.post("/", async c => {
    const input = await c.req.json().catch(() => null);
    if (!validDocument(input)) return c.json({ error: "invalid_document" }, 400);
    await new DocumentImages(sql, config).validateManaged(c.get("ownerId"), input.body);
    const row = await sql.begin(async transaction => {
      const [defaults] = await transaction`SELECT * FROM owner_configuration_defaults WHERE owner_id=${c.get("ownerId")}`;
      const [created] = await transaction`INSERT INTO documents (id,owner_id,title,body,style_id,style_revision,cover_template_id,cover_template_revision)
        VALUES (${randomUUID()},${c.get("ownerId")},${input.title},${input.body},${defaults?.style_id ?? null},${defaults?.style_revision ?? null},${defaults?.cover_template_id ?? null},${defaults?.cover_template_revision ?? null}) RETURNING *`;
      return created;
    });
    return c.json(await dto(c.get("ownerId"), row), 201);
  });
  router.get("/:id", async c => {
    if (!UUID.test(c.req.param("id"))) return c.json({ error: "not_found" }, 404);
    const [row] = await sql`SELECT * FROM documents WHERE id=${c.req.param("id")} AND owner_id=${c.get("ownerId")}`;
    return row ? c.json(await dto(c.get("ownerId"), row)) : c.json({ error: "not_found" }, 404);
  });
  // 内容不变时显式开启新修订：上一份预览已放弃、过期或失败后，同一内容可以重新预览。
  router.post("/:id/revision", async c => {
    const input = await c.req.json().catch(() => null);
    if (!UUID.test(c.req.param("id")) || !Number.isInteger(input?.expectedRevision) || Object.keys(input).length !== 1) return c.json({ error: "invalid_document" }, 400);
    const [row] = await sql`UPDATE documents SET revision=revision+1,updated_at=now()
      WHERE id=${c.req.param("id")} AND owner_id=${c.get("ownerId")} AND revision=${input.expectedRevision} RETURNING *`;
    return row ? c.json(await dto(c.get("ownerId"), row)) : c.json({ error: "revision_conflict" }, 409);
  });
  // 归档只改可见性，不改修订号，已有预览与任务不受影响。
  router.put("/:id/archive", async c => {
    const input = await c.req.json().catch(() => null);
    if (!UUID.test(c.req.param("id")) || typeof input?.archived !== "boolean" || Object.keys(input).length !== 1) return c.json({ error: "invalid_document" }, 400);
    const [row] = await sql`UPDATE documents SET archived_at=${input.archived ? new Date() : null}
      WHERE id=${c.req.param("id")} AND owner_id=${c.get("ownerId")} RETURNING *`;
    return row ? c.json(await dto(c.get("ownerId"), row)) : c.json({ error: "not_found" }, 404);
  });
  router.get("/:id/images", async c => {
    if (!UUID.test(c.req.param("id"))) return c.json({ error: "not_found" }, 404);
    const [doc] = await sql`SELECT * FROM documents WHERE id=${c.req.param("id")} AND owner_id=${c.get("ownerId")}`;
    return doc ? c.json({ revision: doc.revision, items: new DocumentImages(sql, config).scan(doc.body, c.get("ownerId")) }) : c.json({ error: "not_found" }, 404);
  });
  router.post("/:id/image-import", async c => {
    const input = await c.req.json().catch(() => null);
    if (!UUID.test(c.req.param("id")) || !Number.isInteger(input?.expectedRevision) || Object.keys(input).some(key => key !== "expectedRevision")) return c.json({ error: "invalid_document" }, 400);
    const row = await withOperation(sql, c.get("ownerId"), "import", () => new DocumentImages(sql, config).import(c.get("ownerId"), c.req.param("id"), input.expectedRevision));
    return c.json(await dto(c.get("ownerId"), row));
  });
  router.put("/:id", async c => {
    const input = await c.req.json().catch(() => null);
    if (!UUID.test(c.req.param("id")) || !validDocument(input) || !Number.isInteger(input.expectedRevision)) return c.json({ error: "invalid_document" }, 400);
    await new DocumentImages(sql, config).validateManaged(c.get("ownerId"), input.body);
    const [row] = await sql`UPDATE documents SET title=${input.title},body=${input.body},
      revision=revision + CASE WHEN title=${input.title} AND body=${input.body} THEN 0 ELSE 1 END,updated_at=now()
      WHERE id=${c.req.param("id")} AND owner_id=${c.get("ownerId")} AND revision=${input.expectedRevision} RETURNING *`;
    return row ? c.json(await dto(c.get("ownerId"), row)) : c.json({ error: "revision_conflict" }, 409);
  });
  router.put("/:id/style", async c => {
    const input = await c.req.json().catch(() => null);
    if (!UUID.test(c.req.param("id")) || !Number.isInteger(input?.expectedRevision)
      || !(input.styleId === null && input.styleRevision === null || UUID.test(input.styleId ?? "") && Number.isInteger(input.styleRevision) && input.styleRevision > 0)) return c.json({ error: "invalid_style_reference" }, 400);
    if (input.styleId) await styles.get(c.get("ownerId"), input.styleId, input.styleRevision);
    const [row] = await sql`UPDATE documents SET style_id=${input.styleId},style_revision=${input.styleRevision},
      revision=revision + CASE WHEN style_id IS NOT DISTINCT FROM ${input.styleId}::uuid AND style_revision IS NOT DISTINCT FROM ${input.styleRevision}::integer THEN 0 ELSE 1 END,updated_at=now()
      WHERE id=${c.req.param("id")} AND owner_id=${c.get("ownerId")} AND revision=${input.expectedRevision} RETURNING *`;
    return row ? c.json(await dto(c.get("ownerId"), row)) : c.json({ error: "revision_conflict" }, 409);
  });
  router.put("/:id/cover", async c => {
    const input = await c.req.json().catch(() => null);
    if (!UUID.test(c.req.param("id")) || !Number.isInteger(input?.expectedRevision)
      || !(input.templateId === null && input.templateRevision === null || UUID.test(input.templateId ?? "") && Number.isInteger(input.templateRevision) && input.templateRevision > 0)) return c.json({ error: "invalid_cover_reference" }, 400);
    if (input.templateId) {
      const template = await covers.get(c.get("ownerId"), input.templateId, input.templateRevision);
      if (template.schemaVersion === 2 && template.slot !== "article_cover") throw new CoverError("invalid_cover_reference");
      const [doc] = await sql`SELECT title FROM documents WHERE id=${c.req.param("id")} AND owner_id=${c.get("ownerId")} AND revision=${input.expectedRevision}`;
      if (!doc) return c.json({ error: "revision_conflict" }, 409);
      await withOperation(sql, c.get("ownerId"), "canvas", () => covers.layout(c.get("ownerId"), input.templateId, input.templateRevision, doc.title));
    }
    const [row] = await sql`UPDATE documents SET cover_template_id=${input.templateId},cover_template_revision=${input.templateRevision},
      revision=revision + CASE WHEN cover_template_id IS NOT DISTINCT FROM ${input.templateId}::uuid AND cover_template_revision IS NOT DISTINCT FROM ${input.templateRevision}::integer THEN 0 ELSE 1 END,updated_at=now()
      WHERE id=${c.req.param("id")} AND owner_id=${c.get("ownerId")} AND revision=${input.expectedRevision} RETURNING *`;
    return row ? c.json(await dto(c.get("ownerId"), row)) : c.json({ error: "revision_conflict" }, 409);
  });
  return router;
}
