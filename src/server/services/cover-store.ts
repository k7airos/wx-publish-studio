import { randomUUID } from "node:crypto";
import { ARTICLE_COVER_FONT, ARTICLE_COVER_IMAGE_KEY, DEFAULT_ARTICLE_COVER_CONTROLS, createArticleCoverConfig, normalizeArticleCoverTitle, validateArticleCoverControls } from "@akairos/typeset-studio/cover";
import { registerArticleCoverFont } from "@akairos/typeset-studio/server-font";
import { applyTemplateImages, renderPageToPng, runTypeset } from "@akairos/typeset-studio";
import { createCoverSnapshot, createRenderedCoverSnapshot, hashRenderedCoverTitle } from "@akairos/pipeline/cover-snapshot";
import { resolveHostTemplateConfig } from "@akairos/typeset-studio/server-config";
import { canonicalHash } from "@akairos/pipeline/article-snapshot";
import type { TypesetConfig } from "@akairos/typeset-studio";
import { requireAssetCapacity } from "./owner-limits";
import { BodyAssetStore } from "./body-asset-store";
import { fontDto, registerTemplateFonts, templateCatalog, templateResources, validateTypesetTemplateConfig } from "./template-config";
import type { Database } from "../db/schema";
import type { AppConfig } from "../config";
import { AssetStore, CoverError, assetDto } from "./asset-store";
import { NEUTRAL_COVER_ID, NEUTRAL_COVER_PATH } from "./neutral-defaults";

export class CoverStore {
  private assets: AssetStore;
  private bodyAssets: BodyAssetStore;
  constructor(private sql: Database, private config: AppConfig) { this.assets = new AssetStore(sql, config.dataDir); this.bodyAssets = new BodyAssetStore(sql, config.dataDir); }

  catalog(owner: string) { return templateCatalog(this.config, owner); }

  private async nativeInput(owner: string, input: any) {
    try {
      if (!input || input.schemaVersion !== 2 || typeof input.name !== "string" || !input.name.trim() || input.name.trim().length > 80
        || Object.keys(input).some(key => !["schemaVersion", "name", "slot", "config", "expectedRevision"].includes(key))) throw new Error();
      const config = validateTypesetTemplateConfig(input.config);
      if (input.slot !== config.slot || input.name.trim() !== config.name) throw new Error();
      const { resources } = await templateResources(config, owner, this.config, this.bodyAssets);
      return { name: input.name.trim(), config, slot: config.slot!, resources };
    } catch { throw new CoverError("invalid_cover_template"); }
  }

  private async saveNative(owner: string, input: any, id?: string) {
    const value = await this.nativeInput(owner, input);
    const templateId = id || randomUUID();
    const revision = await this.sql.begin(async transaction => {
      let revision = 1;
      if (id) {
        const [row] = await transaction`SELECT * FROM cover_templates WHERE id=${id} AND owner_id=${owner} FOR UPDATE`;
        if (!row) throw new CoverError("cover_template_not_found");
        if (row.current_revision !== input.expectedRevision) throw new CoverError("cover_revision_conflict");
        revision = row.current_revision + 1;
      } else await transaction`INSERT INTO cover_templates (id,owner_id,name) VALUES (${templateId},${owner},${value.name})`;
      await transaction`INSERT INTO cover_template_revisions (owner_id,template_id,revision,name,schema_version,slot,config) VALUES (${owner},${templateId},${revision},${value.name},2,${value.slot},${value.config}::jsonb)`;
      for (const asset of value.resources.filter(resource => !resource.builtin)) await transaction`INSERT INTO cover_template_assets (owner_id,template_id,revision,asset_id) VALUES (${owner},${templateId},${revision},${asset.identity.id})`;
      if (id) await transaction`UPDATE cover_templates SET name=${value.name},current_revision=${revision},updated_at=now() WHERE id=${id}`;
      return revision;
    });
    return this.get(owner, templateId, revision);
  }

  private input(input: any) {
    if (typeof input?.name !== "string" || !input.name.trim() || input.name.trim().length > 80
      || typeof input.assetId !== "string" || !/^[a-f\d]{8}(-[a-f\d]{4}){3}-[a-f\d]{12}$/i.test(input.assetId)
      || Object.keys(input).some(key => !["name", "controls", "assetId", "expectedRevision"].includes(key))) throw new CoverError("invalid_cover_template");
    try { return { name: input.name.trim(), controls: validateArticleCoverControls(input.controls), assetId: input.assetId }; }
    catch { throw new CoverError("invalid_cover_template"); }
  }

