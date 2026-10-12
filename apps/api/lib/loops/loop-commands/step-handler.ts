import {
  LOOP_STEP_ARTIFACT_KEY,
  type LoopStepConfig,
  LoopStepConfigSchema,
  type LoopStepResult,
  LoopStepResultSchema,
} from "@agentflow-ai/loops-api/loop-step";
import { LoopCommand } from "@repo/api/src/types/loop";
import { isRecord } from "@/lib/type-guards";
import { defineHandler } from "./loop-command-handler";

/**
 * STEP loops run one step of a project process on a desktop computer. The
 * upload-artifacts route already stores what the step produced on the loop
 * (`uploadedArtifacts.step`); the workflow engine reads it from there when
 * the loop ends (engine/agent-step.ts), so ingestion has nothing to add.
 * Steps never run on ECS, so there is no S3 state to read either.
 */
export const stepHandler = defineHandler<LoopStepResult | null>({
  requiresRepo: true,
  requiresParent: false,
  // The run's document (its plan, else its Issue) goes to the computer, which
  // writes the Issue to the work directory for the step's instruction.
  includePrimaryArtifact: true,
  downloadArtifacts: () => Promise.resolve(null),
  downloadFromUpload: (uploadedArtifacts) => readStepResult(uploadedArtifacts),
  ingest: () => Promise.resolve(),
});

/** The step outputs of a STEP loop's uploaded artifacts; null when absent or invalid. */
export function readStepResult(
  uploadedArtifacts: unknown
): LoopStepResult | null {
  if (!isRecord(uploadedArtifacts)) {
    return null;
  }
  const parsed = LoopStepResultSchema.safeParse(
    uploadedArtifacts[LOOP_STEP_ARTIFACT_KEY]
  );
  return parsed.success ? parsed.data : null;
}

/** Key of the step settings in a STEP loop's metadata (set by the workflow engine). */
export const LOOP_STEP_METADATA_KEY = "step";

/**
 * The step settings a STEP loop was created with, sent to the computer with
 * the loop; undefined for any other command or when they are not valid.
 */
export function readLoopStepConfig(loop: {
  command: string;
  metadata: unknown;
}): LoopStepConfig | undefined {
  if (loop.command !== LoopCommand.Step || !isRecord(loop.metadata)) {
    return;
  }
  const parsed = LoopStepConfigSchema.safeParse(
    loop.metadata[LOOP_STEP_METADATA_KEY]
  );
  return parsed.success ? parsed.data : undefined;
}
