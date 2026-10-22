import { timingSafeEqual } from "node:crypto";
import type { Context } from "hono";
import type { AppConfig } from "../config";
import type { Database } from "../db/schema";
import { OWNER_ID } from "../db/schema";
import { issueSession, revokeCookieSession, setSessionCookie, tokenHash } from "./session";
export { sessionAuth, type AppEnv } from "./access";
export { logout } from "./session";

export async function login(c: Context, sql: Database, config: AppConfig) {
  if ((config.authMode || "bootstrap") !== "bootstrap") return c.json({ error: "bootstrap_disabled" }, 403);
  const input = await c.req.json().catch(() => null);
  const actual = tokenHash(typeof input?.secret === "string" ? input.secret : "");
  if (!config.bootstrapSecret || !timingSafeEqual(Buffer.from(actual), Buffer.from(tokenHash(config.bootstrapSecret)))) {
    return c.json({ error: "invalid_credentials" }, 401);
  }
  const session = await sql.begin(async transaction => {
    const [member] = await transaction`SELECT status FROM product_memberships WHERE owner_id=${OWNER_ID} FOR UPDATE`;
    if (member?.status !== "active") return null;
    await transaction`DELETE FROM sessions WHERE expires_at <= now()`;
    await revokeCookieSession(c, transaction as unknown as Database);
    return issueSession(transaction as unknown as Database, OWNER_ID, "bootstrap");
  });
  if (!session) return c.json({ error: "access_denied" }, 403);
  setSessionCookie(c, session.token, config);
  return c.json({ authenticated: true });
}
