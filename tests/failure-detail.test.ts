import { expect, test } from "bun:test";
import { classifyFailure, sanitizeFailure } from "../src/server/services/failure-detail";

const invalidAppId = "publish failed (exit 1): [zzhub-pipeline publish] PUBLISH_TARGET_FAILED: API request failed with status 400: WX_SERVICE_ERROR: invalid appid rid: 6adab69a-0a5b3c1d-5e1d9a28 [request 6adae1c2-1111-4222-8333-444455556666]";

test("失败原因保留微信错误码与请求号，并可归类", () => {
  const detail = sanitizeFailure(invalidAppId)!;
  expect(detail).toContain("invalid appid"); expect(detail).toContain("6adab69a-0a5b3c1d-5e1d9a28");
  expect(classifyFailure(detail)).toBe("invalid_appid");
  expect(classifyFailure("errcode 40125 invalid appsecret")).toBe("invalid_secret");
  expect(classifyFailure("errcode: 40164, invalid ip 203.0.113.9, not in whitelist")).toBe("ip_whitelist");
  expect(classifyFailure("relay responded with status 401 Unauthorized")).toBe("relay_unauthorized");
  expect(classifyFailure("fetch failed: ECONNREFUSED")).toBe("relay_unreachable");
  expect(classifyFailure("something else broke")).toBeNull();
  expect(classifyFailure(null)).toBeNull();
});

test("失败原因脱敏：令牌、密钥、长随机串与路径都不外露，并限长", () => {
  const raw = [
    "GET /cgi-bin/token?access_token=AbC123secretTokenValue&x=1", "Authorization: Bearer abc.def-ghi_jkl", "pat_0123456789abcdefABCDEF",
    "appsecret=0123456789abcdef0123456789abcdef", "hex " + "ab".repeat(24), "state at /private/worker/secret/state.json",
  ].join("; ");
  const detail = sanitizeFailure(raw)!;
  for (const leak of ["AbC123secretTokenValue", "abc.def-ghi_jkl", "pat_0123", "0123456789abcdef0123456789abcdef", "ab".repeat(24), "/private/worker"]) expect(detail).not.toContain(leak);
  expect(sanitizeFailure("x".repeat(2000) + " y".repeat(900))!.length).toBeLessThanOrEqual(500);
  expect(sanitizeFailure("  ")).toBeNull(); expect(sanitizeFailure(undefined)).toBeNull();
});
