import { expect, test } from "bun:test";
import { randomUUID } from "node:crypto";
import { createCanvas } from "@napi-rs/canvas";
import { DocumentImages } from "../src/server/services/document-images";
import type { AppConfig } from "../src/server/config";
import { OWNER_ID, type Database } from "../src/server/db/schema";
import { BodyAssetStore } from "../src/server/services/body-asset-store";

const owner = OWNER_ID; const id = randomUUID();
const config = { appOrigin: "http://127.0.0.1:18889", bodyImageSources: [{ origin: "https://img.example.com", pathPrefix: "/owner/" }] } as AppConfig;

test("AST image scans and rewrites leave code, shared definitions, captions and neighboring metadata intact", async () => {
  const body = '前文\n\n<!-- myno-image-ratio:v1 0.50 -->\n\n![描述](https://img.example.com/owner/image.png "原图注")\n\n![引用描述][shared]\n\n[普通链接][shared]\n\n[shared]: https://img.example.com/owner/image.png "引用图注"\n\n```md\n![代码图](https://foreign.invalid/a.png)\n```\n\n`![行内代码](other)`\n';
  let savedBody = "";
  const sql = async (strings: TemplateStringsArray, ...values: any[]) => {
    const text = strings.join("");
    if (text.includes("product_memberships")) return [{ status: "active" }];
    if (text.includes("count(*)")) return [{ files: 0, bytes: 0 }];
    if (text.startsWith("SELECT")) return [{ id, revision: 1, body }];
    savedBody = values[0]; return [{ id, revision: 2, body: savedBody }];
  };
  Object.assign(sql, { begin: (run: (transaction: Database) => unknown) => run(sql as unknown as Database) });
  const images = new DocumentImages(sql as unknown as Database, config);
  const assetId = randomUUID(); const assetUrl = `/api/assets/body/${assetId}`;
  const source = createCanvas(20, 10); const bytes = await source.encode("png");
  const originalFetch = globalThis.fetch; const originalSave = BodyAssetStore.prototype.persist;
  globalThis.fetch = (async () => new Response(new Uint8Array(bytes), { headers: { "Content-Type": "image/png" } })) as unknown as typeof fetch;
  BodyAssetStore.prototype.persist = async () => ({ id: assetId, sha256: "a".repeat(64), contentType: "image/png", byteLength: bytes.length, width: 20, height: 10, url: assetUrl });
  // 这里隔离素材字节存取，只验证本文 AST 定点改写与保存边界。
  const originalGet = BodyAssetStore.prototype.get;
  BodyAssetStore.prototype.get = async () => ({ identity: { id: assetId, sha256: "a".repeat(64), contentType: "image/png", byteLength: bytes.length, width: 20, height: 10, url: assetUrl }, bytes });
  try {
    const scanned = images.scan(body); expect(scanned.length).toBe(2); expect(scanned.every(item => item.importable)).toBe(true);
    await images.import(owner, id, 1);
    expect(savedBody).toContain("<!-- myno-image-ratio:v1 0.50 -->");
    expect(savedBody).toContain(`![描述](${assetUrl} "原图注")`);
    expect(savedBody).toContain(`![引用描述](${assetUrl} "引用图注")`);
    expect(savedBody).toContain('[shared]: https://img.example.com/owner/image.png "引用图注"');
    expect(savedBody).toContain("[普通链接][shared]");
    expect(savedBody).toContain("![代码图](https://foreign.invalid/a.png)");
    expect(savedBody).toContain("`![行内代码](other)`");
    const materials = await images.materials(owner, savedBody);
    expect(materials.assets.length).toBe(1); expect(materials.body).toContain(`asset:${assetId}`);
    expect(images.scan(`![a](${config.appOrigin}${assetUrl})`)[0]?.managed).toBe(true);
    for (const bad of ["http://img.example.com/owner/a.png", "https://img.example.com:8443/owner/a.png", "https://user@img.example.com/owner/a.png", "https://img.example.com/other/a.png"]) expect(images.scan(`![图](${bad})`)[0]?.importable).toBe(false);
  } finally { globalThis.fetch = originalFetch; BodyAssetStore.prototype.persist = originalSave; BodyAssetStore.prototype.get = originalGet; }
});

test("whole import failure and compare-and-save conflict do not overwrite the original body", async () => {
  const body = "![一](https://img.example.com/owner/one.png)\n\n![二](https://img.example.com/owner/two.png)\n";
  let updates = 0;
  const sql = async (strings: TemplateStringsArray) => {
    const text = strings.join("");
    if (text.includes("product_memberships")) return [{ status: "active" }];
    if (text.includes("count(*)")) return [{ files: 0, bytes: 0 }];
    return text.startsWith("SELECT") ? [{ id, revision: 1, body }] : (++updates, []);
  };
  Object.assign(sql, { begin: (run: (transaction: Database) => unknown) => run(sql as unknown as Database) });
  const images = new DocumentImages(sql as unknown as Database, config);
  const originalFetch = globalThis.fetch; const originalSave = BodyAssetStore.prototype.persist;
  const source = createCanvas(20, 10); const bytes = await source.encode("png");
  let calls = 0;
  globalThis.fetch = (async () => ++calls === 2 ? new Response("failed", { status: 502 }) : new Response(new Uint8Array(bytes), { headers: { "Content-Type": "image/png" } })) as unknown as typeof fetch;
  BodyAssetStore.prototype.persist = async () => ({ id, sha256: "a".repeat(64), contentType: "image/png", byteLength: bytes.length, width: 20, height: 10, url: `/api/assets/body/${id}` });
  try {
    await expect(images.import(owner, id, 1)).rejects.toMatchObject({ code: "body_image_import_failed" }); expect(updates).toBe(0);
    globalThis.fetch = (async () => new Response(new Uint8Array(bytes), { headers: { "Content-Type": "image/png" } })) as unknown as typeof fetch;
    const originalGet = BodyAssetStore.prototype.get;
    BodyAssetStore.prototype.get = async () => ({ identity: { id, sha256: "a".repeat(64), contentType: "image/png", byteLength: bytes.length, width: 20, height: 10, url: `/api/assets/body/${id}` }, bytes });
    try { await expect(images.import(owner, id, 1)).rejects.toMatchObject({ code: "revision_conflict" }); expect(updates).toBe(1); }
    finally { BodyAssetStore.prototype.get = originalGet; }
  } finally { globalThis.fetch = originalFetch; BodyAssetStore.prototype.persist = originalSave; }
});
