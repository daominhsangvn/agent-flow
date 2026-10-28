import { IntegrationFieldKind } from "@repo/api/src/types/integration";
import { z } from "zod";

/**
 * Stand-in for `@/lib/integrations/registry` in the workflow-service suite:
 * one provider ("fake") with one trigger type and one action type, each with
 * a url-kind config field so read redaction can be asserted, and a
 * repository provider ("repo") with a pull request action only.
 */

export const FAKE_TRIGGER_TYPE = "fake.issue_assigned";
export const FAKE_ACTION_TYPE = "fake.post";

const trigger = {
  key: FAKE_TRIGGER_TYPE,
  configSchema: z.object({
    projectKeys: z.array(z.string()).default([]),
    callbackUrl: z.string().optional(),
  }),
  configFields: [
    {
      key: "projectKeys",
      label: "Projects",
      kind: IntegrationFieldKind.StringList,
    },
    {
      key: "callbackUrl",
      label: "Callback URL",
      kind: IntegrationFieldKind.Url,
    },
  ],
};

const action = {
  key: FAKE_ACTION_TYPE,
  configSchema: z.object({
    message: z.string().min(1),
    url: z.string().optional(),
  }),
  configFields: [
    { key: "message", label: "Message", kind: IntegrationFieldKind.Template },
    { key: "url", label: "URL", kind: IntegrationFieldKind.Url },
  ],
};

/** The pull request action of the "repo" provider (project repositories). */
export const FAKE_REPO_ACTION_TYPE = "repo.open_pull_request";
const repoAction = {
  key: FAKE_REPO_ACTION_TYPE,
  repositoryScoped: true,
  configSchema: z.object({ title: z.string().min(1) }),
  configFields: [
    { key: "title", label: "Title", kind: IntegrationFieldKind.Template },
  ],
};

/** A comment on the run's source item ("fake" provider). */
export const FAKE_COMMENT_TYPE = "fake.comment";
const commentAction = {
  key: FAKE_COMMENT_TYPE,
  sourceOperation: "comment",
  configSchema: z.object({ body: z.string().min(1) }),
  configFields: [
    { key: "body", label: "Body", kind: IntegrationFieldKind.Template },
  ],
};

/** Project settings of the "fake" provider: the project keys it works on. */
const fakeProject = {
  containers: (settings: { projectKeys?: string[] }) =>
    settings.projectKeys ?? [],
  normalizeContainer: (container: string) => container.toUpperCase(),
  origin: () => "https://fake.test",
  triggerContainersField: "projectKeys",
};

/** The generic webhook trigger behind a workflow's built-in HTTP endpoint. */
export const FAKE_HTTP_TRIGGER_TYPE = "webhook.request";
const httpTrigger = {
  key: FAKE_HTTP_TRIGGER_TYPE,
  configSchema: z.object({ types: z.array(z.string()).default([]) }),
  configFields: [
    { key: "types", label: "Types", kind: IntegrationFieldKind.StringList },
  ],
};

export const fakeWorkflowRegistry = {
  findTriggerDefinition: (provider: string, type: string) => {
    if (provider === "webhook" && type === httpTrigger.key) {
      return httpTrigger;
    }
    return provider === "fake" && type === trigger.key ? trigger : null;
  },
  findActionDefinition: (provider: string, type: string) => {
    if (provider === "repo" && type === repoAction.key) {
      return repoAction;
    }
    if (provider !== "fake") {
      return null;
    }
    return [action, commentAction].find((entry) => entry.key === type) ?? null;
  },
  getIntegrationProvider: (provider: string) => ({
    displayName: "Fake",
    actions: PROVIDER_ACTIONS[provider] ?? [],
    project: provider === "fake" ? fakeProject : undefined,
  }),
  listIntegrationProviders: () => [
    { key: "fake", triggers: [trigger], actions: [action] },
  ],
};

const PROVIDER_ACTIONS: Record<string, { key: string }[]> = {
  fake: [action, commentAction],
  repo: [repoAction],
};
