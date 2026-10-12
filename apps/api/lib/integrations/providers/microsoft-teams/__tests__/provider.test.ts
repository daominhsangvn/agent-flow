import {
  IntegrationFieldKind,
  IntegrationProviderKey,
} from "@repo/api/src/types/integration";
import {
  WorkflowActionRunStatus,
  WorkflowRunEvent,
} from "@repo/api/src/types/workflow";
import { describe, expect, it, vi } from "vitest";
import { z } from "zod";
import type { WorkflowRunSnapshot } from "../../../types";
import { HttpMethod, ValidateConnectionReason } from "../../../types";
import { teamsConnectionSecretsSchema } from "../connection";
import {
  TEAMS_DEFAULT_MESSAGE_TEMPLATE,
  TEAMS_DEFAULT_TITLE_TEMPLATE,
  TeamsActionType,
  type TeamsPostMessageConfig,
  teamsPostMessageConfigSchema,
} from "../post-message-action";
import { microsoftTeamsProvider } from "../provider";
import { TEAMS_RETIRED_CONNECTOR_ERROR } from "../webhook-url";
import {
  ACTION_RUN_ID,
  fakeHttp,
  httpResponse,
  makePreActionRunSnapshot,
  makeRunSnapshot,
  makeTeamsContext,
  renderer,
  silentLog,
  TEAMS_WEBHOOK_URL,
} from "./teams.test-helpers";

const CONNECTOR_URL =
  "https://contoso.webhook.office.com/webhookb2/abc@def/IncomingWebhook/123/456";

const postedCardSchema = z.object({
  type: z.literal("message"),
  attachments: z
    .array(
      z.object({
        content: z.object({
          body: z.array(
            z.object({ type: z.string(), text: z.string().optional() }).loose()
          ),
          actions: z.array(z.object({ title: z.string() }).loose()).optional(),
        }),
      })
    )
    .length(1),
});

describe("microsoftTeamsProvider definition", () => {
  it("is an action-only provider", () => {
    expect(microsoftTeamsProvider.key).toBe(
      IntegrationProviderKey.MicrosoftTeams
    );
    expect(microsoftTeamsProvider.inbound).toBeUndefined();
    expect(microsoftTeamsProvider.source).toBeUndefined();
    expect(microsoftTeamsProvider.triggers).toEqual([]);
    expect(microsoftTeamsProvider.actions.map((action) => action.key)).toEqual([
      TeamsActionType.PostMessage,
    ]);
  });

  it("declares the webhook URL as its only, secret connection field", () => {
    expect(microsoftTeamsProvider.connection.fields).toEqual([
      expect.objectContaining({
        key: "webhookUrl",
        kind: IntegrationFieldKind.Secret,
        required: true,
      }),
    ]);
  });
});

describe("teamsConnectionSecretsSchema", () => {
  it("accepts and trims a Workflows URL", () => {
    expect(
      teamsConnectionSecretsSchema.parse({
        webhookUrl: ` ${TEAMS_WEBHOOK_URL} `,
      })
    ).toEqual({ webhookUrl: TEAMS_WEBHOOK_URL });
  });

  it("rejects a retired connector URL with the explanation", () => {
    const result = teamsConnectionSecretsSchema.safeParse({
      webhookUrl: CONNECTOR_URL,
    });

    expect(result.success).toBe(false);
    expect(result.error?.issues.map((issue) => issue.message)).toEqual([
      TEAMS_RETIRED_CONNECTOR_ERROR,
    ]);
  });

  it("requires a URL", () => {
    expect(
      teamsConnectionSecretsSchema.safeParse({ webhookUrl: "" }).success
    ).toBe(false);
    expect(teamsConnectionSecretsSchema.safeParse({}).success).toBe(false);
  });
});

