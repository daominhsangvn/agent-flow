import { Crc64Nvme } from "@aws-sdk/crc64-nvme";
import { beforeEach, describe, expect, it, vi } from "vitest";

// S3-compatible defaults: no cold storage class, checksums computed by the API.
const { s3Send } = vi.hoisted(() => ({ s3Send: vi.fn() }));

vi.mock("@aws-sdk/client-s3", () => {
  class MockCommand {
    readonly input: Record<string, unknown>;
    readonly kind: string;
    constructor(input: Record<string, unknown>) {
      this.input = input;
      this.kind = new.target.name;
    }
  }
  class CreateMultipartUploadCommand extends MockCommand {}
  class CompleteMultipartUploadCommand extends MockCommand {}
  class HeadObjectCommand extends MockCommand {}
  class GetObjectCommand extends MockCommand {}
  class PutObjectCommand extends MockCommand {}
  return {
    AbortMultipartUploadCommand: MockCommand,
    CompleteMultipartUploadCommand,
    CreateMultipartUploadCommand,
    DeleteObjectCommand: MockCommand,
    DeleteObjectsCommand: MockCommand,
    GetObjectCommand,
    HeadBucketCommand: MockCommand,
    HeadObjectCommand,
    ListObjectsV2Command: MockCommand,
    ListPartsCommand: MockCommand,
    PutObjectCommand,
    UploadPartCommand: MockCommand,
    UploadPartCopyCommand: MockCommand,
    S3Client: class S3Client {
      send = s3Send;
    },
  };
});

vi.mock("@aws-sdk/s3-request-presigner", () => ({
  getSignedUrl: vi
    .fn()
    .mockResolvedValue("https://storage.example.test/signed"),
}));

vi.mock("server-only", () => ({}));

vi.mock("./keys", () => ({
  keys: () => ({
    S3_REGION: "us-east-1",
    S3_FORCE_PATH_STYLE: true,
    S3_MULTIPART_CHECKSUM: "computed",
    TRANSCRIPTS_BUCKET: "transcripts-bucket",
    PLUGIN_STORE_BUCKET: "plugin-store-bucket",
  }),
}));

import { getSignedUrl } from "@aws-sdk/s3-request-presigner";
import {
  completeTranscriptMultipartUpload,
  createTranscriptMultipartUpload,
  getCatalogAssetUploadUrl,
  headTranscriptObject,
  presignTranscriptPutObject,
} from "./index";

type SentCommand = { kind: string; input: Record<string, unknown> };

function sentCommands(kind: string): SentCommand[] {
  return s3Send.mock.calls
    .map(([command]) => command as SentCommand)
    .filter((command) => command.kind === kind);
}

async function crc64NvmeBase64(bytes: Uint8Array): Promise<string> {
  const crc = new Crc64Nvme();
  crc.update(bytes);
  return Buffer.from(await crc.digest()).toString("base64");
}

// biome-ignore lint/suspicious/useAwait: an async generator is the shape the SDK body exposes.
async function* chunks(...parts: string[]): AsyncGenerator<Uint8Array> {
  for (const part of parts) {
    yield Buffer.from(part);
  }
}

describe("transcript storage on S3-compatible backends", () => {
  beforeEach(() => {
    s3Send.mockReset();
  });

  it("creates multipart uploads without a checksum algorithm or storage class", async () => {
    s3Send.mockResolvedValueOnce({ UploadId: "upload-1" });

    await createTranscriptMultipartUpload("org/t/session.jsonl");

    const [create] = sentCommands("CreateMultipartUploadCommand");
    expect(create.input).not.toHaveProperty("ChecksumAlgorithm");
    expect(create.input).not.toHaveProperty("ChecksumType");
    expect(create.input).not.toHaveProperty("StorageClass");
  });

  it("completes without sending part or full-object checksums", async () => {
    s3Send.mockResolvedValueOnce({ ETag: '"etag"' });

    await completeTranscriptMultipartUpload({
      key: "org/t/session.jsonl",
      uploadId: "upload-1",
      parts: [
        { partNumber: 1, etag: '"p1"', checksumCrc64Nvme: "AAAAAAAAAAA=" },
      ],
      checksumCrc64Nvme: "AAAAAAAAAAA=",
    });

    const [complete] = sentCommands("CompleteMultipartUploadCommand");
    expect(complete.input).not.toHaveProperty("ChecksumCRC64NVME");
    expect(complete.input).not.toHaveProperty("ChecksumType");
    expect(complete.input.MultipartUpload).toEqual({
      Parts: [{ PartNumber: 1, ETag: '"p1"' }],
    });
  });

  it("computes the full-object CRC64NVME when the backend stores none", async () => {
    s3Send.mockImplementation((command: SentCommand) => {
      if (command.kind === "HeadObjectCommand") {
        return Promise.resolve({ ContentLength: 12, ETag: '"obj"' });
      }
      return Promise.resolve({ Body: chunks('{"a":1}\n', '{"b"', ":2}\n") });
    });

    const head = await headTranscriptObject("org/t/session.jsonl");

    const expected = await crc64NvmeBase64(Buffer.from('{"a":1}\n{"b":2}\n'));
    expect(head).toEqual({
      byteSize: 12,
      etag: '"obj"',
      checksumCrc64Nvme: expected,
    });
    const [get] = sentCommands("GetObjectCommand");
    // Pinned to the HEAD's ETag so a concurrent overwrite cannot be hashed.
    expect(get.input).toMatchObject({
      Key: "org/t/session.jsonl",
      IfMatch: '"obj"',
    });
  });

  it("uses the stored checksum when the backend reports one", async () => {
    s3Send.mockResolvedValueOnce({
      ContentLength: 3,
      ETag: '"obj"',
      ChecksumCRC64NVME: "stored==",
    });

    const head = await headTranscriptObject("org/t/session.jsonl");

    expect(head?.checksumCrc64Nvme).toBe("stored==");
    expect(sentCommands("GetObjectCommand")).toHaveLength(0);
  });

  it("omits the storage class on presigned fullPut and catalog zip uploads", async () => {
    await presignTranscriptPutObject({
      key: "org/t/s.jsonl",
      checksumCrc64Nvme: "c==",
    });
    await getCatalogAssetUploadUrl({
      orgId: "org",
      itemId: "item",
      kind: "zip",
      contentType: "application/zip",
      contentLength: 10,
    });

    const signed = vi
      .mocked(getSignedUrl)
      .mock.calls.map(
        ([, command]) => (command as unknown as SentCommand).input
      );
    for (const input of signed) {
      expect(input).not.toHaveProperty("StorageClass");
    }
  });
});
