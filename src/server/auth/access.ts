import { randomUUID } from "node:crypto";
import { getCookie } from "hono/cookie";
import type { MiddlewareHandler } from "hono";
import type { AppConfig } from "../config";
import { OWNER_ID, type Database } from "../db/schema";
import { tokenHash } from "./session";
import { lockOwner, memberAccess } from "../services/owner-limits";

export type AppEnv = { Variables: { ownerId: string } };
const uuid = /^[a-f\d]{8}(?:-[a-f\d]{4}){3}-[a-f\d]{12}$/i;

export class AccessError extends Error {
  constructor(readonly code: string) { super(code); }
}

// 每次 API 请求读取当前资格，撤销会话或停用成员不等待 Cookie 过期。
export function sessionAuth(sql: Database, config: AppConfig): MiddlewareHandler<AppEnv> {
  return async (c, next) => {
    const token = getCookie(c, "studio_session");
    if (!token || !/^[a-f\d]{64}$/.test(token)) return c.json({ error: "unauthorized" }, 401);
    const [session] = await sql`SELECT s.*,m.status AS membership_status,m.access_until,i.owner_id AS identity_owner,i.issuer
      FROM sessions s LEFT JOIN product_memberships m ON m.owner_id=s.owner_id LEFT JOIN identities i ON i.id=s.identity_id
      WHERE s.token_hash=${tokenHash(token)} AND s.expires_at > now()`;
    if (!session) return c.json({ error: "unauthorized" }, 401);
    if (session.auth_method === "bootstrap" && ((config.authMode || "bootstrap") !== "bootstrap" || session.owner_id !== OWNER_ID)) return c.json({ error: "unauthorized" }, 401);
    if (session.auth_method === "oauth" && (!config.oauth || session.identity_owner !== session.owner_id || session.issuer !== config.oauth.issuer)) return c.json({ error: "unauthorized" }, 401);
    const access = memberAccess({ status: session.membership_status, access_until: session.access_until });
    if (access !== "active") return c.json({ error: access === "expired" ? "access_expired" : "access_denied" }, 403);
    c.set("ownerId", session.owner_id); await next();
  };
}

export interface ClaimOwnerInput { ownerId: string; issuer: string; subject: string; operator: string; confirm: boolean }

function operatorLabel(operator: string) {
  if (!operator.trim() || operator.length > 100 || /[\r\n]/.test(operator)) throw new AccessError("invalid_operator");
}

// 存量认领只允许受控命令显式绑定固定 owner；登录回调只在开启自动开通且会员有效时为新身份建成员（provisionFromLogin）。
export async function claimOwner(sql: Database, config: Pick<AppConfig, "oauth">, input: ClaimOwnerInput) {
  operatorLabel(input.operator);
  if (!input.confirm || input.ownerId !== OWNER_ID || !config.oauth || input.issuer !== config.oauth.issuer || !uuid.test(input.subject)) throw new AccessError("invalid_identity_claim");
  const subject = input.subject.toLowerCase();
  return sql.begin(async transaction => {
    await transaction`SELECT pg_advisory_xact_lock(82740313)`;
    const [owner] = await transaction`SELECT id FROM owners WHERE id=${input.ownerId} FOR UPDATE`;
    if (!owner) throw new AccessError("owner_not_found");
    const rows = await transaction`SELECT * FROM identities WHERE (issuer=${input.issuer} AND subject=${subject}) OR (owner_id=${input.ownerId} AND issuer=${input.issuer})`;
    if (rows.some((row: any) => row.owner_id !== input.ownerId || row.subject !== subject)) throw new AccessError("identity_claim_conflict");
    let identity = rows[0];
    if (!identity) [identity] = await transaction`INSERT INTO identities (id,owner_id,issuer,subject) VALUES (${randomUUID()},${input.ownerId},${input.issuer},${subject}) RETURNING *`;
    if (!rows.length) await transaction`INSERT INTO product_memberships (owner_id,status,role) VALUES (${input.ownerId},'active','admin') ON CONFLICT (owner_id) DO UPDATE SET status='active',role='admin',updated_at=now()`;
    await transaction`INSERT INTO identity_admin_audit (id,action,owner_id,issuer,subject,operator) VALUES (${randomUUID()},'claim-owner',${input.ownerId},${input.issuer},${subject},${input.operator.trim()})`;
    return { ownerId: input.ownerId, identityId: identity.id, unchanged: rows.length > 0 };
  });
}