  private async dto(owner: string, row: any) {
    if (row.schema_version === 2) {
      const config = validateTypesetTemplateConfig(row.config);
      const { resources, fonts } = await templateResources(config, owner, this.config, this.bodyAssets);
      return { schemaVersion: 2 as const, id: row.id, name: row.name, revision: row.revision, slot: config.slot!, config, assets: resources.map(asset => asset.identity), fonts: fonts.map(fontDto) };
    }
    if (row.schema_version !== 1) throw new CoverError("invalid_cover_template");
    const asset = await this.assets.get(owner, row.asset_id);
    return { schemaVersion: 1 as const, id: row.id, name: row.name, revision: row.revision, controls: validateArticleCoverControls(row.controls), asset: assetDto(asset.row), font: ARTICLE_COVER_FONT };
  }

  async list(owner: string) {
    const rows = await this.sql`SELECT s.id,r.* FROM cover_templates s JOIN cover_template_revisions r ON r.template_id=s.id AND r.revision=s.current_revision WHERE s.owner_id=${owner} ORDER BY s.updated_at DESC`;
    return Promise.all(rows.map((row: any) => this.dto(owner, row)));
  }

  async get(owner: string, id: string, revision: number) {
    const [row] = await this.sql`SELECT s.id,r.* FROM cover_templates s JOIN cover_template_revisions r ON r.template_id=s.id WHERE s.id=${id} AND s.owner_id=${owner} AND r.revision=${revision}`;
    if (!row) throw new CoverError("cover_template_not_found");
    return this.dto(owner, row);
  }

  async create(owner: string, input: any) {
    if (input?.schemaVersion === 2) return this.saveNative(owner, input);
    const value = this.input(input);
    await this.assets.get(owner, value.assetId);
    const id = randomUUID();
    await this.sql.begin(async transaction => {
      await transaction`INSERT INTO cover_templates (id,owner_id,name) VALUES (${id},${owner},${value.name})`;
      await transaction`INSERT INTO cover_template_revisions (owner_id,template_id,revision,name,controls,asset_id) VALUES (${owner},${id},1,${value.name},${value.controls}::jsonb,${value.assetId})`;
    });
    return this.get(owner, id, 1);
  }

  async update(owner: string, id: string, input: any) {
    if (input?.schemaVersion === 2) { if (!Number.isInteger(input.expectedRevision)) throw new CoverError("invalid_cover_template"); return this.saveNative(owner, input, id); }
    const value = this.input(input);
    if (!Number.isInteger(input.expectedRevision)) throw new CoverError("invalid_cover_template");
    await this.assets.get(owner, value.assetId);
    const revision = await this.sql.begin(async transaction => {
      const [row] = await transaction`SELECT * FROM cover_templates WHERE id=${id} AND owner_id=${owner} FOR UPDATE`;
      if (!row) throw new CoverError("cover_template_not_found");
      if (row.current_revision !== input.expectedRevision) throw new CoverError("cover_revision_conflict");
      const revision = row.current_revision + 1;
      await transaction`INSERT INTO cover_template_revisions (owner_id,template_id,revision,name,controls,asset_id) VALUES (${owner},${id},${revision},${value.name},${value.controls}::jsonb,${value.assetId})`;
      await transaction`UPDATE cover_templates SET name=${value.name},current_revision=${revision},updated_at=now() WHERE id=${id}`;
      return revision;
    });
    return this.get(owner, id, revision);
  }

  // 任务只携带已保存修订与已验证字节；排队后不再读取模板或素材最新版。
  async snapshot(owner: string, id: string, revision: number, title?: string, options: { transaction?: boolean; createdAssetIds?: string[] } = {}) {
    const template = await this.get(owner, id, revision);
    if (template.schemaVersion === 2) {
      if (template.slot !== "article_cover" || typeof title !== "string" || !title.trim()) throw new CoverError("invalid_cover_template");
      const png = await this.previewConfig(owner, template.config, title);
      let renderedAsset;
      if (options.transaction) {
        await requireAssetCapacity(this.sql, owner, png.length);
        const assetId = randomUUID();
        options.createdAssetIds?.push(assetId);
        renderedAsset = await this.bodyAssets.persist(this.sql, owner, png, "image/png", null, assetId);
      } else renderedAsset = await this.bodyAssets.save(owner, png, "image/png");
      return createRenderedCoverSnapshot({ id, revision, name: template.name, sourceHash: canonicalHash(template.config),
        assetsHash: canonicalHash(template.assets.map(({ id, sha256, contentType, byteLength, width, height }) => ({ id, sha256, contentType, byteLength, width, height })).sort((a, b) => a.id.localeCompare(b.id))),
        fontHashes: template.fonts.map(({ id, sha256 }) => ({ id, sha256 })), titleHash: hashRenderedCoverTitle(title), renderedAsset: { id: renderedAsset.id, sha256: renderedAsset.sha256, byteLength: renderedAsset.byteLength, contentType: "image/png", width: 3350, height: 1000 } });
    }
    const asset = await this.assets.get(owner, template.asset.id);
    return createCoverSnapshot({
      id, revision, name: template.name, controls: template.controls,
      asset: { id: asset.row.id, sha256: asset.row.sha256, contentType: "image/jpeg", dataBase64: asset.bytes.toString("base64") },
      font: { id: ARTICLE_COVER_FONT.id, sha256: ARTICLE_COVER_FONT.sha256 },
    });
  }

