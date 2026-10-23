import { expect, test } from "bun:test";
import { OWNER_ID } from "../src/server/db/schema";
import { documentArticleStyle, documentCoverSnapshot } from "../src/server/services/job-snapshot";
import { neutralArticleStyle } from "../src/server/services/neutral-defaults";

// 自托管默认 owner 与其他成员一致：没选样式、封面时都带公共中性默认，不落到上游默认主题与默认封面。
test("默认 owner 未选样式与封面时使用公共中性默认", async () => {
  const doc = { style_id: null, cover_template_id: null, title: "标题" };
  for (const owner of [OWNER_ID, "00000000-0000-4000-8000-0000000000b2"]) {
    expect(await documentArticleStyle(null as never, owner, doc)).toBe(neutralArticleStyle);
    const cover = await documentCoverSnapshot(null as never, {} as never, owner, doc);
    expect(cover?.name).toBe("清晰阅读公共封面");
  }
});
