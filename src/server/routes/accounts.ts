import { Hono } from "hono";
import type { AppEnv } from "../auth/bootstrap";
import type { AppConfig } from "../config";
import type { Database } from "../db/schema";
import { AccountError, AccountStore, accountDto } from "../services/account-store";
import { PipelineClient, PipelineError } from "../services/pipeline-client";
import { LimitError } from "../services/owner-limits";

export function accountRoutes(sql: Database, config: AppConfig) {
  const router = new Hono<AppEnv>();
  const store = new AccountStore(sql, config);
  const worker = new PipelineClient(config);
  router.onError((error, c) => c.json({ error: error instanceof AccountError || error instanceof PipelineError || error instanceof LimitError ? error.code : "account_operation_failed" }, error instanceof PipelineError ? 502 : error instanceof LimitError ? 429 : error instanceof AccountError ? 400 : 500));
  router.get("/", async c => {
    const rows = await store.list(c.get("ownerId"));
    const missing = await store.missingRelayToken(c.get("ownerId"));
    const accounts = rows.map((row: any) => accountDto(row, missing.has(row.id)));
    return c.json({ accounts, warning: accounts.some((account: ReturnType<typeof accountDto>) => account.active) ? null : "no_accounts_configured" });
  });
  router.post("/", async c => c.json(accountDto(await store.create(c.get("ownerId"), await c.req.json().catch(() => null))), 201));
  router.put("/:id", async c => c.json(accountDto(await store.update(c.get("ownerId"), c.req.param("id"), await c.req.json().catch(() => null)))));
  router.post("/:id/sync", async c => {
    return c.json(accountDto(await store.synchronize(c.get("ownerId"), c.req.param("id"), credential => worker.register(credential))));
  });
  router.delete("/:id", async c => c.json(accountDto(await store.deactivate(c.get("ownerId"), c.req.param("id")))));
  return router;
}
