import { readdir, unlink } from "node:fs/promises";
import { join, resolve } from "node:path";
import type { Database } from "../db/schema";

// 启动时没有活动上传，仅清新 owner 命名空间中未入库文件；旧平铺素材保持原样。
export async function cleanupUnreferencedAssets(sql: Database, dataDir = "./data") {
  for (const [directory, table] of [["assets", "cover_assets"], ["body-assets", "body_assets"]] as const) {
    const root = join(resolve(dataDir), directory);
    const referenced = new Set((await sql.unsafe(`SELECT storage_path FROM ${table} WHERE storage_path IS NOT NULL`)).map((row: any) => row.storage_path));
    const owners = await readdir(root, { withFileTypes: true }).catch(() => []);
    for (const owner of owners) {
      if (!owner.isDirectory() || !/^[a-f\d]{8}(?:-[a-f\d]{4}){3}-[a-f\d]{12}$/i.test(owner.name)) continue;
      for (const entry of await readdir(join(root, owner.name), { withFileTypes: true })) {
        const path = join(owner.name, entry.name);
        if (entry.isFile() && /^[a-f\d-]{36}(?:\.jpg)?$/i.test(entry.name) && !referenced.has(path)) await unlink(join(root, path));
      }
    }
  }
}
