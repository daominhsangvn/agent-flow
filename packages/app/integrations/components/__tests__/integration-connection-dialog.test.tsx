import {
  IntegrationConnectionStatus,
  IntegrationDeliveryMode,
  IntegrationProviderKey,
} from "@repo/api/src/types/integration";
import { ApiError } from "@repo/app/shared/api/api-error";
import { makeQueryClient } from "@repo/app/shared/query/query-client";
import { createWrapperWithClient } from "@repo/app/shared/test-utils";
import {
  fireEvent,
  render,
  screen,
  waitFor,
  within,
} from "@testing-library/react";
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
 * a user sees when the API rejects a save. The YAML editor is a textarea here
 * (CodeMirror needs a layout engine jsdom does not have).
 */

vi.mock("../connection-yaml-editor", async () => {
  const stub = await import("./connection-yaml-editor.test-helpers");
  return stub.connectionYamlEditorModule;
});

const API_TOKEN_RE = /API token/;
const WEBHOOK_RE = /^Webhook/;
const JIRA_RE = /^Jira/;
const WILL_BE_REMOVED_RE = /will be removed when you save/;

const INVALID_SITE_URL_MESSAGE =
  "Invalid configuration: siteUrl: The Jira site URL must start with https://";
const JIRA_PATH = `/integrations/connections/${JIRA_CONNECTION_ID}`;
const WEBHOOK_PATH = `/integrations/connections/${WEBHOOK_CONNECTION_ID}`;
const SAVE_CHANGES = "Save changes";
const CREATE_CONNECTION = "Create connection";
const STORED_SITE_URL = "https://acme.atlassian.net";

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

async function yamlBox(): Promise<HTMLTextAreaElement> {
  return (await screen.findByRole("textbox", {
    name: "Connection YAML",
  })) as HTMLTextAreaElement;
}

async function editYaml(edit: (text: string) => string) {
  const box = await yamlBox();
  fireEvent.change(box, { target: { value: edit(box.value) } });
}

function problems(): HTMLElement {
  return screen.getByTestId("connection-yaml-problems");
}

beforeEach(() => {
  vi.clearAllMocks();
});

describe("IntegrationConnectionDialog YAML", () => {
  it("starts a new connection from the provider's settings, secrets left out", async () => {
    const user = userEvent.setup();
    renderDialog({ connection: undefined });

    await user.click(screen.getByRole("button", { name: JIRA_RE }));

    const text = (await yamlBox()).value;
    expect(text).toContain("name: Jira");
    expect(text).toContain("  deployment: cloud");
    expect(text).toContain('  siteUrl: ""');
    expect(text).toContain('  email: ""');
    expect(text).toContain("  mode: webhook");
    expect(text).toContain("  pollIntervalSeconds: 120");
    expect(text).not.toContain("apiToken:");
    expect(text).not.toContain("enabled:");
    expect(screen.getByLabelText(API_TOKEN_RE)).toHaveAttribute(
      "type",
      "password"
    );
  });

  it("shows the stored connection as YAML", async () => {
    renderDialog();

    const text = (await yamlBox()).value;
    expect(text).toContain("name: Acme Jira");
    expect(text).toContain("enabled: true");
    expect(text).toContain(`  siteUrl: ${STORED_SITE_URL}`);
    expect(text).toContain("  email: bot@acme.dev");
  });

  it("creates the connection the YAML describes, with the typed secret", async () => {
    const user = userEvent.setup();
    mockApiClient.post.mockResolvedValue(jiraConnection);
    const onCreated = vi.fn();
    renderDialog({ connection: undefined, onCreated });

    await user.click(screen.getByRole("button", { name: JIRA_RE }));
    await editYaml((text) =>
      text
        .replace("name: Jira", "name: Acme Jira")
        .replace('siteUrl: ""', `siteUrl: ${STORED_SITE_URL}`)
        .replace('email: ""', "email: bot@acme.dev")
        .replace("mode: webhook", "mode: poll")
        .replace("pollIntervalSeconds: 120", "pollIntervalSeconds: 300")
    );
    await user.type(screen.getByLabelText(API_TOKEN_RE), "tok-123");
    await user.click(screen.getByRole("button", { name: CREATE_CONNECTION }));

    await waitFor(() => expect(onCreated).toHaveBeenCalled());
    expect(mockApiClient.post).toHaveBeenCalledWith(
      "/integrations/connections",
      {
        provider: IntegrationProviderKey.Jira,
        name: "Acme Jira",
        config: {
          deployment: "cloud",
          siteUrl: STORED_SITE_URL,
          email: "bot@acme.dev",
        },
        secrets: { apiToken: "tok-123" },
        deliveryMode: IntegrationDeliveryMode.Poll,
        pollIntervalSeconds: 300,
      }
    );
  });

  it("lists the YAML's problems by line and does not save", async () => {
    const user = userEvent.setup();
    renderDialog({ connection: undefined });

    await user.click(screen.getByRole("button", { name: JIRA_RE }));
    await editYaml((text) =>
      text
        .replace('email: ""', "email: not-an-email")
        .replace("mode: webhook", "mode: carrier_pigeon")
    );
    await user.type(screen.getByLabelText(API_TOKEN_RE), "tok-123");
    await user.click(screen.getByRole("button", { name: CREATE_CONNECTION }));

    expect(mockApiClient.post).not.toHaveBeenCalled();
    const list = problems();
    expect(list).toHaveTextContent(REQUIRED_FIELD_MESSAGE);
    expect(list).toHaveTextContent("Enter a valid email address");
    expect(list).toHaveTextContent("Write one of: webhook, poll, none");
    expect(
      screen.getByText("Fix the problems in the YAML before saving.")
    ).toBeInTheDocument();
  });

  it("refuses a secret written in the YAML", async () => {
    const user = userEvent.setup();
    renderDialog();

    await editYaml((text) =>
      text.replace(
        "  email: bot@acme.dev",
        "  email: bot@acme.dev\n  apiToken: tok-123"
      )
    );
    await user.click(screen.getByRole("button", { name: SAVE_CHANGES }));

    expect(mockApiClient.patch).not.toHaveBeenCalled();
    expect(problems()).toHaveTextContent(
      'apiToken is a secret: type it in the "API token" field under the editor'
    );
  });

  it("disables the connection with enabled: false", async () => {
    const user = userEvent.setup();
    mockApiClient.patch.mockResolvedValue(jiraConnection);
    const { onClose } = renderDialog();

    await editYaml((text) => text.replace("enabled: true", "enabled: false"));
    await user.click(screen.getByRole("button", { name: SAVE_CHANGES }));

    await waitFor(() => expect(onClose).toHaveBeenCalled());
    expect(mockApiClient.patch).toHaveBeenCalledWith(
      JIRA_PATH,
      expect.objectContaining({ status: IntegrationConnectionStatus.Disabled })
    );
  });
});

