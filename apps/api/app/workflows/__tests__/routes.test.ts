import { Result, Status } from "@repo/api/src/types/result";
import {
  WorkflowRunRetryMode,
  WorkflowRunStatus,
} from "@repo/api/src/types/workflow";
import { WorkflowAgentMode } from "@repo/api/src/types/workflow-agent-mode";
import { NextRequest } from "next/server";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { JiraTriggerType } from "@/lib/integrations/providers/jira/constants";

const mocks = vi.hoisted(() => ({
  authContext: {
    clerkOrgId: "auth-org-1",
    clerkUserId: "auth-user-1",
    user: { id: "user-1", organizationId: "org-1" },
  },
  getOrgAdminStatus: vi.fn(),
  workflowService: {
    list: vi.fn(),
    get: vi.fn(),
    create: vi.fn(),
    update: vi.fn(),
    setEnabled: vi.fn(),
    remove: vi.fn(),
  },
  runService: {
    list: vi.fn(),
    get: vi.fn(),
    cancel: vi.fn(),
    retry: vi.fn(),
    retryActionRun: vi.fn(),
    startManualRun: vi.fn(),
  },
}));

vi.mock("@/lib/auth/with-any-auth", () => ({
  withAnyAuth:
    (handler: (...args: unknown[]) => Promise<Response>) =>
    (request: NextRequest, context: { params: Promise<unknown> }) =>
      handler(mocks.authContext, request, context?.params),
}));
vi.mock("@/lib/auth/org-admin", () => ({
  getOrgAdminStatus: mocks.getOrgAdminStatus,
}));
vi.mock("@/lib/workflows/workflow-service", () => ({
  workflowService: mocks.workflowService,
}));
vi.mock("@/lib/workflows/run-service", () => ({
  RUN_LIST_MAX_LIMIT: 100,
  workflowRunService: mocks.runService,
}));
vi.mock("@repo/observability/log", () => ({
  log: {
    info: vi.fn(),
    warn: vi.fn(),
    error: vi.fn(),
    debug: vi.fn(),
    flush: vi.fn(() => Promise.resolve()),
  },
}));

import { POST as retryActionRun } from "@/app/workflow-runs/[runId]/action-runs/[actionRunId]/retry/route";
import { POST as cancelRun } from "@/app/workflow-runs/[runId]/cancel/route";
import { POST as retryRun } from "@/app/workflow-runs/[runId]/retry/route";
import { GET as getRun } from "@/app/workflow-runs/[runId]/route";
import { GET as listOrgRuns } from "@/app/workflow-runs/route";
import {
  DELETE as deleteWorkflow,
  GET as getWorkflow,
  PATCH as patchWorkflow,
  PUT as putWorkflow,
} from "@/app/workflows/[id]/route";
import {
  GET as listWorkflowRuns,
  POST as startRun,
} from "@/app/workflows/[id]/runs/route";
import {
  POST as createWorkflow,
  GET as listWorkflows,
} from "@/app/workflows/route";

const WORKFLOW_ID = "0199a5f0-0000-7000-8000-0000000000f1";
const RUN_ID = "0199a5f0-0000-7000-8000-0000000000b1";
const TRIGGER_ID = "0199a5f0-0000-7000-8000-0000000000e1";
const BASE_URL = "http://localhost";

const VALID_BODY = {
  name: "Jira to PR",
  projectId: "0199a5f0-0000-7000-8000-0000000000d1",
  agent: {
    computeTargetId: "0199a5f0-0000-7000-8000-0000000000c1",
    mode: WorkflowAgentMode.Plan,
  },
  triggers: [
    {
      connectionKey: "jira",
      type: JiraTriggerType.IssueAssigned,
    },
  ],
  actions: [],
};

beforeEach(() => {
  vi.clearAllMocks();
  mocks.getOrgAdminStatus.mockResolvedValue({ isAdmin: true, reason: "admin" });
});

function request(path: string, method = "GET", body?: unknown) {
  return new NextRequest(`${BASE_URL}${path}`, {
    method,
    body: body === undefined ? undefined : JSON.stringify(body),
    headers: { "content-type": "application/json" },
  });
}

