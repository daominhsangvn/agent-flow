import {
  type IntegrationFieldDescriptor,
  IntegrationFieldKind,
} from "@repo/api/src/types/integration";
import { z } from "zod";
import type { IntegrationProjectDefinition } from "../../types";
import type { AdoConnectionConfig } from "./schemas";

/**
 * Project connections of Azure DevOps: a project works on some team projects
 * of the organization (`projects`, matched without regard to case). A team
 * project belongs to one AgentFlow project, whose project connections (one
 * per connection, i.e. per account) may share it.
 */

const PROJECTS_MAX = 50;
const PROJECT_NAME_MAX = 64;

export const adoProjectSettingsSchema = z.object({
  projects: z
    .array(z.string().trim().min(1).max(PROJECT_NAME_MAX))
    .min(1, "Enter at least one Azure DevOps project")
    .max(PROJECTS_MAX)
    .transform(uniqueIgnoringCase),
});
export type AdoProjectSettings = z.infer<typeof adoProjectSettingsSchema>;

const ADO_PROJECT_SETTINGS_FIELDS: IntegrationFieldDescriptor[] = [
  {
    key: "projects",
    label: "Azure DevOps projects",
    kind: IntegrationFieldKind.StringList,
    required: true,
    placeholder: "Fabrikam",
    description:
      "Names of the team projects this project works on. Their work items start this project's workflows; agents can only read and write work items of these projects. A team project belongs to one project; its connections (one per account) may share it.",
  },
];

export const adoProjectDefinition: IntegrationProjectDefinition<
  AdoConnectionConfig,
  AdoProjectSettings
> = {
  settingsSchema: adoProjectSettingsSchema,
  settingsFields: ADO_PROJECT_SETTINGS_FIELDS,
  containers: (settings) => settings.projects.map(normalizeProject),
  normalizeContainer: normalizeProject,
  origin: (config) => config.organizationUrl.toLowerCase(),
  triggerContainersField: "projects",
};

function normalizeProject(project: string): string {
  return project.trim().toLowerCase();
}

function uniqueIgnoringCase(projects: string[]): string[] {
  const seen = new Set<string>();
  return projects.filter((project) => {
    const key = normalizeProject(project);
    if (seen.has(key)) {
      return false;
    }
    seen.add(key);
    return true;
  });
}
