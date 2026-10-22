import { forwardRef, useEffect, useImperativeHandle, useRef, useState } from "react";
import { CoverControls, TypesetTemplateEditor, changeHostTemplateSlot, type TypesetConfig } from "@akairos/typeset-studio/editor";
import { DEFAULT_ARTICLE_COVER_CONTROLS } from "@akairos/typeset-studio/cover";
import { ChevronRight, ImageIcon, Loader2 } from "lucide-react";
import { api, apiResponse, type Document } from "./api";
import type { CoverTemplate, CoverAsset, CoverFont, TemplateAsset } from "./cover-types";

export interface CoverPanelHandle { prepare(): Promise<CoverTemplate | null>; reset(): void }
interface Props {
  document: Document; title: string; disabled: boolean; wizard?: boolean;
  onBusy: (busy: boolean) => void; onPending: (pending: boolean) => void;
  onApply: (template: CoverTemplate | null) => Promise<void>;
  onPreviewChange?: (url: string) => void;
  /** 新预览生成中；旧图保留显示，避免微调时预览区闪空。 */
  onPreviewRendering?: (rendering: boolean) => void;
}
const initial = { ...DEFAULT_ARTICLE_COVER_CONTROLS };

// 封面缩略图由服务端按当前标题渲染；并发 2、按样式与标题缓存，避免面板打开时一次压满服务。
const thumbCache = new Map<string, Promise<string>>();
const thumbQueue: (() => void)[] = [];
let thumbActive = 0;
function queueThumb(task: () => Promise<string>): Promise<string> {
  return new Promise((resolve, reject) => {
    const run = () => { thumbActive++; task().then(resolve, reject).finally(() => { thumbActive--; thumbQueue.shift()?.(); }); };
    if (thumbActive < 1) run(); else thumbQueue.push(run);
  });
}
// 服务端每人同时只渲染一张封面；遇到忙碌时稍后重试。
async function renderWithRetry(request: () => Promise<Response>) {
  for (let attempt = 0; ; attempt++) {
    try { return URL.createObjectURL(await (await request()).blob()); }
    catch (error) {
      if (attempt >= 4) throw error;
      await new Promise(resolve => setTimeout(resolve, 600 * (attempt + 1)));
    }
  }
}
function thumbnail(key: string, request: () => Promise<Response>) {
  if (!thumbCache.has(key)) thumbCache.set(key, queueThumb(() => renderWithRetry(request)).catch(error => { thumbCache.delete(key); throw error; }));
  return thumbCache.get(key)!;
}

function CoverThumb({ cacheKey, request }: { cacheKey: string; request: (() => Promise<Response>) | null }) {
  const [url, setUrl] = useState("");
  const [failed, setFailed] = useState(false);
  useEffect(() => {
    setUrl(""); setFailed(false);
    if (!request) return;
    let alive = true;
    thumbnail(cacheKey, request).then(value => { if (alive) setUrl(value); }).catch(() => { if (alive) setFailed(true); });
    return () => { alive = false; };
  }, [cacheKey]);
  return <span className="cover-thumb">{url ? <img src={url} alt="" /> : request && !failed ? <Loader2 className="spin" /> : <ImageIcon />}</span>;
}

