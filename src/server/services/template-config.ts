import { createHash } from "node:crypto";
import { readFile } from "node:fs/promises";
import { GlobalFonts } from "@napi-rs/canvas";
import { ARTICLE_COVER_FONT } from "@akairos/typeset-studio/cover";
import { BUILTIN_PRESETS, validateTypesetTemplateConfig } from "@akairos/typeset-studio/server-config";
import { ARTICLE_COVER_PRESETS } from "./cover-presets";
import { coverDecorBytes, coverDecorIdentity, isCoverDecor } from "./cover-decor";
import type { TypesetConfig } from "@akairos/typeset-studio";
import type { AppConfig, TrustedCoverFont } from "../config";
import { CoverError } from "./asset-store";
import { BodyAssetStore } from "./body-asset-store";

export { validateTypesetTemplateConfig };
export const fontDto = (font: TrustedCoverFont) => ({ id: font.id, family: font.family, label: font.family, sha256: font.sha256 });
export function trustedCoverFonts(config: AppConfig, owner: string) {
  return [{ ...ARTICLE_COVER_FONT, path: config.coverFontPath || "/usr/share/fonts/opentype/noto/NotoSansCJK-Regular.ttc" }, ...(config.coverFonts || [])]
    .filter(font => !(font as TrustedCoverFont).owners || (font as TrustedCoverFont).owners!.includes(owner));
}
export function templateAssetIds(config: TypesetConfig) {
  const sources = [...(config.images || []).map(image => image.src), config.coverTheme?.background.image?.src, config.coverTheme?.decoration.image?.src].filter((value): value is string => !!value);
  return [...new Set(sources.map(source => source.slice("asset:".length)))].sort();
}
export async function templateResources(config: TypesetConfig, owner: string, registry: AppConfig, assets: BodyAssetStore) {
  const fonts = trustedCoverFonts(registry, owner);
  const used = [...new Set([config.typography.headingFont, config.typography.bodyFont, ...Object.values(config.coverTheme?.typography || {}).map(font => font.fontFamily)])];
  if (used.some(family => !fonts.some(font => font.family === family))) throw new CoverError("cover_font_unavailable");
  // 内置装饰底图由产品提供，其余素材必须属于本人。
  const resources = await Promise.all(templateAssetIds(config).map(async id => isCoverDecor(id)
    ? { identity: coverDecorIdentity(id), bytes: coverDecorBytes(id), builtin: true as const }
    : { ...await assets.get(owner, id), builtin: false as const }));
  return { fonts: fonts.filter(font => used.includes(font.family)), resources };
}

// 注册隔离别名，绕开历史系统字体回退；同一字体字节才复用该别名。
export async function registerTemplateFonts(fonts: TrustedCoverFont[]) {
  const aliases = new Map<string, string>();
  for (const font of fonts) {
    let bytes: Buffer;
    try { bytes = await readFile(font.path); } catch { throw new CoverError("cover_font_unavailable"); }
    if (createHash("sha256").update(bytes).digest("hex") !== font.sha256) throw new CoverError("cover_font_unavailable");
    const alias = `PublishingTrusted_${font.sha256.slice(0, 16)}`;
    if (!GlobalFonts.has(alias) && !GlobalFonts.registerFromPath(font.path, alias)) throw new CoverError("cover_font_unavailable");
    aliases.set(font.family, alias);
  }
  return aliases;
}

export function templateCatalog(config: AppConfig, owner: string) {
  // 原站演示照片不作为产品资产；所有公开版式均可选择再上传本人素材。
  // 文章封面用本产品按微信双裁切设计的预设；Typeset 内置文章封面标题横跨分界线，发布后会被裁断，不再提供。
  // 本产品预设只引用内置装饰底图，保留图片；Typeset 内置预设去掉演示照片。
  const presets = [...ARTICLE_COVER_PRESETS.map(preset => ({ preset, own: true })), ...BUILTIN_PRESETS.filter(preset => preset.slot !== "article_cover").map(preset => ({ preset, own: false }))].map(({ preset, own }) => {
    const value = structuredClone(preset); if (!own) value.images = []; value.slot ||= "newspic_content";
    value.typography = { headingFont: ARTICLE_COVER_FONT.family, bodyFont: ARTICLE_COVER_FONT.family };
    if (value.coverTheme) for (const font of Object.values(value.coverTheme.typography)) font.fontFamily = ARTICLE_COVER_FONT.family;
    return value;
  });
  return { presets, fonts: trustedCoverFonts(config, owner).map(fontDto), note: "背景与版式预设不含演示照片，可上传原比例图片。系统字体已映射为部署的 Noto CJK 字体。" };
}
