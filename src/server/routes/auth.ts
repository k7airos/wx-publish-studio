import { Hono } from "hono";
import type { AppConfig } from "../config";
import type { Database } from "../db/schema";
import { login } from "../auth/bootstrap";
import { oauthCallback, startOAuth } from "../auth/oauth";
import { logout } from "../auth/session";
import type { AppEnv } from "../auth/access";

// OAuth 回调必须在产品会话中间件之前，匿名用户才能完成握手。
export function authRoutes(sql: Database, config: AppConfig) {
  const router = new Hono<AppEnv>();
  router.use("*", async (c, next) => { c.header("Referrer-Policy", "no-referrer"); c.header("Cache-Control", "no-store"); await next(); });
  router.get("/options", c => c.json({ mode: config.authMode || "bootstrap", oauth: { enabled: !!config.oauth, ...(config.oauth ? { startUrl: "/api/auth/oauth/start" } : {}) }, copyMode: config.copyMode || "neutral" }));
  router.post("/login", c => login(c, sql, config));
  router.post("/logout", c => logout(c, sql));
  router.get("/oauth/start", c => startOAuth(c, sql, config));
  router.get("/oauth/callback", c => oauthCallback(c, sql, config));
  return router;
}
