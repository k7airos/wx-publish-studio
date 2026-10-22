import { getDefaultConfig, type TypesetConfig } from "@akairos/typeset-studio";
import { COVER_DECOR } from "./cover-decor";

// 发布时微信把 3.35:1 封面左侧 2350px 作 2.35:1 头图、右侧 1000px 作 1:1 方图（分享卡片与次条）。
// 每个预设一张整幅装饰底图（SVG 设计、固定 PNG 素材）：左侧 2.35:1 头图做成海报式——边框、底纹、花纹、角标，标题叠在其中；
// 右侧 1:1 方图只留一块与配色协调的纯色底，供成员放公众号或品牌 LOGO（专业设置里可上传）。
interface Design { decor: keyof typeof COVER_DECOR; name: string; background: string; ink: string; accent: string }

const designs: Design[] = [
  { decor: "poster_cobalt", name: "钴蓝信号", background: "#2050EE", ink: "#FFF2B3", accent: "#FF6A35" },
  { decor: "poster_indigo", name: "靛青标识", background: "#FFFFFF", ink: "#1E1B4B", accent: "#6366F1" },
  { decor: "poster_editorial", name: "墨金社论", background: "#F5F0E6", ink: "#161616", accent: "#B8862F" },
  { decor: "poster_press", name: "红白报头", background: "#F7F3EC", ink: "#141414", accent: "#D7262E" },
  { decor: "poster_forest", name: "森野日出", background: "#0D3A2B", ink: "#F4EFD8", accent: "#8BBF9F" },
  { decor: "poster_sunset", name: "复古落日", background: "#FFF4E4", ink: "#4A2C1A", accent: "#F0603A" },
  { decor: "poster_tech", name: "深蓝电路", background: "#0B1027", ink: "#EAF4FF", accent: "#67E8F9" },
  { decor: "poster_rose", name: "玫瑰拱门", background: "#FBEFF1", ink: "#4A1D2B", accent: "#C8607C" },
];

export const ARTICLE_COVER_PRESETS: TypesetConfig[] = designs.map(design => {
  const base = getDefaultConfig("wechat-cover-2.35");
  const decor = COVER_DECOR[design.decor]!;
  const safeArea = { top: 200, right: 1000 + 240, bottom: 200, left: 240 };
  return {
    ...base, id: `studio_cover_${design.decor}`, name: design.name, slot: "article_cover",
    algorithm: { ...base.algorithm, baseFontSize: 64, scaleRatio: 1.45, lineHeightMultiplier: 1.3, textAlign: "left", verticalAlign: "center",
      safeArea },
    theme: { ...base.theme, bgColor: design.background, textColor: design.ink, headingColor: design.ink, accentColor: design.accent,
      quoteColor: design.accent, captionColor: design.accent, watermarkColor: design.accent },
    footerText: "", watermarkText: "",
    chrome: { showHeader: false, showWatermark: false, showPageNumber: false, showFooter: false, showFooterDivider: false, showFooterText: false, showFillRatio: false },
    // 绝对定位图片的坐标以版心为原点，底图需反向偏移安全边距才能铺满整幅画布。
    images: [{ id: "decor", templateAssetKey: "decor", src: `asset:${decor.id}`, alt: `${design.name}装饰底图`, isAbsolute: true, layoutPreset: "custom",
      x: -safeArea.left, y: -safeArea.top, width: decor.width, height: decor.height, zIndex: 0, rotate: 0, opacity: 1, borderRadius: 0 }],
    canvasStyle: { fill: { type: "solid", color: design.background } },
  };
});
