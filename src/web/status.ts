import type { Account, DocumentSummary, Job } from "./api";
import type { Tone } from "./ui";
import { failureAdvice, pick } from "./copy";

export interface Human { label: string; tone: Tone; busy?: boolean; hint?: string }

export const BUSY_STATUSES = ["submitting", "accepting", "queued", "running"];
export const ATTENTION_STATUSES = ["unknown", "interrupted"];

/** 任务状态的客户说法：不出现修订、快照、Worker 等内部概念。 */
export function jobHuman(job: Job, currentRevision?: number, whitelistIp?: string | null): Human {
  if (job.error === "execution_environment_mismatch") return { label: "环境不一致", tone: "warn", hint: "这条记录来自另一套环境，只能在原环境查看。" };
  if (BUSY_STATUSES.includes(job.status)) return job.publicationRequested
    ? { label: "正在存入草稿箱", tone: "info", busy: true }
    : { label: "正在生成预览", tone: "info", busy: true };
  if (job.status === "preview_ready" && !job.publicationRequested) {
    if (job.authorizationRevoked) return { label: "仅供查看", tone: "neutral", hint: "这个公众号的授权已变更，预览只能查看。" };
    if (currentRevision !== undefined && currentRevision !== job.documentRevision) return { label: "预览已过时", tone: "neutral", hint: "文章之后有修改，请重新生成预览。" };
    return { label: "预览待确认", tone: "brand", hint: "确认无误后即可存入草稿箱。" };
  }
  if (job.status === "succeeded") return job.simulated
    ? { label: "演示完成", tone: "ok", hint: "演示环境不会真正写入公众号。" }
    : { label: "已存入草稿箱", tone: "ok", hint: "到公众号后台草稿箱即可发表。" };
  if (job.status === "failed") {
    if (job.error === "preview_expired") return { label: "预览已过期", tone: "neutral", hint: "超过 7 天未确认的预览会自动关闭。" };
    if (job.error === "preview_discarded") return { label: "已放弃", tone: "neutral" };
    if (job.error === "account_disabled" || job.error === "account_version_conflict") return { label: "公众号连接有变化", tone: "bad", hint: "请检查公众号连接后重新发布。" };
    return { label: "未成功", tone: "bad", hint: failureAdvice(job.errorHint, whitelistIp) ?? "这次没有写入公众号，可以修改后重新发布。" };
  }
  if (job.publicationRequested && job.status === "preview_ready") return { label: "正在存入草稿箱", tone: "info", busy: true };
  return { label: "结果待核对", tone: "warn", hint: "请先到公众号后台草稿箱确认是否已经存入，不要重复发布。" };
}

/** 文章卡片状态：取该文章最新的一条任务。 */
export function documentHuman(doc: DocumentSummary, jobs: Job[]): Human {
  const own = jobs.filter(job => job.documentId === doc.id).sort((a, b) => b.createdAt.localeCompare(a.createdAt));
  const latest = own[0];
  if (!latest) return { label: "草稿", tone: "neutral" };
  if (ATTENTION_STATUSES.includes(latest.status)) return { label: "结果待核对", tone: "warn" };
  if (BUSY_STATUSES.includes(latest.status)) return { label: "处理中", tone: "info", busy: true };
  if (latest.status === "preview_ready" && !latest.publicationRequested && !latest.authorizationRevoked && latest.documentRevision === doc.revision) return { label: "预览待确认", tone: "brand" };
  const published = own.find(job => job.status === "succeeded");
  if (published) return published.documentRevision === doc.revision
    ? { label: published.simulated ? "演示完成" : "已存草稿箱", tone: "ok" }
    : { label: "已发布 · 有新修改", tone: "neutral" };
  return { label: "草稿", tone: "neutral" };
}

export interface PublishButtonState {
  label: string;
  kind: "idle" | "busy" | "ready" | "done" | "attention";
  /** 点击后直接打开这条任务；空表示开始新的发布。 */
  jobId?: string;
}

