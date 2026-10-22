import { useEffect, useState } from "react";
import { Check, ChevronLeft, ChevronRight, Copy, ExternalLink, KeyRound, Loader2, MessageSquareText, Plus, ShieldCheck } from "lucide-react";
import { api, type Account } from "../api";
import type { Store } from "../App";
import { Dialog, Empty, Pill, useUi } from "../ui";
import { accountHuman } from "../status";
import { pick, supportCopy } from "../copy";
import { WECHAT_DEV_URL } from "../constants";

let connectRequested = false;
/** 其他页面引导用户来连接公众号时调用；页面挂载后自动打开向导。 */
export function requestConnect() {
  connectRequested = true;
  window.dispatchEvent(new Event("studio:connect"));
}

export function AccountsPage({ store }: { store: Store }) {
  const { confirm, toast } = useUi();
  const [wizard, setWizard] = useState(false);
  const [editing, setEditing] = useState<Account | null>(null);
  const [busy, setBusy] = useState("");

  useEffect(() => {
    const open = () => { connectRequested = false; setWizard(true); };
    if (connectRequested) open();
    window.addEventListener("studio:connect", open);
    return () => window.removeEventListener("studio:connect", open);
  }, []);

  async function run(id: string, operation: () => Promise<unknown>, done: string) {
    setBusy(id);
    try { await operation(); await store.refresh(); toast(done); }
    catch (err) { toast((err as Error).message, "bad"); }
    finally { setBusy(""); }
  }

  const visible = store.accounts.filter(account => account.bindingState !== "released" || store.jobs.some(job => job.accountId === account.id));
  return <div className="page">
    <header className="page-head">
      <div><h1>公众号</h1><p>连接后，写好的文章可以一键存入对应公众号的草稿箱。</p></div>
      {visible.length > 0 && <button className="btn btn-primary" onClick={() => setWizard(true)}><Plus />添加公众号</button>}
    </header>

    {visible.length === 0
      ? <div className="card"><Empty icon={<MessageSquareText />} title="还没有连接公众号"
          action={<div style={{ display: "grid", gap: 10, justifyItems: "center" }}>
            <button className="btn btn-primary" onClick={() => setWizard(true)}><Plus />添加公众号</button>
            <SupportLine />
          </div>}>
          {pick("按指引填写几项信息，大约 5 分钟。也可以请作者协助你完成。", "按指引填写 4 项信息，大约 5 分钟。也可以请顾问帮你完成。")}
        </Empty></div>
      : <div className="account-grid">
          {visible.map(account => {
            const human = accountHuman(account);
            return <article key={account.id} className="card account-card">
              <div className="account-head">
                <span className="account-logo"><MessageSquareText /></span>
                <div><strong>{account.label}</strong><span>{account.appId}</span></div>
                <Pill tone={human.tone}>{human.label}</Pill>
              </div>
              {human.hint && <p className="muted" style={{ margin: 0, fontSize: 13 }}>{human.hint}</p>}
              {account.patMissing && <p className="muted" style={{ margin: 0, fontSize: 13 }}>这个连接没有中转访问令牌（PAT），存入草稿箱会失败。请点「更新密钥」补上。</p>}
              {account.bindingState === "bound" && <div className="account-actions">
                <button className="btn btn-sm" onClick={() => setEditing(account)} disabled={!!busy}><KeyRound />更新密钥</button>
                {account.active && <button className="btn btn-sm" disabled={!!busy} onClick={() => run(account.id, () => api(`/accounts/${account.id}/sync`, "POST"), "连接正常，可以发布")}>
                  {busy === account.id ? <Loader2 className="spin" /> : <ShieldCheck />}检查连接</button>}
                {account.active && <button className="btn btn-sm btn-ghost btn-danger" disabled={!!busy} onClick={async () => {
                  if (!(await confirm({ title: `停用「${account.label}」？`, message: "停用后不能再向这个公众号发布，历史记录会保留。已经存入草稿箱的文章不受影响。", confirmText: "停用", danger: true }))) return;
                  await run(account.id, () => api(`/accounts/${account.id}`, "DELETE"), "已停用");
                }}>停用</button>}
              </div>}
            </article>;
          })}
        </div>}

    {wizard && <ConnectWizard store={store} onClose={() => setWizard(false)} />}
    {editing && <EditKeys account={editing} store={store} onClose={() => setEditing(null)} />}
  </div>;
}

function SupportLine() {
  const [open, setOpen] = useState(false);
  const support = supportCopy();
  return <>
    <span className="concierge">不想自己操作？<button onClick={() => setOpen(true)}>{pick("请作者帮我连接", "请顾问帮我连接")}</button></span>
    <Dialog open={open} onClose={() => setOpen(false)} label={pick("联系作者", "联系顾问")}>
      <h2>{support.title}</h2>
      <p>{support.note}</p>
      <div className="copy-box"><span>{support.contact}</span></div>
      <div className="dialog-actions"><button className="btn btn-primary" onClick={() => setOpen(false)}>知道了</button></div>
    </Dialog>
  </>;
}

