import { createHash } from "node:crypto";
import { readFile } from "node:fs/promises";
import { fileURLToPath } from "node:url";
import { ARTICLE_COVER_FONT, DEFAULT_ARTICLE_COVER_CONTROLS } from "@akairos/typeset-studio/cover";
import { createCoverSnapshot } from "@akairos/pipeline/cover-snapshot";
import { createArticleStyleSnapshot } from "@akairos/pipeline/article-style";

// 宿主内置公共示例，与本人 runtime、账号或素材表完全无关。
export const NEUTRAL_COVER_ID = "00000000-0000-4000-8000-000000000071";
const assetId = "00000000-0000-4000-8000-000000000072";
export const NEUTRAL_COVER_PATH = fileURLToPath(new URL("../assets/neutral-cover.jpg", import.meta.url));
export const neutralArticleStyle = createArticleStyleSnapshot({
  schemaVersion: 1, engineVersion: 1, id: "publishing-neutral-v1", name: "清晰阅读", version: "1.0.0", css: "",
  editorVars: { "--brand": "#47675a" }, exportTheme: { bodyFontSize: "16px", bodyLineHeight: "1.84", primaryColor: "#47675a", h2Color: "#47675a" }, syntaxPresets: { h2: "pillar" },
}, "publishing-neutral-v1", 1);

export async function neutralCoverSnapshot() {
  const bytes = await readFile(NEUTRAL_COVER_PATH);
  return createCoverSnapshot({ id: NEUTRAL_COVER_ID, revision: 1, name: "清晰阅读公共封面", controls: { ...DEFAULT_ARTICLE_COVER_CONTROLS },
    asset: { id: assetId, sha256: createHash("sha256").update(bytes).digest("hex"), contentType: "image/jpeg", dataBase64: bytes.toString("base64") },
    font: { id: ARTICLE_COVER_FONT.id, sha256: ARTICLE_COVER_FONT.sha256 } });
}
