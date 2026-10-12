/**
 * @file loop-replan.ts
 * @description The work directory of a PLAN loop. Every PLAN starts in a
 * clean work directory; a re-plan (a workflow run planning again after the
 * open questions of its plan were answered) is handed what the earlier PLAN
 * left there, so the orchestrator revises that plan with the answers instead
 * of exploring and drafting from scratch:
 *
 * - `previous-plan.json`: the earlier plan.json (or `previous-plan.md`, the
 *   plan document's content, when the earlier work directory is gone);
 * - the exploration files (requirements extract, code maps, investigation
 *   log), only when the repository is still at the commit they describe;
 * - `plan-state.json`, the history of the plan's loops (plan-state-bundle.ts).
 *
 * The earlier work directory is `previous-work`, next to the work directory:
 * the plan's saved state restored there (plan-state-sync.ts), or the local
 * one openLoopWorkspace kept. This module takes what it needs and removes it.
 */

import { execFile } from "node:child_process";
import { existsSync } from "node:fs";
import fs from "node:fs/promises";
import path from "node:path";
import { promisify } from "node:util";
import { LoopArtifactType } from "@agentflow-ai/loops-api/artifacts";
import { z } from "zod";
import { PLAN_STATE_FILE } from "./plan-state-bundle.js";

const execFileAsync = promisify(execFile);

/** The earlier work directory openLoopWorkspace kept for a re-plan. */
export const PREVIOUS_WORK_DIR = "previous-work";
/** The commit the PLAN started from, written into its work directory. */
export const PLAN_BASE_FILE = ".plan-base";
export const PREVIOUS_PLAN_JSON = "previous-plan.json";
export const PREVIOUS_PLAN_MD = "previous-plan.md";
const PLAN_JSON = "plan.json";
const EXPLORATION_FILES = new Set([
  "requirements-extract.json",
  "investigation-log.md",
  "code-map.json",
]);
const CODE_MAP_RE = /^code-map-[\w.-]+\.json$/;
const planJsonSchema = z.record(z.string(), z.unknown());

export type PlanWorkDirInput = {
  claudeWorkDir: string;
  worktreeDir: string;
  replan: boolean;
  artifacts: ReadonlyArray<{ type: string; content: string }>;
  gitBin: string;
  log: (message: string) => void;
};

/**
 * Records the PLAN's base commit and, for a re-plan, hands it the earlier
 * plan (and exploration when the commit is unchanged). Best-effort: a step
 * that fails leaves the PLAN to start from scratch, as before re-plans.
 */
export async function preparePlanWorkDir(
  input: PlanWorkDirInput
): Promise<void> {
  const head = await gitHead(input.gitBin, input.worktreeDir);
  if (head) {
    await fs.writeFile(
      path.join(input.claudeWorkDir, PLAN_BASE_FILE),
      `${head}\n`
    );
  }
  const previousDir = path.join(
    path.dirname(input.claudeWorkDir),
    PREVIOUS_WORK_DIR
  );
  try {
    if (input.replan) {
      await handOverPreviousPlan(input, previousDir, head);
    }
  } catch (error) {
    input.log(
      `Re-plan hand-over failed; planning from scratch: ${error instanceof Error ? error.message : String(error)}`
    );
  } finally {
    await fs.rm(previousDir, { recursive: true, force: true });
  }
}

async function handOverPreviousPlan(
  input: PlanWorkDirInput,
  previousDir: string,
  head: string | null
): Promise<void> {
  if (existsSync(path.join(previousDir, PLAN_STATE_FILE))) {
    await fs.copyFile(
      path.join(previousDir, PLAN_STATE_FILE),
      path.join(input.claudeWorkDir, PLAN_STATE_FILE)
    );
  }
  const previousPlan = await readJsonObject(path.join(previousDir, PLAN_JSON));
  if (previousPlan) {
    await fs.writeFile(
      path.join(input.claudeWorkDir, PREVIOUS_PLAN_JSON),
      JSON.stringify(previousPlan, null, 2)
    );
  } else {
    const planDocument = input.artifacts.find(
      (artifact) => artifact.type === LoopArtifactType.ImplementationPlan
    );
    if (!planDocument?.content.trim()) {
      input.log("Re-plan: no earlier plan to revise; planning from scratch");
      return;
    }
    await fs.writeFile(
      path.join(input.claudeWorkDir, PREVIOUS_PLAN_MD),
      planDocument.content
    );
  }
  const copied =
    head && (await readBase(previousDir)) === head
      ? await copyExploration(previousDir, input.claudeWorkDir)
      : [];
  input.log(
    `Re-plan: revising the earlier plan (${previousPlan ? PREVIOUS_PLAN_JSON : PREVIOUS_PLAN_MD}); ${
      copied.length > 0
        ? `exploration kept (${copied.join(", ")})`
        : "exploration redone (no earlier exploration at this commit)"
    }`
  );
}

async function copyExploration(from: string, to: string): Promise<string[]> {
  const copied: string[] = [];
  for (const name of await fs.readdir(from)) {
    if (EXPLORATION_FILES.has(name) || CODE_MAP_RE.test(name)) {
      await fs.copyFile(path.join(from, name), path.join(to, name));
      copied.push(name);
    }
  }
  return copied.sort();
}

async function readBase(dir: string): Promise<string | null> {
  const file = path.join(dir, PLAN_BASE_FILE);
  if (!existsSync(file)) {
    return null;
  }
  return (await fs.readFile(file, "utf8")).trim() || null;
}

async function readJsonObject(
  file: string
): Promise<Record<string, unknown> | null> {
  if (!existsSync(file)) {
    return null;
  }
  try {
    const parsed = planJsonSchema.safeParse(
      JSON.parse(await fs.readFile(file, "utf8"))
    );
    return parsed.success ? parsed.data : null;
  } catch {
    return null;
  }
}

async function gitHead(gitBin: string, dir: string): Promise<string | null> {
  try {
    const { stdout } = await execFileAsync(gitBin, [
      "-C",
      dir,
      "rev-parse",
      "HEAD",
    ]);
    return stdout.trim() || null;
  } catch {
    return null;
  }
}
