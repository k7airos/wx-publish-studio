import { forwardRef, useEffect, useImperativeHandle, useRef, useState } from "react";
import { mountStyleControls } from "@akairos/myno/style-controls";
import {
  COLOR_PALETTES, STYLE_PACKS, SYNTAX_CATEGORIES,
  applyColorPalette, applyStylePack, brandTint, normalizeStyleConfig,
  type MynoStyleConfig,
} from "@akairos/myno/style-config";
import { api, type ArticleStyle, type Document, type SavedStyle } from "./api";
import { ChevronRight } from "lucide-react";

export interface StylePanelHandle {
  prepare(): Promise<SavedStyle | null>;
  reset(): void;
}

function configOf(style: ArticleStyle | null): MynoStyleConfig {
  return normalizeStyleConfig(style?.manifest);
}

function appliedStyle(document: Document): SavedStyle | null {
  return document.articleStyle && document.styleId && document.styleRevision ? {
    id: document.styleId, revision: document.styleRevision,
    name: document.articleStyle.manifest.name || "正文样式", updatedAt: document.updatedAt,
    articleStyle: document.articleStyle,
  } : null;
}

// myno 的控件仍负责高级项；常用项由下面的中文友好控件接管。
const REPLACED_GROUPS = new Set(["整套预设与配色", "字体与间距", "颜色", "语法节点预设"]);

type ThemeRecord = Record<string, string | undefined>;

function themeOf(config: MynoStyleConfig): ThemeRecord {
  return config.exportTheme as ThemeRecord;
}

function parseNumber(raw: string | undefined, fallback: number) {
  const parsed = Number.parseFloat(raw ?? "");
  return Number.isFinite(parsed) ? parsed : fallback;
}

function withTheme(config: MynoStyleConfig, key: string, next: string): MynoStyleConfig {
  return { ...config, exportTheme: { ...config.exportTheme, [key]: next } };
}

function hexColor(raw: string | undefined, fallback: string) {
  const value = raw?.trim() ?? "";
  const long = /^#([0-9a-f]{6})$/i.exec(value);
  if (long) return `#${long[1].toLowerCase()}`;
  const short = /^#([0-9a-f]{3})$/i.exec(value);
  if (short) return `#${short[1].split("").map(char => char + char).join("")}`;
  return fallback;
}

const COLOR_FIELDS = [
  { key: "primaryColor", variable: "--brand", label: "品牌强调色", hint: "标题装饰与重点标记", fallback: "#ca6093" },
  { key: "bodyColor", variable: "--text", label: "正文颜色", hint: "长文阅读的主色", fallback: "#292526" },
  { key: "h2Color", variable: "", label: "二级标题", hint: "大章节标题", fallback: "#1f1b1c" },
  { key: "h3Color", variable: "", label: "三级标题", hint: "小节标题", fallback: "#5c5658" },
  { key: "blockquoteBorderColor", variable: "", label: "引用强调色", hint: "引用块左侧竖线", fallback: "#ca6093" },
  { key: "dividerColor", variable: "--divider", label: "分割线颜色", hint: "章节之间的分隔", fallback: "#e2dcdf" },
  { key: "mutedColor", variable: "--text-soft", label: "弱化文字", hint: "图注与辅助说明", fallback: "#6f696b" },
] as const;

type ColorField = (typeof COLOR_FIELDS)[number];

function colorValue(config: MynoStyleConfig, field: ColorField) {
  const direct = themeOf(config)[field.key];
  if (direct) return hexColor(direct, field.fallback);
  if (field.variable) return hexColor(config.editorVars[field.variable], field.fallback);
  return field.fallback;
}

function withColor(config: MynoStyleConfig, field: ColorField, next: string): MynoStyleConfig {
  const editorVars = { ...config.editorVars, ...(field.variable ? { [field.variable]: next } : {}) };
  if (field.key === "primaryColor") {
    const tint = brandTint(next, 0.08);
    if (tint) {
      editorVars["--brand-bg"] = tint;
      editorVars["--brand-bg-deep"] = brandTint(next, 0.12)!;
    }
  }
  return { ...config, editorVars, exportTheme: { ...config.exportTheme, [field.key]: next } };
}

function shortName(name: string) {
  return name.replace(/\s*\(.*\)\s*$/, "").replace(/^[^\w㐀-鿿]+/, "").trim();
}

function sizeLabel(value: number) {
  return value <= 14 ? "小" : value <= 16 ? "标准" : value <= 18 ? "大" : "特大";
}

function lineLabel(value: number) {
  return value < 1.7 ? "紧凑" : value < 1.95 ? "舒适" : "宽松";
}

