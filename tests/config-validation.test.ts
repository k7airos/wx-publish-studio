import { expect, test } from "bun:test";
import { loadConfig } from "../src/server/config";

// 配置校验：文案形态与白名单 IP 形状。
const withEnv = async (values: Record<string, string | undefined>, run: () => Promise<void>) => {
  const previous: Record<string, string | undefined> = {};
  for (const [key, value] of Object.entries(values)) {
    previous[key] = process.env[key];
    if (value === undefined) delete process.env[key];
    else process.env[key] = value;
  }
  try { await run(); }
  finally {
    for (const [key, value] of Object.entries(previous)) {
      if (value === undefined) delete process.env[key];
      else process.env[key] = value;
    }
  }
};

const baseEnv = {
  APP_ORIGIN: "http://127.0.0.1:18889",
  DATABASE_URL: "postgres://studio:pass@127.0.0.1:5432/studio",
  CREDENTIAL_ENCRYPTION_KEY: "ab".repeat(32),
  PIPELINE_WORKER_TOKEN: "worker-token",
  PIPELINE_WORKER_URL: "http://worker:18887",
  BOOTSTRAP_SECRET: "bootstrap-secret-at-least-thirty-two-chars",
};

test("copy mode defaults to neutral and only accepts known values", async () => {
  await withEnv({ ...baseEnv, PUBLISHING_COPY_MODE: undefined }, async () => {
    expect((await loadConfig()).copyMode).toBe("neutral");
  });
  await withEnv({ ...baseEnv, PUBLISHING_COPY_MODE: "hosted" }, async () => {
    expect((await loadConfig()).copyMode).toBe("hosted");
  });
  await withEnv({ ...baseEnv, PUBLISHING_COPY_MODE: "whatever" }, async () => {
    await expect(loadConfig()).rejects.toThrow("PUBLISHING_COPY_MODE must be neutral or hosted");
  });
});

test("whitelist IP must look like a real IPv4 or IPv6 address", async () => {
  await withEnv({ ...baseEnv, PUBLISHING_WX_WHITELIST_IP: "203.0.113.10" }, async () => {
    expect((await loadConfig()).wxWhitelistIp).toBe("203.0.113.10");
  });
  await withEnv({ ...baseEnv, PUBLISHING_WX_WHITELIST_IP: "2001:db8::1" }, async () => {
    expect((await loadConfig()).wxWhitelistIp).toBe("2001:db8::1");
  });
  for (const invalid of ["abc", "...", "999.1.1.1", "203.0.113", "203.0.113.10.20", ":::", "0x1.2.3.4"]) {
    await withEnv({ ...baseEnv, PUBLISHING_WX_WHITELIST_IP: invalid }, async () => {
      await expect(loadConfig()).rejects.toThrow("Invalid PUBLISHING_WX_WHITELIST_IP");
    });
  }
});
