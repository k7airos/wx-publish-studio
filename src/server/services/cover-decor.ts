import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { CoverError } from "./asset-store";

// 产品内置的封面装饰底图：由 scripts/build-cover-decor.ts 从 SVG 生成，固定 id 与 sha256，不属于任何成员。
const dir = new URL("../assets/cover-decor/", import.meta.url);
const manifest = JSON.parse(readFileSync(new URL("manifest.json", dir), "utf8")) as Record<string, { id: string; sha256: string; byteLength: number; width: number; height: number }>;

export const COVER_DECOR = Object.fromEntries(Object.entries(manifest).map(([name, entry]) => [name, { ...entry, name }]));
const byId = new Map(Object.values(COVER_DECOR).map(entry => [entry.id, entry]));
const cache = new Map<string, Buffer>();

export function isCoverDecor(id: string) { return byId.has(id); }

export function coverDecorIdentity(id: string) {
  const entry = byId.get(id);
  if (!entry) throw new CoverError("invalid_cover_template");
  return { id, sha256: entry.sha256, contentType: "image/png", byteLength: entry.byteLength, width: entry.width, height: entry.height, url: `/api/cover-templates/decor/${id}` };
}

/** 读取并核对字节；与清单不符说明素材被改动，拒绝出图而不是悄悄换图。 */
export function coverDecorBytes(id: string) {
  const entry = byId.get(id);
  if (!entry) throw new CoverError("invalid_cover_template");
  let bytes = cache.get(id);
  if (!bytes) {
    bytes = readFileSync(fileURLToPath(new URL(`${entry.name}.png`, dir)));
    if (createHash("sha256").update(bytes).digest("hex") !== entry.sha256) throw new CoverError("cover_preview_failed");
    cache.set(id, bytes);
  }
  return bytes;
}
