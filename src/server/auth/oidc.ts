import type { OAuthConfig } from "../config";

const loopbackHosts = ["127.0.0.1", "localhost", "[::1]"];
const requestTimeoutMs = 10_000;
const maxResponseBytes = 64 * 1024;

/**
 * 只信任 HTTPS（或显式回环 HTTP）的绝对地址：不允许凭据、query 与 fragment。
 * 回环判定沿用既有 APP_ORIGIN 规则，避免把任意明文地址当成受信身份源。
 */
export function parseTrustedUrl(value: string, label: string): URL {
  let url: URL;
  try { url = new URL(value); } catch { throw new Error(`${label} must be an absolute URL`); }
  if (!["http:", "https:"].includes(url.protocol)) throw new Error(`${label} must be an HTTPS URL`);
  if (url.username || url.password) throw new Error(`${label} must not contain credentials`);
  if (url.search || url.hash) throw new Error(`${label} must not contain a query or a fragment`);
  if (url.protocol === "http:" && !loopbackHosts.includes(url.hostname)) throw new Error(`${label} must be an HTTPS URL (HTTP is only allowed for an explicit loopback host)`);
  return url;
}

/** issuer 允许带路径（realm 之类），但必须是精确受信值；尾部斜杠规范化掉。 */
export function normalizeIssuer(value: string): string {
  const url = parseTrustedUrl(value, "PUBLISHING_OAUTH_ISSUER");
  return `${url.origin}${url.pathname.replace(/\/+$/, "")}`;
}

export interface OidcEndpoints { authorizationEndpoint: string; tokenEndpoint: string; userinfoEndpoint: string }

async function readDiscoveryJson(url: string): Promise<unknown> {
  let response: Response;
  try {
    response = await fetch(url, { redirect: "manual", cache: "no-store", signal: AbortSignal.timeout(requestTimeoutMs), headers: { Accept: "application/json" } });
  } catch (error) {
    throw new Error(`OIDC discovery request to ${url} failed: ${error instanceof Error ? error.message : "network error"}`);
  }
  if (!response.ok || !response.body) throw new Error(`OIDC discovery request to ${url} failed with status ${response.status}`);
  if (Number(response.headers.get("content-length") || 0) > maxResponseBytes) throw new Error("OIDC discovery response is too large");
  const reader = response.body.getReader(); const chunks: Uint8Array[] = []; let length = 0;
  try {
    while (true) {
      const item = await reader.read(); if (item.done) break;
      length += item.value.byteLength;
      if (length > maxResponseBytes) throw new Error("OIDC discovery response is too large");
      chunks.push(item.value);
    }
  } finally { await reader.cancel().catch(() => {}); }
  try { return JSON.parse(Buffer.concat(chunks).toString("utf8")); } catch { throw new Error(`OIDC discovery response from ${url} is not valid JSON`); }
}

/**
 * 标准 OIDC 发现：只从 issuer 推导，不跟随重定向、不静默降级到别的端点。
 * 缺失的字段返回 undefined，由调用方决定是显式配置还是启动失败。
 */
export async function discoverOidcEndpoints(issuer: string): Promise<Partial<OidcEndpoints>> {
  const url = `${issuer}/.well-known/openid-configuration`;
  const body = await readDiscoveryJson(url);
  if (!body || typeof body !== "object") throw new Error(`OIDC discovery document at ${url} is not an object`);
  const document = body as Record<string, unknown>;
  if (typeof document.issuer === "string" && document.issuer) {
    let advertised = "";
    try { advertised = normalizeIssuer(document.issuer); } catch { advertised = ""; }
    if (!advertised || advertised !== normalizeIssuer(issuer)) throw new Error(`OIDC discovery issuer mismatch for ${issuer}`);
  }
  const read = (field: string, label: string) => {
    const value = document[field];
    if (typeof value !== "string" || !value) return undefined;
    parseTrustedUrl(value, label);
    return value;
  };
  return {
    authorizationEndpoint: read("authorization_endpoint", "OIDC authorization_endpoint"),
    tokenEndpoint: read("token_endpoint", "OIDC token_endpoint"),
    userinfoEndpoint: read("userinfo_endpoint", "OIDC userinfo_endpoint"),
  };
}

/**
 * 发现模式在启动时解析端点：显式端点优先，其次发现结果，最后才是部署自己给的 Portal 地址。
 * 解析不出来就报错，绝不静默换到别的端点。
 */
export async function resolveOAuthEndpoints(oauth: OAuthConfig): Promise<OAuthConfig> {
  if ((oauth.endpointMode ?? "legacy") !== "discovery") return oauth;
  const discovered = await discoverOidcEndpoints(oauth.issuer);
  const authorizationEndpoint = oauth.authorizationEndpoint ?? discovered.authorizationEndpoint ?? oauth.portalUrl ?? "";
  const tokenEndpoint = oauth.tokenEndpoint ?? discovered.tokenEndpoint ?? "";
  const userinfoEndpoint = oauth.userinfoEndpoint ?? discovered.userinfoEndpoint ?? "";
  const missing = [
    !authorizationEndpoint ? "PUBLISHING_OAUTH_AUTHORIZATION_ENDPOINT" : "",
    !tokenEndpoint ? "PUBLISHING_OAUTH_TOKEN_ENDPOINT" : "",
    !userinfoEndpoint ? "PUBLISHING_OAUTH_USERINFO_ENDPOINT" : "",
  ].filter(Boolean);
  if (missing.length) throw new Error(`OIDC discovery did not provide the required endpoint(s); set them explicitly: ${missing.join(", ")}`);
  return { ...oauth, authorizationEndpoint, tokenEndpoint, userinfoEndpoint };
}
