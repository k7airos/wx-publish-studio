import { defineConfig, type Plugin } from "vite";
import react from "@vitejs/plugin-react";
import {
  discoverBrandNames,
  findBrandResidue,
  neutralizeBrandNames,
  type BrandDiscovery,
} from "./scripts/brand-copy";

/**
 * 上游编辑器 / 排版 / 插件包的默认主题与插件示例里带有示例公众号名称。
 * 本项目不使用这些默认文案（正文页脚来自服务端保存的排版快照），
 * 但它们会随前端产物一起分发，因此构建期按**通用规则**自动发现并中性化。
 *
 * 规则本身在 `scripts/brand-copy.ts`（不含任何具体品牌名）：
 * 从上游产物的「公众号 + 分隔符/引号 + 名称」结构里发现名称，
 * 整段替换为中性占位文案，并替换裸名称；产物里仍有残留时构建直接失败。
 *
 * 升级上游包后必须复核机制是否仍然覆盖：发现不到上游包、或产物里仍有残留，构建都会失败。
 */
function brandNeutralization(): Plugin {
  let discovery: BrandDiscovery | null = null;
  return {
    name: "brand-neutralization",
    enforce: "post",
    buildStart() {
      const found = discoverBrandNames(process.cwd());
      if (found.missingPackages.length > 0) {
        this.error(
          `未能发现上游默认文案（缺少上游包：${found.missingPackages.join("、")}），无法保证分发产物干净。` +
            `请确认已执行 bun install --frozen-lockfile，并复核 scripts/brand-copy.ts 里的上游包清单。`,
        );
      }
      discovery = found;
    },
    generateBundle(_options, bundle) {
      if (!discovery) return;
      for (const file of Object.values(bundle)) {
        const source = file.type === "chunk" ? file.code : typeof file.source === "string" ? file.source : null;
        if (source === null) continue;
        const outcome = neutralizeBrandNames(source, discovery);
        if (outcome.sites > 0) {
          if (file.type === "chunk") file.code = outcome.text;
          else file.source = outcome.text;
        }
        const residue = findBrandResidue(file.type === "chunk" ? file.code : String(file.source), discovery);
        if (residue.length > 0) {
          this.error(
            `分发产物 ${file.fileName} 仍有上游默认文案残留（${residue.map(item => item.detail).join("；")}）。` +
              `请复核 scripts/brand-copy.ts 的中性化规则，或升级上游包后重新构建。`,
          );
        }
      }
    },
  };
}

// 开发入口固定绑定 18889 的回环 origin；5173 代理的写请求必须沿用同一 Origin，
// 否则服务端同源校验会返回 invalid_origin。生产构建不经过此代理。
export default defineConfig({
  plugins: [react(), brandNeutralization()],
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
