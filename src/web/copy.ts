import type { Job } from "./api";
// 客户可见文案的唯一来源，按部署形态分流。
//
// 开源自托管部署默认 neutral：不出现任何私有品牌、私有产品名或会员体系用语。
// 线上托管部署设置 PUBLISHING_COPY_MODE=hosted 后沿用原有措辞与续期指引，
// 保证既有用户的登录与到期提示不变。
//
// 服务端通过 /api/auth/options 与 /api/auth/session 下发形态，前端据此取文案。

export type CopyMode = "neutral" | "hosted";

let current: CopyMode = "neutral";

/** 只接受两种取值；未知或缺失一律按开源自托管的中性文案处理。 */
export function setCopyMode(value: unknown): void {
  current = value === "hosted" ? "hosted" : "neutral";
}

export function getCopyMode(): CopyMode {
  return current;
}

/** 按部署形态二选一。 */
export function pick<T>(neutral: T, hosted: T): T {
  return current === "hosted" ? hosted : neutral;
}

/** 接口错误的客户可见说法。 */
export const ERROR_TEXT: Record<string, string> = {
  unauthorized: "登录已过期，请重新登录。", invalid_credentials: "访问口令不正确。",
  access_denied: "当前账号还没有开通使用权限，请联系作者。",
  access_expired: "使用期已到。请联系作者续期后重新登录，文章都还在。",
  bootstrap_disabled: "请使用统一账号登录。",
  oauth_unavailable: "登录服务暂未就绪，请稍后再试或联系作者。",
  revision_conflict: "这篇文章在别处有了更新。你的输入还在，请刷新后再试。",
  worker_result_unknown: "结果暂时无法确认。请先到公众号后台草稿箱看看是否已经存入，不要重复发布。",
  worker_unavailable: "发布服务暂时不可用，请稍后再试。",
  worker_conflict: "这次操作与正在进行的发布冲突，请稍后刷新再试。",
  invalid_account: "请选择一个可用的公众号。", empty_body: "正文还是空的，先写点内容吧。",
  invalid_document: "标题不能为空，正文不超过 2MB。",
  execution_environment_mismatch: "这条记录属于另一套环境，只能在原环境查看。",
  invalid_account_fields: "请填写公众号名称、AppID 和 AppSecret；未由服务统一配置中转令牌时还需填写中转访问令牌。修改时留空的密钥会保持不变。",
  account_app_id_immutable: "AppID 不能修改；如果是另一个公众号，请添加新的连接。",
  account_already_exists: "这个公众号已经连接过了，可以直接在原连接上修改。",
  account_version_conflict: "公众号连接刚刚有了变化，请刷新后再试。",
  account_disabled: "这个公众号连接已停用，请换一个公众号或重新启用。",
  account_app_id_reserved: "这个公众号已被其他成员连接。如需转移，请联系作者。",
  account_authorization_released: "这个公众号的授权已变更，只能查看历史记录。",
  account_quota_exceeded: "最多可以连接 5 个公众号（含已停用的）。",
  credential_quota_exceeded: "这个连接的密钥修改次数已达上限，请联系作者处理。",
  asset_quota_exceeded: "图片空间已满（128MB 或 200 张）。文章和已有图片都还在，请联系作者扩容。",
  job_retained_quota_exceeded: "待处理的发布和待确认的预览已有 10 个。先确认或放弃几条预览，再继续发布。",
  job_active_quota_exceeded: "同时进行的发布已满，请等当前发布完成后再试。",
  operation_busy: "上一个上传或预览还在处理，请稍等片刻。",
  preview_discarded: "这份预览已放弃，不能再存入草稿箱。",
  preview_expired: "这份预览超过 7 天未确认，已自动关闭。修改文章后重新发布即可。",
  preview_already_confirmed: "这份预览已经确认发布，不能放弃。",
  preview_not_ready: "预览还在生成或已开始发布，暂时不能放弃。",
  preview_pruned: "这份预览已超过保留期，内容已清理；发布结果仍然保留。",
  preview_not_found: "找不到这份预览。",
  preview_confirmation_conflict: "预览内容有变化，请重新打开预览再确认。",
  worker_preview_discard_unsupported: "发布服务暂不支持放弃预览；预览会在 7 天后自动关闭。",
  worker_lookup_unsupported: "发布服务需要升级，暂时无法发布，请联系作者。",
  worker_preview_unsupported: "发布服务需要升级，暂时无法生成预览，请联系作者。",
  worker_article_style_unsupported: "发布服务需要升级才能使用这套排版，请联系作者。",
  worker_cover_unsupported: "发布服务需要升级才能使用这个封面，请联系作者。",
  worker_asset_unavailable: "图片传输失败，还没有开始发布，请重试。",
  worker_artifact_unavailable: "预览内容暂时无法读取，请稍后重新打开。",
  body_image_requires_preview: "含图片的文章需要先预览，再存入草稿箱。",
  cover_requires_preview: "自定义封面需要先预览，再存入草稿箱。",
  style_requires_preview: "这套排版需要先预览，再存入草稿箱。",
  job_operation_conflict: "这一版文章已有一条发布记录。修改文章后即可重新发布。",
  credential_decryption_failed: "公众号密钥无法读取，请联系作者处理。",
  invalid_configuration: "请选择已保存的排版和封面。",
  configuration_failed: "排版和封面没有保存成功，你的修改还在，请重试。",
  invalid_style: "这套排版的参数有误，请恢复默认后重新调整。",
  style_revision_conflict: "这套排版刚在别处被修改过。你的调整还在，可以另存一套新排版。",
  style_not_found: "找不到这套排版，请重新选择。",
  invalid_style_reference: "请选择一套已保存的排版。",
  invalid_style_snapshot: "这次发布保存的排版有误，请重新发布。",
  invalid_cover_template: "封面设置有误，请换一个封面样式重试。",
  cover_revision_conflict: "这个封面刚在别处被修改过。你的调整还在，可以另存一个新封面。",
  cover_template_not_found: "找不到这个封面，请重新选择。",
  invalid_cover_reference: "请选择一个已保存的封面。",
  invalid_cover_image: "请上传 PNG、JPEG 或 WebP 图片。",
  cover_image_too_large: "图片不能超过 5MB。",
  cover_image_dimensions: "图片尺寸过大，请压缩后再上传。",
  cover_asset_not_found: "找不到这张封面图片，请重新上传。",
  cover_asset_unavailable: "封面图片读取失败，请重新上传。",
  cover_font_unavailable: "封面字体暂不可用，请联系作者。",
  cover_preview_failed: "标题太长放不下，请缩短标题或调小字号。",
  invalid_cover_preview: "请先填写标题。",
  invalid_cover_snapshot: "这次发布保存的封面有误，请重新发布。",
  invalid_body_image: "正文图片只支持 PNG、JPEG 和 WebP，暂不支持 GIF。",
  body_image_too_large: "单张图片不能超过 5MB。",
  body_image_dimensions: "图片尺寸过大，请压缩后再上传。",
  body_asset_not_found: "有一张图片找不到了，请重新上传。",
  body_asset_unavailable: "有一张图片读取失败，请重新上传。",
  body_image_limits: "每篇最多 20 张图片，合计不超过 40MB。",
  body_image_requires_replacement: "正文里有外部链接的图片，请先一键转存或重新上传。",
  body_image_import_failed: "图片转存失败，正文没有改动。请重新上传这几张图片。",
  invalid_article_snapshot: "这次发布的内容校验失败，请重新发布。",
};

