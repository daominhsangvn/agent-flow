import {
  IntegrationDeliveryMode,
  IntegrationProviderKey,
} from "@repo/api/src/types/integration";
import { ApiError } from "@repo/app/shared/api/api-error";
import { makeQueryClient } from "@repo/app/shared/query/query-client";
import { createWrapperWithClient } from "@repo/app/shared/test-utils";
import { render, screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { beforeEach, describe, expect, it, vi } from "vitest";
import {
  JIRA_CONNECTION_ID,
  jiraConnection,
  PROVIDERS,
  WEBHOOK_CONNECTION_ID,
  webhookConnection,
} from "../../__tests__/integration-fixtures";
import { REQUIRED_FIELD_MESSAGE } from "../../lib/integration-field-values";
import { IntegrationMutationErrorTitle } from "../../lib/mutation-error";
import {
  IntegrationConnectionDialog,
  type IntegrationConnectionDialogProps,
} from "../integration-connection-dialog";

/**
 * The connection dialog wired to the real mutation hooks and the real shared
 * QueryClient (with its default error toast), so these tests see exactly what
 * a user sees when the API rejects a save.
 */

const SITE_URL_RE = /Site URL/;
const BOT_EMAIL_RE = /Bot email/;
const API_TOKEN_RE = /API token/;
const WEBHOOK_RE = /^Webhook/;
const JIRA_RE = /^Jira/;
const WILL_BE_REMOVED_RE = /will be removed when you save/;

const INVALID_SITE_URL_MESSAGE =
  "Invalid configuration: siteUrl: The Jira site URL must start with https://";
const JIRA_PATH = `/integrations/connections/${JIRA_CONNECTION_ID}`;
const WEBHOOK_PATH = `/integrations/connections/${WEBHOOK_CONNECTION_ID}`;
const SAVE_CHANGES = "Save changes";

const mocks = vi.hoisted(() => ({
  toastError: vi.fn(),
  toastSuccess: vi.fn(),
}));

const mockApiClient = {
  get: vi.fn(),
  post: vi.fn(),
  put: vi.fn(),
  patch: vi.fn(),
  delete: vi.fn(),
};

vi.mock("@repo/app/shared/api/use-api-client", () => ({
  useApiClient: () => mockApiClient,
}));

vi.mock("@repo/design-system/components/ui/sonner", () => ({
  toast: { error: mocks.toastError, success: mocks.toastSuccess },
}));

function renderDialog(props: Partial<IntegrationConnectionDialogProps> = {}): {
  onClose: ReturnType<typeof vi.fn>;
} {
  const onClose = vi.fn();
  render(
    <IntegrationConnectionDialog
      connection={jiraConnection}
      onClose={onClose}
      providers={PROVIDERS}
      {...props}
    />,
    { wrapper: createWrapperWithClient(makeQueryClient()) }
  );
  return { onClose };
}

beforeEach(() => {
  vi.clearAllMocks();
});

describe("IntegrationConnectionDialog server errors", () => {
  it("shows the server's message inline and in a toast when an edit is rejected", async () => {
    const user = userEvent.setup();
    mockApiClient.patch.mockRejectedValue(
      new ApiError(INVALID_SITE_URL_MESSAGE, 400)
    );
    const { onClose } = renderDialog();

    await user.click(screen.getByRole("button", { name: SAVE_CHANGES }));

    const alert = await screen.findByRole("alert");
    expect(alert).toHaveTextContent(
      IntegrationMutationErrorTitle.UpdateConnection
    );
    expect(alert).toHaveTextContent(INVALID_SITE_URL_MESSAGE);
    expect(mocks.toastError).toHaveBeenCalledTimes(1);
    expect(mocks.toastError).toHaveBeenCalledWith(
      IntegrationMutationErrorTitle.UpdateConnection,
      { description: INVALID_SITE_URL_MESSAGE }
    );
    expect(onClose).not.toHaveBeenCalled();
  });

  it("shows the provider's message when a new connection is rejected", async () => {
    const user = userEvent.setup();
    const message = "Jira rejected the credentials: 401 Unauthorized";
    mockApiClient.post.mockRejectedValue(new ApiError(message, 400));
    const { onClose } = renderDialog({ connection: undefined });

    await user.click(screen.getByRole("button", { name: JIRA_RE }));
    await user.type(
      screen.getByLabelText(SITE_URL_RE),
      "https://acme.atlassian.net"
    );
    await user.type(screen.getByLabelText(BOT_EMAIL_RE), "bot@acme.dev");
    await user.type(screen.getByLabelText(API_TOKEN_RE), "tok-123");
    await user.click(screen.getByRole("button", { name: "Create connection" }));

    const alert = await screen.findByRole("alert");
    expect(alert).toHaveTextContent(
      IntegrationMutationErrorTitle.CreateConnection
    );
    expect(alert).toHaveTextContent(message);
    expect(mocks.toastError).toHaveBeenCalledWith(
      IntegrationMutationErrorTitle.CreateConnection,
      { description: message }
    );
    expect(onClose).not.toHaveBeenCalled();
  });
});

describe("IntegrationConnectionDialog credential origin", () => {
  it("requires the API token again when the site URL changes", async () => {
    const user = userEvent.setup();
    mockApiClient.patch.mockResolvedValue(jiraConnection);
    const { onClose } = renderDialog();
    expect(
      screen.queryByText("Re-enter API token because Site URL changed")
    ).not.toBeInTheDocument();

    const siteUrl = screen.getByLabelText(SITE_URL_RE);
    await user.clear(siteUrl);
    await user.type(siteUrl, "https://other.atlassian.net");

    expect(
      screen.getByText("Re-enter API token because Site URL changed")
    ).toBeInTheDocument();
    expect(
      screen.queryByText("•••• x9Kd - leave empty to keep")
    ).not.toBeInTheDocument();

    await user.click(screen.getByRole("button", { name: SAVE_CHANGES }));
    expect(mockApiClient.patch).not.toHaveBeenCalled();
    expect(screen.getByText(REQUIRED_FIELD_MESSAGE)).toBeInTheDocument();

    await user.type(screen.getByLabelText(API_TOKEN_RE), "new-token");
    await user.click(screen.getByRole("button", { name: SAVE_CHANGES }));

    await waitFor(() => expect(onClose).toHaveBeenCalled());
    expect(mockApiClient.patch).toHaveBeenCalledWith(
      JIRA_PATH,
      expect.objectContaining({
        config: expect.objectContaining({
          siteUrl: "https://other.atlassian.net",
        }),
        secrets: { apiToken: "new-token" },
      })
    );
  });

  it("keeps the stored token when only a non-origin field changes", async () => {
    const user = userEvent.setup();
    mockApiClient.patch.mockResolvedValue(jiraConnection);
    const { onClose } = renderDialog();

    const email = screen.getByLabelText(BOT_EMAIL_RE);
    await user.clear(email);
    await user.type(email, "robot@acme.dev");
    await user.click(screen.getByRole("button", { name: SAVE_CHANGES }));

    await waitFor(() => expect(onClose).toHaveBeenCalled());
    expect(
      screen.queryByText("Re-enter API token because Site URL changed")
    ).not.toBeInTheDocument();
    expect(mockApiClient.patch).toHaveBeenCalledWith(
      JIRA_PATH,
      expect.objectContaining({ secrets: {} })
    );
  });
});

describe("IntegrationConnectionDialog optional secrets", () => {
  it("removes a stored optional secret by sending an empty value", async () => {
    const user = userEvent.setup();
    mockApiClient.patch.mockResolvedValue(webhookConnection);
    const { onClose } = renderDialog({ connection: webhookConnection });

    await user.click(
      screen.getByRole("button", { name: "Remove Outbound signing secret" })
    );
    const field = screen
      .getByText("Outbound signing secret")
      .closest("[data-field-key]");
    expect(
      within(field as HTMLElement).getByText(WILL_BE_REMOVED_RE)
    ).toHaveTextContent("•••• Qk9= will be removed when you save.");
    await user.click(screen.getByRole("button", { name: SAVE_CHANGES }));

    await waitFor(() => expect(onClose).toHaveBeenCalled());
    expect(mockApiClient.patch).toHaveBeenCalledWith(
      WEBHOOK_PATH,
      expect.objectContaining({ secrets: { signingSecret: "" } })
    );
  });

  it("keeps the secret when the removal is undone", async () => {
    const user = userEvent.setup();
    mockApiClient.patch.mockResolvedValue(webhookConnection);
    const { onClose } = renderDialog({ connection: webhookConnection });

    await user.click(
      screen.getByRole("button", { name: "Remove Outbound signing secret" })
    );
    await user.click(
      screen.getByRole("button", { name: "Keep Outbound signing secret" })
    );
    expect(screen.queryByText(WILL_BE_REMOVED_RE)).not.toBeInTheDocument();
    await user.click(screen.getByRole("button", { name: SAVE_CHANGES }));

    await waitFor(() => expect(onClose).toHaveBeenCalled());
    expect(mockApiClient.patch).toHaveBeenCalledWith(
      WEBHOOK_PATH,
      expect.objectContaining({ secrets: {} })
    );
  });

  it("never offers to remove a required secret", () => {
    renderDialog();
    expect(
      screen.queryByRole("button", { name: "Remove API token" })
    ).not.toBeInTheDocument();
  });
});

describe("IntegrationConnectionDialog webhook callback URL", () => {
  it("treats the callback URL as a write-only, removable secret", () => {
    renderDialog({ connection: webhookConnection });

    expect(screen.getByLabelText("Default callback URL")).toHaveAttribute(
      "type",
      "password"
    );
    expect(
      screen.getByText("•••• /c4f - leave empty to keep")
    ).toBeInTheDocument();
    expect(
      screen.getByRole("button", { name: "Remove Default callback URL" })
    ).toBeInTheDocument();
  });

  it("sends a new callback URL with the secrets, never in the config", async () => {
    const user = userEvent.setup();
    mockApiClient.post.mockResolvedValue(webhookConnection);
    const onCreated = vi.fn();
    renderDialog({ connection: undefined, onCreated });

    await user.click(screen.getByRole("button", { name: WEBHOOK_RE }));
    await user.type(
      screen.getByLabelText("Default callback URL"),
      "https://hooks.example.com/catch/123/abc"
    );
    await user.click(screen.getByRole("button", { name: "Create connection" }));

    await waitFor(() => expect(onCreated).toHaveBeenCalled());
    expect(mockApiClient.post).toHaveBeenCalledWith(
      "/integrations/connections",
      {
        provider: IntegrationProviderKey.Webhook,
        name: "Webhook (HTTPS)",
        config: {},
        secrets: { callbackUrl: "https://hooks.example.com/catch/123/abc" },
        deliveryMode: IntegrationDeliveryMode.Webhook,
        pollIntervalSeconds: 120,
      }
    );
  });
});
