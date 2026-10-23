import type { ArticleStyleSnapshot } from "@akairos/pipeline/article-style";
import type { ArticleCoverControls } from "@akairos/typeset-studio/cover";
import type { ArtifactManifest } from "@akairos/pipeline/article-snapshot";
import { errorText } from "./copy";
export type ArticleStyle = ArticleStyleSnapshot;
export interface SavedStyle { id: string; name: string; revision: number; articleStyle: ArticleStyle; updatedAt: string }
export type { CoverAsset, CoverTemplate } from "./cover-types";
import type { CoverTemplate } from "./cover-types";
export interface BodyAsset { id: string; sha256: string; contentType: string; byteLength: number; width: number; height: number; url: string }
export interface DocumentImage { nodeKey: string; source: string; alt: string; title: string | null; managed: boolean; importable: boolean; reason: string | null }

export interface Document {
  id: string;
  archived?: boolean;
  title: string;
  body: string;
  revision: number;
  updatedAt: string;
  styleId: string | null;
  styleRevision: number | null;
  articleStyle: ArticleStyle | null;
  coverTemplateId: string | null;
  coverTemplateRevision: number | null;
  coverTemplate: CoverTemplate | null;
}
export interface DocumentSummary { id: string; title: string; revision: number; updatedAt: string; archived: boolean; excerpt: string }
export interface Session {
  authenticated: boolean;
  simulation: boolean;
  displayName: string | null;
  accessUntil: string | null;
  role: "admin" | "member";
  /** 服务是否统一持有中转令牌；为真时界面不要求使用者填写 PAT。 */
  relayManaged: boolean;
  /** 部署可选提供的白名单出口 IP；为 null 时由使用者自行填写（模式 A 即本服务器的出口 IP，模式 B 才是自己中转的出口 IP）。 */
  whitelistIp: string | null;
  /** 部署形态：neutral 为开源自托管默认文案，hosted 为线上托管部署的原有文案。 */
  copyMode: "neutral" | "hosted";
}
export interface Account {
  id: string; label: string; appId: string; active: boolean; version: number;
  credentialRevision: number; synchronized: boolean; syncedAt: string | null;
  bindingState: "bound" | "paused" | "released";
  /** 部署未统一持有中转令牌且这个连接没有自己的 PAT 时为真。 */
  patMissing: boolean;
}
export interface Job {
  id: string;
  documentId: string;
  documentRevision: number;
  accountId: string;
  status: string;
  step: string;
  error: string | null;
  /** 发布失败时 Worker 给出的原因（服务端已脱敏、限长）。 */
  errorDetail: string | null;
  /** 服务端对常见失败原因的归类，界面据此给出处理建议。 */
  errorHint: "invalid_appid" | "invalid_secret" | "ip_whitelist" | "relay_unauthorized" | "relay_unreachable" | null;
  draftMediaId: string | null;
  simulated: boolean;
  articleStyleHash: string | null;
  articleThemeHash: string | null;
  coverSnapshotHash: string | null;
  coverAssetHash: string | null;
  coverFontHash: string | null;
  operation: "direct" | "preview";
  inputHash: string | null;
  snapshotHash: string | null;
  artifactManifestHash: string | null;
  artifactManifest: ArtifactManifest | null;
  publicationRequested: boolean;
  authorizationRevoked: boolean;
  createdAt: string;
  updatedAt: string;
}

// 客户可见的错误说法集中在 copy.ts，按部署形态取文案；这里仍是接口错误的唯一出口。
export { errorText } from "./copy";

/** 带错误码的错误，界面据此决定下一步（如 409 时提示刷新）。 */
export class ApiError extends Error {
  constructor(message: string, readonly code: string, readonly status: number) { super(message); }
}

export async function apiResponse(path: string, method = "GET", body?: BodyInit, json = false) {
  const response = await fetch(`/api${path}`, { method, credentials: "same-origin", ...(json ? { headers: { "Content-Type": "application/json" } } : {}), ...(body ? { body } : {}) });
  if (!response.ok) {
    const data = await response.json().catch(() => ({}));
    throw new Error(errorText(data.error) || "操作没有完成，请稍后重试。");
  }
  return response;
}

export async function api<T>(path: string, method = "GET", body?: unknown): Promise<T> {
  const response = await fetch(`/api${path}`, {
    method, credentials: "same-origin", headers: { "Content-Type": "application/json" },
    ...(body ? { body: JSON.stringify(body) } : {}),
  });
  let data: any;
  try {
    data = await response.json();
  } catch {
    throw new Error(response.ok ? "服务暂时异常，请刷新页面重试。" : "网络连接异常，请检查网络后重试。");
  }
  if (!response.ok) throw new ApiError(errorText(data?.error) || "操作没有完成，请稍后重试。", data?.error ?? "", response.status);
  return data;
}

export const statusLabel = (job: Job) => job.error === "execution_environment_mismatch" ? "执行环境不一致，请回原环境核对" : ({
  submitting: "正在提交", accepting: "正在接收", queued: "等待处理", running: "正在处理",
  preview_ready: "预览就绪，等待本人确认",
  succeeded: job.simulated ? "模拟任务完成（未创建微信草稿）" : "已保存到公众号草稿箱",
  failed: "处理失败，请核对原任务", interrupted: "任务中断，需核对草稿箱", unknown: "结果待核对",
}[job.status] || "结果待核对");
