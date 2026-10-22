import { createHash, randomUUID } from "node:crypto";
import type { Database } from "../db/schema";
import { OWNER_ID } from "../db/schema";
import type { AccountConfig, AppConfig } from "../config";
import { CredentialCrypto, type AccountSecret } from "./credential-crypto";
import { lockOwner, OWNER_LIMITS, LimitError } from "./owner-limits";

export class AccountError extends Error {
  constructor(readonly code: string) { super(code); }
}

export const accountDto = (row: any, patMissing = false) => ({
  id: row.id, label: row.label, appId: row.app_id, active: row.active,
  version: row.version, credentialRevision: row.credential_revision,
  synchronized: row.synced_revision === row.credential_revision, syncedAt: row.synced_at,
  bindingState: row.binding_state,
  // 部署未统一持有中转令牌且这个连接没有自己的 PAT 时为真；界面据此提示补齐。
  patMissing,
});

function field(value: unknown, max: number) {
  return typeof value === "string" && !!value.trim() && value.trim().length <= max;
}

// 业务库保存连接与不可变凭据修订；Worker key 不随着排队任务被覆盖。
export class AccountStore {
  private readonly crypto: CredentialCrypto;
  private readonly relayManaged: boolean;

  constructor(private sql: Database, config: AppConfig) {
    this.crypto = new CredentialCrypto(config.credentialEncryptionKey);
    this.relayManaged = !!config.relayPat;
  }

  async list(owner: string) {
    return this.sql`SELECT * FROM accounts WHERE owner_id=${owner} ORDER BY created_at`;
  }

  /**
   * 部署未统一持有中转令牌时，列出没有自己 PAT 的连接。
   * 运维撤掉 PUBLISHING_RELAY_PAT 之后，早先建立的连接会命中这里。
   */
  async missingRelayToken(owner: string) {
    const missing = new Set<string>();
    if (this.relayManaged) return missing;
    const rows = await this.sql`SELECT a.id, a.credential_revision, c.encrypted_secret FROM accounts a
      JOIN account_credentials c ON c.account_id = a.id AND c.revision = a.credential_revision
      WHERE a.owner_id = ${owner}`;
    for (const row of rows) {
      let secret: AccountSecret;
      try { secret = this.crypto.decrypt(row.id, row.credential_revision, row.encrypted_secret); }
      catch { continue; } // 凭据读不出来是另一类问题，不在这里误报成缺 PAT。
      if (!secret.pat?.trim()) missing.add(row.id);
    }
    return missing;
  }

  async get(owner: string, id: string) {
    const [row] = await this.sql`SELECT * FROM accounts WHERE id=${id} AND owner_id=${owner}`;
    if (!row) throw new AccountError("invalid_account");
    return row;
  }

  async create(owner: string, input: any) {
    if (!field(input?.label, 100) || !field(input?.appId, 255) || !field(input?.appSecret, 512)
      || (this.relayManaged ? input?.pat !== undefined && typeof input.pat !== "string" : !field(input?.pat, 512))) throw new AccountError("invalid_account_fields");
    const id = randomUUID();
    return this.sql.begin(async transaction => {
      await lockOwner(transaction as Database, owner);
      const [count] = await transaction`SELECT count(*)::integer AS total FROM accounts WHERE owner_id=${owner}`;
      if (count.total >= OWNER_LIMITS.accounts) throw new LimitError("account_quota_exceeded");
      await transaction`SELECT pg_advisory_xact_lock(hashtextextended(${input.appId.trim()},82740321))`;
      const [binding] = await transaction`SELECT * FROM account_bindings WHERE app_id=${input.appId.trim()} FOR UPDATE`;
      if (binding && (binding.owner_id !== owner || binding.account_id)) throw new AccountError("account_app_id_reserved");
      const existing = await transaction`SELECT id FROM accounts WHERE owner_id=${owner} AND app_id=${input.appId.trim()}`;
      if (existing.length) throw new AccountError("account_already_exists");
      const [row] = await transaction`INSERT INTO accounts (id,owner_id,label,app_id,credential_revision) VALUES (${id},${owner},${input.label.trim()},${input.appId.trim()},1) RETURNING *`;
      const encrypted = this.crypto.encrypt(id, 1, { appSecret: input.appSecret.trim(), pat: this.relayManaged ? "" : input.pat.trim() });
      await transaction`INSERT INTO account_credentials (account_id,revision,encrypted_secret,worker_account) VALUES (${id},1,${encrypted},${this.workerKey(owner, id, 1)})`;
      await transaction`INSERT INTO account_bindings (app_id,owner_id,account_id) VALUES (${row.app_id},${owner},${id})
        ON CONFLICT (app_id) DO UPDATE SET account_id=excluded.account_id,updated_at=now()`;
      return row;
    });
  }

