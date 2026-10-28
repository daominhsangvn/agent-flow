/**
 * @file execute-release-notes.ts
 * @description Release notes the EXECUTE loop of a workflow run writes when
 * `AGENTFLOW_RELEASE_NOTES=1` (agent-policy-env.ts). They are uploaded with
 * the loop's other outputs; the workflow engine publishes them as the run's
 * release notes document (docs/workflows.md "Step roles").
 */

import path from "node:path";
import { LoopArtifactFile } from "@agentflow-ai/loops-api/artifacts";
import { readTextFile } from "../../main/diagnostics/diagnostics-helpers.js";

/** The release notes in `claudeWorkDir`; undefined when the loop wrote none. */
export function readReleaseNotes(claudeWorkDir: string): string | undefined {
  const text = readTextFile(
    path.join(claudeWorkDir, LoopArtifactFile.ReleaseNotes)
  )?.trim();
  return text || undefined;
}
