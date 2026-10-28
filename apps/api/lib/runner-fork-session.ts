import { z } from "zod";

/** A runner that forks a STEP loop's session (`loopStepForkSession`). */
const forkSessionSchema = z.object({ loopStepForkSession: z.literal(true) });

/** True when the compute target's capabilities say its runner can fork a session. */
export function runnerForksSession(capabilities: unknown): boolean {
  return forkSessionSchema.safeParse(capabilities).success;
}

/** The refusal text for a fork on a runner that cannot fork. */
export function forkUnsupportedMessage(input: {
  machineName: string | null | undefined;
  session: string;
  advice: string;
}): string {
  return `${input.machineName ?? "The runner"} runs a runner version that cannot fork a session: it would continue ${input.session} itself. ${input.advice}`;
}
