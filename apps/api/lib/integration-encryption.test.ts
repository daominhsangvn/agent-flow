import { randomBytes } from "node:crypto";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
  decryptIntegrationToken,
  encryptIntegrationToken,
  encryptTokenPair,
  resolveIntegrationToken,
} from "./integration-encryption";
import {
  encryptSecret,
  resetSecretEncryptionKeyForTests,
  SecretPurpose,
} from "./secret-encryption";

const PLAINTEXT_TOKEN = "ya29.a0AfH6SMBxyz-test-access-token";
const MISSING_KEY_ERROR = /ENCRYPTION_KEY/;
const originalKey = process.env.ENCRYPTION_KEY;

beforeEach(() => {
  process.env.ENCRYPTION_KEY = randomBytes(32).toString("base64");
  resetSecretEncryptionKeyForTests();
});

afterEach(() => {
  process.env.ENCRYPTION_KEY = originalKey;
  resetSecretEncryptionKeyForTests();
});

describe("encryptIntegrationToken / decryptIntegrationToken", () => {
  it("round-trips a token", async () => {
    const sealed = await encryptIntegrationToken(PLAINTEXT_TOKEN);
    expect(sealed).not.toContain(PLAINTEXT_TOKEN);
    await expect(decryptIntegrationToken(sealed)).resolves.toBe(
      PLAINTEXT_TOKEN
    );
  });

  it("does not open a value sealed for a different purpose", async () => {
    const claudeKey = encryptSecret("sk-ant-x", SecretPurpose.ClaudeApiKey);
    await expect(decryptIntegrationToken(claudeKey)).rejects.toThrow();
  });

  it("fails closed when ENCRYPTION_KEY is missing", async () => {
    process.env.ENCRYPTION_KEY = "";
    resetSecretEncryptionKeyForTests();
    await expect(encryptIntegrationToken(PLAINTEXT_TOKEN)).rejects.toThrow(
      MISSING_KEY_ERROR
    );
  });
});

describe("resolveIntegrationToken", () => {
  it("decrypts and returns the token when encrypted is provided", async () => {
    const sealed = await encryptIntegrationToken(PLAINTEXT_TOKEN);
    await expect(
      resolveIntegrationToken(sealed, "ignored-plaintext")
    ).resolves.toBe(PLAINTEXT_TOKEN);
  });

  it("returns plaintext when encrypted is null", async () => {
    await expect(resolveIntegrationToken(null, "legacy")).resolves.toBe(
      "legacy"
    );
  });

  it("returns plaintext when encrypted is undefined", async () => {
    await expect(resolveIntegrationToken(undefined, "legacy")).resolves.toBe(
      "legacy"
    );
  });

  it("returns null when both encrypted and plaintext are null", async () => {
    await expect(resolveIntegrationToken(null, null)).resolves.toBeNull();
  });
});

describe("encryptTokenPair", () => {
  it("encrypts both access and refresh tokens and returns them by name", async () => {
    const pair = await encryptTokenPair("access", "refresh");
    await expect(
      decryptIntegrationToken(pair.encryptedAccessToken)
    ).resolves.toBe("access");
    expect(pair.encryptedRefreshToken).not.toBeNull();
    await expect(
      decryptIntegrationToken(pair.encryptedRefreshToken as string)
    ).resolves.toBe("refresh");
  });

  it("returns null for encryptedRefreshToken when refreshToken is null", async () => {
    const pair = await encryptTokenPair("access", null);
    expect(pair.encryptedRefreshToken).toBeNull();
  });

  it("returns null for encryptedRefreshToken when refreshToken is undefined", async () => {
    const pair = await encryptTokenPair("access", undefined);
    expect(pair.encryptedRefreshToken).toBeNull();
  });
});
