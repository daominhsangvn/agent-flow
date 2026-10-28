import { LoopCommandSchema } from "@agentflow-ai/loops-api/commands";
import { loopCommandLabels } from "@repo/app/shared/components/status-badge";

export function getLoopCommandLabel(command: string): string {
  const parsed = LoopCommandSchema.safeParse(command);
  return parsed.success ? loopCommandLabels[parsed.data] : command;
}
