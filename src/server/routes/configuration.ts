import { Hono } from "hono";
import type { AppEnv } from "../auth/bootstrap";
import type { AppConfig } from "../config";
import type { Database } from "../db/schema";
import { StyleStore, StyleError } from "../services/style-store";
import { CoverStore } from "../services/cover-store";
import { CoverError } from "../services/asset-store";
import { documentArticleStyle, documentCover } from "../services/job-snapshot";
import { documentDto, UUID } from "./documents";
import { LimitError, withOperation } from "../services/owner-limits";

/** 一次提交文章配置与本人后续默认，冲突时两者都不更新。 */
export function configurationRoutes(sql: Database, config: AppConfig) {
  const router = new Hono<AppEnv>();
  router.onError((error, c) => c.json({ error: error instanceof StyleError || error instanceof CoverError || error instanceof LimitError ? error.code : "configuration_failed" }, error instanceof LimitError ? 429 : error instanceof StyleError || error instanceof CoverError ? 400 : 500));
  router.put("/documents/:id/configuration", async c => {
    const value = await c.req.json().catch(() => null);
    const reference = (id: unknown, revision: unknown) => id === null && revision === null || typeof id === "string" && UUID.test(id) && Number.isInteger(revision) && Number(revision) > 0;
    if (!UUID.test(c.req.param("id")) || !Number.isInteger(value?.expectedRevision)
      || !reference(value?.styleId, value?.styleRevision) || !reference(value?.templateId, value?.templateRevision)
      || Object.keys(value).some(key => !["expectedRevision", "styleId", "styleRevision", "templateId", "templateRevision"].includes(key))) return c.json({ error: "invalid_configuration" }, 400);
    const owner = c.get("ownerId");
    const row = await sql.begin(async transaction => {
      const tx = transaction as Database;
      const [doc] = await tx`SELECT * FROM documents WHERE id=${c.req.param("id")} AND owner_id=${owner} FOR UPDATE`;
      if (!doc || doc.revision !== value.expectedRevision) return null;
      if (value.styleId) await new StyleStore(tx).get(owner, value.styleId, value.styleRevision);
      if (value.templateId) {
        const covers = new CoverStore(tx, config);
        const cover = await covers.get(owner, value.templateId, value.templateRevision);
        if (cover.schemaVersion === 2 && cover.slot !== "article_cover") throw new CoverError("invalid_cover_reference");
        await withOperation(tx, owner, "canvas", () => covers.layout(owner, value.templateId, value.templateRevision, doc.title));
      }
      const [updated] = await tx`UPDATE documents SET style_id=${value.styleId},style_revision=${value.styleRevision},
        cover_template_id=${value.templateId},cover_template_revision=${value.templateRevision},
        revision=revision + CASE WHEN style_id IS NOT DISTINCT FROM ${value.styleId}::uuid AND style_revision IS NOT DISTINCT FROM ${value.styleRevision}::integer
          AND cover_template_id IS NOT DISTINCT FROM ${value.templateId}::uuid AND cover_template_revision IS NOT DISTINCT FROM ${value.templateRevision}::integer THEN 0 ELSE 1 END,
        updated_at=now() WHERE id=${doc.id} RETURNING *`;
      await tx`INSERT INTO owner_configuration_defaults (owner_id,style_id,style_revision,cover_template_id,cover_template_revision)
        VALUES (${owner},${value.styleId},${value.styleRevision},${value.templateId},${value.templateRevision})
        ON CONFLICT (owner_id) DO UPDATE SET style_id=EXCLUDED.style_id,style_revision=EXCLUDED.style_revision,
        cover_template_id=EXCLUDED.cover_template_id,cover_template_revision=EXCLUDED.cover_template_revision,updated_at=now()`;
      return updated;
    });
    if (!row) return c.json({ error: "revision_conflict" }, 409);
    return c.json({ ...documentDto(row), articleStyle: await documentArticleStyle(sql, owner, row), coverTemplate: await documentCover(sql, config, owner, row) });
  });
  return router;
}
