// Worker 失败原因的脱敏与归类：只把可读、无密钥的短文本带给界面。
const MAX_LENGTH = 500;
// 微信请求号形如 6adab69a-0a5b3c1d-5e1d9a28，保留以便排查。
const REQUEST_ID = /^[0-9a-f]{8}(?:-[0-9a-f]{4,12}){1,4}$/i;

/** 去掉令牌、密钥与本机路径；超长截断。无内容返回 null。 */
export function sanitizeFailure(raw: unknown): string | null {
  if (typeof raw !== "string") return null;
  let text = raw.replace(/[\u0000-\u0008\u000b-\u001f\u007f]/g, " ")
    .replace(/\b(access_token|refresh_token|token|appsecret|app_secret|secret|authorization|pat|password)(["']?\s*[=:]\s*["']?)(?:Bearer\s+)?[^\s&"',;]+/gi, "$1$2[已隐藏]")
    .replace(/\bBearer\s+[A-Za-z0-9._~+/=-]+/gi, "Bearer [已隐藏]")
    .replace(/\bpat_[A-Za-z0-9_-]+/g, "[已隐藏]")
    .replace(/\b(?:sk|ghp|gho|ghs|xox[a-z])[-_][A-Za-z0-9_-]{8,}/g, "[已隐藏]")
    .replace(/(^|[\s"'(=])(?:\/[\w.@+~-]+){3,}\/?/g, "$1[路径]");
  // 其余长串（十六进制、base64、长随机串）一律视为可能的密钥，请求号除外。
  text = text.replace(/[A-Za-z0-9_+/=-]{24,}/g, token => REQUEST_ID.test(token) ? token : "[已隐藏]");
  text = text.replace(/\s+/g, " ").trim();
  if (!text) return null;
  return text.length > MAX_LENGTH ? `${text.slice(0, MAX_LENGTH - 1)}…` : text;
}

export type FailureHint = "invalid_appid" | "invalid_secret" | "ip_whitelist" | "relay_unauthorized" | "relay_unreachable";

/** 按常见微信错误码与中转报错归类；认不出来返回 null，界面直接显示脱敏原文。 */
export function classifyFailure(detail: string | null): FailureHint | null {
  if (!detail) return null;
  const text = detail.toLowerCase();
  if (/\b40164\b|\b61004\b|not in whitelist|ip[^.]{0,20}whitelist/.test(text)) return "ip_whitelist";
  if (/\b40013\b|invalid appid/.test(text)) return "invalid_appid";
  if (/\b40125\b|\b40001\b|invalid appsecret|invalid secret/.test(text)) return "invalid_secret";
  if (/\b401\b|unauthorized|invalid pat|pat invalid|token (?:is )?(?:invalid|expired)/.test(text) && !/errcode/.test(text)) return "relay_unauthorized";
  if (/econnrefused|enotfound|etimedout|fetch failed|unable to connect|connection refused|timed? ?out|no route to host|socket hang up|eai_again/.test(text)) return "relay_unreachable";
  return null;
}
