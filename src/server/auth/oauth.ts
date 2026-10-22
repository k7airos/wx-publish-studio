import { randomBytes } from "node:crypto";
import { deleteCookie, getCookie, setCookie } from "hono/cookie";
import type { Context } from "hono";
import type { AppConfig, OAuthConfig } from "../config";
import type { Database } from "../db/schema";
import { issueSession, revokeCookieSession, setSessionCookie, tokenHash } from "./session";
import { provisionFromLogin } from "./access";
import { memberAccess } from "../services/owner-limits";

const pendingCookie = "studio_oauth_pending";
const uuid = /^[a-f\d]{8}(?:-[a-f\d]{4}){3}-[a-f\d]{12}$/i;

// 授权响应有界读取，禁止跳转到其他服务或把原始错误传到浏览器。
async function oauthJson(url: string, init: RequestInit) {
  const response = await fetch(url, { ...init, redirect: "manual", cache: "no-store", signal: AbortSignal.timeout(10_000) });
  if (!response.ok || !response.body || Number(response.headers.get("content-length") || 0) > 64 * 1024) throw new Error("OAuth response unavailable");
  const reader = response.body.getReader(); const chunks: Uint8Array[] = []; let length = 0;
  try {
    while (true) {
      const item = await reader.read(); if (item.done) break;
      length += item.value.byteLength;
      if (length > 64 * 1024) throw new Error("OAuth response too large");
      chunks.push(item.value);
    }
  } finally { await reader.cancel().catch(() => {}); }
  const body = JSON.parse(Buffer.concat(chunks).toString("utf8"));
  if (body?.code !== 0 || !body.data || typeof body.data !== "object") throw new Error("Invalid OAuth response");
  return body.data as Record<string, unknown>;
}

export async function startOAuth(c: Context, sql: Database, config: AppConfig) {
  const oauth = config.oauth;
  if (!oauth) return c.json({ error: "oauth_unavailable" }, 404);
  const state = randomBytes(32).toString("hex"); const browserBinding = randomBytes(32).toString("hex");
  const oldBinding = getCookie(c, pendingCookie);
  await sql.begin(async transaction => {
    await transaction`DELETE FROM oauth_pending_states WHERE expires_at <= now()`;
    if (oldBinding) await transaction`DELETE FROM oauth_pending_states WHERE browser_binding_hash=${tokenHash(oldBinding)}`;
    await transaction`INSERT INTO oauth_pending_states (state_hash,browser_binding_hash,issuer,client_id,redirect_uri,expires_at)
      VALUES (${tokenHash(state)},${tokenHash(browserBinding)},${oauth.issuer},${oauth.clientId},${oauth.redirectUri},now() + interval '10 minutes')`;
  });
  setCookie(c, pendingCookie, browserBinding, { httpOnly: true, sameSite: "Lax", secure: config.appOrigin.startsWith("https:"), path: "/api/auth/oauth", maxAge: 600 });
  const url = new URL(oauth.portalUrl);
  url.searchParams.set("client_id", oauth.clientId); url.searchParams.set("redirect_uri", oauth.redirectUri); url.searchParams.set("scope", "profile"); url.searchParams.set("state", state);
  return c.redirect(url.toString(), 302);
}

export async function consumeOAuthState(sql: Database, oauth: OAuthConfig, state: string, binding: string) {
  const rows = await sql`DELETE FROM oauth_pending_states WHERE state_hash=${tokenHash(state)} AND browser_binding_hash=${tokenHash(binding)}
    AND issuer=${oauth.issuer} AND client_id=${oauth.clientId} AND redirect_uri=${oauth.redirectUri} AND expires_at > now() RETURNING state_hash`;
  return rows.length === 1;
}

/** Nezus 兑换码开通的会员为 active，注册试用为 trial；只有 active 且未到期的会员可作为准入凭据。 */
export function membershipEntitlement(membership: unknown, now = Date.now()): Date | null {
  if (!membership || typeof membership !== "object") return null;
  const { status, expiresAt } = membership as Record<string, unknown>;
  if (status !== "active" || typeof expiresAt !== "string") return null;
  const until = new Date(expiresAt);
  return Number.isFinite(until.getTime()) && until.getTime() > now ? until : null;
}

/** 界面问候用的显示名：优先用户名，其次邮箱 @ 前部分；只作展示，不参与任何授权。 */
export function profileDisplayName(profile: Record<string, unknown>): string | null {
  const name = typeof profile.username === "string" ? profile.username.trim() : "";
  const email = typeof profile.email === "string" ? profile.email.split("@")[0]!.trim() : "";
  const value = name || email;
  return value ? value.slice(0, 80) : null;
}

