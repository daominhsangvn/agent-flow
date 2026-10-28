import { z } from "zod";
import {
  type IntegrationFieldDescriptor,
  IntegrationFieldKind,
} from "./integration.ts";

/**
 * Email actions: the API sends a run event as an email through the server's
 * own mail relay (`SMTP_URL`, sender `EMAIL_FROM`, the one that also sends
 * invitations), e.g. on `input.needed` when a step has questions or waits
 * for an approval. They need no connection; the workflow decides whether and
 * to whom one is sent. Subject and body take {{variable}} placeholders; left
 * out, they describe the event (the run's summary, with its link).
 */
export const WORKFLOW_EMAIL_ACTION_TYPE = "agentflow.email";
export const WORKFLOW_EMAIL_LABEL = "Send email";
export const WORKFLOW_EMAIL_RECIPIENTS_MAX = 20;
export const WORKFLOW_EMAIL_SUBJECT_MAX = 300;
export const WORKFLOW_EMAIL_BODY_MAX = 20_000;

const recipientsSchema = z
  .array(z.email("Write each recipient as an email address"))
  .max(WORKFLOW_EMAIL_RECIPIENTS_MAX);

export const workflowEmailConfigSchema = z.object({
  to: recipientsSchema.min(1, "Add at least one recipient under to:"),
  cc: recipientsSchema.optional(),
  subject: z.string().trim().min(1).max(WORKFLOW_EMAIL_SUBJECT_MAX).optional(),
  body: z.string().trim().min(1).max(WORKFLOW_EMAIL_BODY_MAX).optional(),
});
export type WorkflowEmailConfig = z.infer<typeof workflowEmailConfigSchema>;

/** The options of an email action, for the YAML editor's checks and completions. */
export const WORKFLOW_EMAIL_CONFIG_FIELDS: IntegrationFieldDescriptor[] = [
  {
    key: "to",
    label: "To",
    kind: IntegrationFieldKind.StringList,
    required: true,
    placeholder: "ada@acme.dev",
    description: "Email addresses that receive the message.",
  },
  {
    key: "cc",
    label: "Cc",
    kind: IntegrationFieldKind.StringList,
    required: false,
    placeholder: "lead@acme.dev",
  },
  {
    key: "subject",
    label: "Subject",
    kind: IntegrationFieldKind.Template,
    required: false,
    placeholder: "[AgentFlow] {{source.key}} needs your input",
    description:
      "Defaults to what the event asks for (an answer, an approval) and the item key.",
  },
  {
    key: "body",
    label: "Body",
    kind: IntegrationFieldKind.Template,
    required: false,
    placeholder: "{{summary}}",
    description:
      "Plain text. Defaults to {{summary}}: the questions or the approval asked for, with a link to the run.",
  },
];
