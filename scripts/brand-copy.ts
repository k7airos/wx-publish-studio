/**
 * 分发产物的品牌中性化规则（通用实现，**不含任何具体品牌名**）。
 *
 * 上游编辑器 / 排版 / 插件包的默认主题与插件示例里带有示例公众号名称。
 * 本项目不使用这些默认文案，但它们会随前端产物一起分发，
 * 因此构建期按通用规则自动发现这些名称并中性化；一旦仍有残留，构建直接失败。
 *
 * 规则与具体品牌无关：
 * 1. 从上游产物的「公众号 + 分隔符/引号 + 名称」结构里发现名称；
 * 2. `公众号 · 名称`、`公众号「名称」` 整段替换为中性占位文案；
 * 3. 上游产物里以裸名称出现过（不带结构前缀）时，裸名称也一并替换；
 * 4. 替换后产物里不允许再出现任何名称或「公众号 + 分隔符/引号」结构。
 */
import { existsSync, readFileSync, readdirSync, statSync } from "node:fs";
import { dirname, join, resolve } from "node:path";

/** 中性化后使用的占位文案。 */
export const NEUTRAL_BRAND_TEXT = "你的公众号";

/** 需要扫描的上游包：它们的产物会进入本项目的前端分发产物。 */
export const UPSTREAM_PACKAGES = ["@akairos/myno", "@akairos/typeset-studio", "@akairos/milkdown-article-plugins"] as const;

/** 上游示例名称前面的结构词。 */
const STRUCTURE_WORD = "公众号";

/** 名称与结构词之间的分隔符。 */
const SEPARATORS = ["·", "•", "・"] as const;

/** 名称与结构词之间的装饰性引号对：属于品牌排版写法。 */
const BRACKET_PAIRS: ReadonlyArray<readonly [string, string]> = [
  ["「", "」"],
  ["『", "』"],
  ["【", "】"],
];

/**
 * 名称与结构词之间的括号对：中文里括号常用于普通说明（例如「公众号（含已停用的）」），
 * 所以发现与替换都覆盖它，但残留检查不把它当作品牌结构。
 */
const PAREN_PAIRS: ReadonlyArray<readonly [string, string]> = [
  ["（", "）"],
  ["(", ")"],
];

/** 名称里不允许出现的字符，避免把后续句子一起吃进来。 */
const NAME_STOP = "\\s\"'`，,。、；;！!？?（）()【】\\[\\]「」『』";

/** 上游产物里的单文件扫描上限，避免把超大资源整份读进内存。 */
const MAX_SCANNED_FILE_BYTES = 8 * 1024 * 1024;

const REGEXP_SPECIAL = /[.*+?^${}()|[\]\\]/g;

function escapeRegExp(value: string): string {
  return value.replace(REGEXP_SPECIAL, "\\$&");
}

/** 把 `\uXXXX` 转义还原成原字符，便于在解码后的文本上做结构匹配。 */
export function decodeUnicodeEscapes(text: string): string {
  return text.replace(/\\u([0-9a-fA-F]{4})/g, (_match, hex: string) => String.fromCharCode(Number.parseInt(hex, 16)));
}

/** 单个字符在产物里可能的写法：原字符，或 `\uXXXX` 转义。 */
function charAtom(ch: string): string {
  const code = ch.codePointAt(0)!;
  if (code < 0x80) return escapeRegExp(ch);
  const forms = [escapeRegExp(ch)];
  if (code <= 0xffff) {
    forms.push(escapeRegExp(`\\u${code.toString(16).padStart(4, "0")}`));
  } else {
    const offset = code - 0x10000;
    const high = (0xd800 + (offset >> 10)).toString(16).padStart(4, "0");
    const low = (0xdc00 + (offset & 0x3ff)).toString(16).padStart(4, "0");
    forms.push(escapeRegExp(`\\u${high}\\u${low}`));
  }
  return `(?:${forms.join("|")})`;
}

/** 一段字面量在产物里可能的写法（逐字符兼容转义形式）。 */
function flexibleLiteral(value: string): string {
  return [...value].map(charAtom).join("");
}

