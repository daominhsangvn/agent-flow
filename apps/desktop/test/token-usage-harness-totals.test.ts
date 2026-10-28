import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, test } from "node:test";
import {
  parseHarnessResult,
  parseHarnessUsageTotals,
  parseTokenUsage,
  resolveRunTokenUsage,
  UNKNOWN_COST_BASIS,
  withHarnessUsageTotals,
} from "../src/main/cost/token-usage.js";

const LIST_PRICE = "list";
const tempDirs: string[] = [];

afterEach(() => {
  for (const dir of tempDirs.splice(0)) {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

function workDirWith(lines: unknown[]): string {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "harness-totals-test-"));
  tempDirs.push(dir);
  fs.writeFileSync(
    path.join(dir, "claude-output.jsonl"),
    `${lines.map((line) => JSON.stringify(line)).join("\n")}\n`,
    "utf-8"
  );
  return dir;
}

function init(sessionId: string): unknown {
  return { type: "system", subtype: "init", session_id: sessionId };
}

function assistant(id: string, model: string, input: number): unknown {
  return {
    type: "assistant",
    message: {
      id,
      model,
      usage: {
        input_tokens: input,
        output_tokens: 1,
        cache_creation_input_tokens: 0,
        cache_read_input_tokens: 0,
      },
    },
  };
}

type ModelRow = {
  input: number;
  output: number;
  costUsd: number;
  costBasis?: string;
};

/** A `result` as the CLI writes it: the session's totals so far. */
function result(
  sessionId: string | null,
  totalCostUsd: number,
  models: Record<string, ModelRow>
): Record<string, unknown> {
  const rows = Object.values(models);
  return {
    type: "result",
    subtype: "success",
    is_error: false,
    ...(sessionId ? { session_id: sessionId } : {}),
    total_cost_usd: totalCostUsd,
    usage: {
      input_tokens: rows.reduce((sum, row) => sum + row.input, 0),
      output_tokens: rows.reduce((sum, row) => sum + row.output, 0),
      cache_read_input_tokens: 0,
      cache_creation_input_tokens: 0,
    },
    modelUsage: Object.fromEntries(
      Object.entries(models).map(([model, row]) => [
        model,
        {
          inputTokens: row.input,
          outputTokens: row.output,
          cacheReadInputTokens: 0,
          cacheCreationInputTokens: 0,
          costUSD: row.costUsd,
          costBasis: row.costBasis ?? LIST_PRICE,
        },
      ])
    ),
  };
}

test("a session's cumulative results count once; separate sessions add up", () => {
  const dir = workDirWith([
    init("s-1"),
    result("s-1", 1, { m: { input: 100, output: 10, costUsd: 1 } }),
    // The same session stops again: its totals so far, not new work.
    result("s-1", 1.5, { m: { input: 150, output: 15, costUsd: 1.5 } }),
    init("s-2"),
    // No session_id: it belongs to the init before it.
    result(null, 0.5, {
      m: { input: 40, output: 4, costUsd: 0.25 },
      h: { input: 10, output: 1, costUsd: 0.25 },
    }),
  ]);

  const totals = parseHarnessUsageTotals(dir);

  assert.equal(totals?.sessionCount, 2);
  assert.equal(totals?.totalCostUsd, 2);
  assert.deepEqual(totals?.usage, {
    input: 200,
    output: 20,
    cacheRead: 0,
    cacheWrite: 0,
    webSearchRequests: 0,
  });
  assert.deepEqual(totals?.modelUsage, {
    m: {
      input: 190,
      output: 19,
      cacheRead: 0,
      cacheCreation: 0,
      costUsd: 1.75,
    },
    h: { input: 10, output: 1, cacheRead: 0, cacheCreation: 0, costUsd: 0.25 },
  });
});

test("a capture without a result has no harness totals", () => {
  const dir = workDirWith([init("s-1"), assistant("msg-1", "m", 100)]);

  assert.equal(parseHarnessUsageTotals(dir), null);
});

test("a guessed price leaves that model's and the run's cost unknown", () => {
  const dir = workDirWith([
    init("s-1"),
    result("s-1", 1, { m: { input: 100, output: 10, costUsd: 1 } }),
    init("s-2"),
    result("s-2", 3, {
      m: { input: 10, output: 1, costUsd: 0.5 },
      other: {
        input: 50,
        output: 5,
        costUsd: 2.5,
        costBasis: UNKNOWN_COST_BASIS,
      },
    }),
  ]);

  const totals = parseHarnessUsageTotals(dir);

  assert.equal(totals?.totalCostUsd, null);
  assert.equal(totals?.modelUsage.m?.costUsd, 1.5);
  assert.equal(totals?.modelUsage.other?.costUsd, null);
  assert.equal(totals?.modelUsage.other?.input, 50);
});

test("the run's token usage prefers the harness totals over the assistant events", () => {
  const dir = workDirWith([
    init("s-1"),
    assistant("msg-1", "m", 100),
    result("s-1", 1, { m: { input: 120, output: 40, costUsd: 1 } }),
    init("s-2"),
    assistant("msg-2", "m", 30),
    result("s-2", 0.5, { m: { input: 30, output: 9, costUsd: 0.5 } }),
  ]);

  const usage = resolveRunTokenUsage(
    parseTokenUsage(dir),
    parseHarnessUsageTotals(dir)
  );

  assert.equal(usage.inputTokens, 150);
  assert.equal(usage.outputTokens, 49);
  assert.equal(usage.turns, 2);
  assert.deepEqual(usage.tokensByModel, {
    m: { input: 150, output: 49, cacheCreation: 0, cacheRead: 0 },
  });
});

test("without harness totals the assistant events stand in", () => {
  const dir = workDirWith([init("s-1"), assistant("msg-1", "m", 100)]);
  const streamUsage = parseTokenUsage(dir);

  assert.deepEqual(resolveRunTokenUsage(streamUsage, null), streamUsage);
});

test("the last result carries the run's totals, keeping its own turns", () => {
  const dir = workDirWith([
    init("s-1"),
    result("s-1", 1, { m: { input: 100, output: 10, costUsd: 1 } }),
    init("s-2"),
    {
      ...result("s-2", 0.5, { m: { input: 20, output: 2, costUsd: 0.5 } }),
      num_turns: 3,
    },
  ]);

  const merged = withHarnessUsageTotals(
    parseHarnessResult(dir),
    parseHarnessUsageTotals(dir)
  );

  assert.equal(merged?.totalCostUsd, 1.5);
  assert.equal(merged?.numTurns, 3);
  assert.equal(merged?.usage?.input, 120);
  assert.equal(merged?.modelUsage.m?.output, 12);
});
