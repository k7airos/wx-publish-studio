import { createHash, randomUUID } from "node:crypto";
import { mkdir, readFile, writeFile, unlink } from "node:fs/promises";
import { join, resolve } from "node:path";
import { createCanvas, loadImage } from "@napi-rs/canvas";
import { imageSize } from "image-size";
import type { Database } from "../db/schema";
import { lockOwner, requireAssetCapacity } from "./owner-limits";

export class CoverError extends Error {
  constructor(readonly code: string) { super(code); }
}

export const assetDto = (row: any) => ({ id: row.id, sha256: row.sha256, width: 1000, height: 1000, byteLength: row.byte_length, url: `/api/assets/${row.id}` });

// 原图只接受三种实际文件格式，规范化后的 JPEG 字节才是发布素材身份。
function imageFormat(bytes: Uint8Array) {
  if (bytes[0] === 0x89 && Buffer.from(bytes.subarray(1, 8)).equals(Buffer.from("PNG\r\n\x1a\n"))) return "image/png";
  if (bytes[0] === 0xff && bytes[1] === 0xd8 && bytes[2] === 0xff) return "image/jpeg";
  if (Buffer.from(bytes.subarray(0, 4)).toString() === "RIFF" && Buffer.from(bytes.subarray(8, 12)).toString() === "WEBP") return "image/webp";
  throw new CoverError("invalid_cover_image");
}

export class AssetStore {
  private directory: string;
  constructor(private sql: Database, dataDir = "./data") { this.directory = join(resolve(dataDir), "assets"); }

  async upload(owner: string, file: File) {
    const id = randomUUID();
    try { return await this.sql.begin(async transaction => {
      await lockOwner(transaction as Database, owner, false);
      return this.save(transaction as Database, owner, file, id);
    }); } catch (error) {
      await this.sql`SELECT id FROM cover_assets WHERE id=${id} AND owner_id=${owner}`.then(async rows => {
        if (!rows.length) await unlink(join(this.directory, owner, `${id}.jpg`)).catch(() => {});
      }).catch(() => {});
      throw error;
    }
  }

  private async save(sql: Database, owner: string, file: File, id: string) {
    if (file.size === 0 || file.size > 5 * 1024 * 1024) throw new CoverError("cover_image_too_large");
    const bytes = Buffer.from(await file.arrayBuffer());
    if (imageFormat(bytes) !== file.type) throw new CoverError("invalid_cover_image");
    let dimensions;
    try { dimensions = imageSize(bytes); } catch { throw new CoverError("invalid_cover_image"); }
    if (!dimensions.width || !dimensions.height || dimensions.width * dimensions.height > 32_000_000) throw new CoverError("cover_image_dimensions");
    let image;
    try { image = await loadImage(bytes); } catch { throw new CoverError("invalid_cover_image"); }
    if (!image.width || !image.height || image.width * image.height > 32_000_000) throw new CoverError("cover_image_dimensions");
    const canvas = createCanvas(1000, 1000);
    const context = canvas.getContext("2d");
    context.fillStyle = "#ffffff"; context.fillRect(0, 0, 1000, 1000);
    const side = Math.min(image.width, image.height);
    context.drawImage(image, (image.width - side) / 2, (image.height - side) / 2, side, side, 0, 0, 1000, 1000);
    let normalized = await canvas.encode("jpeg", 88);
    if (normalized.byteLength > 1024 * 1024) normalized = await canvas.encode("jpeg", 75);
    if (normalized.byteLength > 1024 * 1024) throw new CoverError("cover_image_too_large");
    await requireAssetCapacity(sql, owner, normalized.byteLength);
    const sha256 = createHash("sha256").update(normalized).digest("hex");
    const storagePath = join(owner, `${id}.jpg`);
    await mkdir(join(this.directory, owner), { recursive: true });
    await writeFile(join(this.directory, storagePath), normalized, { mode: 0o600, flag: "wx" });
    const [row] = await sql`INSERT INTO cover_assets (id,owner_id,sha256,source_sha256,byte_length,storage_path)
      VALUES (${id},${owner},${sha256},${createHash("sha256").update(bytes).digest("hex")},${normalized.byteLength},${storagePath}) RETURNING *`;
    return assetDto(row);
  }

  private path(row: any) { return join(this.directory, row.storage_path || `${row.id}.jpg`); }

  async get(owner: string, id: string) {
    const [row] = await this.sql`SELECT * FROM cover_assets WHERE id=${id} AND owner_id=${owner}`;
    if (!row) throw new CoverError("cover_asset_not_found");
    let bytes: Buffer;
    try { bytes = await readFile(this.path(row)); } catch { throw new CoverError("cover_asset_unavailable"); }
    if (bytes.byteLength !== row.byte_length || createHash("sha256").update(bytes).digest("hex") !== row.sha256) throw new CoverError("cover_asset_unavailable");
    return { row, bytes, path: this.path(row) };
  }
}
