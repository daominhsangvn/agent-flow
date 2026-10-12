// End-to-end smoke test of @repo/storage against a live S3-compatible server
// (RustFS from docker-compose.yml). Exercises the same helpers the API uses.
//
//   pnpm --filter @repo/storage smoke
//
// Requires the S3_* variables and buckets (pnpm storage:init) to be set up.
import { Crc64Nvme } from "@aws-sdk/crc64-nvme";
import {
  completeTranscriptMultipartUpload,
  copyTranscriptPart,
  createTranscriptMultipartUpload,
  deleteArtifact,
  deleteTranscriptObjects,
  getSignedDownloadUrl,
  getSignedUploadUrl,
  headAttachmentObject,
  headTranscriptObject,
  presignTranscriptPutObject,
  presignTranscriptUploadPart,
} from "../index";

const MIN_COPY_PART_BYTES = 5 * 1024 * 1024 + 1;

async function crc64(bytes: Uint8Array): Promise<string> {
  const crc = new Crc64Nvme();
  crc.update(bytes);
  return Buffer.from(await crc.digest()).toString("base64");
}

async function put(
  url: string,
  body: Uint8Array<ArrayBuffer>,
  headers: Record<string, string> = {}
) {
  const response = await fetch(url, { method: "PUT", body, headers });
  if (!response.ok) {
    throw new Error(`PUT failed: ${response.status} ${await response.text()}`);
  }
  return response;
}

async function attachmentRoundTrip(): Promise<void> {
  const key = `smoke/${Date.now()}/hello.txt`;
  await put(await getSignedUploadUrl(key, "text/plain"), Buffer.from("hello"), {
    "content-type": "text/plain",
  });
  const head = await headAttachmentObject(key);
  const body = await (await fetch(await getSignedDownloadUrl(key, 60))).text();
  await deleteArtifact(key);
  if (head?.byteSize !== 5 || body !== "hello") {
    throw new Error(`attachment mismatch: ${JSON.stringify({ head, body })}`);
  }
}

async function transcriptAppend(): Promise<void> {
  const key = `smoke/${Date.now()}/session.jsonl`;
  const base = Buffer.alloc(MIN_COPY_PART_BYTES, 0x61);
  const delta = Buffer.from('{"delta":true}\n');
  const full = Buffer.concat([base, delta]);

  // fullPut: single object with a signed CRC64NVME header.
  const baseCrc = await crc64(base);
  await put(
    await presignTranscriptPutObject({ key, checksumCrc64Nvme: baseCrc }),
    base,
    {
      "content-type": "application/x-ndjson",
      "x-amz-checksum-crc64nvme": baseCrc,
    }
  );
  const before = await headTranscriptObject(key);
  if (before?.checksumCrc64Nvme !== baseCrc || !before.etag) {
    throw new Error(`fullPut checksum mismatch: ${JSON.stringify(before)}`);
  }

  // copy-append: part 1 copies the existing object, part 2 is the delta.
  const { uploadId } = await createTranscriptMultipartUpload(key);
  const copied = await copyTranscriptPart({
    key,
    uploadId,
    partNumber: 1,
    sourceKey: key,
    ifMatchEtag: before.etag,
  });
  const partUrl = await presignTranscriptUploadPart({
    key,
    uploadId,
    partNumber: 2,
  });
  const partResponse = await put(partUrl, delta);
  await completeTranscriptMultipartUpload({
    key,
    uploadId,
    parts: [
      copied,
      { partNumber: 2, etag: partResponse.headers.get("etag") ?? "" },
    ],
    checksumCrc64Nvme: await crc64(full),
    ifMatchEtag: before.etag,
  });

  const after = await headTranscriptObject(key);
  const expected = await crc64(full);
  await deleteTranscriptObjects([key]);
  if (after?.byteSize !== full.length || after.checksumCrc64Nvme !== expected) {
    throw new Error(
      `append verification failed: ${JSON.stringify({ after, expected })}`
    );
  }
}

async function main(): Promise<void> {
  for (const [name, run] of [
    ["attachment presign round-trip", attachmentRoundTrip],
    ["transcript fullPut + copy-append + computed checksum", transcriptAppend],
  ] as const) {
    await run();
    console.log(`PASS ${name}`);
  }
}

main().catch((error: unknown) => {
  console.error("FAIL", error);
  process.exitCode = 1;
});
