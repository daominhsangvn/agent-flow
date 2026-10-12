import type { LoopStepCollectedFile } from "@agentflow-ai/loops-api/loop-step";
import type { RunProcessView } from "@repo/api/src/types/project-process";
import {
  WorkflowRunStatus,
  type WorkflowRunStatus as WorkflowRunStatusValue,
} from "@repo/api/src/types/workflow";

/**
 * The process part of a run's detail page: where each step stands, and the
 * files an approval step shows (its `show` entries are step ids or globs of
 * workspace paths).
 */

export const RunStepProgress = {
  Done: "done",
  Current: "current",
  Stopped: "stopped",
  Upcoming: "upcoming",
} as const;
export type RunStepProgress =
  (typeof RunStepProgress)[keyof typeof RunStepProgress];

export function runStepProgress(
  process: RunProcessView,
  status: WorkflowRunStatusValue
): RunStepProgress[] {
  if (status === WorkflowRunStatus.Succeeded) {
    return process.steps.map(() => RunStepProgress.Done);
  }
  const current = process.steps.findIndex((step) => step.id === process.stepId);
  const stopped =
    status === WorkflowRunStatus.Failed ||
    status === WorkflowRunStatus.Cancelled;
  return process.steps.map((_, index) => {
    if (current < 0 || index > current) {
      return RunStepProgress.Upcoming;
    }
    if (index < current) {
      return RunStepProgress.Done;
    }
    return stopped ? RunStepProgress.Stopped : RunStepProgress.Current;
  });
}

/**
 * The files an approval step shows: every file of a step named by id, and
 * every collected file whose path matches a glob. Each file once, in the
 * order of the `show` entries.
 */
export function approvalFiles(
  process: RunProcessView,
  show: readonly string[]
): Array<{ stepId: string; file: LoopStepCollectedFile }> {
  const stepIds = new Set(process.steps.map((step) => step.id));
  const seen = new Set<string>();
  const shown: Array<{ stepId: string; file: LoopStepCollectedFile }> = [];
  for (const entry of show) {
    const matches = stepIds.has(entry)
      ? process.stepFiles.filter((group) => group.stepId === entry)
      : process.stepFiles;
    const pattern = stepIds.has(entry) ? null : globToRegExp(entry);
    for (const group of matches) {
      for (const file of group.files) {
        if ((pattern && !pattern.test(file.path)) || seen.has(file.path)) {
          continue;
        }
        seen.add(file.path);
        shown.push({ stepId: group.stepId, file });
      }
    }
  }
  return shown;
}

/** `**` any depth, `*` and `?` within one path segment. */
export function globToRegExp(glob: string): RegExp {
  let source = "";
  for (let index = 0; index < glob.length; index++) {
    const char = glob.charAt(index);
    if (char === "*" && glob.charAt(index + 1) === "*") {
      const slash = glob.charAt(index + 2) === "/";
      source += slash ? "(?:.*/)?" : ".*";
      index += slash ? 2 : 1;
    } else if (char === "*") {
      source += "[^/]*";
    } else if (char === "?") {
      source += "[^/]";
    } else {
      source += char.replaceAll(REGEXP_SPECIAL, String.raw`\$&`);
    }
  }
  return new RegExp(`^${source}$`);
}

const REGEXP_SPECIAL = /[.+^${}()|[\]\\]/g;
