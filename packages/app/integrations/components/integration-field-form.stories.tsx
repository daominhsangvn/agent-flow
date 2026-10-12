import {
  type IntegrationFieldDescriptor,
  IntegrationFieldKind,
} from "@repo/api/src/types/integration";
import type { Meta, StoryObj } from "@storybook/react";
import { useState } from "react";
import type {
  IntegrationFieldErrors,
  IntegrationFieldValues,
  IntegrationSecretFieldStates,
} from "../lib/integration-field-values";
import { IntegrationFieldForm } from "./integration-field-form";

/**
 * `IntegrationFieldForm` renders any provider's connection, trigger or action
 * fields from the descriptors served by `GET /integrations/providers`. This
 * gallery shows every `IntegrationFieldKind` once, a `showWhen` dependency
 * (switch "Deployment" to Data Center and the email field disappears), the
 * stored-secret hint of an edit (an optional stored secret can be removed),
 * the re-entry notice after a credential origin change, and the error
 * presentation.
 */
const DEPLOYMENT_CLOUD = "cloud";
const DEPLOYMENT_DATA_CENTER = "data_center";

const ALL_KINDS: IntegrationFieldDescriptor[] = [
  {
    key: "deployment",
    label: "Deployment",
    kind: IntegrationFieldKind.Select,
    required: true,
    defaultValue: DEPLOYMENT_CLOUD,
    options: [
      { value: DEPLOYMENT_CLOUD, label: "Cloud" },
      { value: DEPLOYMENT_DATA_CENTER, label: "Data Center" },
    ],
  },
  {
    key: "siteUrl",
    label: "Site URL",
    kind: IntegrationFieldKind.Url,
    required: true,
    placeholder: "https://acme.atlassian.net",
  },
  {
    key: "email",
    label: "Bot account email",
    kind: IntegrationFieldKind.Email,
    required: true,
    description: "Only Jira Cloud authenticates with an email.",
    showWhen: { field: "deployment", equals: DEPLOYMENT_CLOUD },
  },
  {
    key: "apiToken",
    label: "API token",
    kind: IntegrationFieldKind.Secret,
    required: true,
  },
  {
    key: "signingSecret",
    label: "Outbound signing secret",
    kind: IntegrationFieldKind.Secret,
    description: "Leave empty to send unsigned requests.",
  },
  { key: "jql", label: "Extra JQL", kind: IntegrationFieldKind.Text },
  { key: "notes", label: "Notes", kind: IntegrationFieldKind.Textarea },
  {
    key: "maxResults",
    label: "Max issues per poll",
    kind: IntegrationFieldKind.Number,
    defaultValue: 50,
  },
  {
    key: "skipBots",
    label: "Ignore events caused by bots",
    kind: IntegrationFieldKind.Boolean,
    defaultValue: true,
  },
  {
    key: "issueTypes",
    label: "Issue types",
    kind: IntegrationFieldKind.MultiSelect,
    options: [
      { value: "story", label: "Story" },
      { value: "bug", label: "Bug" },
      { value: "task", label: "Task" },
    ],
  },
  {
    key: "labels",
    label: "Labels (any)",
    kind: IntegrationFieldKind.StringList,
    defaultValue: ["ai-ready"],
  },
  {
    key: "comment",
    label: "Comment",
    kind: IntegrationFieldKind.Template,
    defaultValue: "{{summary}}",
    description: "Markdown. Variables are replaced when the action runs.",
  },
];

function Gallery({
  secretFields,
  errors,
  notices,
  disabled = false,
}: Readonly<{
  secretFields?: IntegrationSecretFieldStates;
  errors?: IntegrationFieldErrors;
  notices?: Record<string, string>;
  disabled?: boolean;
}>) {
  const [values, setValues] = useState<IntegrationFieldValues>({});
  return (
    <div className="max-w-xl">
      <IntegrationFieldForm
        disabled={disabled}
        errors={errors}
        fields={ALL_KINDS}
        idPrefix="story"
        notices={notices}
        onChange={setValues}
        secretFields={secretFields}
        values={values}
      />
    </div>
  );
}

const meta = {
  title: "App Core/Integrations/Integration Field Form",
  component: Gallery,
  tags: ["autodocs"],
} satisfies Meta<typeof Gallery>;

export default meta;

type Story = StoryObj<typeof meta>;

/** A new connection: every kind with its defaults. */
export const AllKinds: Story = {};

/**
 * Editing a connection whose secrets are already stored. The required token
 * can only be replaced; the optional signing secret can also be removed
 * ("Remove", then "Keep" to undo).
 */
export const StoredSecret: Story = {
  args: {
    secretFields: {
      apiToken: { isSet: true, lastFour: "x9Kd" },
      signingSecret: { isSet: true, lastFour: "Qk9=" },
    },
  },
};

/**
 * The site URL changed on edit: the stored token would be sent to a new
 * host, so it must be typed again (shown as required, no "keep" hint).
 */
export const SecretReentry: Story = {
  args: {
    secretFields: { apiToken: { isSet: false, lastFour: null } },
    notices: { apiToken: "Re-enter API token because Site URL changed" },
  },
};

/** Client-side validation messages linked to their controls. */
export const WithErrors: Story = {
  args: {
    errors: {
      siteUrl: "Enter a valid http(s) URL",
      apiToken: "This field is required",
    },
  },
};

/** Read-only (members, or while saving). */
export const Disabled: Story = { args: { disabled: true } };
