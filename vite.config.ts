import { defineConfig, type Plugin } from "vite";
import react from "@vitejs/plugin-react";

/**
 * 上游编辑器包 `@akairos/myno` 的默认主题与插件示例里带有示例品牌字面量。
 * 本项目不使用这些默认文案（正文页脚来自服务端保存的排版快照），
 * 但它们会随前端产物一起分发，因此构建期做定点替换。
 *
 * 升级 `@akairos/myno` 后必须复核这份清单：构建会在残留时直接失败。
 */
const BRAND_COPY_OVERRIDES: Array<[string, string]> = [
  ["公众号 · 早早集市", "你的公众号"],
  ["公众号 · 古一软件", "你的公众号"],
  ["🌸 晚樱柔粉 (古一软件经典标配)", "🌸 晚樱柔粉"],
  ["💡 欢迎关注公众号「早早集市」，星标不错过每次更新。", "💡 欢迎关注你的公众号，不错过每次更新。"],
];

const BRAND_PATTERN = /早早集市|古一软件/;

/** 把上游默认文案里的示例品牌替换成中性文案，并保证产物里不再残留。 */
function brandCopyOverride(): Plugin {
  return {
    name: "brand-copy-override",
    enforce: "post",
    generateBundle(_options, bundle) {
      for (const file of Object.values(bundle)) {
        if (file.type !== "chunk" || !BRAND_PATTERN.test(file.code)) continue;
        for (const [from, to] of BRAND_COPY_OVERRIDES) file.code = file.code.split(from).join(to);
        if (BRAND_PATTERN.test(file.code)) this.error(`品牌字面量仍残留在 ${file.fileName}，请更新 BRAND_COPY_OVERRIDES`);
      }
    },
  };
}

// 开发入口固定绑定 18889 的回环 origin；5173 代理的写请求必须沿用同一 Origin，
// 否则服务端同源校验会返回 invalid_origin。生产构建不经过此代理。
export default defineConfig({
  plugins: [react(), brandCopyOverride()],
  server: {
    proxy: {
      "/api": {
        target: "http://127.0.0.1:18889",
        changeOrigin: true,
        configure: proxy => {
          proxy.on("proxyReq", request => request.setHeader("origin", "http://127.0.0.1:18889"));
        },
      },
    },
  },
});
