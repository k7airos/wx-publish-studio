import { unified } from "unified";
import remarkParse from "remark-parse";
import remarkGfm from "remark-gfm";
import { toMarkdown } from "mdast-util-to-markdown";
import { createHash, randomUUID } from "node:crypto";
import type { Root, Image, ImageReference, Definition, Nodes } from "mdast";
import type { Database } from "../db/schema";
import type { AppConfig } from "../config";
import { BodyAssetStore, PreviewError } from "./body-asset-store";
import { OWNER_ID } from "../db/schema";
import { lockOwner, requireAssetCapacity } from "./owner-limits";
import { AssetStore } from "./asset-store";

export interface DocumentImage {
  nodeKey: string; source: string; alt: string; title: string | null;
  managed: boolean; importable: boolean; reason: string | null;
}
interface ImageNode { node: Image | ImageReference; image: Image; start: number; end: number }
const assetPath = /^\/api\/assets\/body\/([a-f\d]{8}(?:-[a-f\d]{4}){3}-[a-f\d]{12})$/i;
const parser = unified().use(remarkParse).use(remarkGfm);

// 只收集图片 AST；引用式图片转换自身节点，不修改可能共享的 definition。
function imageNodes(body: string) {
  const tree = parser.parse(body) as Root;
  const definitions = new Map<string, Definition>();
  const found: ImageNode[] = [];
  const unresolved: DocumentImage[] = [];
  const visit = (node: Nodes, callback: (node: Nodes) => void) => {
    callback(node);
    if ("children" in node) for (const child of node.children) visit(child, callback);
  };
  visit(tree, node => { if (node.type === "definition" && !definitions.has(node.identifier)) definitions.set(node.identifier, node); });
  visit(tree, node => {
    if (node.type === "html" && /<img\b/i.test(node.value)) {
      unresolved.push({ nodeKey: `${node.position?.start.offset}:${node.position?.end.offset}`, source: "", alt: "HTML图片", title: null, managed: false, importable: false, reason: "html_image_requires_markdown" });
      return;
    }
    if (node.type !== "image" && node.type !== "imageReference") return;
    const start = node.position?.start.offset; const end = node.position?.end.offset;
    const definition = node.type === "imageReference" ? definitions.get(node.identifier) : null;
    if (start === undefined || end === undefined || node.type === "imageReference" && !definition) {
      unresolved.push({ nodeKey: `${start}:${end}`, source: "", alt: node.alt || "", title: null, managed: false, importable: false, reason: "unresolved_image_reference" }); return;
    }
    const image: Image = node.type === "image" ? node : { type: "image", url: definition!.url, title: definition!.title, alt: node.alt };
    found.push({ node, image, start, end });
  });
  return { found, unresolved };
}

export class DocumentImages {
  private assets: BodyAssetStore;
  constructor(private sql: Database, private config: AppConfig) { this.assets = new BodyAssetStore(sql, config.dataDir); }

  private assetId(source: string) {
    if (assetPath.test(source)) return assetPath.exec(source)![1]!;
    try { const url = new URL(source); return url.origin === this.config.appOrigin && !url.search && !url.hash ? assetPath.exec(url.pathname)?.[1] ?? null : null; }
    catch { return null; }
  }

  private allowed(source: string, owner: string) {
    try {
      const url = new URL(source);
      return url.protocol === "https:" && !url.username && !url.password && !url.port && !url.hash
        && !/%(?:2e|2f|5c)/i.test(url.pathname)
        && [...(owner === OWNER_ID ? this.config.bodyImageSources || [] : []), ...(this.config.bodyImageOwnerSources?.[owner] || [])].some(item => url.origin === item.origin && url.pathname.startsWith(item.pathPrefix));
    } catch { return false; }
  }

  scan(body: string, owner = OWNER_ID): DocumentImage[] {
    const { found, unresolved } = imageNodes(body);
    return [...found.map(({ image, start, end }) => {
      const managed = !!this.assetId(image.url);
      const importable = !managed && this.allowed(image.url, owner);
      return { nodeKey: `${start}:${end}`, source: image.url, alt: image.alt || "", title: image.title ?? null, managed, importable, reason: managed || importable ? null : "body_image_requires_replacement" };
    }), ...unresolved];
  }

  private rewrite(body: string, replacements: Map<string, string>) {
    const { found } = imageNodes(body);
    let result = body;
    for (const item of found.sort((a, b) => b.start - a.start)) {
      const url = replacements.get(item.image.url); if (!url) continue;
      const markdown = toMarkdown({ type: "root", children: [{ type: "paragraph", children: [{ ...item.image, url }] }] }).trimEnd();
      result = result.slice(0, item.start) + markdown + result.slice(item.end);
    }
    return result;
  }