/**
 * 编辑页右上角按钮跟随发布进度：生成预览 → 待确认 → 存入中 → 已存入。
 * working 表示发布抽屉里有一步正在进行（保存文章、创建预览、确认存入），任务尚未出现或刚被确认。
 */
export function publishButton(documentId: string, revision: number, dirty: boolean, jobs: Job[], working: boolean): PublishButtonState {
  const own = jobs.filter(job => job.documentId === documentId).sort((a, b) => b.createdAt.localeCompare(a.createdAt));
  const latest = own[0];
  // 当前内容之外的预览/成功结果与这次发布无关。
  const current = !!latest && !dirty && latest.documentRevision === revision;
  if (latest && BUSY_STATUSES.includes(latest.status)) return { label: latest.publicationRequested ? "存入草稿箱中…" : "生成预览中…", kind: "busy", jobId: latest.id };
  if (latest && ATTENTION_STATUSES.includes(latest.status)) return { label: "结果待核对", kind: "attention", jobId: latest.id };
  if (working) return { label: current && latest!.status === "preview_ready" ? "存入草稿箱中…" : "生成预览中…", kind: "busy" };
  if (current && latest!.status === "preview_ready" && !latest!.authorizationRevoked) return latest!.publicationRequested
    ? { label: "存入草稿箱中…", kind: "busy", jobId: latest!.id }
    : { label: "确认存入", kind: "ready", jobId: latest!.id };
  if (current && latest!.status === "succeeded") return { label: latest!.simulated ? "演示完成" : "已存入草稿箱", kind: "done", jobId: latest!.id };
  if (latest?.status === "failed" && current && !["preview_expired", "preview_discarded"].includes(latest.error ?? "")) return { label: "重新发布", kind: "idle" };
  return { label: "发布", kind: "idle" };
}

export function accountHuman(account: Account): Human {
  if (account.bindingState === "released") return { label: "已转交", tone: "neutral", hint: "这个公众号已交给其他成员，历史记录仍可查看。" };
  if (account.bindingState === "paused") return { label: "已暂停", tone: "warn", hint: pick("请联系作者恢复。", "请联系顾问恢复。") };
  if (!account.active) return { label: "已停用", tone: "neutral" };
  return { label: "可以发布", tone: "ok" };
}

export function relativeTime(value: string, now = new Date()) {
  const date = new Date(value);
  const diff = now.getTime() - date.getTime();
  if (!Number.isFinite(diff)) return "";
  const minutes = Math.round(diff / 60000);
  if (minutes < 1) return "刚刚";
  if (minutes < 60) return `${minutes} 分钟前`;
  const hours = Math.round(minutes / 60);
  if (hours < 24 && startOfDay(date) === startOfDay(now)) return `${hours} 小时前`;
  const days = Math.floor((startOfDay(now) - startOfDay(date)) / 86400000);
  if (days === 1) return `昨天 ${clock(date)}`;
  if (days < 7) return `${days} 天前`;
  return date.toLocaleDateString("zh-CN", { month: "long", day: "numeric", ...(date.getFullYear() === now.getFullYear() ? {} : { year: "numeric" }) });
}

export function dayGroup(value: string, now = new Date()) {
  const date = new Date(value);
  const days = Math.floor((startOfDay(now) - startOfDay(date)) / 86400000);
  if (days <= 0) return "今天";
  if (days === 1) return "昨天";
  if (days < 7) return "本周";
  return date.toLocaleDateString("zh-CN", { year: "numeric", month: "long" });
}

export function clock(date: Date) {
  return date.toLocaleTimeString("zh-CN", { hour: "2-digit", minute: "2-digit", hour12: false });
}

function startOfDay(date: Date) {
  return new Date(date.getFullYear(), date.getMonth(), date.getDate()).getTime();
}

export function greeting() {
  const hour = new Date().getHours();
  return hour < 6 ? "夜深了" : hour < 11 ? "早上好" : hour < 13 ? "中午好" : hour < 18 ? "下午好" : "晚上好";
}