function params(values: Record<string, string>) {
  return { params: Promise.resolve(values) };
}

async function json(response: Response) {
  return { status: response.status, body: await response.json() };
}

describe("admin gate", () => {
  beforeEach(() => {
    mocks.getOrgAdminStatus.mockResolvedValue({
      isAdmin: false,
      reason: "not_admin",
    });
  });

  it.each([
    [
      "POST /workflows",
      () =>
        createWorkflow(request("/workflows", "POST", VALID_BODY), params({})),
    ],
    [
      "PUT /workflows/{id}",
      () =>
        putWorkflow(
          request(`/workflows/${WORKFLOW_ID}`, "PUT", VALID_BODY),
          params({ id: WORKFLOW_ID })
        ),
    ],
    [
      "PATCH /workflows/{id}",
      () =>
        patchWorkflow(
          request(`/workflows/${WORKFLOW_ID}`, "PATCH", { enabled: false }),
          params({ id: WORKFLOW_ID })
        ),
    ],
    [
      "DELETE /workflows/{id}",
      () =>
        deleteWorkflow(
          request(`/workflows/${WORKFLOW_ID}`, "DELETE"),
          params({ id: WORKFLOW_ID })
        ),
    ],
    [
      "POST /workflows/{id}/runs",
      () =>
        startRun(
          request(`/workflows/${WORKFLOW_ID}/runs`, "POST", {
            triggerId: TRIGGER_ID,
            input: "PROJ-1",
          }),
          params({ id: WORKFLOW_ID })
        ),
    ],
    [
      "POST /workflow-runs/{id}/cancel",
      () =>
        cancelRun(
          request(`/workflow-runs/${RUN_ID}/cancel`, "POST"),
          params({ runId: RUN_ID })
        ),
    ],
    [
      "POST /workflow-runs/{id}/retry",
      () =>
        retryRun(
          request(`/workflow-runs/${RUN_ID}/retry`, "POST"),
          params({ runId: RUN_ID })
        ),
    ],
    [
      "POST /workflow-runs/{id}/action-runs/{id}/retry",
      () =>
        retryActionRun(
          request(
            `/workflow-runs/${RUN_ID}/action-runs/${RUN_ID}/retry`,
            "POST"
          ),
          params({ runId: RUN_ID, actionRunId: RUN_ID })
        ),
    ],
  ])("%s answers 403 for a non-admin", async (_label, call) => {
    const response = await call();

    expect(response.status).toBe(403);
    expect(mocks.workflowService.create).not.toHaveBeenCalled();
    expect(mocks.workflowService.update).not.toHaveBeenCalled();
    expect(mocks.workflowService.setEnabled).not.toHaveBeenCalled();
    expect(mocks.workflowService.remove).not.toHaveBeenCalled();
    expect(mocks.runService.startManualRun).not.toHaveBeenCalled();
    expect(mocks.runService.cancel).not.toHaveBeenCalled();
    expect(mocks.runService.retry).not.toHaveBeenCalled();
    expect(mocks.runService.retryActionRun).not.toHaveBeenCalled();
  });

  it("lets any member read, as a viewer who is not an admin", async () => {
    mocks.workflowService.list.mockResolvedValue([]);
    mocks.workflowService.get.mockResolvedValue({ id: WORKFLOW_ID });

    const response = await json(
      await listWorkflows(request("/workflows"), params({}))
    );
    const single = await getWorkflow(
      request(`/workflows/${WORKFLOW_ID}`),
      params({ id: WORKFLOW_ID })
    );

    expect(response.status).toBe(200);
    expect(response.body.data).toEqual({ workflows: [] });
    expect(single.status).toBe(200);
    expect(mocks.workflowService.list).toHaveBeenCalledWith("org-1", {
      isAdmin: false,
    });
    expect(mocks.workflowService.get).toHaveBeenCalledWith(
      "org-1",
      WORKFLOW_ID,
      { isAdmin: false }
    );
  });
});