export const CoverPanel = forwardRef<CoverPanelHandle, Props>(function CoverPanel({ document, title, disabled, wizard = false, onBusy, onPending, onApply, onPreviewChange, onPreviewRendering }, ref) {
  const applied = document.coverTemplate as CoverTemplate | null;
  const [templates, setTemplates] = useState<CoverTemplate[]>([]);
  const [selected, setSelected] = useState<CoverTemplate | null>(applied);
  const [name, setName] = useState(applied?.name || "");
  const [native, setNative] = useState<TypesetConfig | null>(applied?.schemaVersion === 2 ? applied.config : null);
  const [controls, setControls] = useState(applied?.schemaVersion === 1 ? applied.controls : initial);
  const [asset, setAsset] = useState<CoverAsset | null>(applied?.schemaVersion === 1 ? applied.asset : null);
  const [assets, setAssets] = useState<TemplateAsset[]>(applied?.schemaVersion === 2 ? applied.assets : []);
  const [fonts, setFonts] = useState<CoverFont[]>(applied?.schemaVersion === 2 ? applied.fonts : []);
  const [presets, setPresets] = useState<TypesetConfig[]>([]);
  const [error, setError] = useState("");
  const [message, setMessage] = useState("");
  const previewRef = useRef("");
  const previewGeneration = useRef(0);
  const matching = !!selected && name === selected.name && (selected.schemaVersion === 2 ? JSON.stringify(native) === JSON.stringify(selected.config) : !native && asset?.id === selected.asset.id && JSON.stringify(controls) === JSON.stringify(selected.controls));
  const untouched = !selected && !native && !asset && !name && JSON.stringify(controls) === JSON.stringify(initial);
  const pending = untouched ? !!document.coverTemplateId : !matching || selected?.id !== document.coverTemplateId || selected?.revision !== document.coverTemplateRevision;
  const applicable = !native || native.slot === "article_cover";

  function clearPreview() { previewGeneration.current++; URL.revokeObjectURL(previewRef.current); previewRef.current = ""; onPreviewChange?.(""); }
  function newTemplate(preset: TypesetConfig) {
    setSelected(null); setName(preset.name); setNative(structuredClone(preset)); setAssets([]); setError(""); setMessage(""); clearPreview();
  }
  function load(template: CoverTemplate | null) {
    setSelected(template); setName(template?.name || ""); setNative(template?.schemaVersion === 2 ? structuredClone(template.config) : null);
    setControls(template?.schemaVersion === 1 ? template.controls : initial); setAsset(template?.schemaVersion === 1 ? template.asset : null);
    setAssets(template?.schemaVersion === 2 ? template.assets : []); setError(""); setMessage(""); clearPreview();
  }
  async function refresh() { setTemplates((await api<{ templates: CoverTemplate[] }>("/cover-templates")).templates); }
  useEffect(() => {
    refresh().catch(err => setError((err as Error).message));
    api<{ presets: TypesetConfig[]; fonts: CoverFont[] }>("/cover-templates/catalog").then(catalog => { setPresets(catalog.presets); setFonts(catalog.fonts); }).catch(err => setError((err as Error).message));
    return () => { previewGeneration.current++; URL.revokeObjectURL(previewRef.current); };
  }, []);
  useEffect(() => { onPending(pending); }, [pending]);

  async function save(asNew = false): Promise<CoverTemplate> {
    onBusy(true); setError("");
    try {
      const input = native ? { schemaVersion: 2, name: name.trim(), slot: native.slot, config: { ...native, name: name.trim() } } : { name: name.trim(), controls, assetId: asset?.id };
      const saved = await api<CoverTemplate>(!asNew && selected ? `/cover-templates/${selected.id}` : "/cover-templates", !asNew && selected ? "PUT" : "POST", { ...input, ...(!asNew && selected ? { expectedRevision: selected.revision } : {}) });
      load(saved); await refresh(); setMessage("封面已保存。"); return saved;
    } catch (err) { setError((err as Error).message); throw err; }
    finally { onBusy(false); }
  }
  async function uploadImage(file: File) {
    onBusy(true);
    try { const form = new FormData(); form.set("image", file); const uploaded = await (await apiResponse("/assets/body", "POST", form)).json() as TemplateAsset; setAssets(values => [...values, uploaded]); return uploaded; }
    finally { onBusy(false); }
  }
  useImperativeHandle(ref, () => ({
    async prepare() {
      if (!applicable) throw new Error("贴图模板已可保存到模板库；文章封面请选择文章模板。");
      if (untouched) return null;
      if (matching) return selected;
      return save();
    },
    reset() { load(document.coverTemplate as CoverTemplate | null); onPending(false); },
  }));

  // 当前文章标题驱动服务端权威预览，未保存配置不改文章或默认设置。
  useEffect(() => {
    previewGeneration.current++;
    if (!title.trim()) { clearPreview(); return; }
    // 未选模板时预览发布实际使用的公共默认封面。
    const config = native;
    const legacy = !config && matching && selected?.schemaVersion === 1 ? selected : null;
    const fallback = !config && !selected;
    if (!config && !legacy && !fallback) { clearPreview(); return; }
    const generation = ++previewGeneration.current;
    onPreviewRendering?.(true);
    const timer = setTimeout(() => {
      // 与缩略图共用每人一张的渲染名额，忙碌时退避重试。
      const request = () => config
        ? apiResponse("/cover-templates/preview", "POST", JSON.stringify({ title, config: { ...config, name: name.trim() || config.name } }), true)
        : fallback ? apiResponse("/cover-templates/default/preview", "POST", JSON.stringify({ title }), true)
        : apiResponse(`/cover-templates/${legacy!.id}/revisions/${legacy!.revision}/preview`, "POST", JSON.stringify({ title }), true);
      renderWithRetry(request).then(url => {
        if (generation !== previewGeneration.current) { URL.revokeObjectURL(url); return; }
        URL.revokeObjectURL(previewRef.current); previewRef.current = url; setError(""); onPreviewChange?.(url); onPreviewRendering?.(false);
      }).catch(err => { if (generation === previewGeneration.current) { setError((err as Error).message); onPreviewRendering?.(false); } });
    }, 500);
    return () => { clearTimeout(timer); previewGeneration.current++; };
  }, [native, selected, matching, title, name]);

  const articlePresets = presets.filter(preset => preset.slot === "article_cover");
  const myTemplates = templates.filter(template => template.schemaVersion === 1 || template.slot === "article_cover");
  const previewTitle = title.trim() || "文章标题";
  const presetRequest = (preset: TypesetConfig) => () => apiResponse("/cover-templates/preview", "POST", JSON.stringify({ title: previewTitle, config: preset }), true);
  const savedRequest = (template: CoverTemplate) => () => template.schemaVersion === 2
    ? apiResponse("/cover-templates/preview", "POST", JSON.stringify({ title: previewTitle, config: template.config }), true)
    : apiResponse(`/cover-templates/${template.id}/revisions/${template.revision}/preview`, "POST", JSON.stringify({ title: previewTitle }), true);
  const isDefault = !selected && !native;
  const activePreset = !selected && native ? articlePresets.find(preset => preset.id === native.id) : undefined;

  return <div className="cover-controls">
    <fieldset disabled={disabled} style={{ border: 0, margin: 0, padding: 0, minWidth: 0 }}>
      {myTemplates.length > 0 && <section className="ctl-section">
        <div className="ctl-head"><h4>我的封面</h4><span>以前保存过的样式</span></div>
        <div className="cover-gallery">
          {myTemplates.map(template => <button type="button" key={template.id} className={`cover-option ${selected?.id === template.id ? "is-selected" : ""}`} onClick={() => load(template)}>
            <CoverThumb cacheKey={`saved:${template.id}:${template.revision}:${previewTitle}`} request={savedRequest(template)} />
            <span>{template.name}</span>
          </button>)}
        </div>
      </section>}
      <section className="ctl-section">
        <div className="ctl-head"><h4>封面样式</h4><span>按当前标题实时生成</span></div>
        <div className="cover-gallery">
          <button type="button" className={`cover-option ${isDefault ? "is-selected" : ""}`} onClick={() => { load(null); onPending(!!applied); }}>
            <CoverThumb cacheKey={`default:${previewTitle}`} request={() => apiResponse("/cover-templates/default/preview", "POST", JSON.stringify({ title: previewTitle }), true)} />
            <span>默认封面</span>
          </button>
          {articlePresets.map(preset => <button type="button" key={preset.id} className={`cover-option ${activePreset?.id === preset.id ? "is-selected" : ""}`}
            onClick={() => newTemplate({ ...structuredClone(preset), name: `封面 · ${preset.name}` })}>
            <CoverThumb cacheKey={`preset:${preset.id}:${previewTitle}`} request={presetRequest(preset)} />
            <span>{preset.name}</span>
          </button>)}
        </div>
      </section>
      {(native || selected?.schemaVersion === 1) && <details className="disclosure">
        <summary><ChevronRight />微调<span>标题大小、位置、颜色</span></summary>
        <div className="disclosure-body">
          <label className="field"><span className="field-label">封面名称</span>
            <input className="input" maxLength={80} value={name} onChange={e => { setName(e.target.value); if (native) setNative({ ...native, name: e.target.value }); }} />
          </label>
          {native ? <>
            {!applicable && <p role="status" className="notice notice-warn">这个样式不是文章封面尺寸，请换一个封面样式。</p>}
            <SimpleCoverControls config={native} assets={assets} disabled={disabled} onUpload={uploadImage} onError={setError} onChange={value => { setNative(value); setError(""); }} />
            <details className="disclosure">
              <summary><ChevronRight />专业设置<span>字体、边距、花纹、贴图</span></summary>
              <div className="disclosure-body typeset-host">
                <TypesetTemplateEditor config={native} fonts={fonts.map(font => ({ family: font.family, label: font.label || font.family }))} assets={assets} disabled={disabled}
                  onChange={value => { setNative(value); setError(""); }}
                  onUploadImage={uploadImage} />
              </div>
            </details>
          </> : <>
            <div className="typeset-host"><CoverControls value={controls} disabled={disabled} onChange={setControls} /></div>
            <label className="field"><span className="field-label">背景方图</span><input type="file" accept="image/png,image/jpeg,image/webp" onChange={async e => { const file = e.target.files?.[0]; if (!file) return; onBusy(true); setError(""); try { const data = new FormData(); data.set("image", file); setAsset(await (await apiResponse("/assets", "POST", data)).json() as CoverAsset); } catch (err) { setError((err as Error).message); } finally { onBusy(false); } }} /></label>
            {asset && <img src={asset.url} alt="背景方图" style={{ width: 80, height: 80, objectFit: "cover", borderRadius: 8 }} />}
          </>}
          {selected && <button type="button" className="btn btn-sm" style={{ justifySelf: "start" }} disabled={!name.trim() || (!native && !asset)} onClick={() => save(true).catch(() => {})}>另存为新封面</button>}
        </div>
      </details>}
    </fieldset>
    {message && !wizard && <p className="notice notice-ok" role="status">{message}</p>}
    {error && <p className="notice notice-bad" role="alert">{error}</p>}
  </div>;
});

