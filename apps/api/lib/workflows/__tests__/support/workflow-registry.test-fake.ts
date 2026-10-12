import { IntegrationFieldKind } from "@repo/api/src/types/integration";
import { z } from "zod";

/**
 * Stand-in for `@/lib/integrations/registry` in the workflow-service suite:
 * one provider ("fake") with one trigger type and one action type, each with
 * a url-kind config field so read redaction can be asserted.
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
  findActionDefinition: (provider: string, type: string) =>
    provider === "fake" && type === action.key ? action : null,
  getIntegrationProvider: () => ({ displayName: "Fake" }),
  listIntegrationProviders: () => [
    { key: "fake", triggers: [trigger], actions: [action] },
  ],
};
