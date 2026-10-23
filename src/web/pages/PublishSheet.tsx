import { useEffect, useMemo, useState } from "react";
import { Check, ChevronRight, CircleAlert, ExternalLink, Loader2, MessageSquareText, RefreshCw, TriangleAlert } from "lucide-react";
import { api, ApiError, type Document, type Job } from "../api";
import type { Store } from "../App";
import { Sheet, useUi } from "../ui";
import { BUSY_STATUSES, jobHuman } from "../status";
import { usePreviewArtifacts } from "./preview";
import { WECHAT_MP_URL } from "../constants";

/** 从编辑页发起时带 prepare（保存并检查文章）；从发布记录打开时带 jobId。 */
export interface PublishRequest {
  documentId: string;
  title: string;
  jobId?: string;
  prepare?: () => Promise<Document>;
}

type Step = "account" | "generating" | "review" | "publishing" | "done" | "attention" | "failed";
const STEP_ORDER = ["选择公众号", "生成预览", "确认存入"];

export function PublishSheet({ request, store, onClose, onWorking }: { request: PublishRequest; store: Store; onClose: () => void; onWorking: (working: boolean) => void }) {
  const { confirm, toast } = useUi();
  const usable = store.accounts.filter(account => account.active && account.bindingState === "bound");
  const [accountId, setAccountId] = useState(usable[0]?.id ?? "");
  const [jobId, setJobId] = useState(request.jobId ?? "");
  const [error, setError] = useState("");
  const [working, setWorking] = useState(false);
  // 同一版内容此前已存入草稿箱时，服务端返回原任务；明确告知并允许再存一份。
  const [reused, setReused] = useState(false);
  useEffect(() => { onWorking(working); }, [working]);
  const job = store.jobs.find(item => item.id === jobId) ?? null;
  const currentRevision = store.documents.find(doc => doc.id === request.documentId)?.revision;
  const { html, error: previewError } = usePreviewArtifacts(job?.status === "preview_ready" || job?.status === "succeeded" ? job : null);

  const step: Step = useMemo(() => {
    if (!job) return working ? "generating" : request.jobId ? "attention" : "account";
    if (job.status === "succeeded") return "done";
    if (["unknown", "interrupted"].includes(job.status)) return "attention";
    if (job.status === "failed") return "failed";
    if (job.publicationRequested) return "publishing";
    if (BUSY_STATUSES.includes(job.status)) return "generating";
    return "review";
  }, [job, working, request.jobId]);

  // 只有一个可用公众号时直接开始生成预览。
  useEffect(() => {
    if (!request.jobId && usable.length === 1) void generate(usable[0]!.id);
  }, []);

  async function generate(account = accountId, forceRevision = false) {
    if (!request.prepare) return;
    setWorking(true); setError("");
    try {
      let saved = await request.prepare();
      if (forceRevision) saved = await api<Document>(`/documents/${saved.id}/revision`, "POST", { expectedRevision: saved.revision });
      const created = await api<Job>("/previews", "POST", { documentId: saved.id, revision: saved.revision, accountId: account });
      // 同一版内容的上一份预览已关闭时，开启新版本重新生成一次。
      if (created.status === "failed" && !forceRevision) return generate(account, true);
      setReused(created.status === "succeeded");
      store.updateJob(created);
      setJobId(created.id);
    } catch (err) {
      setError((err as Error).message);
    } finally { setWorking(false); }
  }

  async function confirmPublish() {
    if (!job) return;
    setWorking(true); setError("");
    try {
      store.updateJob(await api<Job>(`/jobs/${job.id}/publish`, "POST", { snapshotHash: job.snapshotHash, artifactManifestHash: job.artifactManifestHash }));
    } catch (err) { setError((err as Error).message); }
    finally { setWorking(false); }
  }

  async function discard() {
    if (!job) return;
    if (!(await confirm({ title: "放弃这份预览？", message: "放弃后不会写入公众号。文章本身不受影响，随时可以重新发布。", confirmText: "放弃预览" }))) return;
    setWorking(true);
    try {
      store.updateJob(await api<Job>(`/jobs/${job.id}/discard`, "POST"));
      toast("已放弃这份预览");
      onClose();
    } catch (err) {
      // 发布服务不支持放弃时，预览会在 7 天后自动关闭，不阻塞用户。
      if (err instanceof ApiError && err.code === "worker_preview_discard_unsupported") { onClose(); return; }
      setError((err as Error).message);
    } finally { setWorking(false); }
  }

  async function recheck() {
    if (!job) return;
    setWorking(true);
    try { store.updateJob(await api<Job>(`/jobs/${job.id}`)); }
    catch (err) { setError((err as Error).message); }
    finally { setWorking(false); }
  }

  const account = store.accounts.find(item => item.id === (job?.accountId ?? accountId));
  const stale = job?.status === "preview_ready" && !job.publicationRequested && currentRevision !== undefined && currentRevision !== job.documentRevision;
  const stepIndex = step === "account" ? 0 : step === "generating" ? 1 : 2;

  let footer: React.ReactNode = null;
  if (step === "account") footer = <>
    <span className="grow">下一步会自动保存文章并生成预览，不会直接发布。</span>
    <button className="btn btn-primary" disabled={!accountId || working} onClick={() => generate()}>生成预览<ChevronRight /></button>
  </>;
  if (step === "review") footer = <>
    <button className="btn btn-ghost" disabled={working} onClick={discard}>放弃</button>
    <span className="grow" />
    {stale || job?.authorizationRevoked
      ? <button className="btn btn-primary" disabled={working || !request.prepare} onClick={() => { setJobId(""); void generate(job!.accountId); }}><RefreshCw />按最新内容重新预览</button>
      : <button className="btn btn-brand" disabled={working || !html || !!previewError} onClick={confirmPublish}>{working ? <Loader2 className="spin" /> : <Check />}存入草稿箱</button>}
  </>;
  if (step === "done") footer = <>
    <span className="grow" />
    {reused && request.prepare && <button className="btn btn-ghost" disabled={working} onClick={() => { setJobId(""); void generate(job?.accountId ?? accountId, true); }}>再存一份</button>}
    <a className="btn" href={WECHAT_MP_URL} target="_blank" rel="noreferrer">打开公众号后台<ExternalLink /></a>
    <button className="btn btn-primary" onClick={onClose}>完成</button>
  </>;
  if (step === "failed" || step === "attention") footer = <>
    <span className="grow" />
    {step === "attention" && <button className="btn" disabled={working} onClick={recheck}><RefreshCw className={working ? "spin" : ""} />重新核对</button>}
    {step === "failed" && request.prepare && <button className="btn btn-primary" disabled={working} onClick={() => { setJobId(""); void generate(job?.accountId ?? accountId, true); }}>重新发布</button>}
    <button className="btn" onClick={onClose}>关闭</button>
  </>;

  return <Sheet open onClose={onClose} wide title={request.title} dismissible={!working || step === "review"}
    subtitle={<span className="flow-steps">{STEP_ORDER.map((label, index) => <span key={label} style={{ display: "contents" }}>
      {index > 0 && <ChevronRight />}
      <b className={index < stepIndex || step === "done" ? "done" : index === stepIndex ? "on" : ""}>{label}</b>
    </span>)}</span>}
    footer={footer}>
    {error && <div className="notice notice-bad" style={{ marginBottom: 16 }}><CircleAlert /><div>{error}</div></div>}

    {step === "account" && <div style={{ display: "grid", gap: 14 }}>
      <p className="muted" style={{ margin: 0 }}>存入哪个公众号的草稿箱？</p>
      <div className="choice-list">
        {usable.map(item => <button key={item.id} className={`choice ${accountId === item.id ? "is-selected" : ""}`} onClick={() => setAccountId(item.id)}>
          <span className="choice-icon"><MessageSquareText /></span>
          <span className="choice-text"><strong>{item.label}</strong><span>可以发布</span></span>
          <span className="radio" />
        </button>)}
      </div>
    </div>}

    {step === "generating" && <div style={{ display: "grid", gap: 20, padding: "8px 0" }}>
      <div className="result" style={{ paddingBottom: 0 }}>
        <div className="result-icon" style={{ background: "var(--surface-2)", color: "var(--ink)" }}><Loader2 className="spin" /></div>
        <h3>正在生成预览</h3>
        <p>大约需要十几秒。生成后先给你看，确认无误才会存入草稿箱。</p>
      </div>
      <GenerationProgress job={job} />
    </div>}

    {step === "review" && <div style={{ display: "grid", gap: 14 }}>
      {stale && <div className="notice notice-warn"><TriangleAlert /><div>文章在生成预览后又有修改，这份预览不是最新内容。</div></div>}
      {job?.authorizationRevoked && <div className="notice notice-warn"><TriangleAlert /><div>这个公众号的授权已变更，这份预览只能查看。</div></div>}
      {previewError && <div className="notice notice-bad"><CircleAlert /><div>{previewError}</div></div>}
      <p className="muted" style={{ margin: 0, textAlign: "center", fontSize: 13 }}>这就是读者在手机上看到的样子 · {account?.label}</p>
      <div className="phone">
        <div className="phone-bar">{account?.label ?? "公众号"}</div>
        <div className="phone-scroll">
          {html ? <iframe className="phone-frame" title="文章预览" sandbox="" referrerPolicy="no-referrer" srcDoc={html} />
            : !previewError && <div className="empty" style={{ margin: "auto" }}><Loader2 className="spin" /></div>}
        </div>
      </div>
      <TechDetails job={job} />
    </div>}

    {step === "publishing" && <div className="result">
      <div className="result-icon" style={{ background: "var(--surface-2)", color: "var(--ink)" }}><Loader2 className="spin" /></div>
      <h3>正在存入「{account?.label}」草稿箱</h3>
      <p>正在上传图片并写入草稿，请不要关闭页面。</p>
    </div>}

    {step === "done" && job && <div className="result">
      <div className="result-icon"><Check /></div>
      <h3>{reused ? "这一版已经存入过草稿箱" : job.simulated ? "演示完成" : "已存入草稿箱"}</h3>
      <p>{reused ? <>文章自上次存入后没有修改，草稿箱里已有这一版，不用重复存入。确实需要另存一份时，点「再存一份」。</> : job.simulated ? "这是演示环境，没有真正写入公众号。" : <>文章已经在「{account?.label}」的草稿箱里，等你最后发表。</>}</p>
      {!job.simulated && <div className="howto">
        <div>打开公众号后台（mp.weixin.qq.com），用管理员微信扫码登录</div>
        <div>进入「内容管理 → 草稿箱」，找到这篇文章</div>
        <div>检查无误后点击「发表」，或设置定时发表</div>
      </div>}
    </div>}

    {step === "failed" && job && <div className="result">
      <div className="result-icon bad"><CircleAlert /></div>
      <h3>{jobHuman(job, currentRevision, store.session.whitelistIp).label}</h3>
      <p>{jobHuman(job, currentRevision, store.session.whitelistIp).hint ?? "这次没有写入公众号。"}</p>
      {job.errorDetail && <details className="tech">
        <summary>失败原因（原文）</summary>
        <code>{job.errorDetail}</code>
      </details>}
    </div>}

    {step === "attention" && <div className="result">
      <div className="result-icon warn"><TriangleAlert /></div>
      <h3>{job ? "结果需要核对" : "找不到这条记录"}</h3>
      <p>{job ? "这次存入的结果暂时无法确认，可能已经写入。请先到公众号后台草稿箱看一看，确认没有再重新发布，避免重复。" : "这条发布记录可能已被清理。"}</p>
      {job && <a className="btn" href={WECHAT_MP_URL} target="_blank" rel="noreferrer">打开公众号后台<ExternalLink /></a>}
      <TechDetails job={job} />
    </div>}
  </Sheet>;
}

function GenerationProgress({ job }: { job: Job | null }) {
  const stage = !job ? 0 : job.status === "running" ? (["render", "publish", "done"].includes(job.step) ? 2 : 1) : job.status === "preview_ready" ? 3 : 0;
  const items = ["保存文章", "排版正文", "生成封面与图片"];
  return <div className="progress-list">
    {items.map((label, index) => <div key={label} className={`progress-item ${index < stage ? "done" : index === stage ? "active" : ""}`}>
      <span className="mark">{index < stage ? <Check /> : index === stage ? <Loader2 className="spin" /> : null}</span>{label}
    </div>)}
  </div>;
}

function TechDetails({ job }: { job: Job | null }) {
  if (!job) return null;
  return <details className="tech">
    <summary>技术详情</summary>
    <div>记录编号<code>{job.id}</code></div>
    {job.snapshotHash && <div>内容指纹<code>{job.snapshotHash}</code></div>}
    {job.artifactManifestHash && <div>预览指纹<code>{job.artifactManifestHash}</code></div>}
    {job.draftMediaId && <div>草稿编号<code>{job.draftMediaId}</code></div>}
  </details>;
}
