import { createHash, randomUUID } from "node:crypto";
import { mkdir, readFile, writeFile, unlink } from "node:fs/promises";
import { join, resolve } from "node:path";
import { loadImage } from "@napi-rs/canvas";
import { imageSize } from "image-size";
import type { Database } from "../db/schema";
import { lockOwner, requireAssetCapacity } from "./owner-limits";

export class PreviewError extends Error {
  constructor(readonly code: string, readonly details?: unknown) { super(code); }
}

export const bodyAssetDto = (row: any) => ({ id: row.id, sha256: row.sha256, contentType: row.content_type, byteLength: row.byte_length, width: row.width, height: row.height, url: `/api/assets/body/${row.id}` });

export class BodyAssetStore {
  private directory: string;
  constructor(private sql: Database, dataDir = "./data") { this.directory = join(resolve(dataDir), "body-assets"); }

  // 正文素材保留原字节与比例，解码只用于确认格式和像素边界。
  async save(owner: string, bytes: Buffer, contentType: string, sourceUrl: string | null = null) {
    const id = randomUUID();
    try { return await this.sql.begin(async transaction => {
      await lockOwner(transaction as Database, owner, false);
      await requireAssetCapacity(transaction as Database, owner, bytes.length);
      return this.persist(transaction as Database, owner, bytes, contentType, sourceUrl, id);
    }); } catch (error) { await this.cleanupFailed(owner, [id]).catch(() => {}); throw error; }
  }

  async persist(sql: Database, owner: string, bytes: Buffer, contentType: string, sourceUrl: string | null, id = randomUUID()) {
    if (!bytes.length || bytes.length > 5 * 1024 * 1024) throw new PreviewError("body_image_too_large");
    let dimensions;
    try { dimensions = imageSize(bytes); } catch { throw new PreviewError("invalid_body_image"); }
    const mime = ({ png: "image/png", jpg: "image/jpeg", webp: "image/webp" } as Record<string, string>)[dimensions.type || ""];
    if (!mime || mime !== contentType) throw new PreviewError("invalid_body_image");
    if (!dimensions.width || !dimensions.height || dimensions.width * dimensions.height > 32_000_000) throw new PreviewError("body_image_dimensions");
    let image;
    try { image = await loadImage(bytes); } catch { throw new PreviewError("invalid_body_image"); }
    if (image.width !== dimensions.width || image.height !== dimensions.height) throw new PreviewError("invalid_body_image");
    const sha256 = createHash("sha256").update(bytes).digest("hex");
    const storagePath = join(owner, id);
    await mkdir(join(this.directory, owner), { recursive: true });
    await writeFile(join(this.directory, storagePath), bytes, { flag: "wx", mode: 0o600 });
    const [row] = await sql`INSERT INTO body_assets (id,owner_id,sha256,content_type,byte_length,width,height,source_url,storage_path)
      VALUES (${id},${owner},${sha256},${mime},${bytes.length},${image.width},${image.height},${sourceUrl},${storagePath}) RETURNING *`;
    return bodyAssetDto(row);
  }

  async upload(owner: string, file: File) {
    if (!file.size || file.size > 5 * 1024 * 1024) throw new PreviewError("body_image_too_large");
    return this.save(owner, Buffer.from(await file.arrayBuffer()), file.type);
  }

  async get(owner: string, id: string) {
    const [row] = await this.sql`SELECT * FROM body_assets WHERE id=${id} AND owner_id=${owner}`;
    if (!row) throw new PreviewError("body_asset_not_found");
    let bytes: Buffer;
    try { bytes = await readFile(join(this.directory, row.storage_path || row.id)); } catch { throw new PreviewError("body_asset_unavailable"); }
    if (bytes.length !== row.byte_length || createHash("sha256").update(bytes).digest("hex") !== row.sha256) throw new PreviewError("body_asset_unavailable");
    return { identity: bodyAssetDto(row), bytes };
  }

  async cleanupFailed(owner: string, ids: string[]) {
    // 提交响应丢失时先查持久身份，不删除可能已经采用的素材。
    for (const id of ids) {
      const [row] = await this.sql`SELECT id FROM body_assets WHERE owner_id=${owner} AND id=${id}`;
      if (!row) await unlink(join(this.directory, owner, id)).catch(() => {});
    }
  }
}