/** 一组字符在产物里可能的写法，用作字符组。 */
function charClassAtom(chars: readonly string[]): string {
  const forms: string[] = [];
  for (const ch of chars) {
    forms.push(escapeRegExp(ch));
    const code = ch.codePointAt(0)!;
    if (code <= 0xffff) forms.push(escapeRegExp(`\\u${code.toString(16).padStart(4, "0")}`));
  }
  return `(?:${forms.join("|")})`;
}

/** 残留检查里的结构词后缀：只认品牌排版写法（分隔符 / 装饰性引号）。 */
function structureTailAtom(): string {
  return charClassAtom([...SEPARATORS, ...BRACKET_PAIRS.map(pair => pair[0])]);
}

/** 发现用的结构正则：只在解码后的文本上匹配。 */
function discoveryPatterns(): RegExp[] {
  const name = `[^${NAME_STOP}]`;
  return [
    new RegExp(`${STRUCTURE_WORD}\\s*[${SEPARATORS.join("")}]\\s*(${name}{2,24})`, "g"),
    ...[...BRACKET_PAIRS, ...PAREN_PAIRS].map(([open, close]) => new RegExp(`${STRUCTURE_WORD}\\s*${escapeRegExp(open)}\\s*(${name}{2,24}?)\\s*${escapeRegExp(close)}`, "g")),
  ];
}

/** 把文本里的结构片段整段抹掉，剩下的部分用于判断名称是否还以裸形式出现。 */
export function stripBrandStructures(text: string): string {
  const decoded = decodeUnicodeEscapes(text);
  let remainder = decoded;
  for (const pattern of discoveryPatterns()) remainder = remainder.replace(new RegExp(pattern.source, "g"), " ");
  return remainder;
}

/** 从一段文本里发现上游默认名称，以及哪些名称还以裸形式出现过。 */
export interface ExtractedBrandNames {
  /** 结构里出现过的名称。 */
  tokens: string[];
  /** 其中在结构之外也以裸形式出现过的名称。 */
  bare: string[];
}

export function extractBrandNames(text: string): ExtractedBrandNames {
  const decoded = decodeUnicodeEscapes(text);
  const tokens = new Set<string>();
  for (const pattern of discoveryPatterns()) {
    for (const match of decoded.matchAll(pattern)) {
      const name = match[1]?.trim();
      if (name) tokens.add(name);
    }
  }
  const remainder = stripBrandStructures(text);
  const bare = [...tokens].filter(token => remainder.includes(token));
  return { tokens: [...tokens], bare };
}

export interface BrandDiscovery {
  /** 发现到的名称，按长度降序（长名称先替换，避免短名称先命中）。 */
  tokens: string[];
  /** 需要做裸名称替换的名称集合。 */
  bareTokens: Set<string>;
  /** 实际扫描到的上游包。 */
  scannedPackages: string[];
  /** 找不到的上游包。 */
  missingPackages: string[];
  /** 扫描过的文件数。 */
  scannedFiles: number;
}

/** 在 node_modules 里向上查找某个包。 */
function resolvePackageDir(rootDir: string, pkg: string): string | null {
  let dir = resolve(rootDir);
  for (let depth = 0; depth < 8; depth += 1) {
    const candidate = join(dir, "node_modules", pkg);
    if (existsSync(candidate)) return candidate;
    const parent = dirname(dir);
    if (parent === dir) break;
    dir = parent;
  }
  return null;
}

/** 递归列出目录下的文件（跳过 source map 与二进制文件）。 */
export function listTextFiles(dir: string): string[] {
  const files: string[] = [];
  const walk = (current: string) => {
    for (const entry of readdirSync(current, { withFileTypes: true })) {
      const path = join(current, entry.name);
      if (entry.isDirectory()) walk(path);
      else if (entry.isFile() && !entry.name.endsWith(".map")) {
        if (statSync(path).size <= MAX_SCANNED_FILE_BYTES) files.push(path);
      }
    }
  };
  walk(dir);
  return files;
}

