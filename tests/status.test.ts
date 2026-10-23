import { expect, test } from "bun:test";
import { dayGroup, documentHuman, jobHuman, publishButton, relativeTime } from "../src/web/status";
import type { DocumentSummary, Job } from "../src/web/api";

const job = (overrides: Partial<Job>): Job => ({
  id: "j", documentId: "d", documentRevision: 2, accountId: "a", status: "preview_ready", step: "preview_ready", error: null, errorDetail: null, errorHint: null, draftMediaId: null,
  simulated: false, articleStyleHash: null, articleThemeHash: null, coverSnapshotHash: null, coverAssetHash: null, coverFontHash: null,
  operation: "preview", inputHash: null, snapshotHash: null, artifactManifestHash: null, artifactManifest: null,
  publicationRequested: false, authorizationRevoked: false, createdAt: "2026-10-20T10:00:00.000Z", updatedAt: "2026-10-20T10:00:00.000Z", ...overrides,
});
const doc: DocumentSummary = { id: "d", title: "t", revision: 2, updatedAt: "2026-10-20T10:00:00.000Z", archived: false, excerpt: "" };

test("relative times and day groups read naturally", () => {
  const now = new Date(2026, 9, 21, 15, 30);
  expect(relativeTime(new Date(2026, 9, 21, 15, 29, 40).toISOString(), now)).toBe("刚刚");
  expect(relativeTime(new Date(2026, 9, 21, 15, 5).toISOString(), now)).toBe("25 分钟前");
  expect(relativeTime(new Date(2026, 9, 21, 9, 0).toISOString(), now)).toBe("7 小时前");
  expect(relativeTime(new Date(2026, 9, 20, 18, 5).toISOString(), now)).toBe("昨天 18:05");
  expect(relativeTime(new Date(2026, 9, 17, 9).toISOString(), now)).toBe("4 天前");
  expect(relativeTime(new Date(2026, 8, 1).toISOString(), now)).toBe("9月1日");
  expect(dayGroup(new Date(2026, 9, 21, 1).toISOString(), now)).toBe("今天");
  expect(dayGroup(new Date(2026, 9, 20, 23).toISOString(), now)).toBe("昨天");
  expect(dayGroup(new Date(2026, 9, 17).toISOString(), now)).toBe("本周");
  expect(dayGroup(new Date(2026, 7, 3).toISOString(), now)).toBe("2026年8月");
});

test("job states use customer language and never internal terms", () => {
  expect(jobHuman(job({ status: "queued" })).label).toBe("正在生成预览");
  expect(jobHuman(job({ status: "running", publicationRequested: true })).label).toBe("正在存入草稿箱");
  expect(jobHuman(job({}), 2).label).toBe("预览待确认");
  expect(jobHuman(job({}), 3).label).toBe("预览已过时");
  expect(jobHuman(job({ status: "succeeded" })).label).toBe("已存入草稿箱");
  expect(jobHuman(job({ status: "succeeded", simulated: true })).label).toBe("演示完成");
  expect(jobHuman(job({ status: "failed", error: "preview_expired" })).label).toBe("预览已过期");
  expect(jobHuman(job({ status: "failed", error: "preview_discarded" })).label).toBe("已放弃");
  expect(jobHuman(job({ status: "unknown" })).label).toBe("结果待核对");
  for (const status of ["queued", "preview_ready", "succeeded", "failed", "unknown", "interrupted"]) {
    const human = jobHuman(job({ status }), 2);
    expect(`${human.label}${human.hint ?? ""}`).not.toMatch(/rev|修订|Hash|快照|Worker|任务/);
  }
});

test("article status reflects the latest publication of the current version", () => {
  expect(documentHuman(doc, []).label).toBe("草稿");
  expect(documentHuman(doc, [job({})]).label).toBe("预览待确认");
  expect(documentHuman(doc, [job({ status: "succeeded" })]).label).toBe("已存草稿箱");
  expect(documentHuman({ ...doc, revision: 3 }, [job({ status: "succeeded" })]).label).toBe("已发布 · 有新修改");
  expect(documentHuman(doc, [job({ status: "interrupted" })]).label).toBe("结果待核对");
});

test("the editor publish button follows the publish progress", () => {
  const at = (minute: number) => `2026-10-20T10:0${minute}:00.000Z`;
  const state = (jobs: Job[], working = false, dirty = false, revision = 2) => publishButton("d", revision, dirty, jobs, working);
  expect(state([])).toEqual({ label: "发布", kind: "idle" });
  // 抽屉里正在保存文章、创建预览，任务尚未出现。
  expect(state([], true)).toMatchObject({ label: "生成预览中…", kind: "busy" });
  expect(state([job({ status: "running" })])).toMatchObject({ label: "生成预览中…", kind: "busy", jobId: "j" });
  expect(state([job({ status: "preview_ready" })])).toEqual({ label: "确认存入", kind: "ready", jobId: "j" });
  // 点击“存入草稿箱”的请求在途，以及服务端已受理后的处理中。
  expect(state([job({ status: "preview_ready" })], true)).toMatchObject({ label: "存入草稿箱中…", kind: "busy" });
  expect(state([job({ status: "running", publicationRequested: true })])).toMatchObject({ label: "存入草稿箱中…", kind: "busy" });
  expect(state([job({ status: "succeeded" })])).toEqual({ label: "已存入草稿箱", kind: "done", jobId: "j" });
  expect(state([job({ status: "succeeded", simulated: true })]).label).toBe("演示完成");
  expect(state([job({ status: "interrupted" })])).toMatchObject({ label: "结果待核对", kind: "attention" });
  // 内容之后又改过，之前的预览或成功结果不再代表现在的文章。
  expect(state([job({ status: "succeeded" })], false, true)).toEqual({ label: "发布", kind: "idle" });
  expect(state([job({ status: "succeeded" })], false, false, 3)).toEqual({ label: "发布", kind: "idle" });
  expect(state([job({ status: "preview_ready" })], false, false, 3)).toEqual({ label: "发布", kind: "idle" });
  // 失败可重发，放弃或过期的预览回到普通“发布”；只看最新一条且只看本文章。
  expect(state([job({ status: "failed", error: "worker_unavailable" })])).toEqual({ label: "重新发布", kind: "idle" });
  expect(state([job({ status: "failed", error: "preview_discarded" })])).toEqual({ label: "发布", kind: "idle" });
  expect(state([job({ id: "old", status: "succeeded", createdAt: at(1) }), job({ id: "new", status: "preview_ready", createdAt: at(5) })]).jobId).toBe("new");
  expect(state([job({ documentId: "other", status: "running" })])).toEqual({ label: "发布", kind: "idle" });
});


test("发布失败时按归类给出处理建议，认不出时保留通用说法", () => {
  const failed = job({ status: "failed", operation: "direct" });
  expect(jobHuman({ ...failed, errorHint: "invalid_appid" }).hint).toContain("AppID");
  expect(jobHuman({ ...failed, errorHint: "ip_whitelist" }, undefined, "203.0.113.9").hint).toContain("203.0.113.9");
  expect(jobHuman({ ...failed, errorHint: "ip_whitelist" }).hint).toContain("出口 IP");
  expect(jobHuman(failed).hint).toContain("可以修改后重新发布");
});
