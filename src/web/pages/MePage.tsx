import { CalendarClock, LifeBuoy, LogOut, MessageSquareText } from "lucide-react";
import type { Store } from "../App";
import { useUi } from "../ui";
import { linkProps } from "../router";
import { renewalText, supportCopy } from "../copy";

export function MePage({ store }: { store: Store }) {
  const { confirm, toast } = useUi();
  const { session } = store;
  const support = supportCopy();
  const name = session.displayName || "我的账号";
  const until = session.accessUntil ? new Date(session.accessUntil) : null;
  const daysLeft = until ? Math.ceil((until.getTime() - Date.now()) / 86400000) : null;
  return <div className="page page-narrow">
    <header className="page-head"><div><h1>我的</h1></div></header>
    <section className="card profile">
      <span className="avatar avatar-lg">{name.slice(0, 1).toUpperCase()}</span>
      <div><h2>{name}</h2><p>{session.role === "admin" ? "管理员" : "会员"} · 已连接 {store.accounts.filter(account => account.active).length} 个公众号</p></div>
    </section>
    <section className="card list-card">
      <div className="list-row"><CalendarClock /><span>使用期限</span>
        <small>{until ? `${until.toLocaleDateString("zh-CN", { year: "numeric", month: "long", day: "numeric" })} 到期${daysLeft !== null && daysLeft <= 14 ? `（还剩 ${Math.max(daysLeft, 0)} 天）` : ""}` : "长期有效"}</small>
      </div>
      <a className="list-row" {...linkProps({ name: "accounts" })}><MessageSquareText /><span>公众号连接</span><small>管理</small></a>
      <div className="list-row"><LifeBuoy /><span>{support.title}</span><small>{support.contact}</small></div>
    </section>
    {daysLeft !== null && daysLeft <= 14 && <div className="notice notice-warn" style={{ marginTop: 16 }}>{renewalText()}</div>}
    <section className="card list-card">
      <button className="list-row" onClick={async () => {
        if (!(await confirm({ title: "退出登录？", confirmText: "退出" }))) return;
        try { await store.logout(); } catch (err) { toast((err as Error).message, "bad"); }
      }}><LogOut /><span>退出登录</span></button>
    </section>
  </div>;
}
