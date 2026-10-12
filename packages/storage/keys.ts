import { createEnv } from "@t3-oss/env-nextjs";
import { z } from "zod";

/**
 * S3-compatible object storage (RustFS in the self-hosted Docker stack; any
 * S3-compatible server works). Nothing here assumes AWS.
 */
export const keys = () =>
  createEnv({
    emptyStringAsUndefined: true,
    server: {
      // Endpoint the API uses for server-side calls (inside Docker this is the
      // service name, e.g. http://rustfs:9000).
      S3_ENDPOINT: z.url().optional(),
      // Endpoint baked into presigned URLs. Browsers and the desktop app must be
      // able to reach it (e.g. http://localhost:9000). SigV4 signs the host, so a
      // URL signed for the internal endpoint would not validate from outside.
      // Defaults to S3_ENDPOINT.
      S3_PUBLIC_ENDPOINT: z.url().optional(),
      S3_REGION: z.string().default("us-east-1"),
      S3_ACCESS_KEY_ID: z.string().min(1).optional(),
      S3_SECRET_ACCESS_KEY: z.string().min(1).optional(),
      // Path-style addressing (http://host/bucket/key) is what self-hosted S3
      // servers expect; virtual-host style needs wildcard DNS.
      S3_FORCE_PATH_STYLE: z
        .enum(["true", "false"])
        .default("true")
        .transform((value) => value === "true"),
      // Storage class for cold data (transcripts, loop state, zip bundles).
      // Unset by default: S3-compatible servers reject AWS-only classes such as
      // INTELLIGENT_TIERING. Set it only when the backend supports the value.
      S3_COLD_STORAGE_CLASS: z.string().min(1).optional(),
      // How transcript multipart uploads prove integrity:
      // - "computed" (default): parts upload without a checksum algorithm and
      //   the API computes the full-object CRC64NVME by streaming the finished
      //   object. Works on any S3-compatible server.
      // - "native": the server composes a FULL_OBJECT CRC64NVME itself (AWS S3
      //   behavior). Only use with backends that accept unchecksummed presigned
      //   parts inside a checksummed multipart upload.
      S3_MULTIPART_CHECKSUM: z.enum(["computed", "native"]).default("computed"),
      FILE_ATTACHMENTS_BUCKET: z.string().min(1).optional(),
      // Raw session-transcript archive bucket. Optional in the schema; the
      // transcript helpers throw at runtime when it is unset.
      TRANSCRIPTS_BUCKET: z.string().min(1).optional(),
      // Catalog / plugin-distribution asset bucket (zip bundles and logos).
      PLUGIN_STORE_BUCKET: z.string().min(1).optional(),
      // Loop run-state bucket (context packs and artifacts uploaded by the
      // desktop runner).
      LOOP_STATE_BUCKET: z.string().min(1).optional(),
    },
    runtimeEnv: {
      S3_ENDPOINT: process.env.S3_ENDPOINT,
      S3_PUBLIC_ENDPOINT: process.env.S3_PUBLIC_ENDPOINT,
      S3_REGION: process.env.S3_REGION,
      S3_ACCESS_KEY_ID: process.env.S3_ACCESS_KEY_ID,
      S3_SECRET_ACCESS_KEY: process.env.S3_SECRET_ACCESS_KEY,
      S3_FORCE_PATH_STYLE: process.env.S3_FORCE_PATH_STYLE,
      S3_COLD_STORAGE_CLASS: process.env.S3_COLD_STORAGE_CLASS,
      S3_MULTIPART_CHECKSUM: process.env.S3_MULTIPART_CHECKSUM,
      FILE_ATTACHMENTS_BUCKET: process.env.FILE_ATTACHMENTS_BUCKET,
      TRANSCRIPTS_BUCKET: process.env.TRANSCRIPTS_BUCKET,
      PLUGIN_STORE_BUCKET: process.env.PLUGIN_STORE_BUCKET,
      LOOP_STATE_BUCKET: process.env.LOOP_STATE_BUCKET,
    },
  });
