import {
  ProcessStepType,
  writesReleaseNotes,
} from "@repo/api/src/types/project-process";
import { log } from "@repo/observability/log";
import { z } from "zod";
import { runIssueVariables } from "./agent-step";
import { findStep, resolveRunProcess } from "./process";
import { readAgentConfig } from "./run-data";
import { publishReleaseNotes, STEP_RELEASE_NOTES_FILE } from "./step-documents";
import type { EngineRun } from "./step-outcome";

/**
 * Release notes of AgentFlow's implement step (agentflow.execute,
 * docs/workflows.md "Step roles"): a workflow EXECUTE writes them when its
 * step does not turn them off (`releaseNotes` in its agent policy) and
 * uploads them as `releaseNotes`; they become the run's release notes
 * document like an implement agent step's. Best effort: a failure is logged
 * and the run goes on.
 */
export async function publishExecuteReleaseNotes(
  run: EngineRun,
  loop: { uploadedArtifacts: unknown }
): Promise<void> {
  const uploaded = uploadedReleaseNotesSchema.safeParse(loop.uploadedArtifacts);
  const text = uploaded.success ? uploaded.data.releaseNotes.trim() : "";
  const agent = readAgentConfig(run.agentConfig);
  if (!(text && agent)) {
    return;
  }
  const { process } = resolveRunProcess(run.process, agent);
  const step = findStep(process, ProcessStepType.AgentFlowExecute, run.stepId);
  if (!(step && writesReleaseNotes(step))) {
    return;
  }
  const published = await publishReleaseNotes({
    run,
    projectId: run.projectId,
    step,
    files: [{ path: STEP_RELEASE_NOTES_FILE, content: text, truncated: false }],
    variables: runIssueVariables(run),
  });
  if (!published.ok) {
    log.warn("[workflows/release-notes] Could not publish the release notes", {
      organizationId: run.organizationId,
      runId: run.id,
      error: published.error.message,
    });
  }
}

const uploadedReleaseNotesSchema = z.object({ releaseNotes: z.string() });
