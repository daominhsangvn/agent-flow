import { z } from "zod";

/**
 * Agent instructions of a project: markdown the project's agent loops read
 * first. A loop on the project's repositories works in a workspace folder that
 * holds every repository as a subdirectory; these instructions become the
 * workspace's root `CLAUDE.md`, followed by the list of repositories, while
 * each repository keeps its own `CLAUDE.md` / `AGENTS.md`. Typical content:
 * what each repository does, how they talk to each other, project-wide rules.
 */

export const PROJECT_AGENT_INSTRUCTIONS_MAX = 32_000;

export type ProjectAgentInstructions = {
  instructions: string;
};

export const updateProjectAgentInstructionsInputSchema = z.object({
  instructions: z.string().max(PROJECT_AGENT_INSTRUCTIONS_MAX),
});
export type UpdateProjectAgentInstructionsInput = z.infer<
  typeof updateProjectAgentInstructionsInputSchema
>;

/** Reads the instructions from a project's `settings` JSON; "" when unset. */
export function readProjectAgentInstructions(settings: unknown): string {
  const parsed = z
    .object({ agentInstructions: z.string() })
    .safeParse(settings);
  return parsed.success ? parsed.data.agentInstructions : "";
}
