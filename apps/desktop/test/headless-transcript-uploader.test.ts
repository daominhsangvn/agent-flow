import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import type { Readable } from "node:stream";
import { test } from "node:test";
import type {
  TranscriptCompleteRequest,
  TranscriptSyncPlanRequest,
  TranscriptSyncPlanResponse,
} from "@repo/api/src/types/desktop-transcripts";
import {
  createHeadlessTranscriptUploader,
  loopTranscriptFiles,
  RATE_LIMIT_PAUSE_MS,
} from "../src/headless/headless-transcript-uploader.js";
import {
  type DesktopTranscriptsClient,
  TranscriptSyncClientError,
} from "../src/main/transcript/desktop-transcripts-client.js";

const TARGET = "01a12707-7360-710b-b9f0-a498a6560081";

function claudeHome(): { home: string; project: string } {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), "claude-home-"));
  const project = path.join(home, "projects", "-workspace-loops-pln-4");
  fs.mkdirSync(path.join(project, "s-1", "subagents"), { recursive: true });
  fs.mkdirSync(path.join(project, "s-2", "subagents", "workflows", "w1"), {
    recursive: true,
  });
  const line = (n: number) => `${JSON.stringify({ type: "user", n })}\n`;
  fs.writeFileSync(path.join(project, "s-1.jsonl"), line(1) + line(2));
  fs.writeFileSync(
    path.join(project, "s-1", "subagents", "agent-a1.jsonl"),
    line(3)
  );
  fs.writeFileSync(
    path.join(project, "s-1", "subagents", "agent-a1.meta.json"),
    "{}"
  );
  fs.writeFileSync(path.join(project, "s-2.jsonl"), line(4));
  fs.writeFileSync(
    path.join(project, "s-2", "subagents", "workflows", "w1", "agent-b2.jsonl"),
    line(5)
  );
  return { home, project };
}

async function drain(stream: Readable): Promise<string> {
  const chunks: Buffer[] = [];
  for await (const chunk of stream) {
    chunks.push(Buffer.from(chunk));
  }
  return Buffer.concat(chunks).toString("utf8");
}

test("a loop's Claude sessions map to main, iteration and subagent files", () => {
  const { home, project } = claudeHome();
  assert.deepEqual(loopTranscriptFiles(home, ["s-1", "s-2", "s-gone"]), [
    { fileKey: "main", filePath: path.join(project, "s-1.jsonl") },
    {
      fileKey: "subagent:agent-a1",
      filePath: path.join(project, "s-1", "subagents", "agent-a1.jsonl"),
    },
    {
      fileKey: "subagent:iteration-2-s-2",
      filePath: path.join(project, "s-2.jsonl"),
    },
    {
      fileKey: "subagent:iteration-2-s-2__workflows__w1__agent-b2",
      filePath: path.join(
        project,
        "s-2",
        "subagents",
        "workflows",
        "w1",
        "agent-b2.jsonl"
      ),
    },
  ]);
  fs.rmSync(home, { recursive: true, force: true });
});