describe("workflow routes", () => {
  it("reads as an admin viewer for org admins", async () => {
    mocks.workflowService.list.mockResolvedValue([]);

    await listWorkflows(request("/workflows"), params({}));

    expect(mocks.workflowService.list).toHaveBeenCalledWith("org-1", {
      isAdmin: true,
    });
  });

  it("turns a workflow on or off with PATCH", async () => {
    mocks.workflowService.setEnabled.mockResolvedValue(
      Result.ok({ id: WORKFLOW_ID, enabled: false })
    );

    const response = await json(
      await patchWorkflow(
        request(`/workflows/${WORKFLOW_ID}`, "PATCH", { enabled: false }),
        params({ id: WORKFLOW_ID })
      )
    );

    expect(response.status).toBe(200);
    expect(response.body.data).toEqual({ id: WORKFLOW_ID, enabled: false });
    expect(mocks.workflowService.setEnabled).toHaveBeenCalledWith(
      "org-1",
      WORKFLOW_ID,
      "user-1",
      { enabled: false }
    );
  });

  it("answers 400 with the reason when the workflow cannot be turned on", async () => {
    mocks.workflowService.setEnabled.mockResolvedValue(
      Result.err({
        status: Status.BadRequest,
        message: "Trigger 1: integration connection not found.",
      })
    );

    const response = await json(
      await patchWorkflow(
        request(`/workflows/${WORKFLOW_ID}`, "PATCH", { enabled: true }),
        params({ id: WORKFLOW_ID })
      )
    );

    expect(response.status).toBe(400);
    expect(JSON.stringify(response.body)).toContain(
      "integration connection not found"
    );
  });

  it("rejects a PATCH body without the enabled flag", async () => {
    const response = await patchWorkflow(
      request(`/workflows/${WORKFLOW_ID}`, "PATCH", { name: "x" }),
      params({ id: WORKFLOW_ID })
    );

    expect(response.status).toBe(400);
    expect(mocks.workflowService.setEnabled).not.toHaveBeenCalled();
  });

  it("creates a workflow from a parsed body", async () => {
    mocks.workflowService.create.mockResolvedValue(
      Result.ok({ id: WORKFLOW_ID })
    );

    const response = await json(
      await createWorkflow(
        request("/workflows", "POST", VALID_BODY),
        params({})
      )
    );

    expect(response.status).toBe(200);
    expect(mocks.workflowService.create).toHaveBeenCalledWith(
      "org-1",
      "user-1",
      expect.objectContaining({
        name: "Jira to PR",
        enabled: true,
        agent: expect.objectContaining({ stopOnOpenQuestions: true }),
      })
    );
  });

  it("answers 400 for an invalid body without calling the service", async () => {
    const response = await createWorkflow(
      request("/workflows", "POST", { ...VALID_BODY, triggers: [] }),
      params({})
    );

    expect(response.status).toBe(400);
    expect(mocks.workflowService.create).not.toHaveBeenCalled();
  });

  it("maps service errors to their status", async () => {
    mocks.workflowService.update.mockResolvedValue(
      Result.err({ status: Status.BadRequest, message: "Project not found" })
    );

    const response = await json(
      await putWorkflow(
        request(`/workflows/${WORKFLOW_ID}`, "PUT", VALID_BODY),
        params({ id: WORKFLOW_ID })
      )
    );

    expect(response.status).toBe(400);
    expect(JSON.stringify(response.body)).toContain("Project not found");
  });

  it("answers 404 for an unknown workflow", async () => {
    mocks.workflowService.get.mockResolvedValue(null);

    const response = await getWorkflow(
      request(`/workflows/${WORKFLOW_ID}`),
      params({ id: WORKFLOW_ID })
    );

    expect(response.status).toBe(404);
  });

  it("lists a workflow's runs with parsed query parameters", async () => {
    mocks.runService.list.mockResolvedValue(
      Result.ok({ runs: [], nextCursor: null })
    );

    const response = await listWorkflowRuns(
      request(
        `/workflows/${WORKFLOW_ID}/runs?limit=10&status=${WorkflowRunStatus.Failed}`
      ),
      params({ id: WORKFLOW_ID })
    );

    expect(response.status).toBe(200);
    expect(mocks.runService.list).toHaveBeenCalledWith("org-1", {
      limit: 10,
      status: WorkflowRunStatus.Failed,
      workflowId: WORKFLOW_ID,
    });
  });

  it("rejects unsupported run list filters", async () => {
    const response = await listOrgRuns(
      request("/workflow-runs?projectId=x"),
      params({})
    );

    expect(response.status).toBe(400);
    expect(mocks.runService.list).not.toHaveBeenCalled();
  });

  it("starts a manual run", async () => {
    mocks.runService.startManualRun.mockResolvedValue(
      Result.ok({ id: RUN_ID })
    );

    const response = await startRun(
      request(`/workflows/${WORKFLOW_ID}/runs`, "POST", {
        triggerId: TRIGGER_ID,
        input: " PROJ-1 ",
      }),
      params({ id: WORKFLOW_ID })
    );

    expect(response.status).toBe(200);
    expect(mocks.runService.startManualRun).toHaveBeenCalledWith(
      "org-1",
      WORKFLOW_ID,
      { triggerId: TRIGGER_ID, input: "PROJ-1" }
    );
  });
});

