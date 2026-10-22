import { validateArticleStyleSnapshot, type ArticleStyleSnapshot } from "@akairos/pipeline/article-style";
import type { Database } from "../db/schema";
import { StyleStore } from "./style-store";
import { StyleError } from "./style-store";
import { coverSnapshotIdentity, validateCoverSnapshot, type CoverSnapshot } from "@akairos/pipeline/cover-snapshot";
import { CoverStore } from "./cover-store";
import { CoverError } from "./asset-store";
import type { AppConfig } from "../config";
import { createArticleSnapshot, validateArticleSnapshot, type ArticleSnapshot } from "@akairos/pipeline/article-snapshot";
import { DocumentImages } from "./document-images";
import { BodyAssetStore, PreviewError } from "./body-asset-store";
import { OWNER_ID } from "../db/schema";
import { neutralArticleStyle, neutralCoverSnapshot } from "./neutral-defaults";

// 文档只引用固定样式修订；建立任务时复制内容，恢复不再读取实时样式资产。
export async function documentArticleStyle(sql: Database, owner: string, doc: any): Promise<ArticleStyleSnapshot | null> {
  if (!doc.style_id) return owner === OWNER_ID ? null : neutralArticleStyle;
  return new StyleStore(sql).get(owner, doc.style_id, doc.style_revision);
}

export function storedArticleStyle(row: any): ArticleStyleSnapshot | null {
  if (!row.article_style) {
    if (row.article_style_hash) throw new StyleError("invalid_style_snapshot");
    return null;
  }
  const snapshot = validateArticleStyleSnapshot(row.article_style);
  if (snapshot.hash !== row.article_style_hash) throw new StyleError("invalid_style_snapshot");
  return snapshot;
}

export async function documentCover(sql: Database, config: AppConfig, owner: string, doc: any) {
  if (!doc.cover_template_id) return null;
  return new CoverStore(sql, config).get(owner, doc.cover_template_id, doc.cover_template_revision);
}

export async function documentCoverSnapshot(sql: Database, config: AppConfig, owner: string, doc: any, createdAssetIds?: string[]): Promise<CoverSnapshot | null> {
  if (!doc.cover_template_id) return owner === OWNER_ID ? null : neutralCoverSnapshot();
  return new CoverStore(sql, config).snapshot(owner, doc.cover_template_id, doc.cover_template_revision, doc.title, { transaction: true, createdAssetIds });
}

export function storedCoverSnapshot(row: any): CoverSnapshot | null {
  if (!row.cover_snapshot) {
    if (row.cover_snapshot_hash || row.cover_asset_hash || row.cover_font_hash) throw new CoverError("invalid_cover_snapshot");
    return null;
  }
  const snapshot = validateCoverSnapshot(row.cover_snapshot);
  const identity = coverSnapshotIdentity(snapshot);
  if (identity.coverSnapshotHash !== row.cover_snapshot_hash || identity.coverAssetHash !== row.cover_asset_hash || identity.coverFontHash !== row.cover_font_hash) throw new CoverError("invalid_cover_snapshot");
  return snapshot;
}

// 文档保留浏览器鉴权 URL，发送副本仅把图片节点改为不可变 asset 身份。
export async function documentPreviewInput(sql: Database, config: AppConfig, owner: string, doc: any, account: string, createdAssetIds?: string[]) {
  const materials = await new DocumentImages(sql, config).materials(owner, doc.body);
  const articleStyle = await documentArticleStyle(sql, owner, doc);
  const coverSnapshot = await documentCoverSnapshot(sql, config, owner, doc, createdAssetIds);
  let articleSnapshot: ArticleSnapshot;
  try {
    articleSnapshot = createArticleSnapshot({
      documentId: doc.id, documentRevision: doc.revision, title: doc.title, body: materials.body, account,
      ...(articleStyle ? { articleStyle } : {}), ...(coverSnapshot ? { coverSnapshot } : {}),
      bodyAssets: materials.assets.map(({ identity }) => ({ id: identity.id, sha256: identity.sha256, contentType: identity.contentType, byteLength: identity.byteLength, width: identity.width, height: identity.height })),
    });
  } catch { throw new PreviewError("invalid_article_snapshot"); }
  return { body: materials.body, articleStyle, coverSnapshot, articleSnapshot };
}

export function storedArticleSnapshot(row: any): ArticleSnapshot {
  try {
    const articleStyle = storedArticleStyle(row); const coverSnapshot = storedCoverSnapshot(row);
    const snapshot = validateArticleSnapshot(row.article_snapshot, {
      title: row.title, body: row.body, account: row.worker_account || row.account_id,
      ...(articleStyle ? { articleStyle } : {}), ...(coverSnapshot ? { coverSnapshot } : {}),
    });
    if (snapshot.inputHash !== row.input_hash) throw new Error("mismatched input hash");
    return snapshot;
  } catch { throw new PreviewError("invalid_article_snapshot"); }
}

export async function storedBodyAssets(sql: Database, config: AppConfig, owner: string, snapshot: ArticleSnapshot) {
  const store = new BodyAssetStore(sql, config.dataDir);
  const assets = [];
  for (const identity of snapshot.bodyAssets) {
    const asset = await store.get(owner, identity.id);
    if (asset.identity.sha256 !== identity.sha256 || asset.identity.contentType !== identity.contentType || asset.identity.byteLength !== identity.byteLength || asset.identity.width !== identity.width || asset.identity.height !== identity.height) throw new PreviewError("invalid_article_snapshot");
    assets.push(asset);
  }
  return assets;
}
