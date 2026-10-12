import { randomBytes } from "node:crypto";
import { IntegrationFieldKind } from "@repo/api/src/types/integration";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  buildCredentialHints,
  collectSecretValues,
  generateInboundKey,
  getSecretFieldKeys,
  hasSecretChanges,
  mergeSecrets,
  omitKeys,
  openCredentials,
  openInboundSecret,
  scrubLogMeta,
  scrubSecretValues,
  sealCredentials,
  sealInboundSecret,
} from "@/lib/integrations/connection/secrets";
import {
  encryptSecret,
  resetSecretEncryptionKeyForTests,
  SecretPurpose,
} from "@/lib/secret-encryption";

const SECRET_KEYS = ["apiToken", "extraToken"];
const SEALED_VALUE_RE = /^v1\./;
const INBOUND_KEY_RE = /^[A-Za-z0-9_-]{32}$/;
const UNDECRYPTABLE_RE = /^Stored credentials could not be decrypted/;

beforeEach(() => {
  vi.stubEnv("ENCRYPTION_KEY", randomBytes(32).toString("base64"));
  resetSecretEncryptionKeyForTests();
});

afterEach(() => {
  vi.unstubAllEnvs();
  resetSecretEncryptionKeyForTests();
});

describe("getSecretFieldKeys / omitKeys", () => {
  it("selects the secret fields and drops them from config", () => {
    const keys = getSecretFieldKeys([
      { key: "siteUrl", label: "Site", kind: IntegrationFieldKind.Url },
      { key: "apiToken", label: "Token", kind: IntegrationFieldKind.Secret },
    ]);

    expect(keys).toEqual(["apiToken"]);
    expect(omitKeys({ siteUrl: "https://x", apiToken: "t" }, keys)).toEqual({
      siteUrl: "https://x",
    });
  });
});

describe("mergeSecrets", () => {
  const stored = { apiToken: "stored-token", extraToken: "stored-extra" };

  it("keeps omitted and null secrets, replaces given ones, clears empty ones", () => {
    expect(
      mergeSecrets(stored, { apiToken: null, extraToken: "" }, SECRET_KEYS)
    ).toEqual({ apiToken: "stored-token" });
    expect(mergeSecrets(stored, { apiToken: "new" }, SECRET_KEYS)).toEqual({
      apiToken: "new",
      extraToken: "stored-extra",
    });
    expect(mergeSecrets(stored, undefined, SECRET_KEYS)).toEqual(stored);
  });

  it("treats null and empty values as unset on create and ignores undeclared keys", () => {
    expect(
      mergeSecrets(
        {},
        { apiToken: "t", extraToken: null, rogue: "x", toString: "y" },
        SECRET_KEYS
      )
    ).toEqual({ apiToken: "t" });
  });
});

describe("hasSecretChanges", () => {
  it("is true only when a declared secret is set or cleared", () => {
    expect(hasSecretChanges(undefined, SECRET_KEYS)).toBe(false);
    expect(hasSecretChanges({ apiToken: null, rogue: "x" }, SECRET_KEYS)).toBe(
      false
    );
    expect(hasSecretChanges({ extraToken: "" }, SECRET_KEYS)).toBe(true);
    expect(hasSecretChanges({ apiToken: "new" }, SECRET_KEYS)).toBe(true);
  });
});

describe("buildCredentialHints", () => {
  it("keeps the last four characters of secrets of at least eight characters", () => {
    expect(
      buildCredentialHints(
        { apiToken: "12345678", extraToken: "1234567" },
        SECRET_KEYS
      )
    ).toEqual({ apiToken: "5678", extraToken: null });
    expect(buildCredentialHints({ apiToken: "" }, SECRET_KEYS)).toEqual({});
  });
});

describe("sealing", () => {
  it("round-trips the credentials object and stores nothing for no secrets", () => {
    const sealed = sealCredentials({ apiToken: "secret-token" });

    expect(sealed).toMatch(SEALED_VALUE_RE);
    expect(sealed).not.toContain("secret-token");
    expect(openCredentials(sealed)).toEqual({
      ok: true,
      value: { apiToken: "secret-token" },
    });
    expect(sealCredentials({})).toBeNull();
    expect(openCredentials(null)).toEqual({ ok: true, value: {} });
  });

  it("binds each sealed value to its purpose", () => {
    const inbound = sealInboundSecret("inbound-secret");

    expect(openInboundSecret(inbound)).toEqual({
      ok: true,
      value: "inbound-secret",
    });
    expect(openCredentials(inbound).ok).toBe(false);
    expect(openInboundSecret(sealCredentials({ apiToken: "x" })).ok).toBe(
      false
    );
  });

  it("reports corrupt, non-object and missing values as errors", () => {
    expect(openCredentials("v1.corrupt")).toEqual({
      ok: false,
      error: expect.stringMatching(UNDECRYPTABLE_RE),
    });
    expect(
      openCredentials(
        encryptSecret(
          '["not", "an", "object"]',
          SecretPurpose.IntegrationCredentials
        )
      )
    ).toEqual({ ok: false, error: "Stored credentials are not a JSON object" });
    expect(openInboundSecret(null)).toEqual({
      ok: false,
      error: "The connection has no inbound secret",
    });
  });
});

describe("generateInboundKey", () => {
  it("returns 32 URL-safe characters", () => {
    const key = generateInboundKey();

    expect(key).toMatch(INBOUND_KEY_RE);
    expect(key).not.toBe(generateInboundKey());
  });
});

describe("secret scrubbing", () => {
  const secrets = collectSecretValues({
    apiToken: "tok_live_abcdef",
    pin: "123",
    flag: true,
  });

  it("collects only string secrets long enough to scrub", () => {
    expect(secrets).toEqual(["tok_live_abcdef"]);
  });

  it("scrubs every occurrence in text and nested log metadata", () => {
    expect(
      scrubSecretValues("tok_live_abcdef and tok_live_abcdef", secrets)
    ).toBe("[redacted] and [redacted]");

    const deep = {
      a: { b: { c: { d: { e: { f: { g: "tok_live_abcdef" } } } } } },
    };
    expect(
      scrubLogMeta(
        {
          url: "https://x.test/?token=tok_live_abcdef",
          list: ["tok_live_abcdef", 1, null],
          error: new Error("failed with tok_live_abcdef"),
          deep,
        },
        secrets
      )
    ).toEqual({
      url: "https://x.test/?token=[redacted]",
      list: ["[redacted]", 1, null],
      error: "failed with [redacted]",
      deep: { a: { b: { c: { d: { e: { f: "[redacted]" } } } } } },
    });
  });
});
