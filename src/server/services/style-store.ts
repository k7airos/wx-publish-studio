import { randomUUID } from "node:crypto";
import { createArticleStyleSnapshotV2, validateArticleStyleSnapshot, type ArticleStyleSnapshot } from "@akairos/pipeline/article-style";
import type { Database } from "../db/schema";

export class StyleError extends Error {
  constructor(readonly code: string) { super(code); }
}

export const styleDto = (row: any) => ({
  id: row.id, name: row.name, revision: row.current_revision,
  articleStyle: validateArticleStyleSnapshot(row.article_style), updatedAt: row.updated_at,
});

// 完整排版配置仍由 Pipeline 的版本化合同校验，旧修订按原版本读取。
function snapshot(id: string, revision: number, input: any) {
  if (typeof input?.name !== "string" || !input.name.trim() || input.name.trim().length > 80
    || !input.config || typeof input.config !== "object" || Array.isArray(input.config)
    || Object.keys(input).some(key => !["name", "config", "expectedRevision"].includes(key))
    || Object.keys(input.config).some(key => !["editorVars", "exportTheme", "syntaxPresets", "structure", "css"].includes(key))) throw new StyleError("invalid_style");
  let result: ArticleStyleSnapshot;
  try {
    result = createArticleStyleSnapshotV2({
      ...input.config, css: input.config.css ?? "", schemaVersion: 1, engineVersion: 1, id, name: input.name.trim(), version: "1.0.0",
    }, id, revision);
  } catch { throw new StyleError("invalid_style"); }
  return result;
}

export class StyleStore {
  constructor(private sql: Database) {}

  list(owner: string) {
    return this.sql`SELECT s.*,r.article_style FROM article_styles s JOIN article_style_revisions r ON r.style_id=s.id AND r.revision=s.current_revision WHERE s.owner_id=${owner} ORDER BY s.updated_at DESC`;
  }

  async get(owner: string, id: string, revision?: number): Promise<ArticleStyleSnapshot> {
    const [row] = revision === undefined
      ? await this.sql`SELECT r.article_style FROM article_styles s JOIN article_style_revisions r ON r.style_id=s.id AND r.revision=s.current_revision WHERE s.id=${id} AND s.owner_id=${owner}`
      : await this.sql`SELECT r.article_style FROM article_styles s JOIN article_style_revisions r ON r.style_id=s.id WHERE s.id=${id} AND s.owner_id=${owner} AND r.revision=${revision}`;
    if (!row) throw new StyleError("style_not_found");
    return validateArticleStyleSnapshot(row.article_style);
  }

  async create(owner: string, input: any) {
    const id = randomUUID();
    const articleStyle = snapshot(id, 1, input);
    return this.sql.begin(async transaction => {
      const [row] = await transaction`INSERT INTO article_styles (id,owner_id,name) VALUES (${id},${owner},${articleStyle.manifest.name}) RETURNING *`;
      await transaction`INSERT INTO article_style_revisions (owner_id,style_id,revision,article_style) VALUES (${owner},${id},1,${articleStyle}::jsonb)`;
      return styleDto({ ...row, article_style: articleStyle });
    });
  }

  async update(owner: string, id: string, input: any) {
    if (!Number.isInteger(input?.expectedRevision)) throw new StyleError("invalid_style");
    return this.sql.begin(async transaction => {
      const [row] = await transaction`SELECT * FROM article_styles WHERE id=${id} AND owner_id=${owner} FOR UPDATE`;
      if (!row) throw new StyleError("style_not_found");
      if (row.current_revision !== input.expectedRevision) throw new StyleError("style_revision_conflict");
      const articleStyle = snapshot(id, row.current_revision + 1, input);
      await transaction`INSERT INTO article_style_revisions (owner_id,style_id,revision,article_style) VALUES (${owner},${id},${articleStyle.revision},${articleStyle}::jsonb)`;
      const [updated] = await transaction`UPDATE article_styles SET name=${articleStyle.manifest.name},current_revision=${articleStyle.revision},updated_at=now() WHERE id=${id} RETURNING *`;
      return styleDto({ ...updated, article_style: articleStyle });
    });
  }
}