  // 应用和提交复用权威预览的排版检查，超长标题不留到 Worker 才失败。
  async layout(owner: string, id: string, revision: number, title: string) {
    const template = await this.get(owner, id, revision);
    if (template.schemaVersion === 2) return this.nativeLayout(owner, template.config, title);
    const asset = await this.assets.get(owner, template.asset.id);
    return this.legacyLayout(createArticleCoverConfig({ id, name: template.name, controls: template.controls, assetId: asset.row.id }), asset.path, title);
  }

  /** 未选封面时发布用的公共默认封面，与 neutralCoverSnapshot 同底图同参数。 */
  async previewDefault(title: string) {
    const config = createArticleCoverConfig({ id: NEUTRAL_COVER_ID, name: "清晰阅读公共封面", controls: { ...DEFAULT_ARTICLE_COVER_CONTROLS }, assetId: "00000000-0000-4000-8000-000000000072" });
    const result = await this.legacyLayout(config, NEUTRAL_COVER_PATH, title);
    try { return await renderPageToPng(result.pages[0]!, result.canvasSpec, result.config, 1); }
    catch { throw new CoverError("cover_preview_failed"); }
  }

  private async legacyLayout(config: ReturnType<typeof createArticleCoverConfig>, imagePath: string, title: string) {
    try { registerArticleCoverFont({ path: this.config.coverFontPath || "/usr/share/fonts/opentype/noto/NotoSansCJK-Regular.ttc" }); }
    catch { throw new CoverError("cover_font_unavailable"); }
    const images = applyTemplateImages([], config.images, { [ARTICLE_COVER_IMAGE_KEY]: imagePath });
    try {
      const normalizedTitle = normalizeArticleCoverTitle(title);
      if (!normalizedTitle) throw new CoverError("cover_preview_failed");
      return await runTypeset({ markdown: `# ${normalizedTitle}`, config, images, maxPages: 1 });
    } catch { throw new CoverError("cover_preview_failed"); }
  }

  private async nativeLayout(owner: string, input: unknown, title: string) {
    try {
      const config = resolveHostTemplateConfig(validateTypesetTemplateConfig(input));
      const normalizedTitle = normalizeArticleCoverTitle(title);
      if (!normalizedTitle || title.length > 255) throw new CoverError("cover_preview_failed");
      const { resources, fonts } = await templateResources(config, owner, this.config, this.bodyAssets);
      const aliases = await registerTemplateFonts(fonts);
      config.typography = { headingFont: aliases.get(config.typography.headingFont)!, bodyFont: aliases.get(config.typography.bodyFont)! };
      if (config.coverTheme) for (const font of Object.values(config.coverTheme.typography)) font.fontFamily = aliases.get(font.fontFamily)!;
      const sources = new Map(resources.map(asset => [`asset:${asset.identity.id}`, `data:${asset.identity.contentType};base64,${asset.bytes.toString("base64")}`]));
      config.images = (config.images || []).map(image => ({ ...image, src: sources.get(image.src)! }));
      if (config.coverTheme) for (const key of ["background", "decoration"] as const) if (config.coverTheme[key].image) config.coverTheme[key].image!.src = sources.get(config.coverTheme[key].image!.src)!;
      return await fitCoverTitle(config, normalizedTitle);
    } catch (error) { if (error instanceof CoverError) throw error; throw new CoverError("cover_preview_failed"); }
  }

  async previewConfig(owner: string, config: unknown, title: string) {
    const result = await this.nativeLayout(owner, config, title);
    try { return await renderPageToPng(result.pages[0]!, result.canvasSpec, result.config, 1); }
    catch { throw new CoverError("cover_preview_failed"); }
  }

  async preview(owner: string, id: string, revision: number, title: string) {
    const result = await this.layout(owner, id, revision, title);
    try { return await renderPageToPng(result.pages[0]!, result.canvasSpec, result.config, 1); }
    catch { throw new CoverError("cover_preview_failed"); }
  }
}

// 标题过长排不进一页时逐级缩小字号，直到放下；与默认封面的自动缩字一致，长标题不再出图失败。
export async function fitCoverTitle(config: TypesetConfig, title: string) {
  const base = config.algorithm.baseFontSize;
  for (let size = base; ; size = Math.floor(size * 0.9)) {
    try { return await runTypeset({ markdown: `# ${title}`, config: { ...config, algorithm: { ...config.algorithm, baseFontSize: size } }, images: config.images, maxPages: 1 }); }
    catch (error) {
      if (!(error instanceof RangeError) || !/maxPages/.test(error.message) || size <= Math.max(16, Math.floor(base * 0.35))) throw error;
    }
  }
}

