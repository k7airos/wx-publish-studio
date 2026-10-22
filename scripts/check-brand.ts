#!/usr/bin/env bun
// 扫描 dist/ 是否还有上游默认文案残留。
// 规则与构建期完全一致（scripts/brand-copy.ts），不含任何具体品牌名。
// 有残留时非零退出，并打印可操作提示。
import { existsSync, readFileSync } from "node:fs";
import { join, relative } from "node:path";
import { discoverBrandNames, findBrandResidue, listTextFiles } from "./brand-copy";

const root = join(import.meta.dir, "..");
const distDir = join(root, "dist");

if (!existsSync(distDir)) {
  console.error("找不到 dist/ 目录，请先执行 bun run build 再自查。");
  process.exit(1);
}

const discovery = discoverBrandNames(root);
if (discovery.missingPackages.length > 0) {
  console.error(
    `未能发现上游默认文案（缺少上游包：${discovery.missingPackages.join("、")}），无法判断产物是否干净。` +
      `请先执行 bun install --frozen-lockfile。`,
  );
  process.exit(1);
}

const findings: Array<{ file: string; detail: string }> = [];
const files = listTextFiles(distDir);
for (const file of files) {
  const text = readFileSync(file, "utf8");
  for (const residue of findBrandResidue(text, discovery)) {
    findings.push({ file: relative(root, file), detail: residue.detail });
  }
}

if (findings.length > 0) {
  console.error(`dist/ 检出 ${findings.length} 处上游默认文案残留：`);
  for (const finding of findings) console.error(`  ${finding.file}：${finding.detail}`);
  console.error("请复核 scripts/brand-copy.ts 的中性化规则后重新执行 bun run build。");
  process.exit(1);
}

console.log(
  `dist/ 未检出上游默认文案残留：已扫描 ${files.length} 个文件，` +
    `上游默认名称 ${discovery.tokens.length} 个，扫描包 ${discovery.scannedPackages.join("、")}。`,
);
