import { createHash, randomBytes, randomUUID } from "node:crypto";
import { deleteCookie, getCookie, setCookie } from "hono/cookie";
import type { Context } from "hono";
import type { Database } from "../db/schema";
import type { AppConfig } from "../config";

export const tokenHash = (value: string) => createHash("sha256").update(value).digest("hex");

// 产品只保存随机会话的哈希，七天绝对期限不随访问续期。
export async function issueSession(sql: Database, ownerId: string, method: "bootstrap" | "oauth", identityId: string | null = null) {
  const token = randomBytes(32).toString("hex");
  const [row] = await sql`INSERT INTO sessions (id,token_hash,owner_id,auth_method,identity_id,expires_at)
    VALUES (${randomUUID()},${tokenHash(token)},${ownerId},${method},${identityId},now() + interval '7 days') RETURNING id,expires_at`;
  return { token, id: row.id, expiresAt: row.expires_at };
}

export function setSessionCookie(c: Context, token: string, config: AppConfig) {
  setCookie(c, "studio_session", token, { httpOnly: true, sameSite: "Strict", secure: config.appOrigin.startsWith("https:"), path: "/", maxAge: 7 * 86400 });
}

export async function revokeCookieSession(c: Context, sql: Database) {
  const token = getCookie(c, "studio_session");
  if (token) await sql`DELETE FROM sessions WHERE token_hash=${tokenHash(token)}`;
}

export async function logout(c: Context, sql: Database) {
  await revokeCookieSession(c, sql);
  deleteCookie(c, "studio_session", { path: "/" });
  return c.json({ authenticated: false });
}
