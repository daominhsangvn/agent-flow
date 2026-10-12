import {
  type IntegrationDelivery,
  IntegrationDeliveryMode,
  IntegrationDeliveryOutcome,
  IntegrationDeliverySource,
} from "@repo/api/src/types/integration";
import { ApiError } from "@repo/app/shared/api/api-error";
import { render, screen, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { beforeEach, describe, expect, it, vi } from "vitest";
import {
  JIRA_CONNECTION_ID,
  jiraConnection,
  makeConnection,
} from "../../__tests__/integration-fixtures";
import { IntegrationMutationErrorTitle } from "../../lib/mutation-error";
import { IntegrationInboundDialog } from "../integration-inbound-dialog";

const INBOUND_URL = "https://api.acme.dev/webhooks/integrations/key-1";
const INBOUND_SECRET = "whsec_abc123";

const mocks = vi.hoisted(() => ({
  inboundEnabled: vi.fn(),
  rotateMutateAsync: vi.fn(),
  rotateError: null as Error | null,
  deliveries: [] as IntegrationDelivery[],
  copyToClipboard: vi.fn(),
  toastSuccess: vi.fn(),
  toastError: vi.fn(),
}));

vi.mock("../../hooks/use-integrations", () => ({
  useIntegrationInbound: (id: string, options: { enabled: boolean }) => {
    mocks.inboundEnabled(id, options);
    return {
      data: {
        inboundUrl: INBOUND_URL,
        inboundSecret: INBOUND_SECRET,
        setupInstructions: "1. Open **Jira settings**\n2. Add the webhook",
      },
      isLoading: false,
      error: null,
      refetch: vi.fn(),
    };
  },
  useIntegrationDeliveries: () => ({
    data: mocks.deliveries,
    isLoading: false,
    error: null,
    refetch: vi.fn(),
  }),
  useRotateIntegrationInbound: () => ({
    mutateAsync: mocks.rotateMutateAsync,
    isPending: false,
    error: mocks.rotateError,
  }),
}));

vi.mock("@repo/app/shared/lib/clipboard-utils", () => ({
  copyToClipboard: mocks.copyToClipboard,
}));

vi.mock("@repo/design-system/components/ui/sonner", () => ({
  toast: { success: mocks.toastSuccess, error: mocks.toastError },
}));

beforeEach(() => {
  vi.clearAllMocks();
  mocks.deliveries = [];
  mocks.rotateError = null;
});

describe("IntegrationInboundDialog", () => {
  it("shows admins the endpoint, hides the secret until revealed, and renders instructions", async () => {
    const user = userEvent.setup();
    render(
      <IntegrationInboundDialog
        connection={jiraConnection}
        isAdmin
        onClose={vi.fn()}
      />
    );

    expect(mocks.inboundEnabled).toHaveBeenCalledWith(JIRA_CONNECTION_ID, {
      enabled: true,
    });
    expect(screen.getByLabelText("Inbound URL")).toHaveValue(INBOUND_URL);
    const secret = screen.getByLabelText("Secret");
    expect(secret).toHaveAttribute("type", "password");
    await user.click(screen.getByRole("button", { name: "Reveal Secret" }));
    expect(secret).toHaveAttribute("type", "text");
    expect(secret).toHaveValue(INBOUND_SECRET);
    // Markdown, not raw text.
    expect(screen.getByText("Jira settings").tagName).toBe("STRONG");
  });

  it("copies the URL and the secret", async () => {
    const user = userEvent.setup();
    mocks.copyToClipboard.mockResolvedValue(true);
    render(
      <IntegrationInboundDialog
        connection={jiraConnection}
        isAdmin
        onClose={vi.fn()}
      />
    );

    await user.click(screen.getByRole("button", { name: "Copy Inbound URL" }));
    await user.click(screen.getByRole("button", { name: "Copy Secret" }));
    expect(mocks.copyToClipboard).toHaveBeenNthCalledWith(1, INBOUND_URL);
    expect(mocks.copyToClipboard).toHaveBeenNthCalledWith(2, INBOUND_SECRET);
    expect(mocks.toastSuccess).toHaveBeenCalledWith("Secret copied");
  });

  it("reports a failed copy", async () => {
    const user = userEvent.setup();
    mocks.copyToClipboard.mockResolvedValue(false);
    render(
      <IntegrationInboundDialog
        connection={jiraConnection}
        isAdmin
        onClose={vi.fn()}
      />
    );

    await user.click(screen.getByRole("button", { name: "Copy Secret" }));
    expect(mocks.toastError).toHaveBeenCalledWith("Couldn't copy the secret");
  });

  it("rotates the URL and secret only after confirmation", async () => {
    const user = userEvent.setup();
    mocks.rotateMutateAsync.mockResolvedValue({});
    render(
      <IntegrationInboundDialog
        connection={jiraConnection}
        isAdmin
        onClose={vi.fn()}
      />
    );

    await user.click(
      screen.getByRole("button", { name: "Rotate URL and secret" })
    );
    expect(mocks.rotateMutateAsync).not.toHaveBeenCalled();
    const confirm = await screen.findByRole("dialog", {
      name: "Rotate the inbound URL and secret?",
    });
    await user.click(within(confirm).getByRole("button", { name: "Rotate" }));
    expect(mocks.rotateMutateAsync).toHaveBeenCalledWith(JIRA_CONNECTION_ID);
  });

  it("shows the server's message when a rotation fails", () => {
    const message = "Inbound delivery is off for this connection";
    mocks.rotateError = new ApiError(message, 409);
    render(
      <IntegrationInboundDialog
        connection={jiraConnection}
        isAdmin
        onClose={vi.fn()}
      />
    );

    const section = screen.getByRole("region", { name: "Inbound endpoint" });
    const alert = within(section).getByRole("alert");
    expect(alert).toHaveTextContent(
      IntegrationMutationErrorTitle.RotateInbound
    );
    expect(alert).toHaveTextContent(message);
  });

  it("shows members only the deliveries, never the secret", () => {
    render(
      <IntegrationInboundDialog
        connection={jiraConnection}
        isAdmin={false}
        onClose={vi.fn()}
      />
    );

    expect(mocks.inboundEnabled).not.toHaveBeenCalled();
    expect(screen.queryByLabelText("Secret")).not.toBeInTheDocument();
    expect(screen.getByText("Recent deliveries")).toBeInTheDocument();
  });

  it("skips the endpoint section for a polling connection", () => {
    render(
      <IntegrationInboundDialog
        connection={makeConnection({
          deliveryMode: IntegrationDeliveryMode.Poll,
          inboundUrl: null,
        })}
        isAdmin
        onClose={vi.fn()}
      />
    );

    expect(mocks.inboundEnabled).not.toHaveBeenCalled();
    expect(
      screen.getByText("No deliveries yet.", { exact: false })
    ).toBeInTheDocument();
  });

  it("lists recent deliveries with their outcome and run count", () => {
    mocks.deliveries = [
      {
        id: "d1",
        deliveryId: "jira-123",
        source: IntegrationDeliverySource.Webhook,
        eventType: "jira:issue_updated",
        outcome: IntegrationDeliveryOutcome.Accepted,
        detail: null,
        runCount: 1,
        receivedAt: new Date(),
      },
      {
        id: "d2",
        deliveryId: "poll:PROJ-2",
        source: IntegrationDeliverySource.Poll,
        eventType: null,
        outcome: IntegrationDeliveryOutcome.Ignored,
        detail: "no trigger matched",
        runCount: 0,
        receivedAt: new Date(),
      },
    ];
    render(
      <IntegrationInboundDialog
        connection={jiraConnection}
        isAdmin={false}
        onClose={vi.fn()}
      />
    );

    const rows = screen.getAllByRole("row");
    expect(rows).toHaveLength(3);
    expect(within(rows[1]).getByText("Accepted")).toBeInTheDocument();
    expect(within(rows[1]).getByText("jira:issue_updated")).toBeInTheDocument();
    expect(within(rows[2]).getByText("Ignored")).toBeInTheDocument();
    expect(within(rows[2]).getByText("no trigger matched")).toBeInTheDocument();
    expect(within(rows[2]).getByText("Poll")).toBeInTheDocument();
  });
});