/** 扫描上游包产物，自动发现其中的默认名称。 */
export function discoverBrandNames(rootDir: string): BrandDiscovery {
  const tokens = new Set<string>();
  const bareTokens = new Set<string>();
  const scannedPackages: string[] = [];
  const missingPackages: string[] = [];
  const files: string[] = [];
  let scannedFiles = 0;
  for (const pkg of UPSTREAM_PACKAGES) {
    const pkgDir = resolvePackageDir(rootDir, pkg);
    const distDir = pkgDir ? join(pkgDir, "dist") : "";
    if (!pkgDir || !existsSync(distDir)) {
      missingPackages.push(pkg);
      continue;
    }
    scannedPackages.push(pkg);
    for (const file of listTextFiles(distDir)) {
      let text: string;
      try {
        text = readFileSync(file, "utf8");
      } catch {
        continue;
      }
      scannedFiles += 1;
      files.push(file);
      for (const token of extractBrandNames(text).tokens) tokens.add(token);
    }
  }
  // 第二遍：名称可能在另一个文件里以裸形式出现（例如主题标签的括号说明），
  // 所以要在已知全部名称之后再回扫一遍结构之外的部分。
  if (tokens.size > 0) {
    for (const file of files) {
      let remainder: string;
      try {
        remainder = stripBrandStructures(readFileSync(file, "utf8"));
      } catch {
        continue;
      }
      for (const token of tokens) if (remainder.includes(token)) bareTokens.add(token);
    }
  }
  return {
    tokens: [...tokens].sort((a, b) => b.length - a.length || a.localeCompare(b)),
    bareTokens,
    scannedPackages,
    missingPackages,
    scannedFiles,
  };
}

export interface NeutralizeOutcome {
  text: string;
  /** 被中性化的位置数量。 */
  sites: number;
}

/** 按通用规则把产物里的上游默认名称中性化。 */
export function neutralizeBrandNames(text: string, discovery: BrandDiscovery): NeutralizeOutcome {
  let out = text;
  let sites = 0;
  for (const token of discovery.tokens) {
    const name = flexibleLiteral(token);
    const structured = new RegExp(`${flexibleLiteral(STRUCTURE_WORD)}\\s*${charClassAtom(SEPARATORS)}\\s*${name}`, "g");
    out = out.replace(structured, () => {
      sites += 1;
      return NEUTRAL_BRAND_TEXT;
    });
    const quoted = new RegExp(
      `${flexibleLiteral(STRUCTURE_WORD)}\\s*(?:${[...BRACKET_PAIRS, ...PAREN_PAIRS].map(([open, close]) => `${charAtom(open)}\\s*${name}\\s*${charAtom(close)}`).join("|")})`,
      "g",
    );
    out = out.replace(quoted, () => {
      sites += 1;
      return NEUTRAL_BRAND_TEXT;
    });
    if (discovery.bareTokens.has(token)) {
      const bare = new RegExp(name, "g");
      out = out.replace(bare, () => {
        sites += 1;
        return NEUTRAL_BRAND_TEXT;
      });
    }
  }
  return { text: out, sites };
}

export interface BrandResidue {
  /** 残留类型。 */
  kind: "name" | "structure";
  /** 定位信息（只描述位置，不含具体名称）。 */
  detail: string;
}

/** 检出产物里是否还有上游默认名称或「公众号 + 分隔符/引号」结构。 */
export function findBrandResidue(text: string, discovery: BrandDiscovery): BrandResidue[] {
  const found: BrandResidue[] = [];
  discovery.tokens.forEach((token, index) => {
    if (new RegExp(flexibleLiteral(token)).test(text)) {
      found.push({ kind: "name", detail: `第 ${index + 1} 个上游默认名称` });
    }
  });
  if (new RegExp(`${flexibleLiteral(STRUCTURE_WORD)}\\s*${structureTailAtom()}`).test(text)) {
    found.push({ kind: "structure", detail: "「公众号 + 分隔符/引号」结构" });
  }
  return found;
}