describe("microsoftTeamsProvider.connection.validate", () => {
  const validate = microsoftTeamsProvider.connection.validate;

  it("checks the URL without calling Teams on save", async () => {
    const { http, requests } = fakeHttp();

    const result = await validate(
      makeTeamsContext({ http }),
      ValidateConnectionReason.Save
    );

    expect(result).toEqual({ ok: true, account: null });
    expect(requests).toEqual([]);
  });

  it("rejects a connector URL on save", async () => {
    const { http, requests } = fakeHttp();

    const result = await validate(
      makeTeamsContext({ http, webhookUrl: CONNECTOR_URL }),
      ValidateConnectionReason.Save
    );

    expect(result).toEqual({ ok: false, error: TEAMS_RETIRED_CONNECTOR_ERROR });
    expect(requests).toEqual([]);
  });

  it("posts a test card on test and succeeds on 202", async () => {
    const { http, requests } = fakeHttp(httpResponse({ status: 202 }));

    const result = await validate(
      makeTeamsContext({ http }),
      ValidateConnectionReason.Test
    );

    expect(result).toEqual({ ok: true, account: null });
    expect(requests).toHaveLength(1);
    expect(requests[0]).toMatchObject({
      method: HttpMethod.Post,
      url: TEAMS_WEBHOOK_URL,
    });
    const posted = postedCardSchema.parse(requests[0]?.body);
    expect(posted.attachments[0]?.content.body[0]?.text).toBe(
      "AgentFlow is connected"
    );
  });

  it("reports a refused test without exposing the URL", async () => {
    const { http } = fakeHttp(
      httpResponse({
        status: 401,
        json: {
          error: { code: "DirectApiAuthorizationRequired", message: "x" },
        },
      })
    );
    const log = silentLog();

    const result = await validate(
      makeTeamsContext({ http, log }),
      ValidateConnectionReason.Test
    );

    expect(result.ok).toBe(false);
    const error = result.ok ? "" : result.error;
    expect(error).toContain("HTTP 401");
    expect(error).toContain("DirectApiAuthorizationRequired");
    expect(error).toContain("Anyone");
    expect(error).not.toContain("SECRET-SIGNATURE");
    expect(error).not.toContain("powerplatform.com");
    expect(JSON.stringify(vi.mocked(log.warn).mock.calls)).not.toContain(
      "SECRET-SIGNATURE"
    );
  });

  it("redacts the URL from transport errors", async () => {
    const { http } = fakeHttp(
      httpResponse({
        status: 0,
        error: `request to ${TEAMS_WEBHOOK_URL} failed, reason: getaddrinfo ENOTFOUND`,
        retryable: true,
      })
    );

    const result = await validate(
      makeTeamsContext({ http }),
      ValidateConnectionReason.Test
    );

    const error = result.ok ? "" : result.error;
    expect(error).toContain("Could not reach the Teams Workflows webhook");
    expect(error).toContain("ENOTFOUND");
    expect(error).not.toContain("SECRET-SIGNATURE");
    expect(error).not.toContain("powerplatform.com");
  });
});

