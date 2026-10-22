import type { Database } from "../db/schema";

export const OWNER_LIMITS = Object.freeze({ accounts: 5, credentials: 20, assetBytes: 128 * 1024 * 1024, assetFiles: 200, retained: 10, active: 2, globalActive: 8 });
export class LimitError extends Error {
  constructor(readonly code: string) { super(code); }
}

/** 成员资格：停用为 denied；会员开通的成员过了 access_until 为 expired；access_until 为空表示不限期。 */
export function memberAccess(member: { status?: string; access_until?: Date | string | null } | undefined, now = Date.now()): "active" | "expired" | "denied" {
  if (member?.status !== "active") return "denied";
  if (member.access_until && new Date(member.access_until).getTime() <= now) return "expired";
  return "active";
}

// 固定锁序为 owner→account→document→job；停用和交接也先取同一 owner 锁。
export async function lockOwner(sql: Database, owner: string, requireMember = true) {
  const [row] = await sql`SELECT id FROM owners WHERE id=${owner} FOR UPDATE`;
  if (!row) throw new LimitError("owner_not_found");
  if (requireMember) {
    const [member] = await sql`SELECT status,access_until FROM product_memberships WHERE owner_id=${owner}`;
    const access = memberAccess(member);
    if (access !== "active") throw new LimitError(access === "expired" ? "access_expired" : "access_denied");
  }
}

export async function requireAssetCapacity(sql: Database, owner: string, bytes: number, files = 1) {
  const [usage] = await sql`SELECT count(*)::integer AS files,coalesce(sum(byte_length),0)::bigint AS bytes FROM (
    SELECT byte_length FROM body_assets WHERE owner_id=${owner} UNION ALL SELECT byte_length FROM cover_assets WHERE owner_id=${owner}) a`;
  if (usage.files + files > OWNER_LIMITS.assetFiles || Number(usage.bytes) + bytes > OWNER_LIMITS.assetBytes) throw new LimitError("asset_quota_exceeded");
}

export async function requireJobCapacity(sql: Database, owner: string, retained: boolean) {
  // 全局额度锁只保护很短的计数/占位，不跨网络操作。
  await sql`SELECT pg_advisory_xact_lock(82740317)`;
  // retained 只统计仍需处理的任务：活跃任务，以及当前修订下仍可确认的预览；终态与已失效预览不占额度。
  const [usage] = await sql`SELECT count(*) FILTER (WHERE j.owner_id=${owner} AND (j.status IN ('submitting','accepting','queued','running','unknown','interrupted')
      OR (j.publication_requested AND j.status NOT IN ('succeeded','failed'))
      OR (j.status='preview_ready' AND NOT j.publication_requested AND NOT j.authorization_revoked AND j.document_revision=d.revision)))::integer AS retained,
    count(*) FILTER (WHERE j.owner_id=${owner} AND (j.status IN ('submitting','accepting','queued','running','unknown','interrupted') OR (j.publication_requested AND j.status NOT IN ('succeeded','failed'))))::integer AS active,
    count(*) FILTER (WHERE j.status IN ('submitting','accepting','queued','running','unknown','interrupted') OR (j.publication_requested AND j.status NOT IN ('succeeded','failed')))::integer AS global_active
    FROM jobs j LEFT JOIN documents d ON d.id=j.document_id AND d.owner_id=j.owner_id`;
  if (retained && usage.retained >= OWNER_LIMITS.retained) throw new LimitError("job_retained_quota_exceeded");
  if (usage.active >= OWNER_LIMITS.active || usage.global_active >= OWNER_LIMITS.globalActive) throw new LimitError("job_active_quota_exceeded");
}

const operations = new Map<string, Set<string>>();
// 单实例进程槽跟随实际请求 finally 释放，没有超时偷放仍在执行的操作。
export async function withOperation<T>(_sql: Database, owner: string, operation: "upload" | "import" | "canvas", run: () => Promise<T>): Promise<T> {
  const active = operations.get(operation) || new Set<string>();
  if (active.has(owner) || active.size >= 2) throw new LimitError("operation_busy");
  active.add(owner); operations.set(operation, active);
  try { return await run(); }
  finally { active.delete(owner); }
}
