import { useEffect, useMemo, useState } from "react";
import { Archive, ArchiveRestore, Check, FileText, Loader2, MoreHorizontal, Plus, Search } from "lucide-react";
import { api, type Document, type DocumentSummary } from "../api";
import type { Store } from "../App";
import { Empty, Pill, useDismiss, useUi } from "../ui";
import { navigate } from "../router";
import { documentHuman, greeting, relativeTime } from "../status";
import { pick } from "../copy";
import { requestConnect } from "./AccountsPage";

type Filter = "all" | "draft" | "published" | "archived";

export async function createArticle(store: Store) {
  const doc = await api<Document>("/documents", "POST", { title: "未命名文章", body: "" });
  await store.refresh();
  await navigate({ name: "editor", id: doc.id });
}

export function ArticlesPage({ store }: { store: Store }) {
  const { toast } = useUi();
  const [filter, setFilter] = useState<Filter>("all");
  const [query, setQuery] = useState("");
  const [archived, setArchived] = useState<DocumentSummary[] | null>(null);
  const [creating, setCreating] = useState(false);

  useEffect(() => {
    if (filter !== "archived") return;
    api<{ documents: DocumentSummary[] }>("/documents?archived=1").then(result => setArchived(result.documents)).catch(err => toast((err as Error).message, "bad"));
  }, [filter, toast]);

  const published = (doc: DocumentSummary) => store.jobs.some(job => job.documentId === doc.id && job.status === "succeeded");
  const source = filter === "archived" ? archived ?? [] : store.documents;
  const visible = useMemo(() => source.filter(doc =>
    (filter !== "draft" || !published(doc)) && (filter !== "published" || published(doc))
    && (!query.trim() || `${doc.title} ${doc.excerpt}`.toLowerCase().includes(query.trim().toLowerCase())),
  ), [source, filter, query, store.jobs]);

  const steps = [
    { done: store.accounts.some(account => account.active), title: "连接公众号", text: pick("按指引填写几项信息，或请作者协助你完成。", "按指引填写几项信息，或请顾问帮你完成。"), action: "去连接", run: () => { requestConnect(); return navigate({ name: "accounts" }); } },
    { done: store.documents.length > 0, title: "写第一篇文章", text: "可以直接粘贴已有的文章，图片和格式会一并保留。", action: "开始写作", run: () => start() },
    { done: store.jobs.some(job => job.status === "succeeded"), title: "存入公众号草稿箱", text: "选好排版和封面，预览无误后一键存入。", action: store.documents[0] ? "继续上次的文章" : "开始写作", run: () => store.documents[0] ? navigate({ name: "editor", id: store.documents[0].id }) : start() },
  ];
  const doneCount = steps.filter(step => step.done).length;

  async function start() {
    if (creating) return;
    setCreating(true);
    try { await createArticle(store); }
    catch (err) { toast((err as Error).message, "bad"); }
    finally { setCreating(false); }
  }

  async function setArchivedState(doc: DocumentSummary, value: boolean) {
    try {
      await api(`/documents/${doc.id}/archive`, "PUT", { archived: value });
      await store.refresh();
      if (filter === "archived") setArchived(current => (current ?? []).filter(item => item.id !== doc.id));
      toast(value ? "已归档，可在“已归档”中找回" : "已恢复到文章列表");
    } catch (err) { toast((err as Error).message, "bad"); }
  }

  const name = store.session.displayName;
  return <div className="page">
    <header className="page-head">
      <div>
        <h1>{greeting()}{name ? `，${name}` : ""}</h1>
        <p>今天想写点什么？</p>
      </div>
      <button className="btn btn-primary" onClick={start} disabled={creating}>{creating ? <Loader2 className="spin" /> : <Plus />}新建文章</button>
    </header>

    {doneCount < steps.length && <section className="card onboard" aria-label="开始使用">
      <div className="onboard-head">
        <div><h2>三步开始使用</h2><p>完成后，以后每篇文章都只需要“写好 → 发布”。</p></div>
        <div style={{ display: "grid", gap: 6, justifyItems: "end" }}>
          <span className="muted" style={{ fontSize: 12 }}>已完成 {doneCount}/{steps.length}</span>
          <div className="progress"><span style={{ width: `${(doneCount / steps.length) * 100}%` }} /></div>
        </div>
      </div>
      <div className="steps">
        {steps.map((step, index) => <div key={step.title} className={`step ${step.done ? "done" : ""}`}>
          <div className="step-top"><span className="step-num">{step.done ? <Check /> : index + 1}</span><strong>{step.title}</strong></div>
          <p>{step.done ? "已完成" : step.text}</p>
          {!step.done && <button className={`btn btn-sm ${steps.findIndex(item => !item.done) === index ? "btn-primary" : ""}`} onClick={() => void step.run()}>{step.action}</button>}
        </div>)}
      </div>
    </section>}

    <div className="toolbar">
      <div className="segmented" role="group" aria-label="筛选文章">
        {([["all", "全部"], ["draft", "草稿"], ["published", "已发布"], ["archived", "已归档"]] as const).map(([value, label]) =>
          <button key={value} aria-pressed={filter === value} onClick={() => setFilter(value)}>{label}</button>)}
      </div>
      <label className="search">
        <Search /><span className="sr-only">搜索文章</span>
        <input className="input" placeholder="搜索标题或内容" value={query} onChange={event => setQuery(event.target.value)} />
      </label>
    </div>

    {filter === "archived" && archived === null
      ? <div className="empty"><Loader2 className="spin" /></div>
      : visible.length === 0
        ? <Empty icon={<FileText />} title={store.documents.length === 0 && filter === "all" ? "还没有文章" : "没有找到文章"}
            action={store.documents.length === 0 && filter === "all" ? <button className="btn btn-primary" onClick={start}><Plus />写第一篇</button> : undefined}>
            {store.documents.length === 0 && filter === "all" ? "新建一篇，或把已经写好的文章直接粘贴进来。" : "换个筛选条件或关键词试试。"}
          </Empty>
        : <div className="article-grid">
            {visible.map(doc => <ArticleCard key={doc.id} doc={doc} store={store} archived={filter === "archived"} onArchive={value => setArchivedState(doc, value)} />)}
          </div>}
  </div>;
}