// 新成员必须由受控命令按固定 issuer/subject 开通，不能从中央角色或邮箱推断。
export async function addMember(sql: Database, config: Pick<AppConfig, "oauth">, input: Omit<ClaimOwnerInput, "ownerId">) {
  operatorLabel(input.operator);
  if (!input.confirm || !config.oauth || input.issuer !== config.oauth.issuer || !uuid.test(input.subject)) throw new AccessError("invalid_identity_claim");
  const subject = input.subject.toLowerCase();
  return sql.begin(async transaction => {
    await transaction`SELECT pg_advisory_xact_lock(82740313)`;
    const [existing] = await transaction`SELECT * FROM identities WHERE issuer=${input.issuer} AND subject=${subject}`;
    if (existing) {
      const [membership] = await transaction`SELECT * FROM product_memberships WHERE owner_id=${existing.owner_id}`;
      if (!membership || membership.role !== "member") throw new AccessError("identity_claim_conflict");
      return { ownerId: existing.owner_id, identityId: existing.id, unchanged: true, status: membership.status };
    }
    const ownerId = randomUUID(); const identityId = randomUUID();
    await transaction`INSERT INTO owners (id) VALUES (${ownerId})`;
    await transaction`INSERT INTO product_memberships (owner_id,status,role) VALUES (${ownerId},'active','member')`;
    await transaction`INSERT INTO identities (id,owner_id,issuer,subject) VALUES (${identityId},${ownerId},${input.issuer},${subject})`;
    await transaction`INSERT INTO identity_admin_audit (id,action,owner_id,issuer,subject,operator) VALUES (${randomUUID()},'add-member',${ownerId},${input.issuer},${subject},${input.operator.trim()})`;
    return { ownerId, identityId, unchanged: false, status: "active" };
  });
}

/**
 * 按 Nezus 有效会员自动开通：新 owner、member、identity 与审计在同一锁内建立。
 * 身份已存在时不做任何修改，交由登录流程按原成员资格处理，停用成员不会被重新激活。
 */
export async function provisionFromLogin(transaction: Database, issuer: string, subject: string, accessUntil: Date) {
  await transaction`SELECT pg_advisory_xact_lock(82740313)`;
  const [existing] = await transaction`SELECT * FROM identities WHERE issuer=${issuer} AND subject=${subject}`;
  if (existing) return existing;
  const ownerId = randomUUID(); const identityId = randomUUID();
  await transaction`INSERT INTO owners (id) VALUES (${ownerId})`;
  await transaction`INSERT INTO product_memberships (owner_id,status,role,access_source,access_until,entitlement_synced_at)
    VALUES (${ownerId},'active','member','nezus_membership',${accessUntil},now())`;
  const [identity] = await transaction`INSERT INTO identities (id,owner_id,issuer,subject) VALUES (${identityId},${ownerId},${issuer},${subject}) RETURNING *`;
  await transaction`INSERT INTO identity_admin_audit (id,action,owner_id,issuer,subject,operator,detail)
    VALUES (${randomUUID()},'self-provision',${ownerId},${issuer},${subject},'oauth-login',${{ accessUntil: accessUntil.toISOString() }}::jsonb)`;
  return identity;
}

export async function revokeSessions(sql: Database, input: { ownerId?: string; sessionId?: string; operator: string; confirm: boolean }) {
  operatorLabel(input.operator);
  if (!input.confirm || !!input.ownerId === !!input.sessionId || !uuid.test(input.ownerId || input.sessionId || "")) throw new AccessError("invalid_session_revocation");
  return sql.begin(async transaction => {
    if (input.ownerId) {
      const [owner] = await transaction`SELECT id FROM owners WHERE id=${input.ownerId}`;
      if (!owner) throw new AccessError("owner_not_found");
      await transaction`SELECT owner_id FROM product_memberships WHERE owner_id=${input.ownerId} FOR UPDATE`;
    }
    const deleted = input.ownerId ? await transaction`DELETE FROM sessions WHERE owner_id=${input.ownerId} RETURNING owner_id,id` : await transaction`DELETE FROM sessions WHERE id=${input.sessionId} RETURNING owner_id,id`;
    const ownerId = input.ownerId || deleted[0]?.owner_id;
    if (ownerId) await transaction`INSERT INTO identity_admin_audit (id,action,owner_id,operator,detail) VALUES (${randomUUID()},'revoke-sessions',${ownerId},${input.operator.trim()},${{ sessionId: input.sessionId || null, count: deleted.length }}::jsonb)`;
    return { revoked: deleted.length };
  });
}

export async function disableMember(sql: Database, input: { ownerId: string; operator: string; confirm: boolean }) {
  operatorLabel(input.operator);
  if (!input.confirm || !uuid.test(input.ownerId)) throw new AccessError("invalid_member_change");
  return sql.begin(async transaction => {
    await lockOwner(transaction as Database, input.ownerId, false);
    const [member] = await transaction`SELECT * FROM product_memberships WHERE owner_id=${input.ownerId} FOR UPDATE`;
    if (!member) throw new AccessError("member_not_found");
    await transaction`UPDATE product_memberships SET status='disabled',updated_at=now() WHERE owner_id=${input.ownerId}`;
    const deleted = await transaction`DELETE FROM sessions WHERE owner_id=${input.ownerId} RETURNING id`;
    await transaction`INSERT INTO identity_admin_audit (id,action,owner_id,operator,detail) VALUES (${randomUUID()},'disable-member',${input.ownerId},${input.operator.trim()},${{ revoked: deleted.length }}::jsonb)`;
    return { ownerId: input.ownerId, disabled: true, revoked: deleted.length };
  });
}
