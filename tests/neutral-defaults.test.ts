import { expect, test } from "bun:test";
import { OWNER_ID } from "../src/server/db/schema";
import { documentCoverSnapshot } from "../src/server/services/job-snapshot";

// 自托管默认 owner 与其他成员一致：没选封面时带公共中性封面，不落到 Worker 自带、依赖受信 CDN 的默认封面。
test("默认 owner 未选封面时使用公共中性封面", async () => {
  const doc = { cover_template_id: null, title: "标题" };
  for (const owner of [OWNER_ID, "00000000-0000-4000-8000-0000000000b2"]) {
    const cover = await documentCoverSnapshot(null as never, {} as never, owner, doc);
    expect(cover?.name).toBe("清晰阅读公共封面");
  }
});