function ArticleCard({ doc, store, archived, onArchive }: { doc: DocumentSummary; store: Store; archived: boolean; onArchive: (value: boolean) => void }) {
  const [menu, setMenu] = useState(false);
  const menuRef = useDismiss<HTMLDivElement>(menu, () => setMenu(false));
  const status = archived ? { label: "已归档", tone: "neutral" as const } : documentHuman(doc, store.jobs);
  return <article className="article-card" role="link" tabIndex={0}
    onClick={() => navigate({ name: "editor", id: doc.id })}
    onKeyDown={event => { if (event.key === "Enter") void navigate({ name: "editor", id: doc.id }); }}>
    <h3>{doc.title || "未命名文章"}</h3>
    <p>{doc.excerpt || "还没有正文"}</p>
    <div className="article-card-foot">
      <Pill tone={status.tone} busy={"busy" in status && status.busy}>{status.label}</Pill>
      <time dateTime={doc.updatedAt}>{relativeTime(doc.updatedAt)}</time>
    </div>
    <div className="card-menu" ref={menuRef} onClick={event => event.stopPropagation()} onKeyDown={event => event.stopPropagation()}>
      <button className="icon-btn" aria-label="更多操作" aria-expanded={menu} onClick={() => setMenu(value => !value)}><MoreHorizontal /></button>
      {menu && <div className="menu" role="menu">
        {archived
          ? <button role="menuitem" onClick={() => { setMenu(false); onArchive(false); }}><ArchiveRestore />恢复到文章列表</button>
          : <button role="menuitem" onClick={() => { setMenu(false); onArchive(true); }}><Archive />归档</button>}
      </div>}
    </div>
  </article>;
}