/** 线上托管部署沿用的原文案；未列出的错误两套文案相同。 */
export const ERROR_TEXT_HOSTED: Record<string, string> = {
  access_denied: "当前账号还没有开通使用权限，请联系你的顾问。",
  access_expired: "使用期已到。请在 Nezus 兑换新的邀请码后重新登录，文章都还在。",
  oauth_unavailable: "登录服务暂未就绪，请稍后再试或联系顾问。",
  account_app_id_reserved: "这个公众号已被其他成员连接。如需转移，请联系顾问。",
  credential_quota_exceeded: "这个连接的密钥修改次数已达上限，请联系顾问处理。",
  asset_quota_exceeded: "图片空间已满（128MB 或 200 张）。文章和已有图片都还在，请联系顾问扩容。",
  worker_lookup_unsupported: "发布服务需要升级，暂时无法发布，请联系顾问。",
  worker_preview_unsupported: "发布服务需要升级，暂时无法生成预览，请联系顾问。",
  worker_article_style_unsupported: "发布服务需要升级才能使用这套排版，请联系顾问。",
  worker_cover_unsupported: "发布服务需要升级才能使用这个封面，请联系顾问。",
  credential_decryption_failed: "公众号密钥无法读取，请联系顾问处理。",
  cover_font_unavailable: "封面字体暂不可用，请联系顾问。",
};

