import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { MynoEditor } from "@akairos/myno/editor";
import { ArrowLeft, Check, ImageIcon, ImageUp, Loader2, Palette, Send, TriangleAlert, X } from "lucide-react";
import { api, apiResponse, ApiError, type BodyAsset, type CoverTemplate, type Document, type DocumentImage, type SavedStyle } from "./api";
import type { Store } from "./App";
import { StylePanel, type StylePanelHandle } from "./StylePanel";
import { CoverPanel, type CoverPanelHandle } from "./CoverPanel";
import { useUi } from "./ui";
import { navigate, setNavigationGuard } from "./router";
import { articleStats } from "./document-stats";
import { publishButton } from "./status";
import { requestConnect } from "./pages/AccountsPage";

type SaveState = "saved" | "dirty" | "saving" | "error";
type PanelTab = "style" | "cover";
const AUTOSAVE_MS = 1500;

export function EditorPage({ id, store }: { id: string; store: Store }) {
  const { toast, confirm } = useUi();
  const [doc, setDoc] = useState<Document | null>(null);
  const [loadError, setLoadError] = useState("");
  useEffect(() => {
    api<Document>(`/documents/${id}`).then(setDoc).catch(err => setLoadError((err as Error).message));
  }, [id]);

  if (loadError) return <div className="page page-narrow"><div className="notice notice-bad"><TriangleAlert />{loadError}</div>
    <p><button className="btn" onClick={() => navigate({ name: "articles" })}><ArrowLeft />返回文章列表</button></p></div>;
  if (!doc) return <div className="login-loading"><Loader2 className="spin" /></div>;
  return <Editor initial={doc} store={store} toast={toast} confirm={confirm} />;
}