test("archives each changed file once: plan, PUT the redacted bytes, complete", async () => {
  const { home, project } = claudeHome();
  const plans: TranscriptSyncPlanRequest[] = [];
  const completes: TranscriptCompleteRequest[] = [];
  const bodies: string[] = [];
  const client: DesktopTranscriptsClient = {
    syncPlan(request) {
      plans.push(request);
      const plan: TranscriptSyncPlanResponse =
        request.fileKey === "subagent:agent-a1"
          ? {
              mode: "noop",
              syncedByteOffset: request.planEndOffset,
              storedEtag: "e",
            }
          : {
              mode: "fullPut",
              url: `https://s3.test/${request.fileKey}`,
              planEndOffset: request.planEndOffset,
              syncedByteOffset: 0,
              storedEtag: null,
            };
      return Promise.resolve(plan);
    },
    async uploadPut(_url, body, contentLength) {
      const text = await drain(body);
      assert.equal(Buffer.byteLength(text), contentLength);
      bodies.push(text);
    },
    uploadPart() {
      return Promise.reject(new Error("unexpected multipart"));
    },
    complete(request) {
      completes.push(request);
      return Promise.resolve({
        status: "uploaded",
        syncedByteOffset: request.planEndOffset,
        storedEtag: "etag",
        sessionDetailId: null,
      });
    },
    skip() {
      return Promise.reject(new Error("unexpected skip"));
    },
  };
  const uploader = createHeadlessTranscriptUploader({
    apiUrl: "http://api.test",
    apiKey: "key",
    claudeHome: home,
    client,
  });
  const loop = { externalSessionId: "s-1", harnessSessionIds: ["s-1", "s-2"] };

  assert.equal(await uploader.upload(TARGET, loop), true);
  assert.deepEqual(
    plans.map((plan) => [
      plan.externalSessionId,
      plan.fileKey,
      plan.sourceHarness,
    ]),
    [
      ["s-1", "main", "claude"],
      ["s-1", "subagent:agent-a1", "claude"],
      ["s-1", "subagent:iteration-2-s-2", "claude"],
      ["s-1", "subagent:iteration-2-s-2__workflows__w1__agent-b2", "claude"],
    ]
  );
  assert.ok(plans.every((plan) => plan.computeTargetId === TARGET));
  assert.ok(plans.every((plan) => !plan.sourcePathHash.includes(project)));
  // The noop file is not completed; the others are, with their plan's window.
  assert.deepEqual(
    completes.map((done) => [done.fileKey, done.mode, done.planEndOffset]),
    plans
      .filter((plan) => plan.fileKey !== "subagent:agent-a1")
      .map((plan) => [plan.fileKey, "fullPut", plan.planEndOffset])
  );
  assert.ok(bodies[0]?.includes('"n":1'));

  // Unchanged files are not planned again; a grown one is.
  fs.appendFileSync(path.join(project, "s-2.jsonl"), '{"type":"user","n":6}\n');
  assert.equal(await uploader.upload(TARGET, loop), true);
  assert.deepEqual(
    plans.slice(4).map((plan) => plan.fileKey),
    ["subagent:iteration-2-s-2"]
  );
  fs.rmSync(home, { recursive: true, force: true });
});

test("a failed file is reported and retried on the next pass", async () => {
  const { home } = claudeHome();
  let fail = true;
  const client = {
    syncPlan: () =>
      fail
        ? Promise.reject(new Error("HTTP 503"))
        : Promise.resolve({
            mode: "noop",
            syncedByteOffset: 1,
            storedEtag: null,
          }),
  } as unknown as DesktopTranscriptsClient;
  const uploader = createHeadlessTranscriptUploader({
    apiUrl: "http://api.test",
    apiKey: "key",
    claudeHome: home,
    client,
  });
  const loop = { externalSessionId: "s-1", harnessSessionIds: ["s-1"] };
  assert.equal(await uploader.upload(TARGET, loop), false);
  fail = false;
  assert.equal(await uploader.upload(TARGET, loop), true);
  fs.rmSync(home, { recursive: true, force: true });
});

test("a rate-limited pass stops and waits out the window", async () => {
  const { home } = claudeHome();
  let clock = 0;
  let planned = 0;
  let limited = true;
  const client = {
    syncPlan: () => {
      planned += 1;
      return limited
        ? Promise.reject(new TranscriptSyncClientError("HTTP 429", 429))
        : Promise.resolve({
            mode: "noop",
            syncedByteOffset: 1,
            storedEtag: null,
          });
    },
  } as unknown as DesktopTranscriptsClient;
  const uploader = createHeadlessTranscriptUploader({
    apiUrl: "http://api.test",
    apiKey: "key",
    claudeHome: home,
    client,
    now: () => clock,
  });
  const loop = { externalSessionId: "s-1", harnessSessionIds: ["s-1", "s-2"] };
  assert.equal(await uploader.upload(TARGET, loop), false);
  assert.equal(planned, 1);
  limited = false;
  clock += RATE_LIMIT_PAUSE_MS - 1;
  assert.equal(await uploader.upload(TARGET, loop), false);
  assert.equal(planned, 1);
  clock += 1;
  assert.equal(await uploader.upload(TARGET, loop), true);
  assert.equal(planned, 5);
  fs.rmSync(home, { recursive: true, force: true });
});
