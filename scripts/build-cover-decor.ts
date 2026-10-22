// 把 src/server/assets/cover-decor/*.svg 栅格化为固定 PNG 素材，并写入清单（固定 id + sha256）。
// 素材一经发布即不可变：改图请新增文件名（如 cobalt-2.svg），旧 id 继续服务已保存的封面。
import { createHash } from "node:crypto";
import { readdirSync, readFileSync, writeFileSync, existsSync } from "node:fs";
import { join } from "node:path";
import { createCanvas, loadImage } from "@napi-rs/canvas";

const dir = join(import.meta.dir, "../src/server/assets/cover-decor");
const manifestPath = join(dir, "manifest.json");
const manifest: Record<string, { id: string; sha256: string; byteLength: number; width: number; height: number }> = existsSync(manifestPath) ? JSON.parse(readFileSync(manifestPath, "utf8")) : {};
let next = Math.max(0x100, ...Object.values(manifest).map(entry => Number.parseInt(entry.id.slice(-12), 16) + 1));

for (const file of readdirSync(dir).filter(name => name.endsWith(".svg")).sort()) {
  const name = file.slice(0, -4);
  if (manifest[name]) continue;
  const image = await loadImage(readFileSync(join(dir, file)));
  const canvas = createCanvas(image.width, image.height);
  canvas.getContext("2d").drawImage(image, 0, 0);
  const png = await canvas.encode("png");
  writeFileSync(join(dir, `${name}.png`), png);
  manifest[name] = { id: `00000000-0000-4000-8000-${(next++).toString(16).padStart(12, "0")}`, sha256: createHash("sha256").update(png).digest("hex"), byteLength: png.length, width: image.width, height: image.height };
  console.log("built", name, manifest[name]!.id, png.length);
}
writeFileSync(manifestPath, `${JSON.stringify(manifest, null, 2)}\n`);
