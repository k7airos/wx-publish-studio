import { expect, test } from "bun:test";
import { CredentialCrypto } from "../src/server/services/credential-crypto";
import { validateAppOrigin } from "../src/server/config";

test("credential encryption authenticates account/revision and requires the original deployment key", () => {
  const crypto = new CredentialCrypto("ab".repeat(32));
  const secret = { appSecret: "test-only-secret", pat: "test-only-pat" };
  const encrypted = crypto.encrypt("account", 1, secret);
  expect(encrypted).not.toContain(secret.appSecret);
  expect(crypto.decrypt("account", 1, encrypted)).toEqual(secret);
  expect(() => crypto.decrypt("other", 1, encrypted)).toThrow("credential_decryption_failed");
  expect(() => crypto.decrypt("account", 2, encrypted)).toThrow("credential_decryption_failed");
  expect(() => new CredentialCrypto("cd".repeat(32)).decrypt("account", 1, encrypted)).toThrow("credential_decryption_failed");
});

test("trusted browser origin is explicit and rejects paths, credentials and non-loopback HTTP", () => {
  expect(validateAppOrigin("http://127.0.0.1:18889")).toBe("http://127.0.0.1:18889");
  expect(validateAppOrigin("https://studio.example.com")).toBe("https://studio.example.com");
  for (const value of ["http://0.0.0.0:18889", "http://studio.example.com", "https://user:pass@studio.example.com", "https://studio.example.com/path"]) {
    expect(() => validateAppOrigin(value)).toThrow();
  }
});