function CopyBox({ value }: { value: string }) {
  const { toast } = useUi();
  return <div className="copy-box"><span>{value}</span>
    <button className="btn btn-sm" onClick={() => navigator.clipboard.writeText(value).then(() => toast("已复制")).catch(() => toast("复制失败，请手动选择", "bad"))}><Copy />复制</button>
  </div>;
}

const STEPS = ["准备", "获取凭据", "设置白名单", "完成"];

function ConnectWizard({ store, onClose }: { store: Store; onClose: () => void }) {
  const { confirm } = useUi();
  const [step, setStep] = useState(0);
  const [form, setForm] = useState({ label: "", appId: "", appSecret: "", pat: "" });
  const [whitelistIp, setWhitelistIp] = useState("");
  const [working, setWorking] = useState(false);
  const [error, setError] = useState("");
  const [connected, setConnected] = useState<Account | null>(null);
  const set = (key: keyof typeof form) => (event: React.ChangeEvent<HTMLInputElement>) => setForm({ ...form, [key]: event.target.value });
  // 服务端统一持有中转令牌时，使用者不必再填 PAT；否则必须提供自己中转服务的令牌。
  const relayManaged = store.session.relayManaged;
  const canNext = [form.label.trim().length > 0, /^wx[0-9a-zA-Z]{8,}$/.test(form.appId.trim()) && form.appSecret.trim().length >= 16
    && (relayManaged || form.pat.trim().length > 0), true, true][step];

  async function finish() {
    setWorking(true); setError("");
    try {
      const account = await api<Account>("/accounts", "POST", { label: form.label.trim(), appId: form.appId.trim(), appSecret: form.appSecret.trim(), pat: form.pat.trim() });
      await api(`/accounts/${account.id}/sync`, "POST");
      await store.refresh();
      setConnected(account);
      setStep(3);
    } catch (err) { setError((err as Error).message); }
    finally { setWorking(false); }
  }

  async function close() {
    if (!connected && (form.appId || form.appSecret) && !(await confirm({ title: "退出连接向导？", message: "已填写的信息不会保存。", confirmText: "退出" }))) return;
    onClose();
  }

  return <Dialog open onClose={close} wide label="添加公众号">
    <div className="wizard-steps" aria-hidden="true">{STEPS.map((label, index) => <span key={label} className={index <= step ? "on" : ""} />)}</div>
    <div className="wizard-body">
      <span className="muted" style={{ fontSize: 12 }}>第 {step + 1} 步，共 {STEPS.length} 步 · {STEPS[step]}</span>
      {step === 0 && <>
        <h3>连接一个公众号</h3>
        <p>大约需要 5 分钟。请准备好能扫码登录公众号后台的管理员微信。</p>
        <label className="field"><span className="field-label">公众号名称</span>
          <input className="input" autoFocus value={form.label} onChange={set("label")} placeholder="例如：我的公众号" maxLength={60} />
          <span className="field-hint">只用于在这里区分不同公众号。</span></label>
      </>}
      {step === 1 && <>
        <h3>复制 AppID 和 AppSecret</h3>
        <div className="guide">
          <div>在电脑上打开 <a href={WECHAT_DEV_URL} target="_blank" rel="noreferrer">微信开发者平台 <ExternalLink size={12} /></a>，用公众号管理员微信扫码登录</div>
          <div>在「我的业务」里找到这个公众号，进入它的开发设置</div>
          <div>复制 AppID；AppSecret 需点击「重置」并扫码确认后才能看到，请当场复制</div>
        </div>
        <div className="notice">AppSecret 加密保存，只用于把文章存入你的草稿箱，{pick("作者和其他人都", "工作人员")}看不到。不想继续使用时，在开发者平台重置一次即可让它失效。</div>
        <div className="notice notice-warn">如果这个公众号已经接入了其他系统，重置 AppSecret 会让旧系统失效。不确定的话，请先{pick("联系作者。", "联系顾问。")}</div>
        <label className="field"><span className="field-label">AppID</span><input className="input input-mono" value={form.appId} onChange={set("appId")} placeholder="wx 开头的 18 位字符" autoComplete="off" spellCheck={false} /></label>
        <label className="field"><span className="field-label">AppSecret</span><input className="input input-mono" value={form.appSecret} onChange={set("appSecret")} placeholder="32 位字符" autoComplete="off" spellCheck={false} type="password" /></label>
        {!relayManaged && <label className="field"><span className="field-label">中转服务访问令牌（PAT）</span>
          <input className="input input-mono" value={form.pat} onChange={set("pat")} placeholder="你自己中转服务的访问令牌" autoComplete="off" spellCheck={false} type="password" />
          <span className="field-hint">这是你自己中转服务的访问令牌，用来代表你调用微信接口。它只加密保存在你的部署里。</span></label>}
      </>}
      {step === 2 && <>
        <h3>把发布服务加入 IP 白名单</h3>
        <p>微信要求只有白名单里的服务器才能写入草稿箱。</p>
        <div className="guide">
          <div>还在这个公众号的开发设置里，找到「API IP 白名单」，点击编辑</div>
          <div>把下面这个 IP 粘贴进去，保存并扫码确认</div>
        </div>
        {store.session.whitelistIp
          ? <CopyBox value={store.session.whitelistIp} />
          : <label className="field"><span className="field-label">你的中转服务出口公网 IP</span>
            <input className="input input-mono" value={whitelistIp} onChange={event => setWhitelistIp(event.target.value)} placeholder="例如：203.0.113.10" autoComplete="off" spellCheck={false} />
            <span className="field-hint">填写你自己的中转服务对外的出口公网 IP。部署没有提供时，由你在这里填写。</span>
            {whitelistIp.trim() ? <CopyBox value={whitelistIp.trim()} /> : <span className="field-hint">填写后可一键复制到微信后台。</span>}</label>}
        <p className="muted" style={{ fontSize: 13, margin: 0 }}>添加好后点「完成连接」。白名单是否生效，会在第一次存入草稿箱时得到验证。</p>
      </>}
      {step === 3 && connected && <div className="result" style={{ padding: "8px 0" }}>
        <div className="result-icon"><Check /></div>
        <h3>「{connected.label}」已连接</h3>
        <p>现在可以把文章存入这个公众号的草稿箱了。第一次发布时如果提示连接问题，多半是白名单还没生效，稍等几分钟再试。</p>
      </div>}
      {error && <div className="notice notice-bad">{error}</div>}
      {step < 3 && <SupportLine />}
    </div>
    <div className="dialog-actions">
      {step > 0 && step < 3 && <button className="btn" disabled={working} onClick={() => setStep(step - 1)}><ChevronLeft />上一步</button>}
      {step < 2 && <button className="btn btn-primary" disabled={!canNext} onClick={() => setStep(step + 1)}>下一步<ChevronRight /></button>}
      {step === 2 && <button className="btn btn-primary" disabled={working} onClick={finish}>{working ? <Loader2 className="spin" /> : null}完成连接</button>}
      {step === 3 && <button className="btn btn-primary" onClick={onClose}>开始发布</button>}
    </div>
  </Dialog>;
}

