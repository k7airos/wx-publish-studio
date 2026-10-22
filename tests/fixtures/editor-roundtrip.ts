// 在独立进程中用 happy-dom 加载真实 myno 编辑器，读入 Markdown 后原样导出，供往返测试比对。
import { GlobalRegistrator } from "@happy-dom/global-registrator";

GlobalRegistrator.register({ url: "http://localhost/" });
const input = await Bun.stdin.text();
const errors: string[] = [];
const originalError = console.error;
console.error = (...args: unknown[]) => { errors.push(args.map(String).join(" ")); };
console.warn = () => {};
const { MynoEditor } = await import("@akairos/myno/editor");
const root = document.createElement("div");
document.body.appendChild(root);
const editor = new MynoEditor({ root, defaultValue: input });
await editor.create();
await new Promise(resolve => setTimeout(resolve, 200));
const output = editor.getMarkdown();
console.error = originalError;
process.stdout.write(JSON.stringify({ output, errors }));
process.exit(0);