describe("microsoft_teams.post_message", () => {
  const action = microsoftTeamsProvider.actions[0];
  if (!action) {
    throw new Error("post_message action missing");
  }

  function actionContext(options: {
    response?: ReturnType<typeof httpResponse>;
    webhookUrl?: string;
    config?: Partial<TeamsPostMessageConfig>;
    run?: WorkflowRunSnapshot;
  }) {
    const { http, requests } = fakeHttp(options.response ?? httpResponse());
    const run = options.run ?? makeRunSnapshot();
    const log = silentLog();
    const context = {
      ...makeTeamsContext({ http, webhookUrl: options.webhookUrl, log }),
      config: teamsPostMessageConfigSchema.parse(options.config ?? {}),
      run,
      actionRunId: ACTION_RUN_ID,
      attempt: 1,
      render: renderer(run),
    };
    return { context, requests, log };
  }

  it("defaults to needs_input, succeeded and failed events", () => {
    expect(action.defaultEvents).toEqual([
      WorkflowRunEvent.NeedsInput,
      WorkflowRunEvent.Succeeded,
      WorkflowRunEvent.Failed,
    ]);
  });

  it("fills config defaults", () => {
    expect(teamsPostMessageConfigSchema.parse({})).toEqual({
      title: TEAMS_DEFAULT_TITLE_TEMPLATE,
      message: TEAMS_DEFAULT_MESSAGE_TEMPLATE,
      includeFacts: true,
    });
  });

  it("posts the rendered card and succeeds on 2xx", async () => {
    const { context, requests } = actionContext({});

    const result = await action.execute(context);

    expect(result).toEqual({
      status: WorkflowActionRunStatus.Succeeded,
      detail: "Teams accepted the message (HTTP 202).",
    });
    expect(requests).toHaveLength(1);
    expect(requests[0]?.url).toBe(TEAMS_WEBHOOK_URL);
    const body = postedCardSchema.parse(requests[0]?.body).attachments[0]
      ?.content.body;
    expect(body?.map((block) => block.type)).toEqual([
      "TextBlock",
      "FactSet",
      "TextBlock",
    ]);
    expect(body?.[0]?.text).toBe("Jira intake: PROJ-123");
    expect(body?.[2]?.text).toBe(context.run.summaryMarkdown);
  });

  it("works as a pre action: status and source facts only, no pull request button", async () => {
    const { context, requests } = actionContext({
      run: makePreActionRunSnapshot(),
    });

    const result = await action.execute(context);

    expect(result.status).toBe(WorkflowActionRunStatus.Succeeded);
    const card = postedCardSchema.parse(requests[0]?.body).attachments[0]
      ?.content;
    expect(card?.body).toEqual([
      expect.objectContaining({
        type: "TextBlock",
        text: "Jira intake: PROJ-123",
      }),
      {
        type: "FactSet",
        facts: [
          { title: "Status", value: "Running pre actions" },
          {
            title: "Source",
            value: "[PROJ-123](https://acme.atlassian.net/browse/PROJ-123)",
          },
        ],
      },
      expect.objectContaining({
        type: "TextBlock",
        text: context.run.summaryMarkdown,
      }),
    ]);
    expect(card?.actions?.map((link) => link.title)).toEqual([
      "Open run",
      "Open PROJ-123",
    ]);
  });

  it("honours includeFacts=false and custom templates", async () => {
    const { context, requests } = actionContext({
      config: {
        title: "Done: {{source.key}}",
        message: "# Result\nSee {{pr.url}}",
        includeFacts: false,
      },
    });

    await action.execute(context);

    const body = postedCardSchema.parse(requests[0]?.body).attachments[0]
      ?.content.body;
    expect(body?.map((block) => block.text)).toEqual([
      "Done: PROJ-123",
      "**Result**\nSee https://github.com/acme/repo/pull/42",
    ]);
  });

  it.each([
    [429, true],
    [503, true],
    [400, false],
    [404, false],
  ])("maps HTTP %i to a failed result with retryable=%s", async (status, retryable) => {
    const { context, log } = actionContext({
      response: httpResponse({ status }),
    });

    const result = await action.execute(context);

    expect(result).toEqual({
      status: WorkflowActionRunStatus.Failed,
      error: expect.stringContaining(`HTTP ${status}`),
      retryable,
    });
    expect(JSON.stringify(result)).not.toContain("SECRET-SIGNATURE");
    expect(JSON.stringify(vi.mocked(log.warn).mock.calls)).not.toContain(
      "SECRET-SIGNATURE"
    );
  });

  it("fails without retrying when the stored URL is a retired connector", async () => {
    const { context, requests } = actionContext({ webhookUrl: CONNECTOR_URL });

    const result = await action.execute(context);

    expect(result).toEqual({
      status: WorkflowActionRunStatus.Failed,
      error: TEAMS_RETIRED_CONNECTOR_ERROR,
      retryable: false,
    });
    expect(requests).toEqual([]);
  });
});