describe("run routes", () => {
  it("answers 404 for an unknown run", async () => {
    mocks.runService.get.mockResolvedValue(null);

    const response = await getRun(
      request(`/workflow-runs/${RUN_ID}`),
      params({ runId: RUN_ID })
    );

    expect(response.status).toBe(404);
  });

  it("maps a cancel conflict to 409", async () => {
    mocks.runService.cancel.mockResolvedValue(
      Result.err({
        status: Status.Conflict,
        message: "The run already finished.",
      })
    );

    const response = await cancelRun(
      request(`/workflow-runs/${RUN_ID}/cancel`, "POST"),
      params({ runId: RUN_ID })
    );

    expect(response.status).toBe(409);
  });

  it("retries an action run", async () => {
    mocks.runService.retryActionRun.mockResolvedValue(
      Result.ok({ id: RUN_ID })
    );

    const response = await retryActionRun(
      request(`/workflow-runs/${RUN_ID}/action-runs/ar-1/retry`, "POST"),
      params({ runId: RUN_ID, actionRunId: "ar-1" })
    );

    expect(response.status).toBe(200);
    expect(mocks.runService.retryActionRun).toHaveBeenCalledWith(
      "org-1",
      RUN_ID,
      "ar-1"
    );
  });

  it("retries the failed step of a run", async () => {
    mocks.runService.retry.mockResolvedValue(Result.ok({ id: RUN_ID }));

    const response = await retryRun(
      request(`/workflow-runs/${RUN_ID}/retry`, "POST"),
      params({ runId: RUN_ID })
    );

    expect(response.status).toBe(200);
    expect(mocks.runService.retry).toHaveBeenCalledWith(
      "org-1",
      RUN_ID,
      WorkflowRunRetryMode.Restart
    );
  });

  it("resumes the failed step's session when asked, and rejects an unknown mode", async () => {
    mocks.runService.retry.mockResolvedValue(Result.ok({ id: RUN_ID }));

    const resumed = await retryRun(
      request(`/workflow-runs/${RUN_ID}/retry`, "POST", {
        mode: WorkflowRunRetryMode.Resume,
      }),
      params({ runId: RUN_ID })
    );
    const unknown = await retryRun(
      request(`/workflow-runs/${RUN_ID}/retry`, "POST", { mode: "again" }),
      params({ runId: RUN_ID })
    );

    expect(resumed.status).toBe(200);
    expect(mocks.runService.retry).toHaveBeenCalledWith(
      "org-1",
      RUN_ID,
      WorkflowRunRetryMode.Resume
    );
    expect(unknown.status).toBe(400);
    expect(mocks.runService.retry).toHaveBeenCalledTimes(1);
  });

  it("maps a run that cannot be retried to 409", async () => {
    mocks.runService.retry.mockResolvedValue(
      Result.err({
        status: Status.Conflict,
        message:
          "Only a run that failed in a plan, implement or agent step can be retried.",
      })
    );

    const response = await retryRun(
      request(`/workflow-runs/${RUN_ID}/retry`, "POST"),
      params({ runId: RUN_ID })
    );

    expect(response.status).toBe(409);
  });
});
