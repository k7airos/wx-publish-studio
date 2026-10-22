import { SQL } from "bun";
import { readdir, readFile } from "node:fs/promises";

// 本地默认 owner（bootstrap 单用户）。所有实例共享同一个默认 owner id：
// 它只用于让单用户自托管部署开箱可用，不代表任何真实用户身份；多用户部署须另行绑定身份。
export const OWNER_ID = "00000000-0000-4000-8000-000000000001";

export async function openDatabase(url: string) {
  const sql = new SQL(url);
  const directory = new URL("../../../migrations/", import.meta.url);
  // R1 没有迁移表；其幂等 initial 可重读一次，后续迁移只执行已记录之外的文件。
  await sql`CREATE TABLE IF NOT EXISTS schema_migrations (name text PRIMARY KEY, applied_at timestamptz NOT NULL DEFAULT now())`;
  for (const name of (await readdir(directory)).filter(name => /^\d+_.+\.sql$/.test(name)).sort()) {
    await sql.begin(async transaction => {
      await transaction`SELECT pg_advisory_xact_lock(82740311)`;
      const [applied] = await transaction`SELECT name FROM schema_migrations WHERE name=${name}`;
      if (applied) return;
      await transaction.unsafe(await readFile(new URL(name, directory), "utf8"));
      await transaction`INSERT INTO schema_migrations (name) VALUES (${name})`;
    });
  }
  await sql`WITH new_owner AS (INSERT INTO owners (id) VALUES (${OWNER_ID}) ON CONFLICT DO NOTHING RETURNING id)
    INSERT INTO product_memberships (owner_id,status,role) SELECT id,'active','admin' FROM new_owner`;
  // 单实例应用重启时，未确认的提交留给原幂等键恢复，不能永久停在提交中。
  await sql`UPDATE jobs SET status='unknown',step='unknown',error_code='worker_result_unknown',updated_at=now() WHERE status='submitting' AND worker_job_id IS NULL`;
  return sql;
}

export type Database = SQL;
