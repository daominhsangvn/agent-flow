import { beforeEach, describe, expect, it, vi } from "vitest";

const { constructed, env } = vi.hoisted(() => ({
  constructed: [] as Record<string, unknown>[],
  env: {} as Record<string, unknown>,
}));

vi.mock("@aws-sdk/client-s3", () => ({
  S3Client: class S3Client {
    constructor(config: Record<string, unknown>) {
      constructed.push(config);
    }
  },
}));

vi.mock("server-only", () => ({}));

vi.mock("./keys", () => ({ keys: () => env }));

import {
  coldStorageClassInput,
  getPresignClient,
  getStorageClient,
  resetStorageClientsForTests,
} from "./client";

describe("storage clients", () => {
  beforeEach(() => {
    constructed.length = 0;
    for (const key of Object.keys(env)) {
      delete env[key];
    }
    Object.assign(env, {
      S3_REGION: "us-east-1",
      S3_FORCE_PATH_STYLE: true,
      S3_ENDPOINT: "http://rustfs:9000",
      S3_ACCESS_KEY_ID: "access",
      S3_SECRET_ACCESS_KEY: "secret",
    });
    resetStorageClientsForTests();
  });

  it("configures the internal client for an S3-compatible endpoint", () => {
    getStorageClient();

    expect(constructed[0]).toEqual({
      region: "us-east-1",
      endpoint: "http://rustfs:9000",
      forcePathStyle: true,
      requestChecksumCalculation: "WHEN_REQUIRED",
      responseChecksumValidation: "WHEN_REQUIRED",
      credentials: { accessKeyId: "access", secretAccessKey: "secret" },
    });
  });

  it("signs presigned URLs against the public endpoint when one is set", () => {
    env.S3_PUBLIC_ENDPOINT = "http://localhost:9000";

    getPresignClient();

    expect(constructed[0]).toMatchObject({ endpoint: "http://localhost:9000" });
  });

  it("falls back to the internal endpoint for presigning", () => {
    getPresignClient();

    expect(constructed[0]).toMatchObject({ endpoint: "http://rustfs:9000" });
  });

  it("memoizes each client", () => {
    expect(getStorageClient()).toBe(getStorageClient());
    expect(getPresignClient()).toBe(getPresignClient());
    expect(constructed).toHaveLength(2);
  });

  it("applies a cold storage class only when configured", () => {
    expect(coldStorageClassInput()).toEqual({});
    env.S3_COLD_STORAGE_CLASS = "STANDARD_IA";
    expect(coldStorageClassInput()).toEqual({ StorageClass: "STANDARD_IA" });
  });
});
