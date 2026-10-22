import { createContext, useCallback, useContext, useEffect, useRef, useState, type ReactNode } from "react";
import { createPortal } from "react-dom";
import { AlertCircle, CheckCircle2, X } from "lucide-react";

export type Tone = "ok" | "warn" | "bad" | "info" | "brand" | "neutral";

export function Pill({ tone = "neutral", busy = false, dot = true, children }: { tone?: Tone; busy?: boolean; dot?: boolean; children: ReactNode }) {
  return <span className={`pill ${tone === "neutral" ? "" : `pill-${tone}`} ${busy ? "pill-busy" : ""} ${dot ? "" : "no-dot"}`}>{children}</span>;
}

export function Empty({ icon, title, children, action }: { icon: ReactNode; title: string; children?: ReactNode; action?: ReactNode }) {
  return <div className="empty">
    <div className="empty-icon">{icon}</div>
    <h3>{title}</h3>
    {children && <p>{children}</p>}
    {action}
  </div>;
}

function useEscape(active: boolean, onClose: () => void) {
  const latest = useRef(onClose);
  latest.current = onClose;
  useEffect(() => {
    if (!active) return;
    const handle = (event: KeyboardEvent) => { if (event.key === "Escape") latest.current(); };
    window.addEventListener("keydown", handle);
    return () => window.removeEventListener("keydown", handle);
  }, [active]);
}

/** 居中对话框；手机端自动变为底部抽屉。 */
export function Dialog({ open, onClose, wide = false, label, children }: { open: boolean; onClose: () => void; wide?: boolean; label: string; children: ReactNode }) {
  useEscape(open, onClose);
  if (!open) return null;
  return createPortal(
    <div className="overlay" onMouseDown={event => { if (event.target === event.currentTarget) onClose(); }}>
      <div className={`dialog ${wide ? "dialog-wide" : ""}`} role="dialog" aria-modal="true" aria-label={label}>{children}</div>
    </div>,
    document.body,
  );
}

/** 右侧面板；手机端占满屏幕。 */
export function Sheet({ open, onClose, title, subtitle, wide = false, footer, children, dismissible = true }: {
  open: boolean; onClose: () => void; title: ReactNode; subtitle?: ReactNode; wide?: boolean; footer?: ReactNode; children: ReactNode; dismissible?: boolean;
}) {
  useEscape(open && dismissible, onClose);
  if (!open) return null;
  return createPortal(<>
    <div className="sheet-overlay" onClick={() => { if (dismissible) onClose(); }} />
    <aside className={`sheet ${wide ? "sheet-wide" : ""}`} role="dialog" aria-modal="true">
      <header className="sheet-head">
        <div className="sheet-title"><h2>{title}</h2>{subtitle && <p>{subtitle}</p>}</div>
        <button className="icon-btn" onClick={onClose} disabled={!dismissible} aria-label="关闭"><X /></button>
      </header>
      <div className="sheet-body">{children}</div>
      {footer && <footer className="sheet-foot">{footer}</footer>}
    </aside>
  </>, document.body);
}

interface ConfirmOptions { title: string; message?: ReactNode; confirmText?: string; cancelText?: string; danger?: boolean }
interface Toast { id: number; text: string; tone: "ok" | "bad" }
interface UiContext { confirm: (options: ConfirmOptions) => Promise<boolean>; toast: (text: string, tone?: "ok" | "bad") => void }
const Context = createContext<UiContext | null>(null);

/** 统一的确认对话框与提示条，替代浏览器原生 confirm／alert。 */
export function UiProvider({ children }: { children: ReactNode }) {
  const [pending, setPending] = useState<(ConfirmOptions & { resolve: (value: boolean) => void }) | null>(null);
  const [toasts, setToasts] = useState<Toast[]>([]);
  const confirm = useCallback((options: ConfirmOptions) => new Promise<boolean>(resolve => setPending({ ...options, resolve })), []);
  const toast = useCallback((text: string, tone: "ok" | "bad" = "ok") => {
    const id = Date.now() + Math.random();
    setToasts(current => [...current.slice(-2), { id, text, tone }]);
    setTimeout(() => setToasts(current => current.filter(item => item.id !== id)), tone === "bad" ? 6000 : 3200);
  }, []);
  const close = (value: boolean) => { pending?.resolve(value); setPending(null); };
  return <Context.Provider value={{ confirm, toast }}>
    {children}
    <Dialog open={!!pending} onClose={() => close(false)} label={pending?.title ?? "确认"}>
      {pending && <>
        <h2>{pending.title}</h2>
        {pending.message && <p>{pending.message}</p>}
        <div className="dialog-actions">
          <button className="btn" onClick={() => close(false)}>{pending.cancelText ?? "取消"}</button>
          <button className={`btn ${pending.danger ? "btn-danger" : "btn-primary"}`} autoFocus onClick={() => close(true)}>{pending.confirmText ?? "确定"}</button>
        </div>
      </>}
    </Dialog>
    {createPortal(<div className="toast-stack" aria-live="polite">
      {toasts.map(item => <div key={item.id} className={`toast ${item.tone === "bad" ? "toast-bad" : ""}`}>
        {item.tone === "bad" ? <AlertCircle /> : <CheckCircle2 />}<span>{item.text}</span>
      </div>)}
    </div>, document.body)}
  </Context.Provider>;
}

export function useUi() {
  const value = useContext(Context);
  if (!value) throw new Error("UiProvider missing");
  return value;
}

/** 点击外部关闭的轻量菜单。 */
export function useDismiss<T extends HTMLElement>(open: boolean, onClose: () => void) {
  const ref = useRef<T>(null);
  const latest = useRef(onClose);
  latest.current = onClose;
  useEffect(() => {
    if (!open) return;
    const handle = (event: MouseEvent) => { if (ref.current && !ref.current.contains(event.target as Node)) latest.current(); };
    document.addEventListener("mousedown", handle);
    return () => document.removeEventListener("mousedown", handle);
  }, [open]);
  return ref;
}