function Editor({ initial, store, toast, confirm }: { initial: Document; store: Store; toast: ReturnType<typeof useUi>["toast"]; confirm: ReturnType<typeof useUi>["confirm"] }) {
  const root = useRef<HTMLDivElement>(null);
  const editor = useRef<MynoEditor | null>(null);
  const titleRef = useRef<HTMLTextAreaElement>(null);
  const stylePanel = useRef<StylePanelHandle>(null);
  const coverPanel = useRef<CoverPanelHandle>(null);
  const docRef = useRef(initial);
  const [doc, setDocState] = useState(initial);
  const setDoc = (next: Document) => { docRef.current = next; setDocState(next); };
  const [title, setTitle] = useState(initial.title === "未命名文章" && !initial.body ? "" : initial.title);
  const [body, setBody] = useState(initial.body);
  const [ready, setReady] = useState(false);
  const [saveState, setSaveState] = useState<SaveState>("saved");
  const [locked, setLocked] = useState(false);
  const [uploading, setUploading] = useState(0);
  const [images, setImages] = useState<DocumentImage[]>([]);
  const [panel, setPanel] = useState<PanelTab | null>(null);
  const [mounted, setMounted] = useState({ style: false, cover: false });
  const [stylePending, setStylePending] = useState(false);
  const [coverPending, setCoverPending] = useState(false);
  const [panelBusy, setPanelBusy] = useState(false);
  const [coverPreview, setCoverPreview] = useState("");
  const [coverRendering, setCoverRendering] = useState(false);
  const savingRef = useRef<Promise<Document> | null>(null);
  const latest = useRef({ title, body });
  latest.current = { title, body };

  // 编辑器会规范化 Markdown（如列表标记），以就绪时的输出作为与已存正文等价的基准，避免打开即产生新修订。
  const baseline = useRef<{ stored: string; rendered: string } | null>(null);
  const effectiveTitle = title.trim() || "未命名文章";
  const sameAsStored = (markdown: string, stored: string) => markdown === stored || (baseline.current?.stored === stored && baseline.current.rendered === markdown);
  const dirty = effectiveTitle !== doc.title || !sameAsStored(body, doc.body);
  const stats = useMemo(() => articleStats(body), [body]);

  useEffect(() => { if (panel) setMounted(current => current[panel] ? current : { ...current, [panel]: true }); }, [panel]);

  // 标题输入框随内容自动增高。
  useEffect(() => {
    const element = titleRef.current;
    if (!element) return;
    element.style.height = "auto";
    element.style.height = `${element.scrollHeight}px`;
  }, [title]);

  useEffect(() => {
    let disposed = false;
    const instance = new MynoEditor({
      root: root.current!,
      defaultValue: initial.body,
      styleConfig: initial.articleStyle?.manifest,
      placeholder: "开始写作，或直接粘贴已有文章。输入 / 可插入图片、引用、提示卡片等",
      onMarkdownChange: setBody,
      uploadImage: async file => {
        setUploading(value => value + 1);
        try {
          const data = new FormData();
          data.set("image", file);
          return ((await (await apiResponse("/assets/body", "POST", data)).json()) as BodyAsset).url;
        } catch (err) {
          toast((err as Error).message, "bad");
          throw err;
        } finally { setUploading(value => value - 1); }
      },
    });
    editor.current = instance;
    instance.create().then(async () => {
      if (disposed) { await instance.destroy(); return; }
      const rendered = instance.getMarkdown();
      baseline.current = { stored: initial.body, rendered };
      setBody(rendered);
      setReady(true);
    })
      .catch(() => { if (!disposed) toast("编辑器没能打开，请刷新页面重试。", "bad"); });
    return () => { disposed = true; editor.current = null; void instance.destroy(); };
  }, []);

  const save = useCallback(async (): Promise<Document> => {
    // 同一时间只有一个保存请求；排队的保存使用最新输入。
    while (savingRef.current) await savingRef.current.catch(() => {});
    const current = docRef.current;
    const nextTitle = latest.current.title.trim() || "未命名文章";
    const nextBody = editor.current?.getMarkdown() ?? latest.current.body;
    if (nextTitle === current.title && sameAsStored(nextBody, current.body)) { setSaveState("saved"); return current; }
    setSaveState("saving");
    const request = api<Document>(`/documents/${current.id}`, "PUT", { title: nextTitle, body: nextBody, expectedRevision: current.revision });
    savingRef.current = request;
    try {
      const saved = await request;
      baseline.current = { stored: saved.body, rendered: nextBody };
      setDoc(saved);
      const stillDirty = (latest.current.title.trim() || "未命名文章") !== saved.title || !sameAsStored(editor.current?.getMarkdown() ?? latest.current.body, saved.body);
      setSaveState(stillDirty ? "dirty" : "saved");
      void store.refresh();
      return saved;
    } catch (err) {
      setSaveState("error");
      if (err instanceof ApiError && err.code === "revision_conflict") {
        const reload = await confirm({ title: "这篇文章在别处被修改过", message: "可能是在另一个窗口或设备上编辑了它。重新加载会显示最新版本，当前页面未保存的内容会丢失。", confirmText: "重新加载", cancelText: "暂不" });
        if (reload) window.location.reload();
      }
      throw err;
    } finally { savingRef.current = null; }
  }, [confirm, store]);

  // 停止输入后自动保存。
  useEffect(() => {
    if (!ready || !dirty || locked) return;
    setSaveState(state => state === "saving" ? state : "dirty");
    const timer = setTimeout(() => { save().catch(() => {}); }, AUTOSAVE_MS);
    return () => clearTimeout(timer);
  }, [title, body, ready, dirty, locked, save]);

  // 离开前先保存；保存失败再确认。
  const pendingWork = dirty || saveState === "saving" || uploading > 0 || stylePending || coverPending;
  useEffect(() => {
    setNavigationGuard(async () => {
      if (uploading > 0 && !(await confirm({ title: "图片还在上传", message: "现在离开，正在上传的图片会丢失。", confirmText: "仍然离开" }))) return false;
      if ((stylePending || coverPending) && !(await confirm({ title: "排版和封面还没保存", message: "离开后这次的排版和封面调整会丢失，正文已自动保存。", confirmText: "放弃调整并离开" }))) return false;
      try { await save(); return true; }
      catch { return confirm({ title: "最新修改没能保存", message: "离开后最近的修改会丢失。", confirmText: "仍然离开", danger: true }); }
    });
    return () => setNavigationGuard(null);
  }, [save, uploading, stylePending, coverPending, confirm]);
  useEffect(() => {
    const guard = (event: BeforeUnloadEvent) => { if (pendingWork) { event.preventDefault(); event.returnValue = ""; } };
    window.addEventListener("beforeunload", guard);
    return () => window.removeEventListener("beforeunload", guard);
  }, [pendingWork]);

  async function checkImages(current = docRef.current) {
    try {
      const result = await api<{ items: DocumentImage[] }>(`/documents/${current.id}/images`);
      setImages(result.items.filter(item => !item.managed));
      return result.items.filter(item => !item.managed);
    } catch { return []; }
  }
  useEffect(() => { void checkImages(); }, []);

  async function importImages() {
    setLocked(true); editor.current?.setReadonly(true);
    try {
      const saved = await save();
      const imported = await api<Document>(`/documents/${saved.id}/image-import`, "POST", { expectedRevision: saved.revision });
      setDoc(imported); setBody(imported.body); editor.current?.setMarkdown(imported.body);
      const remaining = await checkImages(imported);
      toast(remaining.length ? `已转存部分图片，还有 ${remaining.length} 张需要重新上传` : "图片已全部转存");
      void store.refresh();
    } catch (err) { toast((err as Error).message, "bad"); }
    finally { editor.current?.setReadonly(false); setLocked(false); }
  }

  async function saveConfiguration() {
    setLocked(true); editor.current?.setReadonly(true);
    try {
      const saved = await save();
      const style = stylePanel.current ? await stylePanel.current.prepare() : saved.articleStyle && saved.styleId ? { id: saved.styleId, revision: saved.styleRevision! } as SavedStyle : null;
      const cover = coverPanel.current ? await coverPanel.current.prepare() : saved.coverTemplate as CoverTemplate | null;
      const applied = await api<Document>(`/documents/${saved.id}/configuration`, "PUT", {
        expectedRevision: saved.revision,
        styleId: style?.id ?? null, styleRevision: style?.revision ?? null,
        templateId: cover?.id ?? null, templateRevision: cover?.revision ?? null,
      });
      setDoc(applied); setStylePending(false); setCoverPending(false);
      editor.current?.applyStyleConfig(applied.articleStyle?.manifest);
      void store.refresh();
      toast("排版和封面已保存，之后新建的文章也会沿用");
      return applied;
    } catch (err) { toast((err as Error).message, "bad"); throw err; }
    finally { editor.current?.setReadonly(false); setLocked(false); }
  }

  async function discardConfiguration() {
    if ((stylePending || coverPending) && !(await confirm({ title: "放弃这次调整？", message: "排版和封面会恢复到上次保存的样子，正文不受影响。", confirmText: "放弃调整" }))) return;
    stylePanel.current?.reset(); coverPanel.current?.reset();
    editor.current?.applyStyleConfig(docRef.current.articleStyle?.manifest);
    setStylePending(false); setCoverPending(false); setCoverPreview(""); setPanel(null);
  }

  const prepareForPublish = async () => {
    const saved = await save();
    const pending = await checkImages(saved);
    if (pending.length) throw new Error(pending.some(item => item.importable)
      ? `文中有 ${pending.length} 张外部图片，请先点击编辑页上方的“一键转存”。`
      : `文中有 ${pending.length} 张图片无法使用，请删除后重新上传。`);
    return saved;
  };

  async function publish() {
    // 已有进行中、待确认或已完成的发布时，按钮直接回到那一步，而不是重新开始。
    if (publishState.jobId) {
      store.publish({ documentId: docRef.current.id, title: effectiveTitle, jobId: publishState.jobId, prepare: prepareForPublish });
      return;
    }
    if (!store.accounts.some(account => account.active)) {
      toast("先连接一个公众号，就可以发布了");
      requestConnect();
      await navigate({ name: "accounts" });
      return;
    }
    if (stylePending || coverPending) {
      const ok = await confirm({ title: "先保存排版和封面？", message: "这次的排版和封面调整还没保存。保存后再发布，公众号里看到的就是现在的样子。", confirmText: "保存并发布" });
      if (!ok) return;
      try { await saveConfiguration(); } catch { return; }
      setPanel(null);
    }
    store.publish({ documentId: docRef.current.id, title: effectiveTitle, prepare: prepareForPublish });
  }

  const busy = locked || panelBusy || uploading > 0;
  const publishState = publishButton(doc.id, doc.revision, dirty, store.jobs, store.publishWorking(doc.id));
  const publishClass = { idle: "btn-primary", busy: "btn-primary", ready: "btn-brand", done: "btn-ok", attention: "btn-warn" }[publishState.kind];
  const importable = images.filter(item => item.importable).length;
  const blocked = images.length - importable;

  return <div className="editor-shell">
    <header className="editor-top">
      <button className="icon-btn" aria-label="返回文章列表" onClick={() => navigate({ name: "articles" })}><ArrowLeft /></button>
      <SaveIndicator state={uploading > 0 ? "saving" : saveState} uploading={uploading} onRetry={() => save().catch(() => {})} />
      <span className="spacer" />
      <button className="btn btn-ghost tool-toggle" aria-pressed={panel === "style"} onClick={() => setPanel(panel === "style" ? null : "style")} disabled={!ready}><Palette /><span className="btn-label">排版</span></button>
      <button className="btn btn-ghost tool-toggle" aria-pressed={panel === "cover"} onClick={() => setPanel(panel === "cover" ? null : "cover")} disabled={!ready}><ImageIcon /><span className="btn-label">封面</span></button>
      <button className={`btn ${publishClass}`} onClick={publish} disabled={!ready || (busy && !publishState.jobId)} aria-live="polite">
        {publishState.kind === "busy" ? <Loader2 className="spin" /> : publishState.kind === "done" ? <Check /> : publishState.kind === "attention" ? <TriangleAlert /> : <Send />}
        <span className="btn-label-keep">{publishState.label}</span>
      </button>
    </header>

    <div className="editor-body">
      <main className="editor-canvas">
        <div className="editor-column">
          {images.length > 0 && <div className="editor-notices">
            {importable > 0 && <div className="notice notice-info"><ImageUp />
              <div style={{ flex: 1 }}><strong>文中有 {importable} 张外部图片</strong>，发布前需要转存，公众号才能正常显示。</div>
              <button className="btn btn-sm" onClick={importImages} disabled={busy}>一键转存</button>
            </div>}
            {blocked > 0 && <div className="notice notice-warn"><TriangleAlert />
              <div><strong>{blocked} 张图片来源不支持</strong>，请删除后通过编辑器重新上传（支持 PNG、JPEG、WebP）。</div>
            </div>}
          </div>}
          <label className="sr-only" htmlFor="article-title">文章标题</label>
          <textarea id="article-title" ref={titleRef} className="title-input" rows={1} maxLength={255} placeholder="标题"
            value={title} disabled={locked} onChange={event => setTitle(event.target.value)}
            onKeyDown={event => { if (event.key === "Enter") { event.preventDefault(); root.current?.querySelector<HTMLElement>("[contenteditable=true]")?.focus(); } }} />
          <div className="title-meta">
            <span>{stats.chars.toLocaleString("zh-CN")} 字</span>
            <span>约 {stats.minutes} 分钟读完</span>
          </div>
          <article className="article-sheet" aria-label="正文">
            <div ref={root} className="myno-root" />
          </article>
        </div>
      </main>

      {panel && <div className="panel-scrim" onClick={() => setPanel(null)} />}
      <aside className="panel" hidden={!panel} aria-label="排版与封面">
        <div className="panel-tabs" role="tablist">
          <button role="tab" aria-selected={panel === "style"} onClick={() => setPanel("style")}><Palette />排版{stylePending && <span className="tab-dot" aria-label="有未保存的调整" />}</button>
          <button role="tab" aria-selected={panel === "cover"} onClick={() => setPanel("cover")}><ImageIcon />封面{coverPending && <span className="tab-dot" aria-label="有未保存的调整" />}</button>
          <button className="icon-btn" aria-label="收起" onClick={() => setPanel(null)}><X /></button>
        </div>
        <div className="panel-body">
          <div hidden={panel !== "style"}>
            {mounted.style && <StylePanel ref={stylePanel} wizard document={doc} disabled={busy || !ready} onBusy={setPanelBusy}
              onApply={async () => doc}
              onPreview={(config, pending) => { editor.current?.applyStyleConfig(config); setStylePending(pending); }} />}
          </div>
          <div hidden={panel !== "cover"}>
            <div className="cover-stage-dock">
              <div className="cover-stage">
                {coverPreview && <span className="cover-stage-split" aria-hidden="true"><i>头图</i><i>分享图</i></span>}
                {coverPreview ? <img src={coverPreview} alt="封面预览" /> : <span className="muted">{coverRendering ? <Loader2 className="spin" /> : "填写文章标题后，这里会实时预览封面"}</span>}
                {coverPreview && coverRendering && <span className="cover-stage-busy" aria-label="正在更新预览"><Loader2 className="spin" /></span>}
              </div>
            </div>
            {mounted.cover && <CoverPanel ref={coverPanel} wizard document={doc} title={effectiveTitle} disabled={busy || !ready}
              onBusy={setPanelBusy} onPending={setCoverPending} onApply={async () => {}} onPreviewChange={setCoverPreview} onPreviewRendering={setCoverRendering} />}
          </div>
        </div>
        <footer className="panel-foot">
          <span className="grow">{stylePending || coverPending ? "改动已在正文中实时显示，保存后用于发布" : "当前设置已保存"}</span>
          {(stylePending || coverPending) && <button className="btn btn-ghost" onClick={discardConfiguration} disabled={busy}>放弃</button>}
          <button className="btn btn-primary" disabled={busy || !(stylePending || coverPending)} onClick={() => saveConfiguration().then(() => setPanel(null)).catch(() => {})}>保存</button>
        </footer>
      </aside>
    </div>
  </div>;
}

function SaveIndicator({ state, uploading, onRetry }: { state: SaveState; uploading: number; onRetry: () => void }) {
  if (state === "error") return <button className="save-state is-error btn-ghost btn btn-sm" onClick={onRetry}><i />保存失败，点击重试</button>;
  const label = uploading > 0 ? `正在上传 ${uploading} 张图片` : state === "saving" ? "保存中…" : state === "dirty" ? "有未保存的修改" : "已保存";
  return <span className={`save-state ${state === "saving" || uploading > 0 ? "is-saving" : state === "dirty" ? "is-dirty" : ""}`} role="status"><i />{label}</span>;
}
