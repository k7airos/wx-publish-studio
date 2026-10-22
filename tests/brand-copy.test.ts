import { expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import {
  discoverBrandNames,
  extractBrandNames,
  findBrandResidue,
  listTextFiles,
  neutralizeBrandNames,
  type BrandDiscovery,
} from "../scripts/brand-copy";

const root = join(import.meta.dir, "..");

/** 构造一份发现结果，用于单测替换规则本身。 */
function discoveryOf(tokens: string[], bare: string[] = tokens): BrandDiscovery {
  return {
    tokens,
    bareTokens: new Set(bare),
    scannedPackages: [],
    missingPackages: [],
    scannedFiles: 0,
  };
}

test("结构型默认文案能发现名称，并区分裸形式出现", () => {
  const found = extractBrandNames(
    [
      'footerText: "公众号 · 示例名称",',
      "> 💡 欢迎关注公众号「示例名称」，星标不错过每次更新。",
      'name: "🌸 示例主题 (示例名称经典标配)",',
    ].join("\n"),
  );
  expect(found.tokens).toEqual(["示例名称"]);
  expect(found.bare).toEqual(["示例名称"]);
});

test("转义形式的中文同样能被发现", () => {
  const found = extractBrandNames('footerText: "\\u516c\\u4f17\\u53f7 \\u00b7 \\u793a\\u4f8b\\u540d\\u79f0"');
  expect(found.tokens).toEqual(["示例名称"]);
});

test("中性化只改品牌位置，正常文案原样保留", () => {
  const sample = [
    "请到公众号后台草稿箱查看，正文排版与封面不受影响。",
    "最多可以连接 5 个公众号（含已停用的）。",
    "公众号 · 示例名称",
    "🌸 示例主题 (示例名称经典标配)",
    "💡 欢迎关注公众号「示例名称」，星标不错过每次更新。",
  ].join("\n");
  const outcome = neutralizeBrandNames(sample, discoveryOf(["示例名称"]));
  expect(outcome.text).toContain("请到公众号后台草稿箱查看，正文排版与封面不受影响。");
  expect(outcome.text).toContain("最多可以连接 5 个公众号（含已停用的）。");
  expect(outcome.text).not.toContain("示例名称");
  expect(outcome.text).toContain("你的公众号");
  expect(outcome.sites).toBe(3);
  expect(findBrandResidue(outcome.text, discoveryOf(["示例名称"]))).toEqual([]);
});

test("产物里的转义形式与混写形式都会被中性化", () => {
  const discovery = discoveryOf(["示例名称"], []);
  const escaped = neutralizeBrandNames('footerText: "\\u516c\\u4f17\\u53f7 \\u00b7 \\u793a\\u4f8b\\u540d\\u79f0"', discovery);
  expect(escaped.text).toBe('footerText: "你的公众号"');
  const mixed = neutralizeBrandNames('"\\u516c\\u4f17\\u53f7 · \\u793a\\u4f8b\\u540d\\u79f0"', discovery);
  expect(mixed.text).toBe('"你的公众号"');
});

test("上游包产物可被发现，且本仓库自有文件不含这些名称", () => {
  const discovery = discoverBrandNames(root);
  expect(discovery.missingPackages).toEqual([]);
  expect(discovery.tokens.length).toBeGreaterThan(0);
  for (const file of listTextFiles(join(root, "src"))) {
    const text = readFileSync(file, "utf8");
    for (const token of discovery.tokens) expect(text).not.toContain(token);
  }
});

test("本仓库自有文件不含「公众号 + 分隔符/引号」的品牌结构", () => {
  for (const file of listTextFiles(join(root, "src"))) {
    const text = readFileSync(file, "utf8");
    expect(text).not.toMatch(/公众号\s*[·•・「『【]/);
  }
});
