// 界面走查截图：CDP 驱动 headless Chrome，按客户路径操作（桌面 1440×900、手机 390×844）。
// 先按 docs 启动模拟服务（tests/preview-server.ts，端口 18895），登录拿到 studio_session 写入
// SHOTS_COOKIE（默认 ./test-output/ui-cookie.txt），再运行：bun scripts/dev/ui-shots.ts [desktop|mobile]
// 截图输出到 SHOTS_DIR（默认 ./test-output/ui-shots）。
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
const dir = process.env.SHOTS_DIR || "test-output/ui-shots"; mkdirSync(dir, { recursive: true });
const origin = "http://127.0.0.1:18895";
const cookie = readFileSync(process.env.SHOTS_COOKIE || "test-output/ui-cookie.txt", "utf8").trim();
const [name, value] = cookie.split("=");
const only = process.argv[2] ?? "all";
const chrome = Bun.spawn(["/Applications/Google Chrome.app/Contents/MacOS/Google Chrome", "--headless=new", "--remote-debugging-port=9341", "--no-first-run", "--hide-scrollbars", `--user-data-dir=${dir}/.chrome-profile-${Date.now()}`, "about:blank"], { stdout: "ignore", stderr: "ignore" });
let ws = "";
for (let i = 0; i < 50 && !ws; i++) { await Bun.sleep(200); ws = await fetch("http://127.0.0.1:9341/json/version").then(r => r.json()).then(j => j.webSocketDebuggerUrl).catch(() => ""); }
const socket = new WebSocket(ws); await new Promise(r => socket.addEventListener("open", r, { once: true }));
let id = 0; const pending = new Map<number, (v: any) => void>(); let session = ""; const logs: string[] = [];
socket.addEventListener("message", e => {
  const m = JSON.parse(String(e.data));
  if (m.method === "Page.javascriptDialogOpening") { logs.push("NATIVE DIALOG: " + m.params.message); void send("Page.handleJavaScriptDialog", { accept: true }); }
  if (m.method === "Runtime.exceptionThrown") logs.push("EXCEPTION: " + (m.params.exceptionDetails?.exception?.description ?? m.params.exceptionDetails?.text));
  if (m.method === "Runtime.consoleAPICalled" && m.params.type === "error") logs.push("CONSOLE: " + m.params.args.map((a: any) => a.value ?? a.description).join(" "));
  if (m.id && pending.has(m.id)) { pending.get(m.id)!(m.error ? { error: m.error } : m.result); pending.delete(m.id); }
});
function send(method: string, params: any = {}, useSession = true): Promise<any> {
  const i = ++id; socket.send(JSON.stringify({ id: i, method, params, ...(useSession && session ? { sessionId: session } : {}) }));
  return new Promise(r => pending.set(i, r));
}
const { targetId } = await send("Target.createTarget", { url: "about:blank" }, false);
session = (await send("Target.attachToTarget", { targetId, flatten: true }, false)).sessionId;
await send("Page.enable"); await send("Runtime.enable"); await send("Network.enable");
async function viewport(width: number, height: number) { await send("Emulation.setDeviceMetricsOverride", { width, height, deviceScaleFactor: 1, mobile: width < 600 }); }
async function evaluate(expression: string) { return (await send("Runtime.evaluate", { expression, awaitPromise: true, returnByValue: true })).result?.value; }
async function shot(file: string) { await Bun.sleep(800); const { data } = await send("Page.captureScreenshot", { format: "png" }); writeFileSync(`${dir}/${file}.png`, Buffer.from(data, "base64")); const overflow = await evaluate("document.documentElement.scrollWidth > window.innerWidth"); console.log("shot", file, overflow ? "HORIZONTAL-OVERFLOW" : ""); }
async function click(text: string, scope = "button,a,[role=tab],[role=link]") {
  const ok = await evaluate(`(() => { const el = [...document.querySelectorAll(${JSON.stringify(scope)})].reverse().find(b => b.textContent.replace(/\\s+/g,"").includes(${JSON.stringify(text.replace(/\s+/g, ""))}) && !b.disabled && b.offsetParent !== null); if (!el) return false; el.click(); return true; })()`);
  if (!ok) console.log("  missing", text); await Bun.sleep(600); return ok;
}
async function waitFor(expression: string, timeout = 20000) { const end = Date.now() + timeout; while (Date.now() < end) { if (await evaluate(expression)) return true; await Bun.sleep(300); } console.log("  timeout", expression.slice(0, 60)); return false; }
async function go(path: string) { await send("Page.navigate", { url: origin + path }); await Bun.sleep(2200); }
async function api(path: string, method = "GET", body?: unknown) {
  const r = await fetch(origin + "/api" + path, { method, headers: { Cookie: cookie, Origin: origin, "Content-Type": "application/json" }, ...(body ? { body: JSON.stringify(body) } : {}) });
  return r.json();
}

