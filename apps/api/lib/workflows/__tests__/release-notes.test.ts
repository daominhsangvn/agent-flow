import {
  deriveProcessFromAgentConfig,
  ProcessStepType,
} from "@repo/api/src/types/project-process";
import { Result } from "@repo/api/src/types/result";
import {
  WorkflowRunErrorCode,
  WorkflowRunStatus,
} from "@repo/api/src/types/workflow";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { AGENT_CONFIG } from "@/lib/workflows/__tests__/support/advance-db.test-fake";
import { publishExecuteReleaseNotes } from "@/lib/workflows/engine/release-notes";
import type { EngineRun } from "@/lib/workflows/engine/step-outcome";

/**
 * Release notes of AgentFlow's implement step (engine/release-notes.ts): what
 * a workflow EXECUTE uploaded becomes the run's release notes document,
 * unless the step turns them off; a failure never stops the run.
 */

const RELEASE_NOTES_FILE = vi.hoisted(
  () => ".agentflow-ai/work/release-notes.md"
);

const mocks = vi.hoisted(() => ({
  publishReleaseNotes: vi.fn(),
}));

vi.mock("@repo/database", () => {
  const withDb = (fn: (db: unknown) => unknown) => fn({});
  withDb.tx = withDb;
  return { withDb, Prisma: { sql: () => ({}) } };
});
vi.mock("@/lib/workflows/engine/step-documents", () => ({
  STEP_RELEASE_NOTES_FILE: RELEASE_NOTES_FILE,
  publishReleaseNotes: mocks.publishReleaseNotes,
}));

function engineRun(overrides: Partial<EngineRun> = {}): EngineRun {
  return {
    id: "run-1",
    organizationId: "org-1",
    workflowId: "wf-1",
    status: WorkflowRunStatus.Executing,
    cycle: 1,
    source: null,
    agentConfig: AGENT_CONFIG,
    runAsUserId: "user-1",
    connectionId: null,
    featureDocumentId: "issue-1",
    planDocumentId: "plan-1",
    phaseStartedAt: new Date("2026-10-15T10:00:00.000Z"),
    stepAttempts: 0,
    process: null,
    stepId: null,
    stepState: null,
    projectId: "project-1",
    projectConnectionId: null,
    workflow: { name: "Delivery", enabled: true },
    ...overrides,
  };
}

const NOTES = "## What changed\nCSV export";

beforeEach(() => {
  vi.clearAllMocks();
  mocks.publishReleaseNotes.mockResolvedValue(Result.ok(null));
});

describe("publishExecuteReleaseNotes", () => {
  it("publishes the release notes EXECUTE uploaded on the built-in flow", async () => {
    await publishExecuteReleaseNotes(engineRun(), {
      uploadedArtifacts: { releaseNotes: `\n${NOTES}\n` },
    });

    expect(mocks.publishReleaseNotes).toHaveBeenCalledWith({
      run: expect.objectContaining({ id: "run-1" }),
      projectId: "project-1",
      step: expect.objectContaining({
        type: ProcessStepType.AgentFlowExecute,
        id: "execute",
      }),
      files: [{ path: RELEASE_NOTES_FILE, content: NOTES, truncated: false }],
      variables: { "issue.key": "", "issue.title": "", "issue.url": "" },
    });
  });

  it("publishes nothing when the implement step turns them off", async () => {
    const builtIn = deriveProcessFromAgentConfig(AGENT_CONFIG);
    const run = engineRun({
      stepId: "execute",
      process: {
        version: 1,
        source: "workflow",
        definition: {
          ...builtIn,
          steps: builtIn.steps.map((step) =>
            step.type === ProcessStepType.AgentFlowExecute
              ? { ...step, releaseNotes: false }
              : step
          ),
        },
      },
    });

    await publishExecuteReleaseNotes(run, {
      uploadedArtifacts: { releaseNotes: NOTES },
    });

    expect(mocks.publishReleaseNotes).not.toHaveBeenCalled();
  });

  it("publishes nothing when EXECUTE wrote none", async () => {
    for (const uploadedArtifacts of [null, {}, { releaseNotes: "  " }]) {
      await publishExecuteReleaseNotes(engineRun(), { uploadedArtifacts });
    }

    expect(mocks.publishReleaseNotes).not.toHaveBeenCalled();
  });

  it("goes on when they cannot be published", async () => {
    mocks.publishReleaseNotes.mockResolvedValue(
      Result.err({
        code: WorkflowRunErrorCode.DocumentCreateFailed,
        message: "no project",
      })
    );

    await expect(
      publishExecuteReleaseNotes(engineRun(), {
        uploadedArtifacts: { releaseNotes: NOTES },
      })
    ).resolves.toBeUndefined();
  });
});
