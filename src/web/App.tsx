import { useCallback, useEffect, useState } from "react";
import { FileText, History, MessageSquareText, UserRound, FlaskConical } from "lucide-react";
import { api, type Account, type Document, type DocumentSummary, type Job, type Session } from "./api";
import { setCopyMode } from "./copy";
import { Logo, PRODUCT } from "./Logo";
import { UiProvider, useUi } from "./ui";
import { linkProps, useRoute, type Route } from "./router";
import { ATTENTION_STATUSES, BUSY_STATUSES } from "./status";
import { LoginPage } from "./LoginPage";
import { ArticlesPage } from "./pages/ArticlesPage";
import { EditorPage } from "./EditorPage";
import { RecordsPage } from "./pages/RecordsPage";
import { AccountsPage } from "./pages/AccountsPage";
import { MePage } from "./pages/MePage";
import { PublishSheet, type PublishRequest } from "./pages/PublishSheet";

export interface Store {
  session: Session;
  documents: DocumentSummary[];
  accounts: Account[];
  jobs: Job[];
  refresh: () => Promise<void>;
  updateJob: (job: Job) => void;
  publish: (request: PublishRequest) => void;
  /** 发布抽屉里是否有一步正在进行，供编辑页按钮回显。 */
  publishWorking: (documentId: string) => boolean;
  logout: () => Promise<void>;
}

export function App() {
  return <UiProvider><Root /></UiProvider>;
}

function Root() {
  const { toast } = useUi();
  const route = useRoute();
  const [session, setSession] = useState<Session | null | undefined>(undefined);
  const [documents, setDocuments] = useState<DocumentSummary[]>([]);
  const [accounts, setAccounts] = useState<Account[]>([]);
  const [jobs, setJobs] = useState<Job[]>([]);
  const [publishing, setPublishing] = useState<PublishRequest | null>(null);
  const [sheetWorking, setSheetWorking] = useState(false);

  const updateJob = useCallback((job: Job) => setJobs(previous => [job, ...previous.filter(item => item.id !== job.id)]), []);
  const refresh = useCallback(async () => {
    const [docs, bindings, history] = await Promise.all([
      api<{ documents: DocumentSummary[] }>("/documents"),
      api<{ accounts: Account[] }>("/accounts"),
      api<{ jobs: Job[] }>("/jobs"),
    ]);
    setDocuments(docs.documents);
    setAccounts(bindings.accounts);
    setJobs(history.jobs);
  }, []);

  useEffect(() => {
    api<Session>("/auth/session").then(result => { setCopyMode(result.copyMode); setSession(result); }).catch(() => setSession(null));
  }, []);
  useEffect(() => {
    if (session) refresh().catch(err => toast((err as Error).message, "bad"));
  }, [session, refresh, toast]);

  // 处理中的任务每 2 秒只读核对一次，所有页面共用同一份状态。
  const busyIds = jobs.filter(job => BUSY_STATUSES.includes(job.status) || (job.publicationRequested && job.status === "preview_ready")).map(job => job.id).join(",");
  useEffect(() => {
    if (!session || !busyIds) return;
    let disposed = false;
    let timer: ReturnType<typeof setTimeout>;
    const poll = async () => {
      await Promise.all(busyIds.split(",").map(id => api<Job>(`/jobs/${id}`).then(job => { if (!disposed) updateJob(job); }).catch(() => {})));
      if (!disposed) timer = setTimeout(poll, 2000);
    };
    timer = setTimeout(poll, 2000);
    return () => { disposed = true; clearTimeout(timer); };
  }, [session, busyIds, updateJob]);

  const logout = useCallback(async () => {
    await api("/auth/logout", "POST");
    setSession(null); setDocuments([]); setAccounts([]); setJobs([]);
    history.replaceState(null, "", "/");
  }, []);

  if (session === undefined) return <div className="login-loading" role="status"><Logo size={40} /></div>;
  if (!session) return <LoginPage onAuthenticated={() => api<Session>("/auth/session").then(setSession)} />;

  const store: Store = { session, documents, accounts, jobs, refresh, updateJob, publish: setPublishing, publishWorking: documentId => sheetWorking && publishing?.documentId === documentId, logout };
  const attention = jobs.filter(job => ATTENTION_STATUSES.includes(job.status)).length;
  const editor = route.name === "editor";

  return <div className="shell">
    {!editor && <Sidebar route={route} store={store} attention={attention} />}
    <div className={`main ${editor ? "is-editor" : ""}`} style={editor ? { marginLeft: 0 } : undefined}>
      {session.simulation && <div className="demo-banner"><FlaskConical />演示环境：发布不会真正写入公众号</div>}
      {route.name === "articles" && <ArticlesPage store={store} />}
      {route.name === "editor" && <EditorPage key={route.id} id={route.id} store={store} />}
      {route.name === "records" && <RecordsPage store={store} />}
      {route.name === "accounts" && <AccountsPage store={store} />}
      {route.name === "me" && <MePage store={store} />}
    </div>
    {!editor && <Tabbar route={route} attention={attention} />}
    {publishing && <PublishSheet request={publishing} store={store} onWorking={setSheetWorking} onClose={() => { setPublishing(null); setSheetWorking(false); }} />}
  </div>;
}

const NAV: { route: Route; label: string; icon: typeof FileText }[] = [
  { route: { name: "articles" }, label: "文章", icon: FileText },
  { route: { name: "records" }, label: "发布记录", icon: History },
  { route: { name: "accounts" }, label: "公众号", icon: MessageSquareText },
];

function Sidebar({ route, store, attention }: { route: Route; store: Store; attention: number }) {
  const name = store.session.displayName || "我的账号";
  return <aside className="sidebar">
    <a className="brand" {...linkProps({ name: "articles" })}><Logo /><span className="brand-text"><span className="brand-name">{PRODUCT.name}</span><span className="brand-sub">{PRODUCT.tagline}</span></span></a>
    <nav className="nav" aria-label="主导航">
      {NAV.map(item => <a key={item.label} {...linkProps(item.route)} aria-current={route.name === item.route.name ? "page" : undefined}>
        <item.icon />{item.label}
        {item.route.name === "records" && attention > 0 && <span className="nav-count" title="需要核对">{attention}</span>}
      </a>)}
    </nav>
    <div className="sidebar-foot">
      <a className="user-chip" {...linkProps({ name: "me" })} aria-current={route.name === "me" ? "page" : undefined}>
        <span className="avatar">{name.slice(0, 1).toUpperCase()}</span>
        <span className="user-chip-text"><strong>{name}</strong><span>{store.session.role === "admin" ? "管理员" : "会员"}</span></span>
      </a>
    </div>
  </aside>;
}

function Tabbar({ route, attention }: { route: Route; attention: number }) {
  const items = [...NAV.map(item => ({ ...item, label: item.label === "发布记录" ? "记录" : item.label })), { route: { name: "me" } as Route, label: "我的", icon: UserRound }];
  return <nav className="tabbar" aria-label="主导航">
    {items.map(item => <a key={item.label} {...linkProps(item.route)} aria-current={route.name === item.route.name ? "page" : undefined}>
      <item.icon />{item.label}
      {item.route.name === "records" && attention > 0 && <span className="dot" />}
    </a>)}
  </nav>;
}

export type { Document };
