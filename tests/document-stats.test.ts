import { expect, test } from "bun:test";
import { articleStats } from "../src/web/document-stats";

test("字数统计忽略 Markdown 标记并按中英文混排计数", () => {
  const stats = articleStats("## 标题\n\n你好，世界。\n\nHello world!");
  expect(stats).toEqual({ chars: 8, paragraphs: 3, minutes: 1 });
});

test("图片、链接地址与代码块不计入字数", () => {
  const stats = articleStats("![封面](https://example.com/a.png)\n\n[阅读原文](https://example.com)\n\n```\nconst secret = 1;\n```");
  expect(stats.chars).toBe(4);
  expect(stats.paragraphs).toBe(3);
});

test("长文按每分钟 400 字估算阅读时间", () => {
  expect(articleStats("字".repeat(801)).minutes).toBe(3);
});