  private async download(source: string, owner: string) {
    if (!this.allowed(source, owner)) throw new PreviewError("body_image_requires_replacement");
    let response: Response;
    try { response = await fetch(source, { redirect: "error", signal: AbortSignal.timeout(15_000) }); }
    catch { throw new PreviewError("body_image_import_failed"); }
    if (!response.ok || !response.body || Number(response.headers.get("content-length") || 0) > 5 * 1024 * 1024) throw new PreviewError("body_image_import_failed");
    const chunks: Uint8Array[] = []; let length = 0;
    const reader = response.body.getReader();
    try {
      while (true) {
        const chunk = await reader.read(); if (chunk.done) break;
        length += chunk.value.byteLength;
        if (length > 5 * 1024 * 1024) throw new PreviewError("body_image_too_large");
        chunks.push(chunk.value);
      }
    } catch (error) { if (error instanceof PreviewError) throw error; throw new PreviewError("body_image_import_failed"); }
    finally { await reader.cancel().catch(() => {}); }
    return { bytes: Buffer.concat(chunks), contentType: response.headers.get("content-type")?.split(";")[0]?.trim() || "" };
  }

  async import(owner: string, id: string, expectedRevision: number) {
    const created: string[] = [];
    try { return await this.sql.begin(async transaction => {
      const assets = new BodyAssetStore(transaction as Database, this.config.dataDir);
      await lockOwner(transaction as Database, owner);
      const [doc] = await transaction`SELECT * FROM documents WHERE id=${id} AND owner_id=${owner} AND revision=${expectedRevision} FOR UPDATE`;
      if (!doc) throw new PreviewError("revision_conflict");
      const images = this.scan(doc.body, owner);
      if (images.length > 20) throw new PreviewError("body_image_limits");
      const blocked = images.filter(item => !item.managed && !item.importable);
      if (blocked.length) throw new PreviewError("body_image_requires_replacement", blocked);
      const replacements = new Map<string, string>();
      const sources = new Set(images.filter(item => item.importable).map(item => item.source));
      // owner 锁持有到整批提交；每张下载有界，落盘前按实际字节核额度。
      await requireAssetCapacity(transaction as Database, owner, 0, sources.size);
      const bytesByHash = new Map<string, number>();
      let total = 0;
      for (const image of images.filter(item => item.managed)) {
        const asset = await assets.get(owner, this.assetId(image.source)!);
        if (!bytesByHash.has(asset.identity.sha256)) { total += asset.bytes.length; bytesByHash.set(asset.identity.sha256, asset.bytes.length); }
      }
      for (const source of sources) {
        const downloaded = await this.download(source, owner);
        const hash = createHash("sha256").update(downloaded.bytes).digest("hex");
        if (!bytesByHash.has(hash)) { total += downloaded.bytes.length; bytesByHash.set(hash, downloaded.bytes.length); }
        if (total > 40 * 1024 * 1024) throw new PreviewError("body_image_limits");
        await requireAssetCapacity(transaction as Database, owner, downloaded.bytes.length);
        const assetId = randomUUID(); created.push(assetId);
        const asset = await this.assets.persist(transaction as Database, owner, downloaded.bytes, downloaded.contentType, source, assetId);
        replacements.set(source, asset.url);
      }
      const body = this.rewrite(doc.body, replacements);
      await new DocumentImages(transaction as Database, this.config).materials(owner, body);
      const [updated] = await transaction`UPDATE documents SET body=${body},revision=revision + CASE WHEN body=${body} THEN 0 ELSE 1 END,updated_at=now()
        WHERE id=${id} AND owner_id=${owner} AND revision=${expectedRevision} RETURNING *`;
      if (!updated) throw new PreviewError("revision_conflict");
      return updated;
    }); } catch (error) { await this.assets.cleanupFailed(owner, created); throw error; }
  }

  async materials(owner: string, body: string) {
    const images = this.scan(body, owner);
    if (images.length > 20) throw new PreviewError("body_image_limits");
    const blocked = images.filter(item => !item.managed);
    if (blocked.length) throw new PreviewError("body_image_requires_replacement", blocked);
    const assets = new Map<string, Awaited<ReturnType<BodyAssetStore["get"]>>>();
    const hashes = new Set<string>();
    let total = 0;
    for (const image of images) {
      const id = this.assetId(image.source)!;
      if (assets.has(id)) continue;
      const asset = await this.assets.get(owner, id); assets.set(id, asset);
      if (!hashes.has(asset.identity.sha256)) total += asset.bytes.length;
      hashes.add(asset.identity.sha256);
      if (total > 40 * 1024 * 1024) throw new PreviewError("body_image_limits");
    }
    const replacements = new Map(images.map(image => [image.source, `asset:${this.assetId(image.source)!}`]));
    return { body: this.rewrite(body, replacements), assets: [...assets.values()] };
  }

  async validateManaged(owner: string, body: string) {
    for (const { image } of imageNodes(body).found) {
      const bodyId = this.assetId(image.url);
      if (bodyId) { await this.assets.get(owner, bodyId); continue; }
      let path = image.url;
      try {
        const url = new URL(image.url);
        if (url.origin !== this.config.appOrigin || url.search || url.hash) continue;
        path = url.pathname;
      } catch {}
      const cover = /^\/api\/assets\/([a-f\d]{8}(?:-[a-f\d]{4}){3}-[a-f\d]{12})$/i.exec(path);
      if (cover) await new AssetStore(this.sql, this.config.dataDir).get(owner, cover[1]!);
    }
  }
}
