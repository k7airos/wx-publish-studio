import { useEffect, useState } from "react";
import { apiResponse, type Job } from "../api";

/**
 * 读取预览产物：正文 HTML 不挂载到工作台 DOM，只允许冻结素材，随后交给无脚本 sandbox。
 * 逻辑沿用原 PreviewPanel，确认发布时看到的就是将要写入公众号的内容。
 */
export function usePreviewArtifacts(job: Job | null) {
  const [html, setHtml] = useState("");
  const [cover, setCover] = useState("");
  const [error, setError] = useState("");

  useEffect(() => {
    setHtml(""); setCover(""); setError("");
    if (!job?.artifactManifest || !job.snapshotHash || !job.artifactManifestHash) return;
    let disposed = false;
    const load = async () => {
      const manifest = job.artifactManifest!;
      // 无脚本 sandbox 的 iframe 是不透明来源，读不到父页面的 blob: 地址；冻结素材转成 data: 地址交给它。
      const mapped = new Map<string, string>();
      for (const artifact of manifest.artifacts.filter(item => item.kind !== "html")) {
        const response = await apiResponse(`/jobs/${job.id}/artifacts/${artifact.key}`);
        const blob = await response.blob();
        mapped.set(artifact.key, await new Promise<string>((resolve, reject) => {
          const reader = new FileReader();
          reader.onload = () => resolve(String(reader.result));
          reader.onerror = () => reject(new Error("预览图片读取失败，请重新打开预览。"));
          reader.readAsDataURL(blob);
        }));
      }
      if (!manifest.artifacts.some(item => item.key === "article" && item.kind === "html")) throw new Error("预览内容不完整，暂时不能存入草稿箱。");
      const response = await apiResponse(`/jobs/${job.id}/artifacts/article`);
      const template = document.createElement("template");
      template.innerHTML = await response.text();
      template.content.querySelectorAll("script,iframe,object,embed,link,base,meta,form").forEach(node => node.remove());
      for (const image of template.content.querySelectorAll("img")) {
        const id = /^asset:([a-f\d-]+)$/i.exec(image.getAttribute("src") || "")?.[1];
        const url = id ? mapped.get(`media_${id}`) : undefined;
        if (!url) throw new Error("预览里有图片没有准备好，暂时不能存入草稿箱。");
        image.removeAttribute("srcset");
        image.setAttribute("src", url);
      }
      template.content.querySelectorAll("*").forEach(node => {
        for (const attribute of [...node.attributes]) {
          if (/^on/i.test(attribute.name) || ["href", "xlink:href", "action", "formaction", "poster", "srcdoc"].includes(attribute.name)) node.removeAttribute(attribute.name);
        }
      });
      const content = `<!doctype html><html><head><meta charset="utf-8"><meta http-equiv="Content-Security-Policy" content="default-src 'none'; script-src 'none'; style-src 'unsafe-inline'; img-src data:; connect-src 'none'; base-uri 'none'; form-action 'none'"><style>body{margin:0;padding:20px 16px 32px;background:#fff;font-family:-apple-system,BlinkMacSystemFont,"PingFang SC",sans-serif;-webkit-font-smoothing:antialiased}img{max-width:100%;height:auto}.cover{display:block;width:calc(100% + 32px);max-width:none;margin:-20px -16px 18px;aspect-ratio:3.35/1;object-fit:cover}</style></head><body>${mapped.get("cover") ? `<img class="cover" alt="" src="${mapped.get("cover")}">` : ""}${template.innerHTML}</body></html>`;
      if (disposed) return;
      setHtml(content);
      setCover(mapped.get("cover") || "");
    };
    load().catch(err => { if (!disposed) setError((err as Error).message); });
    return () => { disposed = true; };
  }, [job?.id, job?.artifactManifestHash]);

  return { html, cover, error };
}
