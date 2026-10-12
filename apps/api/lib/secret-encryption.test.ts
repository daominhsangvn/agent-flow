import { randomBytes } from "node:crypto";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
  decryptSecret,
  encryptSecret,
  resetSecretEncryptionKeyForTests,
  SecretPurpose,
} from "./secret-encryption";

const WRONG_LENGTH_ERROR = /32 bytes/;
const MISSING_KEY_ERROR = /ENCRYPTION_KEY/;

describe("secret-encryption", () => {
  const originalKey = process.env.ENCRYPTION_KEY;

  beforeEach(() => {
    process.env.ENCRYPTION_KEY = randomBytes(32).toString("base64");
    resetSecretEncryptionKeyForTests();
  });

  afterEach(() => {
    process.env.ENCRYPTION_KEY = originalKey;
    resetSecretEncryptionKeyForTests();
  });

  it("round-trips a secret for the same purpose", () => {
    const sealed = encryptSecret("sk-ant-secret", SecretPurpose.ClaudeApiKey);
    expect(sealed.startsWith("v1.")).toBe(true);
    expect(decryptSecret(sealed, SecretPurpose.ClaudeApiKey)).toBe(
      "sk-ant-secret"
    );
  });

  it("produces a different ciphertext on every call", () => {
    const a = encryptSecret("same", SecretPurpose.IntegrationToken);
    const b = encryptSecret("same", SecretPurpose.IntegrationToken);
    expect(a).not.toBe(b);
  });

  it("refuses to open a secret sealed for another purpose", () => {
    const sealed = encryptSecret("token", SecretPurpose.IntegrationToken);
    expect(() => decryptSecret(sealed, SecretPurpose.ClaudeApiKey)).toThrow();
  });

  it("detects tampering", () => {
    const sealed = encryptSecret("token", SecretPurpose.IntegrationToken);
    const payload = Buffer.from(sealed.slice(3), "base64");
    // Flip the last ciphertext byte.
    const last = payload.length - 1;
    payload.set([255 - (payload.at(-1) ?? 0)], last);
    const tampered = `v1.${payload.toString("base64")}`;
    expect(() =>
      decryptSecret(tampered, SecretPurpose.IntegrationToken)
    ).toThrow();
  });

  it("rejects a key of the wrong length", () => {
    process.env.ENCRYPTION_KEY = randomBytes(16).toString("base64");
    resetSecretEncryptionKeyForTests();
    expect(() => encryptSecret("x", SecretPurpose.ClaudeApiKey)).toThrow(
      WRONG_LENGTH_ERROR
    );
  });

  it("fails clearly when the key is missing", () => {
    delete process.env.ENCRYPTION_KEY;
    resetSecretEncryptionKeyForTests();
    expect(() => encryptSecret("x", SecretPurpose.ClaudeApiKey)).toThrow(
      MISSING_KEY_ERROR
    );
  });
});
