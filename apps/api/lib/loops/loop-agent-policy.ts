import {
  type LoopAgentPolicy,
  LoopAgentPolicySchema,
} from "@agentflow-ai/loops-api/context-pack";
import { z } from "zod";

const loopMetadataSchema = z.object({ agentPolicy: LoopAgentPolicySchema });

/**
 * The agent policy a workflow process step stored on its loop
 * (engine/launch.ts), for the loop's context pack; undefined when the loop
 * has none, so other loops launch exactly as before.
 */
export function readLoopAgentPolicy(
  metadata: unknown
): LoopAgentPolicy | undefined {
  const parsed = loopMetadataSchema.safeParse(metadata);
  return parsed.success ? parsed.data.agentPolicy : undefined;
}