async function desktop() {
  await viewport(1440, 900);
  await go("/"); await shot("d01-login");
  await send("Network.setCookie", { name, value, domain: "127.0.0.1", path: "/" });
  await go("/"); await shot("d02-home-onboarding");
  const doc = await api("/documents", "POST", { title: "2026 年内容创业者的三个增长杠杆", body: "## 为什么要重新思考增长\n\n过去一年，公众号的打开率持续走低，但**高质量长文**的转化反而在上升。\n\n> 内容是信任的复利。\n\n## 杠杆一：选题系统化\n\n- 建立选题池\n- 每周复盘数据\n- 固定栏目节奏\n\n> [!TIP] 小建议\n> 先从每周一篇开始。\n\n## 杠杆二：视觉一致性\n\n统一的排版与封面，让读者一眼认出你。\n\n## 杠杆三：发布流程自动化\n\n从写作到草稿箱，一步到位。" });
  await api("/documents", "POST", { title: "私域运营的第一性原理", body: "用户留存比拉新更重要。\n\n## 三个误区\n\n1. 只追求加粉\n2. 群发过度\n3. 没有内容节奏" });
  await go("/"); await shot("d03-home-cards");
  await go(`/articles/${doc.id}`); await waitFor("!!document.querySelector('.myno-root .milkdown')"); await shot("d04-editor");
  await click("排版"); await Bun.sleep(1200); await shot("d05-style-panel");
  await click("极简纸墨", ".pack"); await shot("d06-style-applied");
  await evaluate(`document.querySelector('.disclosure')?.setAttribute('open','')`); await evaluate(`document.querySelector('.panel-body').scrollTop = 900`); await shot("d07-style-more");
  await click("封面", "[role=tab]"); await Bun.sleep(5000); await shot("d08-cover-gallery");
  await evaluate(`[...document.querySelectorAll('.cover-option')][2]?.click()`); await Bun.sleep(3500); await shot("d09-cover-selected");
  await evaluate(`document.querySelector('.cover-controls .disclosure')?.setAttribute('open','')`); await evaluate(`document.querySelector('.panel-body').scrollTop = 420`); await Bun.sleep(1500); await shot("d09b-cover-tune");
  await evaluate(`(async () => { const c = document.createElement('canvas'); c.width = 240; c.height = 240; const g = c.getContext('2d'); g.fillStyle = '#16A34A'; g.fillRect(0,0,240,240); g.fillStyle = '#fff'; g.font = 'bold 120px sans-serif'; g.textAlign = 'center'; g.fillText('集', 120, 160); const blob = await new Promise(r => c.toBlob(r)); const input = document.querySelector('.cover-controls input[type=file]'); const dt = new DataTransfer(); dt.items.add(new File([blob], 'logo.png', { type: 'image/png' })); input.files = dt.files; input.dispatchEvent(new Event('change', { bubbles: true })); })()`); await Bun.sleep(4500); await shot("d09d-cover-logo");
  await click("大", ".cover-controls .segmented button"); await click("居中", ".cover-controls .segmented button"); await Bun.sleep(3500); await shot("d09c-cover-tuned");
  await click("保存", ".panel-foot button"); await Bun.sleep(3500); await shot("d10-config-saved");
  await click("发布"); await waitFor("!!document.querySelector('.phone-frame') || !!document.querySelector('.choice')", 30000); await Bun.sleep(1500); await shot("d11-publish-review");
  // 预览待确认时先关闭抽屉：编辑页按钮应显示“确认存入”，再点它回到预览。
  await evaluate(`document.querySelector('.sheet button[aria-label="关闭"], [role=dialog] button[aria-label="关闭"], button[aria-label="关闭"]')?.click()`); await Bun.sleep(600); await shot("d11b-button-ready");
  await click("确认存入", ".editor-top button"); await waitFor("!!document.querySelector('.phone-frame')", 15000);
  await click("存入草稿箱"); await Bun.sleep(300); await shot("d11c-button-publishing"); await waitFor("document.body.innerText.includes('演示完成') || document.body.innerText.includes('已存入草稿箱')", 30000); await shot("d12-publish-done");
  await click("完成"); await shot("d12b-button-done"); await go("/records"); await shot("d13-records");
  await go("/accounts"); await shot("d14-accounts");
  await click("添加公众号"); await shot("d15-wizard-1");
  await evaluate(`(() => { const i = document.querySelector('.dialog input'); const s = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype,'value').set; s.call(i,'我的公众号'); i.dispatchEvent(new Event('input',{bubbles:true})); })()`);
  await click("下一步"); await shot("d16-wizard-2");
  await evaluate(`(() => { const s = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype,'value').set; const [a,b] = document.querySelectorAll('.dialog input'); s.call(a,'wx1234567890abcdef'); a.dispatchEvent(new Event('input',{bubbles:true})); s.call(b,'0123456789abcdef0123456789abcdef'); b.dispatchEvent(new Event('input',{bubbles:true})); })()`);
  await click("下一步"); await shot("d16b-wizard-3");
  await send("Input.dispatchKeyEvent", { type: "keyDown", key: "Escape" }); await Bun.sleep(500); await click("退出", ".dialog button");
  await go("/me"); await shot("d17-me");
  await go("/"); await shot("d18-home-after");
  return doc.id;
}

async function mobile(docId?: string) {
  await viewport(390, 844);
  await send("Network.setCookie", { name, value, domain: "127.0.0.1", path: "/" });
  const id = docId ?? (await api("/documents")).documents[0]?.id;
  await go("/"); await shot("m01-home");
  await go(`/articles/${id}`); await waitFor("!!document.querySelector('.myno-root .milkdown')"); await shot("m02-editor");
  await click("排版"); await Bun.sleep(1200); await shot("m03-style-sheet");
  await click("封面", "[role=tab]"); await Bun.sleep(4000); await shot("m04-cover-sheet");
  await evaluate(`document.querySelector('.panel-scrim')?.click()`); await Bun.sleep(400);
  await click("发布"); await waitFor("!!document.querySelector('.phone-frame') || !!document.querySelector('.result')", 30000); await Bun.sleep(1500); await shot("m05-publish");
  await go("/records"); await shot("m06-records");
  await go("/accounts"); await click("添加公众号"); await shot("m07-wizard");
  await go("/me"); await shot("m08-me");
}

const docId = only === "mobile" ? undefined : await desktop();
if (only !== "desktop") await mobile(docId);
console.log(logs.length ? logs.join("\n") : "no console errors / native dialogs");
chrome.kill(); process.exit(0);