function letterLabel(value: number) {
  return value < 0.01 ? "紧凑" : value < 0.03 ? "标准" : "疏朗";
}

function paragraphLabel(value: number) {
  return value < 1.1 ? "紧凑" : value < 1.45 ? "标准" : "宽松";
}

function RangeField({ label, valueText, min, max, step, value, presets, onChange }: {
  label: string;
  valueText: string;
  min: number;
  max: number;
  step: number;
  value: number;
  presets: { label: string; value: number }[];
  onChange: (value: number) => void;
}) {
  return <div className="range-row">
    <div className="seg-label"><span>{label}</span><span>{valueText}</span></div>
    <input type="range" min={min} max={max} step={step} value={value} aria-label={label} onChange={event => onChange(Number(event.target.value))} />
    {presets.length > 0 && <div className="segmented">{presets.map(preset => <button type="button" key={preset.label} aria-pressed={Math.abs(preset.value - value) < 0.001} onClick={() => onChange(preset.value)}>{preset.label}</button>)}</div>}
  </div>;
}

export const StylePanel = forwardRef<StylePanelHandle, {
  document: Document;
  disabled: boolean;
  wizard?: boolean;
  onPreview: (config: MynoStyleConfig | undefined, pending: boolean) => void;
  onApply: (style: SavedStyle | null) => Promise<Document>;
  onBusy: (busy: boolean) => void;
}>(function StylePanel({ document, disabled, wizard = false, onPreview, onApply, onBusy }, ref) {
  const [styles, setStyles] = useState<SavedStyle[]>([]);
  const [selected, setSelected] = useState<SavedStyle | null>(() => appliedStyle(document));
  const [name, setName] = useState(document.articleStyle?.manifest.name ?? "");
  const [controls, setControls] = useState(() => configOf(document.articleStyle));
  const [useDefault, setUseDefault] = useState(false);
  const [error, setError] = useState("");
  const [message, setMessage] = useState("");
  const controlsRoot = useRef<HTMLDivElement>(null);
  const mountedControls = useRef<ReturnType<typeof mountStyleControls> | null>(null);

  const matchesSaved = !!selected && name === selected.name
    && JSON.stringify(controls) === JSON.stringify(configOf(selected.articleStyle));
  const pending = useDefault ? !!document.styleId : name !== (document.articleStyle?.manifest.name ?? "")
    || JSON.stringify(controls) !== JSON.stringify(configOf(document.articleStyle))
    || selected?.id !== (document.styleId ?? undefined)
    || selected?.revision !== (document.styleRevision ?? undefined);
  const appliedLabel = document.styleId && document.styleRevision
    ? `${document.articleStyle?.manifest.name || "正文样式"} · 修订 ${document.styleRevision}`
    : "默认出厂样式";

  const theme = themeOf(controls);
  const fontSize = parseNumber(theme.bodyFontSize, 16);
  const lineHeight = parseNumber(theme.bodyLineHeight, 1.84);
  const letterSpacing = parseNumber(theme.bodyLetterSpacing, 0.012);
  const paragraphSpacing = parseNumber(theme.bodyParagraphSpacing, 1.18);

  async function refresh() {
    setStyles((await api<{ styles: SavedStyle[] }>("/styles")).styles);
  }

  useEffect(() => {
    refresh().catch(err => {
      setError((err as Error).message);
      const applied = appliedStyle(document);
      if (applied) setStyles([applied]);
    });
    const host = controlsRoot.current!;
    mountedControls.current = mountStyleControls(host, {
      value: controls, disabled,
      onChange: next => { setControls(next); setUseDefault(false); setMessage(""); },
    });
    // myno 每次重绘高级控件都会重建 details；隐藏已由友好控件接管的重复分组。
    const tidy = () => {
      host.querySelectorAll<HTMLDetailsElement>("details").forEach(section => {
        const title = section.querySelector(":scope > summary")?.textContent?.trim() ?? "";
        if (REPLACED_GROUPS.has(title)) section.hidden = true;
        else section.open = false;
      });
    };
    const observer = new MutationObserver(tidy);
    observer.observe(host, { childList: true, subtree: true });
    tidy();
    return () => {
      observer.disconnect();
      mountedControls.current?.destroy();
      mountedControls.current = null;
    };
  }, []);

  useEffect(() => { mountedControls.current?.update(controls, disabled); }, [controls, disabled]);
  useEffect(() => { onPreview(useDefault ? undefined : controls, pending); }, [controls, useDefault, pending]);

  function reset() {
    setSelected(appliedStyle(document));
    setName(document.articleStyle?.manifest.name ?? "");
    setControls(configOf(document.articleStyle));
    setUseDefault(false);
    setError(""); setMessage("");
  }

  async function save(asNew: boolean, styleName = name): Promise<SavedStyle> {
    onBusy(true); setError(""); setMessage("");
    try {
      const saved = await api<SavedStyle>(!asNew && selected ? `/styles/${selected.id}` : "/styles",
        !asNew && selected ? "PUT" : "POST", {
          name: styleName, config: controls,
          ...(!asNew && selected ? { expectedRevision: selected.revision } : {}),
        });
      setSelected(saved); setName(saved.name); setControls(configOf(saved.articleStyle));
      await refresh();
      setMessage(`已保存修订 ${saved.revision}，${wizard ? "完成向导后应用。" : "应用到文章后生效。"}`);
      return saved;
    } catch (err) {
      setError((err as Error).message);
      await refresh().catch(() => {});
      throw err;
    } finally { onBusy(false); }
  }

  useImperativeHandle(ref, () => ({
    async prepare() {
      if (useDefault) return null;
      if (!pending) return appliedStyle(document);
      if (matchesSaved) return selected;
      // 向导里只调了封面或配色时不再因空名称卡住，留空自动取一个可读名称。
      const styleName = name.trim() || selected?.name.trim() || "自定义正文样式";
      if (styleName !== name) setName(styleName);
      return save(false, styleName);
    },
    reset,
  }));

  function choose(id: string) {
    const style = styles.find(item => item.id === id) ?? null;
    setSelected(style); setName(style?.name ?? ""); setError(""); setMessage("");
    setUseDefault(false); setControls(configOf(style?.articleStyle ?? null));
  }

  async function restoreDefault() {
    setError("");
    try {
      if (!wizard) await onApply(null);
      setSelected(null); setName(""); setControls(normalizeStyleConfig()); setUseDefault(true);
      setMessage(wizard ? "完成向导后恢复默认正文样式。" : "已恢复默认出厂正文样式。");
    } catch (err) { setError((err as Error).message); }
  }

  function applyPack(pack: (typeof STYLE_PACKS)[number]) {
    setControls(current => applyStylePack(current, pack));
    setUseDefault(false); setMessage("");
  }

  function applyPalette(palette: (typeof COLOR_PALETTES)[number]) {
    setControls(current => applyColorPalette(current, palette));
    setUseDefault(false); setMessage("");
  }

  const activePack = STYLE_PACKS.find(pack =>
    hexColor(theme.primaryColor, "") === pack.theme.brandColor
    && hexColor(theme.bodyColor, "") === pack.theme.textColor
    && Math.abs(parseNumber(theme.bodyFontSize, 16) - Number.parseFloat(pack.theme.fontSize)) < 0.001
    && Math.abs(parseNumber(theme.bodyLineHeight, 1.84) - Number.parseFloat(pack.theme.lineHeight)) < 0.001
  );
  const activePalette = COLOR_PALETTES.find(palette =>
    hexColor(theme.primaryColor, "") === palette.colors.brand
    && hexColor(theme.bodyColor, "") === palette.colors.text
  );

  const sizeOptions = [{ label: "小", value: 14 }, { label: "标准", value: 16 }, { label: "大", value: 18 }, { label: "特大", value: 20 }];
  const lineOptions = [{ label: "紧凑", value: 1.6 }, { label: "舒适", value: 1.84 }, { label: "宽松", value: 2.05 }];
  const brand = colorValue(controls, COLOR_FIELDS[0]);
  return <div className="style-controls">
    <fieldset disabled={disabled} style={{ border: 0, margin: 0, padding: 0, minWidth: 0 }}>
      <section className="ctl-section">
        <div className="ctl-head"><h4>风格</h4><span>一键换整套字体、间距与配色</span></div>
        <div className="pack-grid">
          {STYLE_PACKS.map(pack => <button type="button" key={pack.id} className={`pack ${activePack?.id === pack.id ? "is-selected" : ""}`} onClick={() => applyPack(pack)} title={pack.description}>
            <span className="pack-sample" aria-hidden="true">
              <b style={{ borderColor: pack.swatch[0], background: `${pack.swatch[0]}22` }} />
              <i style={{ background: pack.swatch[1] }} /><i style={{ background: pack.swatch[1], width: "78%" }} />
            </span>
            <strong>{pack.name}</strong>
            <small>{pack.subtitle}</small>
          </button>)}
        </div>
      </section>

      <section className="ctl-section">
        <div className="ctl-head"><h4>主题色</h4><span>标题装饰与重点标记</span></div>
        <div className="swatches">
          {COLOR_PALETTES.map(palette => <button type="button" key={palette.id} className={`swatch ${activePalette?.id === palette.id ? "is-selected" : ""}`}
            style={{ background: palette.colors.brand }} title={shortName(palette.name)} aria-label={shortName(palette.name)} onClick={() => applyPalette(palette)} />)}
          <label className={`swatch swatch-custom ${activePalette ? "" : "is-selected"}`} title="自定义颜色">
            <span className="sr-only">自定义主题色</span>
            <input type="color" value={brand} onChange={event => setControls(current => withColor(current, COLOR_FIELDS[0], event.target.value))} />
          </label>
        </div>
      </section>

      <section className="ctl-section">
        <div className="seg-row">
          <div className="seg-label"><span>字号</span><span>{fontSize}px</span></div>
          <div className="segmented">{sizeOptions.map(option => <button type="button" key={option.label} aria-pressed={Math.abs(option.value - fontSize) < 0.001}
            onClick={() => setControls(current => withTheme(current, "bodyFontSize", `${option.value}px`))}>{option.label}</button>)}</div>
        </div>
        <div className="seg-row">
          <div className="seg-label"><span>行距</span><span>{lineLabel(lineHeight)}</span></div>
          <div className="segmented">{lineOptions.map(option => <button type="button" key={option.label} aria-pressed={Math.abs(option.value - lineHeight) < 0.001}
            onClick={() => setControls(current => withTheme(current, "bodyLineHeight", String(option.value)))}>{option.label}</button>)}</div>
        </div>
      </section>

      <details className="disclosure">
        <summary><ChevronRight />更多设置<span>颜色、间距、标题样式</span></summary>
        <div className="disclosure-body">
          <div className="color-rows">
            {COLOR_FIELDS.slice(1).map(field => {
              const value = colorValue(controls, field);
              return <label className="color-row" key={field.key}>
                <span className="dot" style={{ background: value }}><input type="color" value={value} aria-label={field.label} onChange={event => setControls(current => withColor(current, field, event.target.value))} /></span>
                <span>{field.label}</span><code>{value.toUpperCase()}</code>
              </label>;
            })}
          </div>
          <RangeField label="正文字号" valueText={`${sizeLabel(fontSize)} · ${fontSize}`} min={13} max={24} step={1} value={fontSize} presets={[]}
            onChange={value => setControls(current => withTheme(current, "bodyFontSize", `${value}px`))} />
          <RangeField label="字间距" valueText={letterLabel(letterSpacing)} min={0} max={0.06} step={0.002} value={letterSpacing} presets={[]}
            onChange={value => setControls(current => withTheme(current, "bodyLetterSpacing", `${value}em`))} />
          <RangeField label="段落间距" valueText={paragraphLabel(paragraphSpacing)} min={0.6} max={2} step={0.02} value={paragraphSpacing} presets={[]}
            onChange={value => setControls(current => withTheme(current, "bodyParagraphSpacing", `${value}em`))} />
          <div className="select-grid">
            {SYNTAX_CATEGORIES.map(category => <label className="field" key={category.key}>
              <span className="field-label">{shortName(category.label)}</span>
              <select className="select" value={controls.syntaxPresets[category.key] ?? category.defaultPresetId}
                onChange={event => setControls(current => ({ ...current, syntaxPresets: { ...current.syntaxPresets, [category.key]: event.target.value } }))}>
                {category.presets.map(preset => <option key={preset.id} value={preset.id}>{preset.name}</option>)}
              </select>
            </label>)}
          </div>
          <label className="field"><span className="field-label">从我保存的排版开始</span>
            <select className="select" value={selected?.id ?? ""} onChange={event => choose(event.target.value)}>
              <option value="">当前文章的排版</option>
              {styles.map(style => <option key={style.id} value={style.id}>{style.name}</option>)}
            </select>
          </label>
          <label className="field"><span className="field-label">给这套排版起个名字</span>
            <input className="input" value={name} maxLength={80} placeholder="例如：深度长文" onChange={event => { setName(event.target.value); setUseDefault(false); }} />
            <span className="field-hint">保存后可在其他文章中直接选用；不填会自动命名。</span>
          </label>
          <div style={{ display: "flex", gap: 8, flexWrap: "wrap" }}>
            <button type="button" className="btn btn-sm" onClick={reset}>撤销本次调整</button>
            <button type="button" className="btn btn-sm" onClick={() => void restoreDefault()}>恢复默认排版</button>
          </div>
          <details className="disclosure">
            <summary><ChevronRight />专业设置<span>结构、提示块、导入导出</span></summary>
            <div ref={controlsRoot} className="advanced-style-controls" />
          </details>
        </div>
      </details>
    </fieldset>
    {error && <div className="notice notice-bad" role="alert">{error}</div>}
    {message && !wizard && <div className="notice notice-ok" role="status">{message}</div>}
  </div>;
});
