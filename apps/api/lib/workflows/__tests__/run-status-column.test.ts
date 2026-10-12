import { readFileSync } from "node:fs";
import path from "node:path";
import {
  WorkflowActionRunStatus,
  WorkflowRunStatus,
} from "@repo/api/src/types/workflow";
import { describe, expect, it } from "vitest";

/**
 * Status values are stored in varchar columns: a value longer than its column
 * makes every transition into it fail at write time (a run then retries the
 * transition forever). The lengths are read from the Prisma schema.
 */

const SCHEMA = readFileSync(
  path.resolve(
    import.meta.dirname,
    "../../../../../packages/database/prisma/schema.prisma"
  ),
  "utf8"
);
const VARCHAR_LENGTH_RE = /@db\.VarChar\((\d+)\)/;

function statusColumnLength(model: string): number {
  const start = SCHEMA.indexOf(`model ${model} {`);
  const block = SCHEMA.slice(start, SCHEMA.indexOf("\n}", start));
  const line = block
    .split("\n")
    .find((candidate) => candidate.trim().startsWith("status "));
  const length = line ? VARCHAR_LENGTH_RE.exec(line)?.[1] : undefined;
  if (start < 0 || !length) {
    throw new Error(`No varchar status column in model ${model}`);
  }
  return Number(length);
}

describe("status columns", () => {
  it("fit every workflow run status", () => {
    const max = statusColumnLength("WorkflowRun");
    for (const status of Object.values(WorkflowRunStatus)) {
      expect(status.length, status).toBeLessThanOrEqual(max);
    }
  });

  it("fit every workflow action run status", () => {
    const max = statusColumnLength("WorkflowActionRun");
    for (const status of Object.values(WorkflowActionRunStatus)) {
      expect(status.length, status).toBeLessThanOrEqual(max);
    }
  });
});
