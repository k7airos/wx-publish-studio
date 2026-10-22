import { expect, test } from "bun:test";
import { join } from "node:path";

// 编辑器读入文章再导出时不得丢失任何内容节点；Milkdown 7.21.x 曾静默丢弃全部列表。
test("myno editor keeps every content node when opening and saving an article", async () => {
  const article = [
    "## 小节标题",
    "正文包含**加粗**、*斜体*、`行内代码`和[链接](https://example.com)。",
    "> 引用里的一句话。",
    "- 无序一\n- 无序二\n  - 嵌套无序",
    "1. 有序一\n2. 有序二",
    "- [ ] 待办事项\n- [x] 已完成事项",
    "| 列一 | 列二 |\n| --- | --- |\n| 单元甲 | 单元乙 |",
    "```ts\nconst keep = true;\n```",
    "![配图说明](https://example.com/photo.png \"图注\")",
    "> [!TIP] 提示卡片\n> 卡片正文。",
    "---",
    "结尾段落。",
  ].join("\n\n");
  const child = Bun.spawn([process.execPath, join(import.meta.dir, "fixtures/editor-roundtrip.ts")], { stdin: new Blob([article]), stdout: "pipe", stderr: "pipe", cwd: join(import.meta.dir, "..") });
  const [stdout, stderr, code] = await Promise.all([new Response(child.stdout).text(), new Response(child.stderr).text(), child.exited]);
  expect({ code, stderr: stderr.slice(-2000) }).toEqual({ code: 0, stderr: expect.any(String) });
  const { output, errors } = JSON.parse(stdout) as { output: string; errors: string[] };
  expect(errors.filter(line => /RangeError|Expected value of type/.test(line))).toEqual([]);
  for (const text of ["小节标题", "加粗", "斜体", "行内代码", "https://example.com", "引用里的一句话", "无序一", "无序二", "嵌套无序", "有序一", "有序二",
    "待办事项", "已完成事项", "单元甲", "单元乙", "const keep = true;", "https://example.com/photo.png", "图注", "提示卡片", "卡片正文", "结尾段落"]) {
    expect(output).toContain(text);
  }
  expect(output).toMatch(/^\s*[*-] 无序一$/m);
  expect(output).toMatch(/^\s*1\. 有序一$/m);
  expect(output).toMatch(/^\s*[*-] \[ \] 待办事项$/m);
}, 60_000);
