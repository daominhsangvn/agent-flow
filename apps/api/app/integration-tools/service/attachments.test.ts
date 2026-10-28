import {
  type ConnectionGrants,
  GrantApproval,
  normalizeConnectionGrants,
  SourceOperation,
} from "@repo/api/src/types/connection-grants";
import { IntegrationProviderKey } from "@repo/api/src/types/integration";
import {
  IntegrationToolCallStatus,
  IntegrationToolName,
} from "@repo/api/src/types/integration-tools";
import { Result } from "@repo/api/src/types/result";
import { beforeEach, describe, expect, it, vi } from "vitest";
import {
  type AgentToolSessionInput,
  buildAgentTools,
} from "@/lib/integrations/agent-tools/catalog";
import {
  attachSourceFile,
  cleanFileName,
  findSessionFiles,
  SOURCE_ATTACH_OPERATION,
  uploadContentType,
} from "./attachments";
import type { ToolSessionContext } from "./session-context";

/**
 * Uploads for comment attachments: only for a session whose comment tool
 * takes files, recorded as a write before the provider attaches the file,
 * idempotent on the content; a comment may only name this session's uploads.
 */

const mocks = vi.hoisted(() => ({
  attachFile: vi.fn(),
  startWriteCall: vi.fn(),
  finishCall: vi.fn(),
  recordSettledCall: vi.fn(),
  writeBudgetSpent: vi.fn(),
  findCalls: vi.fn(),
}));

vi.mock("@repo/database", () => ({
  withDb: (fn: (db: unknown) => unknown) =>
    fn({ integrationToolCall: { findMany: mocks.findCalls } }),
}));
vi.mock("@/lib/integrations/connection-service", () => ({
  createProviderContext: (runtime: unknown) => ({ connection: runtime }),
}));
vi.mock("./call-records", () => ({
  startWriteCall: mocks.startWriteCall,
  finishCall: mocks.finishCall,
  recordSettledCall: mocks.recordSettledCall,
  writeBudgetSpent: mocks.writeBudgetSpent,
}));

const SESSION = {
  id: "session-1",
  organizationId: "org-1",
  runId: "run-1",
  subject: { kind: "step" as const, loopId: "loop-1", stepId: "test" },
};
const SOURCE_REF = {
  provider: IntegrationProviderKey.Jira,
  externalId: "10007",
  key: "JB-7",
  url: null,
  title: "Login fails",
  container: "JB",
};
const PNG = new Uint8Array([137, 80, 78, 71]);
const SHA256_RE = /^[0-9a-f]{64}$/;

beforeEach(() => {
  vi.clearAllMocks();
  mocks.writeBudgetSpent.mockResolvedValue(false);
  mocks.startWriteCall.mockResolvedValue(Result.ok({ id: "call-1" }));
  mocks.attachFile.mockResolvedValue(
    Result.ok({ id: "10500", name: "login.png", contentType: "image/png" })
  );
});

