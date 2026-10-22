import { expect, test } from "bun:test";
import { dirname } from "node:path";
import { createCanvas, loadImage } from "@napi-rs/canvas";
import { renderPageToPng } from "@akairos/typeset-studio";
import { resolveHostTemplateConfig } from "@akairos/typeset-studio/server-config";
import { ARTICLE_COVER_FONT } from "@akairos/typeset-studio/cover";
import { ARTICLE_COVER_PRESETS } from "../src/server/services/cover-presets";
import { COVER_DECOR, coverDecorBytes } from "../src/server/services/cover-decor";
import { createHash } from "node:crypto";
import { existsSync } from "node:fs";
import { fitCoverTitle } from "../src/server/services/cover-store";
import { registerTemplateFonts, templateCatalog, validateTypesetTemplateConfig } from "../src/server/services/template-config";
import type { AppConfig } from "../src/server/config";

const fontPath = process.env.TYPESET_ARTICLE_COVER_FONT_PATH;
if (!fontPath) throw new Error("Cover preset test requires TYPESET_ARTICLE_COVER_FONT_PATH");
const LONG_TITLE = "当所有人都在卷 AI 工具时，真正拉开差距的是你提问的能力，以及把答案变成行动的执行力和长期复盘的耐心";

test("studio registers fonts in the same native canvas that Typeset draws with", () => {
  // 两份 @napi-rs/canvas 时，可信字体只注册到其中一份，排版测量与绘制字体不一致，标题会越过裁切线。
  const typesetRoot = dirname(Bun.resolveSync("@akairos/typeset-studio/package.json", import.meta.dir));
  expect(Bun.resolveSync("@napi-rs/canvas", typesetRoot)).toBe(Bun.resolveSync("@napi-rs/canvas", import.meta.dir));
});

test("built-in cover decorations are immutable files matching their manifest", () => {
  const ids = new Set<string>();
  for (const [name, entry] of Object.entries(COVER_DECOR)) {
    // 每张底图都保留 SVG 源文件；PNG 与清单 sha256 一致，id 不重复且落在保留区间。
    expect(existsSync(new URL(`../src/server/assets/cover-decor/${name}.svg`, import.meta.url))).toBe(true);
    expect(createHash("sha256").update(coverDecorBytes(entry.id)).digest("hex")).toBe(entry.sha256);
    expect([entry.width, entry.height]).toEqual([3350, 1000]);
    expect(entry.id).toMatch(/^00000000-0000-4000-8000-0000000001[0-9a-f]{2}$/);
    expect(ids.has(entry.id)).toBe(false); ids.add(entry.id);
  }
  for (const preset of ARTICLE_COVER_PRESETS) expect(ids.has(preset.images![0]!.src.slice("asset:".length))).toBe(true);
});

test("catalog offers only crop-safe article covers", () => {
  const { presets } = templateCatalog({ coverFontPath: fontPath } as AppConfig, "00000000-0000-4000-8000-000000000001");
  const covers = presets.filter(preset => preset.slot === "article_cover");
  expect(covers.map(preset => preset.id)).toEqual(ARTICLE_COVER_PRESETS.map(preset => preset.id));
  for (const preset of covers) {
    expect(preset.aspectRatio).toBe("wechat-cover-2.35");
    // 标题区右边界落在 2.35:1 头图内（3350 宽画布左侧 2350px）。
    expect(3350 - preset.algorithm.safeArea.right).toBeLessThanOrEqual(2350 - 200);
  }
});

test("every preset fits a 64-character title inside the 2.35:1 header crop", async () => {
  const aliases = await registerTemplateFonts([{ ...ARTICLE_COVER_FONT, path: fontPath }]);
  const alias = aliases.get(ARTICLE_COVER_FONT.family)!;
  for (const preset of ARTICLE_COVER_PRESETS) {
    for (const title of [LONG_TITLE.slice(0, 64), "私域"]) {
      const config = resolveHostTemplateConfig(validateTypesetTemplateConfig(structuredClone(preset)));
      config.typography = { headingFont: alias, bodyFont: alias };
      config.images = config.images!.map(image => ({ ...image, src: `data:image/png;base64,${coverDecorBytes(image.src.slice(6)).toString("base64")}` }));
      const result = await fitCoverTitle(config, title);
      expect(result.pageCount).toBe(1);
      expect(result.pages[0]!.lines.map(line => line.text).join("").replace(/\s/g, "")).toBe(title.replace(/\s/g, ""));
      if (preset.id !== "studio_cover_poster_editorial" || title.length < 64) continue;
      // 实际像素校验：深色标题不得越过版心右界（2110px），这条带在版心与边框之间，只有浅色底纹。
      const image = await loadImage(await renderPageToPng(result.pages[0]!, result.canvasSpec, result.config, 1));
      const canvas = createCanvas(image.width, image.height); const context = canvas.getContext("2d"); context.drawImage(image, 0, 0);
      const pixels = context.getImageData(2125, 200, 90, 600).data;
      let ink = 0; for (let index = 0; index < pixels.length; index += 4) if (pixels[index]! < 100) ink++;
      expect(ink).toBe(0);
    }
  }
}, 60_000);