describe("IntegrationConnectionDialog server errors", () => {
  it("shows the server's message inline and in a toast when an edit is rejected", async () => {
    const user = userEvent.setup();
    mockApiClient.patch.mockRejectedValue(
      new ApiError(INVALID_SITE_URL_MESSAGE, 400)
    );
    const { onClose } = renderDialog();
    await yamlBox();

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
    await editYaml((text) =>
      text
        .replace('siteUrl: ""', `siteUrl: ${STORED_SITE_URL}`)
        .replace('email: ""', "email: bot@acme.dev")
    );
    await user.type(screen.getByLabelText(API_TOKEN_RE), "tok-123");
    await user.click(screen.getByRole("button", { name: CREATE_CONNECTION }));

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
    await yamlBox();
    expect(
      screen.queryByText("Re-enter API token because Site URL changed")
    ).not.toBeInTheDocument();

    await editYaml((text) =>
      text.replace(STORED_SITE_URL, "https://other.atlassian.net")
    );

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

  it("keeps the stored token when only a non-origin setting changes", async () => {
    const user = userEvent.setup();
    mockApiClient.patch.mockResolvedValue(jiraConnection);
    const { onClose } = renderDialog();

    await editYaml((text) => text.replace("bot@acme.dev", "robot@acme.dev"));
    await user.click(screen.getByRole("button", { name: SAVE_CHANGES }));

    await waitFor(() => expect(onClose).toHaveBeenCalled());
    expect(
      screen.queryByText("Re-enter API token because Site URL changed")
    ).not.toBeInTheDocument();
    expect(mockApiClient.patch).toHaveBeenCalledWith(
      JIRA_PATH,
      expect.objectContaining({
        config: expect.objectContaining({ email: "robot@acme.dev" }),
        secrets: {},
      })
    );
  });
});

describe("IntegrationConnectionDialog optional secrets", () => {
  it("removes a stored optional secret by sending an empty value", async () => {
    const user = userEvent.setup();
    mockApiClient.patch.mockResolvedValue(webhookConnection);
    const { onClose } = renderDialog({ connection: webhookConnection });
    await yamlBox();

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
    await yamlBox();

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

  it("never offers to remove a required secret", async () => {
    renderDialog();
    await yamlBox();
    expect(
      screen.queryByRole("button", { name: "Remove API token" })
    ).not.toBeInTheDocument();
  });
});

describe("IntegrationConnectionDialog webhook callback URL", () => {
  it("treats the callback URL as a write-only, removable secret", async () => {
    renderDialog({ connection: webhookConnection });
    await yamlBox();

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
    await yamlBox();
    await user.type(
      screen.getByLabelText("Default callback URL"),
      "https://hooks.example.com/catch/123/abc"
    );
    await user.click(screen.getByRole("button", { name: CREATE_CONNECTION }));

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
