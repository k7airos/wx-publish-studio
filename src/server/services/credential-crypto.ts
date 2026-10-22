import { createCipheriv, createDecipheriv, randomBytes } from "node:crypto";

export interface AccountSecret { appSecret: string; pat: string }

// 主密钥由部署注入；AAD 使密文不能跨账号或凭据修订互换。
export class CredentialCrypto {
  private readonly key: Buffer;

  constructor(hexKey: string) {
    if (!/^[a-f\d]{64}$/i.test(hexKey)) throw new Error("CREDENTIAL_ENCRYPTION_KEY must be 32-byte hexadecimal");
    this.key = Buffer.from(hexKey, "hex");
  }

  encrypt(accountId: string, revision: number, secret: AccountSecret) {
    const iv = randomBytes(12);
    const cipher = createCipheriv("aes-256-gcm", this.key, iv);
    cipher.setAAD(Buffer.from(`${accountId}:${revision}`));
    const ciphertext = Buffer.concat([cipher.update(JSON.stringify(secret), "utf8"), cipher.final()]);
    return ["v1", iv.toString("base64"), cipher.getAuthTag().toString("base64"), ciphertext.toString("base64")].join(".");
  }

  decrypt(accountId: string, revision: number, value: string): AccountSecret {
    try {
      const [version, iv, tag, ciphertext] = value.split(".");
      if (version !== "v1") throw new Error();
      const decipher = createDecipheriv("aes-256-gcm", this.key, Buffer.from(iv, "base64"));
      decipher.setAAD(Buffer.from(`${accountId}:${revision}`));
      decipher.setAuthTag(Buffer.from(tag, "base64"));
      return JSON.parse(Buffer.concat([decipher.update(Buffer.from(ciphertext, "base64")), decipher.final()]).toString("utf8"));
    } catch { throw new Error("credential_decryption_failed"); }
  }
}
