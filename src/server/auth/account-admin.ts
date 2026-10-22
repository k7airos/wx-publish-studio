import { SQL } from "bun";
import { randomUUID } from "node:crypto";
import type { Database } from "../db/schema";
import { lockOwner, memberAccess } from "../services/owner-limits";
import { AccountError } from "../services/account-store";

interface HandoffInput { accountId: string; targetOwnerId?: string; restoreAccountId?: string; operator: string; confirm: boolean }

// 仅本机受控交接；不复制凭据、不转历史 owner，不存在开放 AppID 的空窗。
export async function administerAccount(sql: Database, action: "pause-account" | "release-account", input: HandoffInput) {
  if (!input.confirm || !input.operator.trim() || input.operator.length > 100 || /[\r\n]/.test(input.operator)
    || !/^[a-zA-Z0-9_.-]{1,80}$/.test(input.accountId)
    || action === "release-account" && !/^[a-f\d]{8}(?:-[a-f\d]{4}){3}-[a-f\d]{12}$/i.test(input.targetOwnerId || "")) throw new AccountError("invalid_account_handoff");
  return sql.begin(async transaction => {
    const [initial] = await transaction`SELECT * FROM accounts WHERE id=${input.accountId}`;
    if (!initial) throw new AccountError("invalid_account");
    const [initialBinding] = await transaction`SELECT * FROM account_bindings WHERE app_id=${initial.app_id}`;
    for (const owner of [...new Set([initial.owner_id, initialBinding?.owner_id, input.targetOwnerId].filter(Boolean) as string[])].sort()) await lockOwner(transaction as Database, owner, false);
    const [account] = await transaction`SELECT * FROM accounts WHERE id=${input.accountId} FOR UPDATE`;
    const [binding] = await transaction`SELECT * FROM account_bindings WHERE app_id=${account.app_id} FOR UPDATE`;
    if (!binding || binding.owner_id !== initialBinding?.owner_id || binding.account_id !== initialBinding?.account_id) throw new AccountError("account_version_conflict");
    if (action === "pause-account") {
      if (binding.account_id !== account.id || binding.owner_id !== account.owner_id || account.binding_state === "released") throw new AccountError("account_authorization_released");
      await transaction`UPDATE accounts SET active=false,binding_state='paused',version=version+1,updated_at=now() WHERE id=${account.id}`;
    } else {
      const [member] = await transaction`SELECT status,access_until FROM product_memberships WHERE owner_id=${input.targetOwnerId!}`;
      if (memberAccess(member) !== "active") throw new AccountError("target_member_inactive");
      if (binding.account_id && (binding.account_id !== account.id || account.active || account.binding_state !== "paused")) throw new AccountError("account_handoff_requires_pause");
      const [pending] = await transaction`SELECT count(*)::integer AS total FROM jobs WHERE account_id=${binding.account_id || account.id}
        AND (status IN ('submitting','accepting','queued','running','unknown','interrupted') OR (publication_requested AND status NOT IN ('succeeded','failed')))`;
      if (pending.total) throw new AccountError("account_handoff_pending_jobs");
      let restore: any;
      if (input.restoreAccountId) {
        [restore] = await transaction`SELECT * FROM accounts WHERE id=${input.restoreAccountId} AND owner_id=${input.targetOwnerId!} AND app_id=${account.app_id} FOR UPDATE`;
        if (!restore || !["released", "paused"].includes(restore.binding_state)) throw new AccountError("invalid_account_handoff");
      }
      await transaction`UPDATE accounts SET active=false,binding_state='released',version=version+1,updated_at=now() WHERE id=${account.id}`;
      // 转出前尚未请求发布的预览永久只读，反向恢复连接也不复活旧确认资格。
      await transaction`UPDATE jobs SET authorization_revoked=true,updated_at=now() WHERE account_id=${account.id} AND operation='preview' AND NOT publication_requested`;
      await transaction`UPDATE account_bindings SET owner_id=${input.targetOwnerId!},account_id=${restore?.id ?? null},updated_at=now() WHERE app_id=${account.app_id}`;
      if (restore) await transaction`UPDATE accounts SET active=true,binding_state='bound',version=version+1,updated_at=now() WHERE id=${restore.id}`;
    }
    await transaction`INSERT INTO account_admin_audit (id,action,app_id,owner_id,account_id,target_owner_id,operator,detail)
      VALUES (${randomUUID()},${action},${account.app_id},${account.owner_id},${account.id},${input.targetOwnerId ?? null},${input.operator.trim()},${{ restoreAccountId: input.restoreAccountId || null }}::jsonb)`;
    return { accountId: account.id, action, targetOwnerId: input.targetOwnerId || null, restoredAccountId: input.restoreAccountId || null };
  });
}

export async function runAccountAdmin(args: string[], env: Record<string, string | undefined> = process.env) {
  const [action, ...rest] = args;
  if (action !== "pause-account" && action !== "release-account") throw new Error("Expected pause-account or release-account");
  const fields = new Map<string, string>(); let confirm = false;
  for (let index = 0; index < rest.length; index++) {
    const key = rest[index]!;
    if (key === "--confirm" && !confirm) { confirm = true; continue; }
    const value = rest[++index];
    if (!["--account-id", "--target-owner-id", "--restore-account-id", "--operator"].includes(key) || fields.has(key) || !value || value.startsWith("--")) throw new Error("Invalid or duplicate admin argument");
    fields.set(key, value);
  }
  if (!env.DATABASE_URL) throw new Error("DATABASE_URL is required");
  const sql = new SQL(env.DATABASE_URL);
  try { return await administerAccount(sql, action, { accountId: fields.get("--account-id") || "", targetOwnerId: fields.get("--target-owner-id"), restoreAccountId: fields.get("--restore-account-id"), operator: fields.get("--operator") || "", confirm }); }
  finally { await sql.close(); }
}
if (import.meta.main) {
  try { console.info(JSON.stringify(await runAccountAdmin(process.argv.slice(2)))); }
  catch (error) { console.error(error instanceof Error ? error.message : "Account admin operation failed"); process.exitCode = 1; }
}
