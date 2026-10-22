import type { Database } from "../db/schema";

export const TERMINAL_JOB_RETENTION_DAYS = 30;
const DAY_MS = 24 * 60 * 60 * 1000;

/**
 * 终态超过保留期的任务清空正文与快照大字段，保留身份、幂等键、hash 与 draft_media_id。
 * 终态任务不再被刷新，updated_at 即结束时间且保持不变；可重复执行。
 */
export async function pruneTerminalJobs(sql: Database, days = TERMINAL_JOB_RETENTION_DAYS, now = new Date()) {
  const cutoff = new Date(now.getTime() - days * DAY_MS);
  const rows = await sql`UPDATE jobs SET body='',article_style=NULL,cover_snapshot=NULL,article_snapshot=NULL,artifact_manifest=NULL,pruned_at=${now}
    WHERE status IN ('succeeded','failed') AND pruned_at IS NULL AND updated_at < ${cutoff} RETURNING id`;
  return rows.length;
}
