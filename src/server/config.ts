import { readFile } from "node:fs/promises";
import { isIP } from "node:net";
import { resolve } from "node:path";

export interface AccountConfig {
  id: string;
  label: string;
  appId: string;
  appSecret: string;
  pat: string;
  revision?: number;
  workerAccount?: string;
}

export interface OAuthConfig {
  issuer: string;
  portalUrl: string;
  baseUrl: string;
  clientId: string;
  clientSecret: string;
  redirectUri: string;
}

export interface TrustedCoverFont { id: string; family: string; path: string; sha256: string; owners?: string[] }

export interface AppConfig {
  databaseUrl: string;
  bootstrapSecret: string;
  appOrigin: string;
  workerUrl: string;
  workerToken: string;
  credentialEncryptionKey: string;
  accounts?: AccountConfig[];
  importAccountsOnce?: boolean;
  host?: string;
  simulation?: boolean;
  staticRoot?: string;
  dataDir?: string;
  coverFontPath?: string;
  coverFonts?: TrustedCoverFont[];
  bodyImageSources?: { origin: string; pathPrefix: string }[];
  bodyImageOwnerSources?: Record<string, { origin: string; pathPrefix: string }[]>;
  authMode?: "bootstrap" | "oauth";
  oauth?: OAuthConfig;
  /** 服务统一持有的公众号中转令牌；设置后客户只填 AppID/AppSecret，Worker 一律用它访问中转。 */
  relayPat?: string;
  /** 部署可选提供的微信 API 白名单出口 IP；未设置时由使用者在连接向导里自行填写自己的中转出口 IP。 */
  wxWhitelistIp?: string;
  /** OAuth 登录时按上游有效会员自动开通成员；默认关闭。 */
  selfProvision?: boolean;
  /** 客户可见文案的部署形态：neutral 为开源自托管默认，hosted 为线上托管部署的原有文案。 */
  copyMode?: "neutral" | "hosted";
}

