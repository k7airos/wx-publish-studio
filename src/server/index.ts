import { createApp } from "./app";
import { loadConfig } from "./config";
import { openDatabase } from "./db/schema";
import { initializeAccounts } from "./services/account-store";
import { cleanupUnreferencedAssets } from "./services/asset-cleanup";
import { pruneTerminalJobs } from "./services/job-retention";

const config = await loadConfig();
const sql = await openDatabase(config.databaseUrl);
await initializeAccounts(sql, config);
await cleanupUnreferencedAssets(sql, config.dataDir);
// 终态任务每日清理大字段；失败只记录，不影响服务。
const pruneJobs = () => pruneTerminalJobs(sql).catch(error => console.error("terminal job cleanup failed", error));
await pruneJobs();
setInterval(pruneJobs, 24 * 60 * 60 * 1000).unref();
const server = Bun.serve({
  hostname: config.host, port: Number(process.env.PORT || 18889),
  fetch: createApp(config, sql).fetch,
});
console.info(`Content studio listening at ${server.url.origin}`);
