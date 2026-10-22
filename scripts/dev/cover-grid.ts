// 内置封面对比图：按服务端同一路径（校验 → 解析 → 自动缩字排版 → PNG）渲染全部预设，两列排版。
// 用法：TYPESET_ARTICLE_COVER_FONT_PATH=/path/NotoSansCJK-Regular.ttc bun scripts/dev/cover-grid.ts ["标题"] [输出.png]
import { writeFileSync } from "node:fs";
import { createCanvas, loadImage } from "@napi-rs/canvas";
import { renderPageToPng } from "@akairos/typeset-studio";
import { resolveHostTemplateConfig } from "@akairos/typeset-studio/server-config";
import { ARTICLE_COVER_FONT } from "@akairos/typeset-studio/cover";
import { ARTICLE_COVER_PRESETS } from "../../src/server/services/cover-presets";
import { fitCoverTitle } from "../../src/server/services/cover-store";
import { coverDecorBytes } from "../../src/server/services/cover-decor";
import { registerTemplateFonts, validateTypesetTemplateConfig } from "../../src/server/services/template-config";

const fontPath = process.env.TYPESET_ARTICLE_COVER_FONT_PATH;
if (!fontPath) throw new Error("Set TYPESET_ARTICLE_COVER_FONT_PATH");
const alias = (await registerTemplateFonts([{ ...ARTICLE_COVER_FONT, path: fontPath }])).get(ARTICLE_COVER_FONT.family)!;
const title = process.argv[2] || "2026 年内容创业者的三个增长杠杆";
const W = 1340, H = 400, gap = 30;
const sheet = createCanvas(W * 2 + gap * 3, Math.ceil(ARTICLE_COVER_PRESETS.length / 2) * (H + 60) + gap);
const ctx = sheet.getContext("2d"); ctx.fillStyle = "#d6d3d1"; ctx.fillRect(0, 0, sheet.width, sheet.height);
for (const [index, preset] of ARTICLE_COVER_PRESETS.entries()) {
  const config = resolveHostTemplateConfig(validateTypesetTemplateConfig(structuredClone(preset)));
  config.typography = { headingFont: alias, bodyFont: alias };
  config.images = (config.images || []).map(image => ({ ...image, src: `data:image/png;base64,${coverDecorBytes(image.src.slice("asset:".length)).toString("base64")}` }));
  const result = await fitCoverTitle(config, title);
  const image = await loadImage(await renderPageToPng(result.pages[0]!, result.canvasSpec, result.config, 1));
  const x = gap + (index % 2) * (W + gap), y = gap + Math.floor(index / 2) * (H + 60);
  ctx.fillStyle = "#1c1917"; ctx.font = "22px sans-serif"; ctx.fillText(preset.name, x, y + 20);
  ctx.drawImage(image, x, y + 32, W, H);
}
const output = process.argv[3] || "test-output/cover-grid.png";
writeFileSync(output, await sheet.encode("png"));
console.log(output);
