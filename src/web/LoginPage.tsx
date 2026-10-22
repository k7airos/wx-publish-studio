import { useEffect, useState } from "react";
import { ArrowRight, Check, Loader2 } from "lucide-react";
import { api } from "./api";
import { loginCopy, loginReasonText, setCopyMode } from "./copy";
import { Logo, PRODUCT } from "./Logo";

interface AuthOptions {
  mode: "bootstrap" | "oauth";
  oauth: { enabled: boolean; startUrl?: string };
  copyMode: "neutral" | "hosted";
}

export function LoginPage({ onAuthenticated }: { onAuthenticated: () => void }) {
  const [options, setOptions] = useState<AuthOptions | null>(null);
  const [secret, setSecret] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");

  useEffect(() => {
    let disposed = false;
    const reason = new URL(window.location.href).searchParams.get("auth");
    if (reason) window.history.replaceState(null, "", "/");
    // 先取部署形态再显示失败原因，保证续期指引与当前部署一致。
    api<AuthOptions>("/auth/options").then(result => {
      if (disposed) return;
      setCopyMode(result.copyMode);
      setOptions(result);
      if (reason) setError(loginReasonText(reason));
    }).catch(err => {
      if (disposed) return;
      setError(reason ? loginReasonText(reason) : (err as Error).message);
    });
    return () => { disposed = true; };
  }, []);

  const copy = loginCopy();
  const subtitle = options?.mode === "oauth" ? copy.oauthSubtitle : copy.bootstrapSubtitle;

  return <main className="login">
    <section className="login-art" aria-hidden="true">
      <div className="brand" style={{ padding: 0 }}><Logo size={36} /><span className="brand-text"><span className="brand-name">{PRODUCT.name}</span><span className="brand-sub">{PRODUCT.tagline}</span></span></div>
      <div>
        <h2>写好一篇文章，<br />一键存进公众号草稿箱。</h2>
        <ul>
          <li><Check />专业排版，手机上看就是最终效果</li>
          <li><Check />封面随标题自动生成，一处修改处处生效</li>
          <li><Check />存入草稿箱前完整预览，所见即所发</li>
        </ul>
      </div>
      <small>为认真做内容的人准备</small>
    </section>
    <section className="login-panel">
      <div className="login-card">
        <div>
          <h1>欢迎回来</h1>
          {options && <p>{subtitle}</p>}
        </div>
        {error && <div className="notice notice-warn" role="alert">{error}</div>}
        {!options && !error && <div className="muted" role="status"><Loader2 className="spin" size={16} /> 正在准备登录…</div>}
        {options?.oauth.enabled && <a className="btn btn-primary btn-lg btn-block" href="/api/auth/oauth/start">{copy.oauthButton} <ArrowRight /></a>}
        {options?.mode === "bootstrap" && <form className="field" onSubmit={async event => {
          event.preventDefault();
          setBusy(true); setError("");
          try { await api("/auth/login", "POST", { secret }); onAuthenticated(); }
          catch (err) { setError((err as Error).message); }
          finally { setBusy(false); }
        }}>
          <label className="field-label" htmlFor="secret">访问口令</label>
          <input id="secret" className="input" type="password" autoComplete="current-password" value={secret} onChange={event => setSecret(event.target.value)} placeholder="输入访问口令" />
          <button className="btn btn-primary btn-lg btn-block" disabled={busy || !secret}>{busy ? <Loader2 className="spin" /> : null}进入</button>
        </form>}
        <p className="login-foot">{copy.foot}</p>
      </div>
    </section>
  </main>;
}
