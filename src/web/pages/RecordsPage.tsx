import { useMemo, useState } from "react";
import { History, RefreshCw } from "lucide-react";
import { api, type Job } from "../api";
import type { Store } from "../App";
import { Empty, Pill, useUi } from "../ui";
import { navigate } from "../router";
import { ATTENTION_STATUSES, clock, dayGroup, jobHuman } from "../status";

export function RecordsPage({ store }: { store: Store }) {
  const { toast } = useUi();
  const [checking, setChecking] = useState("");
  const groups = useMemo(() => {
    const map = new Map<string, Job[]>();
    for (const job of [...store.jobs].sort((a, b) => b.createdAt.localeCompare(a.createdAt))) {
      const key = dayGroup(job.createdAt);
      map.set(key, [...(map.get(key) ?? []), job]);
    }
    return [...map.entries()];
  }, [store.jobs]);
  const attention = store.jobs.filter(job => ATTENTION_STATUSES.includes(job.status)).length;

  async function recheck(job: Job) {
    setChecking(job.id);
    try { store.updateJob(await api<Job>(`/jobs/${job.id}`)); toast("已更新最新状态"); }
    catch (err) { toast((err as Error).message, "bad"); }
    finally { setChecking(""); }
  }

  const title = (job: Job) => store.documents.find(doc => doc.id === job.documentId)?.title ?? "已归档的文章";
  return <div className="page">
    <header className="page-head">
      <div><h1>发布记录</h1><p>每一次预览和存入草稿箱都在这里。</p></div>
    </header>
    {attention > 0 && <div className="notice notice-warn" style={{ marginBottom: 20 }}>
      <div><strong>有 {attention} 条结果需要核对。</strong>请先到公众号后台草稿箱确认是否已经存入，再决定是否重新发布，避免重复。</div>
    </div>}
    {groups.length === 0
      ? <Empty icon={<History />} title="还没有发布记录">写好文章后点击“发布”，预览和存入草稿箱的结果会出现在这里。</Empty>
      : groups.map(([group, jobs]) => <section key={group} className="record-group">
          <h3>{group}</h3>
          <div className="record-list">
            {jobs.map(job => {
              const doc = store.documents.find(item => item.id === job.documentId);
              const human = jobHuman(job, doc?.revision);
              const account = store.accounts.find(item => item.id === job.accountId)?.label ?? "公众号";
              const reviewable = job.status === "preview_ready" && !job.publicationRequested && human.label === "预览待确认";
              return <div className="record" key={job.id}>
                <div className="record-main">
                  <strong>{title(job)}</strong>
                  <div className="record-meta"><Pill tone={human.tone} busy={human.busy}>{human.label}</Pill><span>{account}</span><span>·</span><span>{clock(new Date(job.createdAt))}</span></div>
                </div>
                <div className="record-actions">
                  {reviewable && <button className="btn btn-sm btn-primary" onClick={() => store.publish({ documentId: job.documentId, title: title(job), jobId: job.id })}>查看并确认</button>}
                  {job.status === "succeeded" && job.artifactManifestHash && <button className="btn btn-sm" onClick={() => store.publish({ documentId: job.documentId, title: title(job), jobId: job.id })}>查看</button>}
                  {ATTENTION_STATUSES.includes(job.status) && <button className="btn btn-sm" disabled={checking === job.id} onClick={() => recheck(job)}><RefreshCw className={checking === job.id ? "spin" : ""} />重新核对</button>}
                  {doc && <button className="btn btn-sm btn-ghost" onClick={() => navigate({ name: "editor", id: doc.id })}>打开文章</button>}
                </div>
              </div>;
            })}
          </div>
        </section>)}
  </div>;
}
