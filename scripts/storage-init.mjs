// Creates the object-storage buckets the apps expect, and lets the web app
// read and write them from the browser (CORS): it uploads attachments and
// reads archived transcripts through presigned URLs. Idempotent: existing
// buckets are left alone; the CORS rules are rewritten each run. Reads the
// same S3_* variables as @repo/storage, from the environment or
// apps/api/.env.local.
//
//   pnpm storage:init
import { readFileSync } from "node:fs";
import { createRequire } from "node:module";
import path from "node:path";

const root = path.resolve(import.meta.dirname, "..");
const require = createRequire(path.join(root, "packages/storage/package.json"));
const {
  CreateBucketCommand,
  HeadBucketCommand,
  PutBucketCorsCommand,
  S3Client,
} = require("@aws-sdk/client-s3");

// Declared before `env`: readDotEnv runs at module top level and reads them.
const LINE_BREAK = /\r?\n/;
const ENV_LINE = /^\s*([A-Z0-9_]+)\s*=\s*(.*)\s*$/;
const SURROUNDING_QUOTES = /^(["'])(.*)\1$/;

const env = {
  ...readDotEnv(path.join(root, "apps/api/.env.local")),
  ...process.env,
};

const BUCKET_VARS = [
  "FILE_ATTACHMENTS_BUCKET",
  "TRANSCRIPTS_BUCKET",
  "PLUGIN_STORE_BUCKET",
  "LOOP_STATE_BUCKET",
];

/** The browser-facing buckets and the methods the web app uses on them. */
const BROWSER_BUCKET_METHODS = {
  FILE_ATTACHMENTS_BUCKET: ["GET", "HEAD", "PUT"],
  TRANSCRIPTS_BUCKET: ["GET", "HEAD"],
};
const CORS_MAX_AGE_SECONDS = 3600;

const endpoint = env.S3_ENDPOINT ?? "http://localhost:9000";
const client = new S3Client({
  region: env.S3_REGION ?? "us-east-1",
  endpoint,
  forcePathStyle: (env.S3_FORCE_PATH_STYLE ?? "true") === "true",
  requestChecksumCalculation: "WHEN_REQUIRED",
  responseChecksumValidation: "WHEN_REQUIRED",
  credentials: {
    accessKeyId: env.S3_ACCESS_KEY_ID ?? "agentflow",
    secretAccessKey: env.S3_SECRET_ACCESS_KEY ?? "agentflow-dev-secret",
  },
});

let failed = false;
for (const variable of BUCKET_VARS) {
  const bucket = env[variable];
  if (!bucket) {
    console.warn(`- ${variable} is not set; skipping`);
    continue;
  }
  try {
    await client.send(new HeadBucketCommand({ Bucket: bucket }));
    console.log(`= ${bucket} (exists)`);
  } catch (error) {
    if (error?.$metadata?.httpStatusCode !== 404) {
      console.error(
        `! ${bucket}: ${error?.name ?? "Error"} ${error?.message ?? ""}`
      );
      failed = true;
      continue;
    }
    await client.send(new CreateBucketCommand({ Bucket: bucket }));
    console.log(`+ ${bucket} (created)`);
  }
}

const origins = browserOrigins();
for (const [variable, methods] of Object.entries(BROWSER_BUCKET_METHODS)) {
  const bucket = env[variable];
  if (!(bucket && origins.length > 0)) {
    continue;
  }
  try {
    await client.send(
      new PutBucketCorsCommand({
        Bucket: bucket,
        CORSConfiguration: {
          CORSRules: [
            {
              AllowedOrigins: origins,
              AllowedMethods: methods,
              AllowedHeaders: ["*"],
              ExposeHeaders: ["ETag"],
              MaxAgeSeconds: CORS_MAX_AGE_SECONDS,
            },
          ],
        },
      })
    );
    console.log(
      `= ${bucket} CORS: ${methods.join("/")} from ${origins.join(", ")}`
    );
  } catch (error) {
    console.error(
      `! ${bucket} CORS: ${error?.name ?? "Error"} ${error?.message ?? ""}`
    );
    failed = true;
  }
}

if (failed) {
  console.error(
    `Could not reach every bucket at ${endpoint}. Is \`docker compose up -d\` running?`
  );
  process.exitCode = 1;
}

/**
 * Origins the web app runs on: S3_CORS_ALLOWED_ORIGINS (comma-separated), else
 * the origin of NEXT_PUBLIC_APP_URL.
 */
function browserOrigins() {
  const listed = (env.S3_CORS_ALLOWED_ORIGINS ?? "")
    .split(",")
    .map((origin) => origin.trim())
    .filter(Boolean);
  if (listed.length > 0) {
    return listed;
  }
  try {
    return [new URL(env.NEXT_PUBLIC_APP_URL).origin];
  } catch {
    console.warn(
      "- NEXT_PUBLIC_APP_URL / S3_CORS_ALLOWED_ORIGINS not set; skipping CORS"
    );
    return [];
  }
}

function readDotEnv(file) {
  let text;
  try {
    text = readFileSync(file, "utf8");
  } catch {
    return {};
  }
  const values = {};
  for (const line of text.split(LINE_BREAK)) {
    const match = ENV_LINE.exec(line);
    if (!match) {
      continue;
    }
    values[match[1]] = match[2].replace(SURROUNDING_QUOTES, "$2");
  }
  return values;
}