async function exchangeIdentity(oauth: OAuthConfig, code: string) {
  const tokens = await oauthJson(`${oauth.baseUrl}/api/v1/oauth/token`, { method: "POST", headers: { "Content-Type": "application/json", Accept: "application/json" }, body: JSON.stringify({ grant_type: "authorization_code", code, client_id: oauth.clientId, client_secret: oauth.clientSecret, redirect_uri: oauth.redirectUri }) });
  if (typeof tokens.access_token !== "string" || !tokens.access_token || tokens.access_token.length > 8192 || tokens.token_type !== "Bearer" || typeof tokens.expires_in !== "number" || !Number.isInteger(tokens.expires_in) || tokens.expires_in <= 0 || tokens.expires_in > 600) throw new Error("Invalid OAuth token");
  const profile = await oauthJson(`${oauth.baseUrl}/api/v1/oauth/userinfo`, { headers: { Authorization: `Bearer ${tokens.access_token}`, Accept: "application/json" } });
  if (typeof profile.userId !== "string" || !uuid.test(profile.userId)) throw new Error("Invalid OAuth subject");
  return { subject: profile.userId.toLowerCase(), entitlement: membershipEntitlement(profile.membership), displayName: profileDisplayName(profile) };
}

// state 在交换前原子消费；失败需重新登录，不重放原 code 或覆盖已有有效会话。
export async function oauthCallback(c: Context, sql: Database, config: AppConfig) {
  const fail = (reason: "oauth_failed" | "access_denied" | "access_expired" | "membership_required") => c.redirect(`/?auth=${reason}`, 303);
  const oauth = config.oauth; const binding = getCookie(c, pendingCookie);
  const query = new URL(c.req.url).searchParams;
  const state = query.get("state"); const code = query.get("code"); const error = query.get("error");
  if (!oauth || !binding || !/^[a-f\d]{64}$/.test(binding) || !state || !/^[a-f\d]{64}$/.test(state)
    || [...query.keys()].some(key => !["state", "code", "error"].includes(key))
    || ["state", "code", "error"].some(key => query.getAll(key).length > 1)
    || query.has("code") === query.has("error") || query.has("code") && (!code || code.length > 2048) || query.has("error") && (!error || error.length > 100)) return fail("oauth_failed");
  try {
    if (!await consumeOAuthState(sql, oauth, state, binding)) return fail("oauth_failed");
    deleteCookie(c, pendingCookie, { path: "/api/auth/oauth" });
    if (error) return fail(error === "access_denied" ? "access_denied" : "oauth_failed");
    const { subject, entitlement, displayName } = await exchangeIdentity(oauth, code!);
    let denied: "access_denied" | "access_expired" | "membership_required" = "access_denied";
    const session = await sql.begin(async transaction => {
      let [identity] = await transaction`SELECT * FROM identities WHERE issuer=${oauth.issuer} AND subject=${subject}`;
      if (!identity) {
        // 自动开通关闭时保持原行为：未绑定身份一律拒绝，不建任何映射。
        if (!config.selfProvision) return null;
        if (!entitlement) { denied = "membership_required"; return null; }
        identity = await provisionFromLogin(transaction as unknown as Database, oauth.issuer, subject, entitlement);
      }
      let [member] = await transaction`SELECT * FROM product_memberships WHERE owner_id=${identity.owner_id} FOR UPDATE`;
      // 停用成员不因会员有效而复活；手工开通的成员不读取、不改写有效期。
      if (member?.status !== "active") return null;
      if (member.access_source === "nezus_membership" && entitlement) {
        [member] = await transaction`UPDATE product_memberships SET access_until=${entitlement},entitlement_synced_at=now(),updated_at=now() WHERE owner_id=${identity.owner_id} RETURNING *`;
      }
      if (memberAccess(member) !== "active") { denied = member.access_source === "nezus_membership" ? "membership_required" : "access_expired"; return null; }
      const [current] = await transaction`SELECT id FROM identities WHERE id=${identity.id} AND owner_id=${identity.owner_id} AND issuer=${oauth.issuer} AND subject=${subject}`;
      if (!current) return null;
      if (displayName) await transaction`UPDATE identities SET display_name=${displayName} WHERE id=${identity.id}`;
      await revokeCookieSession(c, transaction as unknown as Database);
      return issueSession(transaction as unknown as Database, identity.owner_id, "oauth", identity.id);
    });
    if (!session) return fail(denied);
    setSessionCookie(c, session.token, config);
    return c.redirect("/", 303);
  } catch { return fail("oauth_failed"); }
}