const TITLE_SIZES = [{ label: "小", value: 52 }, { label: "标准", value: 64 }, { label: "大", value: 76 }];

/** 内置封面为“头图底色 | 方图色块”的四节点硬分界渐变；其他结构不显示颜色项。 */
function splitFill(config: TypesetConfig) {
  const fill = config.canvasStyle?.fill;
  if (fill?.type !== "linear" || fill.angle !== 0 || fill.stops.length !== 4 || fill.stops[1]!.offset !== fill.stops[2]!.offset) return null;
  return fill;
}

// 面向客户的封面微调：只暴露标题大小、对齐与三种颜色，其余交给专业设置。
const LOGO_ID = "logo";
function SimpleCoverControls({ config, assets, disabled, onChange, onUpload, onError }: { config: TypesetConfig; assets: TemplateAsset[]; disabled: boolean; onChange: (config: TypesetConfig) => void; onUpload: (file: File) => Promise<TemplateAsset>; onError: (message: string) => void }) {
  const fill = splitFill(config);
  const size = config.algorithm.baseFontSize;
  const align = config.algorithm.textAlign === "center" ? "center" : "left";
  const setFill = (side: "left" | "right", color: string) => {
    if (!fill) return;
    const stops = fill.stops.map((stop, index) => (side === "left" ? index < 2 : index >= 2) ? { ...stop, color } : stop);
    // 花纹与头图底色同色，保持只在方图上显现。
    const pattern = side === "left" && config.canvasStyle?.pattern ? { ...config.canvasStyle.pattern, color } : config.canvasStyle?.pattern;
    onChange({ ...config, theme: side === "left" ? { ...config.theme, bgColor: color } : config.theme, canvasStyle: { ...config.canvasStyle, fill: { ...fill, stops }, ...(pattern ? { pattern } : {}) } });
  };
  const colors = [
    { key: "text", label: "标题文字", value: config.theme.headingColor || config.theme.textColor, set: (color: string) => onChange({ ...config, theme: { ...config.theme, textColor: color, headingColor: color } }) },
    ...(fill ? [
      { key: "left", label: "头图底色", value: fill.stops[0]!.color, set: (color: string) => setFill("left", color) },
      { key: "right", label: "右侧方块", value: fill.stops[2]!.color, set: (color: string) => setFill("right", color) },
    ] : []),
  ];
  return <div style={{ display: "grid", gap: 14 }}>
    <div className="seg-row">
      <div className="seg-label"><span>标题大小</span><span>标题较长时会自动缩小</span></div>
      <div className="segmented">{TITLE_SIZES.map(option => <button type="button" key={option.label} aria-pressed={option.value === size}
        onClick={() => onChange({ ...config, algorithm: { ...config.algorithm, baseFontSize: option.value } })}>{option.label}</button>)}</div>
    </div>
    <div className="seg-row">
      <div className="seg-label"><span>标题位置</span></div>
      <div className="segmented">{([["left", "居左"], ["center", "居中"]] as const).map(([value, label]) => <button type="button" key={value} aria-pressed={align === value}
        onClick={() => onChange({ ...config, algorithm: { ...config.algorithm, textAlign: value } })}>{label}</button>)}</div>
    </div>
    <div className="color-rows">
      {colors.map(field => <label className="color-row" key={field.key}>
        <span className="dot" style={{ background: field.value }}><input type="color" value={field.value} aria-label={field.label} onChange={event => field.set(event.target.value)} /></span>
        <span>{field.label}</span><code>{field.value.toUpperCase()}</code>
      </label>)}
    </div>
    {config.slot === "article_cover" && <LogoControl config={config} assets={assets} disabled={disabled} onChange={onChange} onUpload={onUpload} onError={onError} />}
  </div>;
}

