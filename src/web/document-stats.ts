export interface ArticleStats {
  /** 中文字符数 + 英文／数字词数，忽略 Markdown 标记、图片与代码块。 */
  chars: number;
  paragraphs: number;
  minutes: number;
}

export function articleStats(markdown: string): ArticleStats {
  const text = markdown
    .replace(/```[\s\S]*?```/g, " ")
    .replace(/<!--[\s\S]*?-->/g, " ")
    .replace(/!\[[^\]]*\]\([^)]*\)/g, " ")
    .replace(/\[([^\]]*)\]\([^)]*\)/g, "$1")
    .replace(/<[^>]+>/g, " ")
    .replace(/[#>*_`~|=-]+/g, " ");
  const cjk = text.match(/[㐀-鿿]/g)?.length ?? 0;
  const words = text.replace(/[㐀-鿿]/g, " ").match(/[A-Za-z0-9]+/g)?.length ?? 0;
  const chars = cjk + words;
  const paragraphs = markdown.split(/\n{2,}/).filter(part => part.trim()).length;
  return { chars, paragraphs, minutes: Math.max(1, Math.ceil(chars / 400)) };
}