function EditKeys({ account, store, onClose }: { account: Account; store: Store; onClose: () => void }) {
  const { toast } = useUi();
  const [form, setForm] = useState({ label: account.label, appSecret: "", pat: "" });
  const [working, setWorking] = useState(false);
  const [error, setError] = useState("");
  return <Dialog open onClose={onClose} label="更新密钥">
    <h2>更新「{account.label}」</h2>
    <p>只需要填写有变化的项，留空的密钥保持不变。</p>
    <label className="field"><span className="field-label">公众号名称</span><input className="input" value={form.label} onChange={event => setForm({ ...form, label: event.target.value })} /></label>
    <label className="field"><span className="field-label">新的 AppSecret</span><input className="input input-mono" type="password" autoComplete="off" value={form.appSecret} onChange={event => setForm({ ...form, appSecret: event.target.value })} placeholder="不修改请留空" /></label>
    {!store.session.relayManaged && <label className="field"><span className="field-label">新的中转服务访问令牌（PAT）</span>
      <input className="input input-mono" type="password" autoComplete="off" value={form.pat} onChange={event => setForm({ ...form, pat: event.target.value })} placeholder="不修改请留空" />
      <span className="field-hint">{account.patMissing ? "这个连接目前没有中转令牌，存入草稿箱会失败，请填写。" : "这是你自己中转服务的访问令牌。"}</span></label>}
    {error && <div className="notice notice-bad">{error}</div>}
    <div className="dialog-actions">
      <button className="btn" onClick={onClose}>取消</button>
      <button className="btn btn-primary" disabled={working || !form.label.trim()} onClick={async () => {
        setWorking(true); setError("");
        try {
          await api(`/accounts/${account.id}`, "PUT", { label: form.label.trim(), appId: account.appId, appSecret: form.appSecret.trim(), pat: form.pat.trim(), expectedVersion: account.version });
          await api(`/accounts/${account.id}/sync`, "POST");
          await store.refresh(); toast("已更新"); onClose();
        } catch (err) { setError((err as Error).message); }
        finally { setWorking(false); }
      }}>{working ? <Loader2 className="spin" /> : null}保存</button>
    </div>
  </Dialog>;
}