// 右侧 1:1 方图在公众号里单独显示（分享卡片、次条），留给公众号或品牌 LOGO：上传后居中放入方块。
function LogoControl({ config, assets, disabled, onChange, onUpload, onError }: { config: TypesetConfig; assets: TemplateAsset[]; disabled: boolean; onChange: (config: TypesetConfig) => void; onUpload: (file: File) => Promise<TemplateAsset>; onError: (message: string) => void }) {
  const logo = config.images?.find(image => image.id === LOGO_ID);
  const logoAsset = logo ? assets.find(asset => `asset:${asset.id}` === logo.src) : undefined;
  const { left, top } = config.algorithm.safeArea;
  const place = async (file: File) => {
    onError("");
    try {
      const asset = await onUpload(file);
      const ratio = (asset.width || 1) / (asset.height || 1);
      const box = 560;
      const width = Math.round(ratio >= 1 ? box : box * ratio), height = Math.round(ratio >= 1 ? box / ratio : box);
      // 绝对定位图片以版心左上角为原点；方块位于画布 x 2350–3350。
      const image = { id: LOGO_ID, templateAssetKey: LOGO_ID, src: `asset:${asset.id}`, alt: "LOGO", isAbsolute: true, layoutPreset: "custom" as const,
        x: 2350 + Math.round((1000 - width) / 2) - left, y: Math.round((1000 - height) / 2) - top, width, height, zIndex: 15, rotate: 0, opacity: 1,
        borderRadius: Math.abs(ratio - 1) < 0.08 ? 56 : 0 };
      onChange({ ...config, images: [...(config.images || []).filter(item => item.id !== LOGO_ID), image] });
    } catch (err) { onError((err as Error).message); }
  };
  return <div className="seg-row">
    <div className="seg-label"><span>右侧 LOGO</span><span>公众号分享卡片、次条里单独显示</span></div>
    <div style={{ display: "flex", gap: 8, alignItems: "center", flexWrap: "wrap" }}>
      <label className="btn btn-sm" style={{ cursor: disabled ? "not-allowed" : "pointer" }}>
        {logo ? "更换 LOGO" : "上传 LOGO"}
        <input type="file" accept="image/png,image/jpeg,image/webp" disabled={disabled} hidden onChange={async event => { const file = event.target.files?.[0]; event.target.value = ""; if (file) await place(file); }} />
      </label>
      {logo && <button type="button" className="btn btn-sm btn-ghost" disabled={disabled} onClick={() => onChange({ ...config, images: (config.images || []).filter(item => item.id !== LOGO_ID) })}>移除</button>}
      {logoAsset && <span className="muted" style={{ fontSize: 12 }}>已放入右侧方块</span>}
    </div>
  </div>;
}