  async update(owner: string, id: string, input: any) {
    if (!field(input?.label, 100) || !Number.isInteger(input?.expectedVersion)
      || !["appSecret", "pat"].every(key => input[key] === undefined || typeof input[key] === "string" && input[key].trim().length <= 512)) throw new AccountError("invalid_account_fields");
    return this.sql.begin(async transaction => {
      await lockOwner(transaction as Database, owner);
      const row = await this.writable(transaction as Database, owner, id, false);
      if (input.appId !== undefined && input.appId !== row.app_id) throw new AccountError("account_app_id_immutable");
      if (input.expectedVersion !== row.version) throw new AccountError("account_version_conflict");
      const current = await this.credentials(owner, id, row.credential_revision, transaction as Database);
      // 服务持有中转令牌时忽略客户提交的令牌，避免旧前端写入无用凭据修订。
      const secret = { appSecret: input.appSecret?.trim() || current.appSecret, pat: this.relayManaged ? current.pat : input.pat?.trim() || current.pat };
      const changed = secret.appSecret !== current.appSecret || secret.pat !== current.pat;
      const revision = row.credential_revision + (changed ? 1 : 0);
      if (changed) {
        if (revision > OWNER_LIMITS.credentials) throw new LimitError("credential_quota_exceeded");
        await transaction`INSERT INTO account_credentials (account_id,revision,encrypted_secret,worker_account)
          VALUES (${id},${revision},${this.crypto.encrypt(id, revision, secret)},${this.workerKey(owner, id, revision)})`;
      }
      const [updated] = await transaction`UPDATE accounts SET label=${input.label.trim()},credential_revision=${revision},version=version+1,updated_at=now() WHERE id=${id} RETURNING *`;
      return updated;
    });
  }

  async deactivate(owner: string, id: string) {
    return this.sql.begin(async transaction => {
      await lockOwner(transaction as Database, owner);
      await this.writable(transaction as Database, owner, id, false);
      const [row] = await transaction`UPDATE accounts SET active=false,version=version+1,updated_at=now() WHERE id=${id} RETURNING *`;
      return row;
    });
  }

  async writable(sql: Database, owner: string, id: string, requireActive = true) {
    const [row] = await sql`SELECT * FROM accounts WHERE id=${id} AND owner_id=${owner} FOR UPDATE`;
    if (!row) throw new AccountError("invalid_account");
    const [binding] = await sql`SELECT * FROM account_bindings WHERE app_id=${row.app_id}`;
    if (row.binding_state !== "bound" || binding?.owner_id !== owner || binding?.account_id !== id) throw new AccountError("account_authorization_released");
    if (requireActive && !row.active) throw new AccountError("account_disabled");
    return row;
  }

  // 同步也属于首次外部写，不能在交接后把旧 Worker 身份重新登记。
  async synchronize(owner: string, id: string, register: (account: AccountConfig) => Promise<void>) {
    return this.sql.begin(async transaction => {
      await lockOwner(transaction as Database, owner);
      const account = await this.writable(transaction as Database, owner, id);
      const credential = await this.credentials(owner, id, account.credential_revision, transaction as Database);
      await register(credential);
      const [row] = await transaction`UPDATE accounts SET synced_revision=${credential.revision!},synced_at=now() WHERE id=${id} RETURNING *`;
      return row;
    });
  }

  async credentials(owner: string, id: string, revision?: number | null, sql = this.sql): Promise<AccountConfig> {
    const [account] = await sql`SELECT * FROM accounts WHERE id=${id} AND owner_id=${owner}`;
    if (!account) throw new AccountError("invalid_account");
    const selected = revision ?? account.credential_revision;
    const [row] = await sql`SELECT * FROM account_credentials WHERE account_id=${id} AND revision=${selected}`;
    if (!row) throw new AccountError("account_credentials_missing");
    return { id: account.id, label: account.label, appId: account.app_id,
      ...this.crypto.decrypt(id, selected, row.encrypted_secret), revision: selected, workerAccount: row.worker_account };
  }

  async markSynced(id: string, revision: number) {
    await this.sql`UPDATE accounts SET synced_revision=${revision},synced_at=now() WHERE id=${id} AND credential_revision=${revision}`;
  }

  async importOnce(accounts: AccountConfig[]) {
    await this.sql.begin(async transaction => {
      await transaction`SELECT pg_advisory_xact_lock(82740312)`;
      if ((await transaction`SELECT key FROM app_settings WHERE key='legacy_accounts_imported'`).length) return;
      for (const account of accounts) {
        const [existing] = await transaction`SELECT id,app_id FROM accounts WHERE id=${account.id} OR (owner_id=${OWNER_ID} AND app_id=${account.appId})`;
        if (existing) throw new AccountError("account_import_conflict");
        await transaction`INSERT INTO accounts (id,owner_id,label,app_id,credential_revision) VALUES (${account.id},${OWNER_ID},${account.label},${account.appId},1)`;
        // R1 任务引用旧 key，显式导入保留它作为第一版凭据的 Worker 身份。
        await transaction`INSERT INTO account_credentials (account_id,revision,encrypted_secret,worker_account)
          VALUES (${account.id},1,${this.crypto.encrypt(account.id, 1, { appSecret: account.appSecret, pat: account.pat })},${account.id})`;
        await transaction`INSERT INTO account_bindings (app_id,owner_id,account_id) VALUES (${account.appId},${OWNER_ID},${account.id})`;
      }
      await transaction`INSERT INTO app_settings (key,value) VALUES ('legacy_accounts_imported','true')`;
    });
  }

  private workerKey(owner: string, id: string, revision: number) {
    return `ps_${createHash("sha256").update(`${owner}:${id}`).digest("hex").slice(0, 32)}_r${revision}`;
  }
}

export async function initializeAccounts(sql: Database, config: AppConfig) {
  if (config.importAccountsOnce) await new AccountStore(sql, config).importOnce(config.accounts ?? []);
}
