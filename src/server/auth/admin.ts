import { SQL } from "bun";
import { addMember, claimOwner, disableMember, revokeSessions } from "./access";
import { loadAuthConfig, validateAppOrigin } from "../config";

// 本机受控命令不启动 Web 服务或任务执行器，也不自动迁移业务库。
export async function runIdentityAdmin(args: string[], env: Record<string, string | undefined> = process.env) {
  const [command, ...rest] = args;
  if (!["add-member", "claim-owner", "revoke-sessions", "revoke-session", "disable-member"].includes(command || "")) throw new Error("Expected add-member, claim-owner, revoke-sessions, revoke-session or disable-member");
  const input = new Map<string, string>();
  let confirm = false;
  for (let index = 0; index < rest.length; index++) {
    const key = rest[index]!;
    if (key === "--confirm" && !confirm) { confirm = true; continue; }
    const allowed = ["--operator", ...(command === "revoke-session" ? ["--session-id"] : command === "add-member" ? [] : ["--owner-id"]), ...(["claim-owner", "add-member"].includes(command!) ? ["--issuer", "--subject"] : [])];
    const value = rest[++index];
    if (!allowed.includes(key) || input.has(key) || !value || value.startsWith("--")) throw new Error("Invalid or duplicate admin argument");
    input.set(key, value);
  }
  const operator = input.get("--operator") || "";
  if (!confirm || !operator || !env.DATABASE_URL) throw new Error("Admin action requires DATABASE_URL, --operator and --confirm");
  const sql = new SQL(env.DATABASE_URL);
  try {
    if (command === "claim-owner" || command === "add-member") {
      const auth = loadAuthConfig(env, validateAppOrigin(env.APP_ORIGIN || ""));
      if (command === "add-member") return await addMember(sql, auth, { issuer: input.get("--issuer") || "", subject: input.get("--subject") || "", operator, confirm });
      return await claimOwner(sql, auth, { ownerId: input.get("--owner-id") || "", issuer: input.get("--issuer") || "", subject: input.get("--subject") || "", operator, confirm });
    }
    if (command === "disable-member") return await disableMember(sql, { ownerId: input.get("--owner-id") || "", operator, confirm });
    return await revokeSessions(sql, { ...(command === "revoke-session" ? { sessionId: input.get("--session-id") || "" } : { ownerId: input.get("--owner-id") || "" }), operator, confirm });
  } finally { await sql.close(); }
}

if (import.meta.main) {
  try { console.info(JSON.stringify(await runIdentityAdmin(process.argv.slice(2)))); }
  catch (error) { console.error(error instanceof Error ? error.message : "Identity admin operation failed"); process.exitCode = 1; }
}
