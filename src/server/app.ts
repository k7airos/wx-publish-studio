import { Hono } from "hono";
import { bodyLimit } from "hono/body-limit";
import { serveStatic } from "hono/bun";
import type { AppConfig } from "./config";
import type { Database } from "./db/schema";
import { sessionAuth, type AppEnv } from "./auth/bootstrap";
import { documentRoutes } from "./routes/documents";
import { accountRoutes } from "./routes/accounts";
import { jobRoutes } from "./routes/jobs";
import { styleRoutes } from "./routes/styles";
import { assetRoutes } from "./routes/assets";
import { coverTemplateRoutes } from "./routes/cover-templates";
import { previewRoutes } from "./routes/previews";
import { authRoutes } from "./routes/auth";
import { configurationRoutes } from "./routes/configuration";

export function createApp(config: AppConfig, sql: Database) {
  if (config.authMode === "oauth" && !config.oauth) throw new Error("OAuth mode requires configured provider");
  const app = new Hono<AppEnv>();
  app.use("*", async (c, next) => {
    c.header("X-Content-Type-Options", "nosniff");
    c.header("Referrer-Policy", "same-origin");
    c.header("X-Frame-Options", "DENY");
    if (c.req.path.startsWith("/api/")) c.header("Cache-Control", "no-store");
    await next();
  });
  app.use("/api/*", async (c, next) => bodyLimit({ maxSize: /^\/api\/assets(?:\/body)?\/?$/.test(c.req.path) ? 6 * 1024 * 1024 : 2_100_000 })(c, next));
  app.use("/api/*", async (c, next) => {
    const origin = c.req.header("Origin");
    if (!["GET", "HEAD"].includes(c.req.method) && origin && origin !== config.appOrigin) {
      return c.json({ error: "invalid_origin" }, 403);
    }
    await next();
  });
  app.get("/api/health", async c => {
    await sql`SELECT 1`;
    return c.json({ status: "ok" });
  });
  app.route("/api/auth", authRoutes(sql, config));
  app.use("/api/*", sessionAuth(sql, config));
  app.get("/api/auth/session", async c => {
    const [member] = await sql`SELECT m.role,m.access_until,(SELECT display_name FROM identities i WHERE i.owner_id=m.owner_id AND i.display_name IS NOT NULL LIMIT 1) AS display_name
      FROM product_memberships m WHERE m.owner_id=${c.get("ownerId")}`;
    return c.json({ authenticated: true, simulation: config.simulation === true, displayName: member?.display_name ?? null,
      accessUntil: member?.access_until ?? null, role: member?.role ?? "member",
      // 服务是否统一持有中转令牌；未持有时使用者需在自己的中转服务上自行填写 PAT。
      relayManaged: !!config.relayPat,
      // 部署可选提供的白名单出口 IP；未配置时由使用者在连接向导里填写自己的中转出口 IP。
      whitelistIp: config.wxWhitelistIp ?? null,
      // 客户可见文案的部署形态；前端据此取中性或原有措辞。
      copyMode: config.copyMode || "neutral" });
  });
  app.route("/api/documents", documentRoutes(sql, config));
  app.route("/api/accounts", accountRoutes(sql, config));
  app.route("/api/jobs", jobRoutes(sql, config));
  app.route("/api/styles", styleRoutes(sql));
  app.route("/api/assets", assetRoutes(sql, config));
  app.route("/api/cover-templates", coverTemplateRoutes(sql, config));
  app.route("/api", previewRoutes(sql, config));
  app.route("/api", configurationRoutes(sql, config));
  app.all("/api/*", c => c.json({ error: "not_found" }, 404));
  if (config.staticRoot) {
    app.use("/*", serveStatic({ root: config.staticRoot }));
    app.get("/", serveStatic({ path: `${config.staticRoot}/index.html` }));
    // 前端路由的深链与刷新回到同一个页面入口；/api 已在上方单独处理。
    app.get("*", serveStatic({ path: `${config.staticRoot}/index.html` }));
  }
  app.onError((_error, c) => c.json({ error: "internal_error" }, 500));
  return app;
}