/** 错误码对应的客户可见说法；未知错误码返回 undefined。 */
export function errorText(code: string | null | undefined): string | undefined {
  if (!code) return undefined;
  return current === "hosted" ? (ERROR_TEXT_HOSTED[code] ?? ERROR_TEXT[code]) : ERROR_TEXT[code];
}

/** 发布失败的常见原因与处理建议；whitelistIp 为部署提供的白名单出口 IP，未知时只说「本服务的出口 IP」。 */
export function failureAdvice(hint: Job["errorHint"], whitelistIp?: string | null): string | undefined {
  switch (hint) {
    case "invalid_appid": return "微信不认这个 AppID。请到公众号后台「设置与开发 → 基本配置」核对 AppID，在「公众号」页重新填写连接。";
    case "invalid_secret": return "AppSecret 不正确或已被重置。请到公众号后台「设置与开发 → 基本配置」重置并复制新的 AppSecret，在「公众号」页更新连接。";
    case "ip_whitelist": return `服务器的出口 IP 不在公众号的白名单里。请在公众号后台「设置与开发 → 基本配置」，把${whitelistIp ? ` ${whitelistIp} ` : "本服务的出口 IP "}加入 IP 白名单后重试。`;
    case "relay_unauthorized": return "发布服务连不上微信中转：中转令牌无效或已过期。请重新生成中转令牌并更新到配置里，再重启服务。";
    case "relay_unreachable": return "发布服务连不上微信中转。请检查中转服务是否在运行、地址是否填对，再重试。";
    default: return undefined;
  }
}

/** 登录页从地址栏读到的失败原因。 */
export const LOGIN_REASON_TEXT: Record<string, string> = {
  access_denied: "这个账号还没有开通使用权限，请联系作者。",
  membership_required: "这个账号还没有开通使用权限，请联系作者开通后再登录。",
  access_expired: "使用期已到，请联系作者续期。你的文章都还在。",
  oauth_failed: "登录没有完成或已超时，请重新登录。",
};

/** 线上托管部署沿用的原文案。 */
export const LOGIN_REASON_TEXT_HOSTED: Record<string, string> = {
  access_denied: "这个账号还没有开通使用权限，请联系邀请你的顾问。",
  membership_required: "需要有效的邀请会员才能使用。请先在 Nezus 兑换邀请码，再回来登录（注册赠送的试用不包含本服务）。",
  access_expired: "使用期已到，请联系顾问续期。你的文章都还在。",
};

export function loginReasonText(code: string): string {
  const hosted = LOGIN_REASON_TEXT_HOSTED[code];
  return current === "hosted" ? (hosted ?? LOGIN_REASON_TEXT[code] ?? LOGIN_REASON_TEXT.oauth_failed!) : (LOGIN_REASON_TEXT[code] ?? LOGIN_REASON_TEXT.oauth_failed!);
}

/** 人工支持入口。 */
export const SUPPORT = {
  neutral: { title: "联系作者", contact: "微信：akairos", note: "添加作者微信并发送公众号名称与部署情况，作者会协助你完成连接。" },
  hosted: { title: "你的专属顾问", contact: "微信：akairos", note: "添加顾问微信并发送公众号名称，几分钟内帮你完成连接。" },
};

export function supportCopy() {
  return SUPPORT[current];
}

/** 登录页标题区与按钮文案。 */
export const LOGIN_COPY = {
  neutral: {
    bootstrapSubtitle: "使用管理员配置的口令登录",
    oauthSubtitle: "使用统一身份登录",
    oauthButton: "使用统一身份登录",
    foot: "还没有访问口令？请向部署管理员索取，或联系作者协助。",
  },
  hosted: {
    // 线上托管部署是 oauth 模式，原文案无条件渲染，这里原样保留。
    bootstrapSubtitle: "使用 Nezus 账号登录",
    oauthSubtitle: "使用 Nezus 账号登录",
    oauthButton: "使用 Nezus 账号登录",
    foot: "还没有账号？请联系邀请你的顾问获取邀请码。",
  },
};

export function loginCopy() {
  return LOGIN_COPY[current];
}

/** 使用期即将到期时的续期说明。 */
export const RENEWAL_TEXT = {
  neutral: "使用期即将到期。续期请联系作者处理后重新登录即可，文章都会保留。",
  hosted: "使用期即将到期。续期请联系顾问获取新的邀请码，在 Nezus 兑换后重新登录即可，文章都会保留。",
};

export function renewalText() {
  return RENEWAL_TEXT[current];
}
