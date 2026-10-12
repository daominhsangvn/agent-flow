import { randomUUID } from "node:crypto";
import type { Page } from "@playwright/test";
import { IntegrationProviderKey } from "@repo/api/src/types/integration";
import { LoopCommand, LoopStatus } from "@repo/api/src/types/loop";
import {
  ProcessStepType,
  type RunProcessView,
} from "@repo/api/src/types/project-process";
import {
  type WorkflowRunDetail,
  WorkflowRunStatus,
} from "@repo/api/src/types/workflow";
import { requireOrgClaims } from "./helpers/better-auth";
import { E2ETag } from "./helpers/tags";
import { expect, test } from "./test";

// The run page's Process card on a run that follows a project process. A run
// only reaches its questions or its approval after agent steps ran on a
// runner, so the run itself is served by a route (the rest of the page is
// real): the questions form and the approval panel send what a person gave
// to POST /workflow-runs/{id}/answers and /approval.

const SPEC_FILE = {
  path: ".agentflow-ai/work/feature/spec.md",
  content: "# Color picker spec\n\nPick a color, copy it.",
  truncated: false,
};
/** The workflow's HTTP request trigger (webhook provider). */
const WEBHOOK_REQUEST_TRIGGER = "webhook.request";
const ANSWERS_SENT_RE = /Answers sent to "Clarify"/;
const DECIDED_RE = /Decided\. The run goes on in a moment\./;

type RunRoute = {
  runId: string;
  url: string;
  /** Bodies POSTed to the run's answers / approval endpoints. */
  posted: Array<{ path: string; body: unknown }>;
};

test.describe("workflow run process card", { tag: E2ETag.Smoke }, () => {
  test("answers the questions of the waiting step", async ({
    apiToken,
    page,
  }) => {
    const run = await serveRun(page, apiToken, {
      status: WorkflowRunStatus.NeedsInput,
      process: processView({
        stepId: "clarify",
        waiting: {
          stepId: "clarify",
          questions: [
            {
              id: "q1",
              question: "Which id format?",
              options: ["Integers", "UUIDs"],
            },
            { id: "q2", question: "Keep a history?" },
          ],
          askedAt: new Date().toISOString(),
          answered: false,
        },
      }),
    });

    await page.goto(run.url);
    const card = page.getByTestId("workflow-run-process");
    await expect(card).toBeVisible({ timeout: 30_000 });
    await expect(
      card.getByTestId("process-run-step").filter({ hasText: "Clarify" })
    ).toHaveAttribute("data-progress", "current");
    await expect(card.getByTestId("run-step-files")).toContainText(
      SPEC_FILE.path
    );

    const form = page.getByTestId("run-step-questions");
    const send = form.getByRole("button", { name: "Send answers" });
    await expect(send).toBeDisabled();
    const uuids = form.getByRole("button", { name: "UUIDs", exact: true });
    await uuids.click();
    await expect(uuids).toHaveAttribute("aria-pressed", "true");
    await form.getByLabel("Keep a history?").fill("Yes, the last 10");
    await send.click();

    await expect(page.getByText(ANSWERS_SENT_RE)).toBeVisible();
    expect(run.posted).toEqual([
      {
        path: "answers",
        body: {
          answers: [
            { id: "q1", answer: "UUIDs" },
            { id: "q2", answer: "Yes, the last 10" },
          ],
        },
      },
    ]);
  });

  test("approves the waiting approval step with a comment", async ({
    apiToken,
    page,
  }) => {
    const run = await serveRun(page, apiToken, {
      status: WorkflowRunStatus.NeedsApproval,
      process: processView({
        stepId: "review",
        approval: {
          stepId: "review",
          requestedAt: new Date().toISOString(),
          show: ["specify"],
          decided: false,
        },
      }),
    });

    await page.goto(run.url);
    const panel = page.getByTestId("run-step-approval");
    await expect(panel).toBeVisible({ timeout: 30_000 });
    await expect(panel.getByText(SPEC_FILE.path)).toBeVisible();
    await expect(
      panel.getByRole("heading", { name: "Color picker spec" })
    ).toBeVisible();
    await panel.getByLabel("Comment").fill("Ship it.");
    await panel.getByRole("button", { name: "Approve" }).click();

    await expect(panel.getByText(DECIDED_RE)).toBeVisible();
    expect(run.posted).toEqual([
      { path: "approval", body: { approved: true, comment: "Ship it." } },
    ]);
  });
});

/**
 * Serves GET /workflow-runs/{id} with the given state and records the
 * answers / approval POSTs, after which the run reads as answered / decided.
 */
async function serveRun(
  page: Page,
  apiToken: string,
  state: Pick<WorkflowRunDetail, "status" | "process">
): Promise<RunRoute> {
  const { orgSlug } = requireOrgClaims(apiToken);
  const runId = randomUUID();
  const workflowId = randomUUID();
  const detail = runDetail(runId, workflowId, state);
  const posted: RunRoute["posted"] = [];
  await page.route(`**/workflow-runs/${runId}**`, async (route) => {
    const request = route.request();
    const path = new URL(request.url()).pathname.split("/").at(-1) ?? "";
    if (request.method() === "POST") {
      posted.push({ path, body: request.postDataJSON() });
      if (path === "answers" && detail.process?.waiting) {
        detail.process.waiting.answered = true;
      }
      if (path === "approval" && detail.process?.approval) {
        detail.process.approval.decided = true;
      }
    }
    await route.fulfill({ json: { success: true, data: detail } });
  });
  return {
    runId,
    url: `/${orgSlug}/workflows/${workflowId}/runs/${runId}`,
    posted,
  };
}

function runDetail(
  runId: string,
  workflowId: string,
  state: Pick<WorkflowRunDetail, "status" | "process">
): WorkflowRunDetail {
  const now = new Date();
  return {
    id: runId,
    workflowId,
    workflowName: "PRDs to Color Picker",
    triggerId: null,
    triggerType: WEBHOOK_REQUEST_TRIGGER,
    source: {
      provider: IntegrationProviderKey.Webhook,
      externalId: "prd-color-1",
      key: "COLOR-1",
      title: "Color picker web app",
      url: null,
    },
    prUrl: null,
    error: null,
    createdAt: now,
    updatedAt: now,
    completedAt: null,
    feature: null,
    plan: null,
    branchName: null,
    loops: [
      {
        loopId: randomUUID(),
        command: LoopCommand.Step,
        status: LoopStatus.Completed,
        adopted: false,
        stepId: "specify",
        prUrl: null,
        startedAt: now,
        completedAt: now,
      },
    ],
    actionRuns: [],
    ...state,
  };
}

function processView(
  overrides: Pick<RunProcessView, "stepId"> & Partial<RunProcessView>
): RunProcessView {
  return {
    version: 2,
    toolkit: "contoso/colorkit",
    steps: [
      { id: "specify", name: "Specify", type: ProcessStepType.Agent },
      { id: "clarify", name: "Clarify", type: ProcessStepType.Agent },
      { id: "review", name: "Review the spec", type: ProcessStepType.Approval },
      { id: "implement", name: "Implement", type: ProcessStepType.Agent },
    ],
    waiting: null,
    approval: null,
    stepFiles: [
      { stepId: "specify", loopId: randomUUID(), files: [SPEC_FILE] },
    ],
    ...overrides,
  };
}