describe("attachSourceFile", () => {
  it("records the upload as a write, then attaches the file to the run's item", async () => {
    const result = await attachSourceFile(context(), {
      name: "evidence%2Flogin.png",
      contentType: "image/png",
      bytes: PNG,
    });

    expect(result).toEqual({
      ok: true,
      output: {
        id: "10500",
        name: "login.png",
        contentType: "image/png",
        size: 4,
      },
    });
    expect(mocks.startWriteCall).toHaveBeenCalledWith(
      expect.objectContaining({
        tool: IntegrationToolName.SourceItemAttach,
        operationType: SOURCE_ATTACH_OPERATION,
        connectionKey: "jira-customer",
        input: {
          name: "login.png",
          contentType: "image/png",
          size: 4,
          sha256: expect.stringMatching(SHA256_RE),
        },
      })
    );
    expect(mocks.attachFile).toHaveBeenCalledWith(
      expect.anything(),
      SOURCE_REF,
      { name: "login.png", contentType: "image/png", bytes: PNG }
    );
    expect(mocks.finishCall).toHaveBeenCalledWith("call-1", {
      status: IntegrationToolCallStatus.Succeeded,
      externalRef: "10500",
      error: null,
    });
  });

  it("answers an identical upload with the first one's attachment", async () => {
    mocks.startWriteCall.mockResolvedValue(
      Result.err({ kind: "succeeded", externalRef: "10500" })
    );

    const result = await attachSourceFile(context(), {
      name: "login.png",
      contentType: "image/png",
      bytes: PNG,
    });

    expect(result).toEqual({
      ok: true,
      output: expect.objectContaining({ id: "10500" }),
    });
    expect(mocks.attachFile).not.toHaveBeenCalled();
  });

  it.each<[string, ConnectionGrants]>([
    ["no comment grant", { source: [SourceOperation.Transition] }],
    [
      "a comment that needs approval",
      {
        source: {
          allow: [SourceOperation.Comment],
          approval: GrantApproval.Required,
        },
      },
    ],
  ])("refuses an upload with %s", async (_label, grants) => {
    const result = await attachSourceFile(context(grants), {
      name: "login.png",
      contentType: "image/png",
      bytes: PNG,
    });

    expect(result).toEqual({
      ok: false,
      error: expect.stringContaining("cannot attach files"),
      retryable: false,
    });
    expect(mocks.recordSettledCall).toHaveBeenCalledWith(
      expect.objectContaining({ tool: IntegrationToolName.SourceItemAttach }),
      expect.objectContaining({ status: IntegrationToolCallStatus.Refused })
    );
    expect(mocks.attachFile).not.toHaveBeenCalled();
  });

  it("refuses an upload once the write budget is spent", async () => {
    mocks.writeBudgetSpent.mockResolvedValue(true);

    const result = await attachSourceFile(context(), {
      name: "login.png",
      contentType: "image/png",
      bytes: PNG,
    });

    expect(result).toEqual(
      expect.objectContaining({ ok: false, retryable: false })
    );
    expect(mocks.startWriteCall).not.toHaveBeenCalled();
  });

  it("records the provider's failure", async () => {
    mocks.attachFile.mockResolvedValue(
      Result.err({
        message: "Jira could not attach login.png",
        retryable: true,
      })
    );

    const result = await attachSourceFile(context(), {
      name: "login.png",
      contentType: "image/png",
      bytes: PNG,
    });

    expect(result).toEqual({
      ok: false,
      error: "Jira could not attach login.png",
      retryable: true,
    });
    expect(mocks.finishCall).toHaveBeenCalledWith("call-1", {
      status: IntegrationToolCallStatus.Failed,
      externalRef: null,
      error: "Jira could not attach login.png",
    });
  });
});

describe("findSessionFiles", () => {
  it("returns this session's uploads in the order the comment names them", async () => {
    mocks.findCalls.mockResolvedValue([
      { externalRef: "2", input: { name: "b.log", contentType: "text/plain" } },
      { externalRef: "1", input: { name: "a.png", contentType: "image/png" } },
    ]);

    expect(await findSessionFiles("session-1", ["1", "2"])).toEqual({
      ok: true,
      value: [
        { id: "1", name: "a.png", contentType: "image/png" },
        { id: "2", name: "b.log", contentType: "text/plain" },
      ],
    });
    expect(mocks.findCalls).toHaveBeenCalledWith(
      expect.objectContaining({
        where: expect.objectContaining({
          sessionId: "session-1",
          tool: IntegrationToolName.SourceItemAttach,
          status: IntegrationToolCallStatus.Succeeded,
        }),
      })
    );
  });

  it("refuses an id the session did not upload", async () => {
    mocks.findCalls.mockResolvedValue([]);

    expect(await findSessionFiles("session-1", ["10999"])).toEqual({
      ok: false,
      error: expect.stringContaining(
        '"10999" is not a file this session uploaded'
      ),
    });
  });
});

describe("file names and types", () => {
  it.each([
    ["evidence%2Flogin.png", "login.png"],
    ["C:\\shots\\step 1.png", "step 1.png"],
    ["a|b!c[d]^e.png", "a_b_c_d__e.png"],
    ["..", null],
    ["", null],
  ])("cleans %j to %j", (raw, cleaned) => {
    expect(cleanFileName(raw)).toBe(cleaned);
  });

  it("keeps a specific content type and infers one from the extension otherwise", () => {
    expect(uploadContentType("image/png; charset=binary", "x.bin")).toBe(
      "image/png"
    );
    expect(uploadContentType("application/octet-stream", "shot.JPG")).toBe(
      "image/jpeg"
    );
    expect(uploadContentType(null, "report")).toBe("application/octet-stream");
    expect(uploadContentType("not a type", "run.log")).toBe("text/plain");
  });
});

function context(
  grants: ConnectionGrants = { source: [SourceOperation.Comment] }
): ToolSessionContext {
  const input: AgentToolSessionInput = {
    agent: 'the process step "Test"',
    workflowName: "QC",
    runUrl: "https://app.test/runs/run-1",
    source: {
      ref: SOURCE_REF,
      provider: IntegrationProviderKey.Jira,
      key: "jira-customer",
    },
    grants: normalizeConnectionGrants(grants),
    connections: [],
    pullRequests: [],
  };
  return {
    session: SESSION,
    snapshot: { source: SOURCE_REF },
    sourceConnection: {
      provider: { source: { attachFile: mocks.attachFile } },
      runtime: { secrets: {} },
    },
    input,
    tools: buildAgentTools(input),
    writeBudget: 100,
  } as unknown as ToolSessionContext;
}
