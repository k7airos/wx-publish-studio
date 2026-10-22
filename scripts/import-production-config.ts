import { createHash } from "node:crypto";
import { readdir, readFile } from "node:fs/promises";
import { extname, join, resolve } from "node:path";
import { loadConfig } from "../src/server/config";
import { openDatabase, OWNER_ID } from "../src/server/db/schema";
import { BodyAssetStore } from "../src/server/services/body-asset-store";
import { CoverStore } from "../src/server/services/cover-store";
import { StyleStore } from "../src/server/services/style-store";
import { isCoverDecor } from "../src/server/services/cover-decor";

type ProductionTemplate = { id: string; config: any };

const sourcePath = process.argv[2];
const uploadDir = resolve(process.argv[3] || "./data/typeset-uploads");
if (!sourcePath) throw new Error("Usage: bun run scripts/import-production-config.ts <config.json> [typeset-upload-dir]");

const source = JSON.parse(await readFile(resolve(sourcePath), "utf8")) as {
  theme: Record<string, unknown>;
  css?: string;
  templates: Record<string, ProductionTemplate>;
};
const slots = ["article_cover", "newspic_cover", "newspic_content"];
if (!source.theme || !source.templates || slots.some(slot => !source.templates[slot]?.id || !source.templates[slot]?.config)
  || Object.keys(source.templates).some(slot => !slots.includes(slot))) throw new Error("Expected production style and all three template slots");
const config = await loadConfig();
const sql = await openDatabase(config.databaseUrl);
try {
const bodyAssets = new BodyAssetStore(sql, config.dataDir);
const covers = new CoverStore(sql, config);
const styles = new StyleStore(sql);

const shaFiles = new Map<string, string>();
for (const name of await readdir(uploadDir)) {
  const path = join(uploadDir, name);
  const bytes = await readFile(path).catch(() => null);
  if (bytes) shaFiles.set(createHash("sha256").update(bytes).digest("hex"), path);
}

const importedAssets = new Map<string, string>();
const omittedDemoImages: string[] = [];
async function assetForSource(value: unknown) {
  if (typeof value !== "string") return null;
  const match = /([a-f\d]{64})(?:\.[a-z\d]+)?$/i.exec(value);
  if (!match) return null;
  const sourceHash = match[1]!.toLowerCase();
  if (importedAssets.has(sourceHash)) return importedAssets.get(sourceHash)!;
  const path = shaFiles.get(sourceHash);
  if (!path) return null;
  const bytes = await readFile(path);
  const contentType = ({ ".png": "image/png", ".jpg": "image/jpeg", ".jpeg": "image/jpeg", ".webp": "image/webp" } as Record<string, string>)[extname(path).toLowerCase()];
  if (!contentType) return null;
  const [existing] = await sql`SELECT id FROM body_assets WHERE owner_id=${OWNER_ID} AND sha256=${sourceHash} ORDER BY created_at LIMIT 1`;
  const id = existing?.id || (await bodyAssets.save(OWNER_ID, bytes, contentType, value)).id;
  importedAssets.set(sourceHash, id);
  return id;
}

async function rewriteImages(value: any): Promise<any> {
  if (!value || typeof value !== "object") return value;
  const next = structuredClone(value);
  if (Array.isArray(next.images)) {
    const images = [];
    for (const image of next.images) {
      // 产品内置装饰底图本就以固定 id 引用，原样保留。
      if (typeof image.src === "string" && image.src.startsWith("asset:") && isCoverDecor(image.src.slice("asset:".length))) { images.push(image); continue; }
      const id = await assetForSource(image.src);
      if (!id) {
        if (image.id === "img_demo_1" && !image.templateAssetKey && image.src?.startsWith("https://images.unsplash.com/")) {
          omittedDemoImages.push(image.id);
          continue;
        }
        throw new Error(`Missing source image: ${image.id}`);
      }
      images.push({ ...image, src: `asset:${id}` });
    }
    next.images = images;
  }
  for (const key of ["background", "decoration"] as const) {
    const image = next.coverTheme?.[key]?.image;
    if (image) {
      const id = await assetForSource(image.src);
      if (!id) throw new Error(`Missing source image: ${key}`);
      next.coverTheme[key].image = { ...image, src: `asset:${id}` };
    }
  }
  return next;
}

function normalizeFonts(template: any) {
  const next = structuredClone(template);
  const map = (family: unknown) => family === "PingFang SC" ? "Publishing Cover" : family;
  next.typography.headingFont = map(next.typography.headingFont);
  next.typography.bodyFont = map(next.typography.bodyFont);
  if (next.coverTheme?.typography) for (const font of Object.values(next.coverTheme.typography) as any[]) font.fontFamily = map(font.fontFamily);
  return next;
}

const styleName = "正式生产排版";
// 来源映射与用户可修改的名称分离，重复导入不会覆盖或复制后续编辑。
const styleKey = `production-config:${OWNER_ID}:style`;
const [styleMapping] = await sql`SELECT value FROM app_settings WHERE key=${styleKey}`;
const existingStyle = (await styles.list(OWNER_ID)).find((row: any) => styleMapping ? row.id === styleMapping.value : row.name === styleName);
if (styleMapping && !existingStyle) throw new Error("Imported production style is unavailable");
const style = existingStyle
  ? { id: existingStyle.id, revision: existingStyle.current_revision }
  : await styles.create(OWNER_ID, { name: styleName, config: { ...source.theme, css: source.css || "" } });
await sql`INSERT INTO app_settings (key,value) VALUES (${styleKey},${style.id}) ON CONFLICT DO NOTHING`;

const references: Record<string, { id: string; revision: number }> = {};
for (const [slot, entry] of Object.entries(source.templates)) {
  const name = `正式生产 · ${entry.config.name}`;
  const mappingKey = `production-config:${OWNER_ID}:template:${entry.id}`;
  const [mapping] = await sql`SELECT value FROM app_settings WHERE key=${mappingKey}`;
  const existing = (await covers.list(OWNER_ID)).find(template => mapping ? template.id === mapping.value : template.name === name);
  if (mapping && !existing) throw new Error(`Imported production template is unavailable: ${slot}`);
  if (existing) {
    references[slot] = { id: existing.id, revision: existing.revision };
    await sql`INSERT INTO app_settings (key,value) VALUES (${mappingKey},${existing.id}) ON CONFLICT DO NOTHING`;
    continue;
  }
  const native = await rewriteImages(normalizeFonts({ ...entry.config, name, id: entry.id, slot: entry.config.slot || slot }));
  const created = await covers.create(OWNER_ID, { schemaVersion: 2, name, slot: native.slot, config: native });
  if (created.schemaVersion !== 2) throw new Error(`Imported template is not native: ${slot}`);
  references[slot] = { id: created.id, revision: created.revision };
  await sql`INSERT INTO app_settings (key,value) VALUES (${mappingKey},${created.id}) ON CONFLICT DO NOTHING`;
}

const article = references.article_cover;
await sql`INSERT INTO owner_configuration_defaults (owner_id,style_id,style_revision,cover_template_id,cover_template_revision)
  VALUES (${OWNER_ID},${style.id},${style.revision},${article.id},${article.revision})
  ON CONFLICT (owner_id) DO NOTHING`;

console.log(JSON.stringify({ owner: OWNER_ID, style, templates: references, assets: importedAssets.size, omittedDemoImages,
  compatibility: { fonts: { "PingFang SC": "Publishing Cover (Noto CJK)" }, presets: { "h3:tag-style": "Preserved; unregistered preset uses current myno fallback" }, defaults: "Existing owner defaults are preserved" } }, null, 2));
} finally { await sql.close(); }
