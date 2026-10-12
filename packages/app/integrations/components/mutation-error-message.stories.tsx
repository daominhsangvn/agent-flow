import { ApiError } from "@repo/app/shared/api/api-error";
import type { Meta, StoryObj } from "@storybook/react";
import { MutationErrorMessage } from "./mutation-error-message";

/**
 * `MutationErrorMessage` shows why a save or an action failed, with the
 * server's own message, where the user is: the connection dialog, the
 * workflow editor footer, the Run now dialog and the inbound rotate action.
 */
const meta = {
  title: "App Core/Integrations/Mutation Error Message",
  component: MutationErrorMessage,
  tags: ["autodocs"],
  args: {
    title: "Couldn't save the connection",
    error: new ApiError(
      "Invalid configuration: siteUrl: The Jira site URL must start with https://",
      400
    ),
  },
} satisfies Meta<typeof MutationErrorMessage>;

export default meta;

type Story = StoryObj<typeof meta>;

/** A 400 with the provider's validation message. */
export const ServerMessage: Story = {};

/** A long, unbroken message wraps inside the alert instead of overflowing. */
export const LongMessage: Story = {
  args: {
    title: "Couldn't save the workflow",
    error: new ApiError(
      'Trigger 1: the connection "Acme Jira (https://acme-engineering-platform.atlassian.net/rest/api/3/myself?expand=groups,applicationRoles)" is disabled.',
      400
    ),
  },
  decorators: [
    (Story) => (
      <div className="max-w-sm">
        <Story />
      </div>
    ),
  ],
};

/** Nothing renders until the mutation fails. */
export const NoError: Story = { args: { error: null } };
