import {
  type ProjectAgentInstructions,
  readProjectAgentInstructions,
  type UpdateProjectAgentInstructionsInput,
} from "@repo/api/src/types/project-agent-instructions";
import { withDb } from "@repo/database";

/**
 * Agent instructions of a project (Project → Overview). Stored under the
 * `agentInstructions` key of the project's `settings` JSON and written with a
 * single jsonb update, so they never overwrite the other settings keys.
 * Loops on the project's repositories receive them as the root `CLAUDE.md`
 * of their workspace (lib/loops/loop-launch-repositories.ts).
 */
export const projectAgentInstructionsService = {
  /** Null when the project does not exist in the organization. */
  async get(
    organizationId: string,
    projectId: string
  ): Promise<ProjectAgentInstructions | null> {
    const project = await withDb((db) =>
      db.project.findFirst({
        where: { id: projectId, organizationId },
        select: { settings: true },
      })
    );
    return project
      ? { instructions: readProjectAgentInstructions(project.settings) }
      : null;
  },

  /** Saves the instructions; blank instructions remove them. Null when the project is missing. */
  async update(
    organizationId: string,
    projectId: string,
    input: UpdateProjectAgentInstructionsInput
  ): Promise<ProjectAgentInstructions | null> {
    const instructions = input.instructions.trim() ? input.instructions : "";
    const updated = await withDb((db) =>
      instructions
        ? db.$executeRaw`
            UPDATE projects
            SET settings = jsonb_set(COALESCE(settings, '{}'::jsonb), '{agentInstructions}', to_jsonb(${instructions}::text)),
                updated_at = NOW()
            WHERE id = ${projectId}::uuid AND organization_id = ${organizationId}::uuid`
        : db.$executeRaw`
            UPDATE projects
            SET settings = COALESCE(settings, '{}'::jsonb) - 'agentInstructions',
                updated_at = NOW()
            WHERE id = ${projectId}::uuid AND organization_id = ${organizationId}::uuid`
    );
    return updated > 0 ? { instructions } : null;
  },
};