// 部署密钥仅在服务端载入；旧账号文件只用于显式的一次性迁移。
export async function loadConfig(): Promise<AppConfig> {
  const required = (key: string) => {
    const value = process.env[key]?.trim();
    if (!value) throw new Error(`Missing required configuration: ${key}`);
    return value;
  };
  const auth = loadAuthConfig(process.env, validateAppOrigin(required("APP_ORIGIN")));
  const bootstrapSecret = process.env.BOOTSTRAP_SECRET?.trim() || "";
  if (auth.authMode === "bootstrap" && bootstrapSecret.length < 32) throw new Error("BOOTSTRAP_SECRET must contain at least 32 characters");
  const importAccountsOnce = process.env.IMPORT_ACCOUNTS_ONCE === "1";
  if (auth.authMode === "oauth" && importAccountsOnce) throw new Error("OAuth mode cannot import bootstrap accounts");
  const accounts: unknown = importAccountsOnce ? JSON.parse(await readFile(required("ACCOUNTS_FILE"), "utf8")) : [];
  if (!Array.isArray(accounts)) throw new Error("ACCOUNTS_FILE must contain an array");
  const ids = new Set<string>();
  for (const account of accounts) {
    if (!account || !/^[a-zA-Z0-9_.-]{1,80}$/.test(account.id) || ids.has(account.id)
      || !["label", "appId", "appSecret", "pat"].every(key => typeof account[key] === "string" && account[key].trim())) {
      throw new Error("Invalid or duplicate server-side account configuration");
    }
    ids.add(account.id);
  }
  const appOrigin = validateAppOrigin(required("APP_ORIGIN"));
  // 部署可统一持有中转令牌；未配置时由使用者在自己的中转服务上取一个 PAT 自行填写。
  const relayPat = process.env.PUBLISHING_RELAY_PAT?.trim() || undefined;
  if (auth.authMode === "oauth" && !relayPat) throw new Error("Missing required configuration: PUBLISHING_RELAY_PAT");
  if (relayPat && relayPat.length > 512) throw new Error("Invalid PUBLISHING_RELAY_PAT");
  // 可选的白名单出口 IP：只用于界面提示，未配置时由使用者填写自己中转服务的出口 IP。
  const wxWhitelistIp = process.env.PUBLISHING_WX_WHITELIST_IP?.trim() || undefined;
  // 只接受真实 IPv4 / IPv6 形状，避免把任意字符串当成白名单地址。
  if (wxWhitelistIp && !isIP(wxWhitelistIp)) throw new Error("Invalid PUBLISHING_WX_WHITELIST_IP");
  const workerUrl = new URL(required("PIPELINE_WORKER_URL"));
  if (!["http:", "https:"].includes(workerUrl.protocol)) throw new Error("Invalid PIPELINE_WORKER_URL");
  const credentialEncryptionKey = required("CREDENTIAL_ENCRYPTION_KEY");
  if (!/^[a-f\d]{64}$/i.test(credentialEncryptionKey)) throw new Error("CREDENTIAL_ENCRYPTION_KEY must be 32-byte hexadecimal");
  const host = process.env.APP_HOST?.trim() || "127.0.0.1";
  if (!["127.0.0.1", "::1", "0.0.0.0"].includes(host)) throw new Error("APP_HOST must be an explicit loopback or container bind address");
  // 客户可见文案的部署形态；开源默认中性，线上托管部署可显式切回原有措辞。
  const copyMode = process.env.PUBLISHING_COPY_MODE?.trim() || "neutral";
  if (copyMode !== "neutral" && copyMode !== "hosted") throw new Error("PUBLISHING_COPY_MODE must be neutral or hosted");
  const bodyImageSources = process.env.PUBLISHING_BODY_IMAGE_SOURCE_ORIGIN ? [{ origin: process.env.PUBLISHING_BODY_IMAGE_SOURCE_ORIGIN, pathPrefix: process.env.PUBLISHING_BODY_IMAGE_SOURCE_PREFIX || "" }] : [];
  const bodyImageOwnerSources = process.env.PUBLISHING_BODY_IMAGE_OWNER_SOURCES ? JSON.parse(process.env.PUBLISHING_BODY_IMAGE_OWNER_SOURCES) : {};
  if (!bodyImageOwnerSources || Array.isArray(bodyImageOwnerSources) || typeof bodyImageOwnerSources !== "object"
    || Object.entries(bodyImageOwnerSources).some(([owner, sources]) => !/^[a-f\d]{8}(?:-[a-f\d]{4}){3}-[a-f\d]{12}$/i.test(owner) || !Array.isArray(sources))) throw new Error("Invalid owner body image sources");
  for (const source of [...bodyImageSources, ...Object.values(bodyImageOwnerSources).flat() as { origin: string; pathPrefix: string }[]]) {
    if (!source || typeof source.origin !== "string" || typeof source.pathPrefix !== "string") throw new Error("Invalid trusted body image source");
    const url = new URL(source.origin);
    if (url.protocol !== "https:" || url.origin !== source.origin || url.username || url.password || url.port || !source.pathPrefix.startsWith("/") || !source.pathPrefix.endsWith("/") || /[%?#\\]/.test(source.pathPrefix)) throw new Error("Invalid trusted body image source");
  }
  const coverFonts: TrustedCoverFont[] = process.env.TYPESET_COVER_FONTS ? JSON.parse(process.env.TYPESET_COVER_FONTS) : [];
  if (!Array.isArray(coverFonts) || coverFonts.some(font => !font || !/^[a-zA-Z0-9_.-]{1,100}$/.test(font.id)
    || typeof font.family !== "string" || !font.family.trim() || font.family.length > 100 || typeof font.path !== "string" || !font.path.startsWith("/")
    || !/^[a-f\d]{64}$/i.test(font.sha256) || font.owners !== undefined && (!Array.isArray(font.owners) || font.owners.some(owner => !/^[a-f\d]{8}(?:-[a-f\d]{4}){3}-[a-f\d]{12}$/i.test(owner))))
    || new Set(coverFonts.map(font => font.id)).size !== coverFonts.length || new Set(coverFonts.map(font => font.family)).size !== coverFonts.length) throw new Error("Invalid trusted Typeset font registry");
  return {
    databaseUrl: required("DATABASE_URL"), bootstrapSecret, appOrigin,
    workerUrl: workerUrl.origin, workerToken: required("PIPELINE_WORKER_TOKEN"),
    accounts, importAccountsOnce, credentialEncryptionKey, host,
    simulation: process.env.PUBLISHING_TEST_MODE === "fake-worker", staticRoot: "./dist",
    dataDir: resolve(process.env.PUBLISHING_DATA_DIR?.trim() || "./data"),
    coverFontPath: process.env.TYPESET_ARTICLE_COVER_FONT_PATH?.trim() || "/usr/share/fonts/opentype/noto/NotoSansCJK-Regular.ttc",
    bodyImageSources, bodyImageOwnerSources, coverFonts, relayPat, wxWhitelistIp, copyMode,
    ...auth,
  };
}

// 登录端点只来自部署配置；模式和配置错误必须停止启动，不能回退口令登录。
export function loadAuthConfig(env: Record<string, string | undefined>, appOrigin: string): Pick<AppConfig, "authMode" | "oauth" | "selfProvision"> {
  const authMode = env.PUBLISHING_AUTH_MODE?.trim() || "bootstrap";
  if (authMode !== "bootstrap" && authMode !== "oauth") throw new Error("PUBLISHING_AUTH_MODE must be bootstrap or oauth");
  const selfProvisionValue = env.PUBLISHING_SELF_PROVISION?.trim() || "0";
  if (selfProvisionValue !== "0" && selfProvisionValue !== "1") throw new Error("PUBLISHING_SELF_PROVISION must be 0 or 1");
  if (selfProvisionValue === "1" && authMode !== "oauth") throw new Error("PUBLISHING_SELF_PROVISION requires OAuth mode");
  const fields = ["ISSUER", "PORTAL_URL", "BASE_URL", "CLIENT_ID", "CLIENT_SECRET", "REDIRECT_URI"] as const;
  const values = fields.map(field => env[`PUBLISHING_OAUTH_${field}`]?.trim() || "");
  if (authMode === "bootstrap" && values.every(value => !value)) return { authMode };
  if (values.some(value => !value)) throw new Error("Complete OAuth configuration is required");
  const [issuer, portalUrl, baseUrl, clientId, clientSecret, redirectUri] = values as [string, string, string, string, string, string];
  if (validateAppOrigin(issuer) !== issuer || validateAppOrigin(baseUrl) !== baseUrl) throw new Error("OAuth issuer and base URL must be exact trusted origins");
  const portal = new URL(portalUrl);
  if (validateAppOrigin(portal.origin) !== portal.origin || portal.username || portal.password || portal.search || portal.hash || portal.pathname !== "/oauth/authorize") throw new Error("Invalid public OAuth portal URL");
  if (redirectUri !== `${appOrigin}/api/auth/oauth/callback` || clientId.length > 255 || clientSecret.length > 1024) throw new Error("Invalid OAuth client or exact callback URI");
  return { authMode, oauth: { issuer, portalUrl, baseUrl, clientId, clientSecret, redirectUri }, ...(selfProvisionValue === "1" ? { selfProvision: true } : {}) };
}

// 信任固定部署 origin，不使用请求 Host 或 X-Forwarded-* 推断安全 Cookie。
export function validateAppOrigin(value: string) {
  const url = new URL(value);
  if (!["http:", "https:"].includes(url.protocol) || url.username || url.password || url.search || url.hash
    || url.pathname !== "/" || url.protocol === "http:" && !["127.0.0.1", "localhost", "[::1]"].includes(url.hostname)) {
    throw new Error("APP_ORIGIN must be an HTTPS origin, or an explicit HTTP loopback origin");
  }
  return url.origin;
}
