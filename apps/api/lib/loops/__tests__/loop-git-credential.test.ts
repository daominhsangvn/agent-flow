import { LoopStatus } from "@repo/api/src/types/loop";
import { Result, Status } from "@repo/api/src/types/result";
import { beforeEach, describe, expect, it, vi } from "vitest";
import type { ProjectRepositoryCheckout } from "@/app/projects/project-repository-checkouts";
import {
  formatGitCredential,
  issueLoopGitCredential,
  parseGitCredentialRequest,
} from "@/lib/loops/loop-git-credential";

const ORG_ID = "0199a5f0-0000-7000-8000-00000000000a";
const LOOP_ID = "0199a5f0-0000-7000-8000-0000000000l1";
const DOCUMENT_ID = "0199a5f0-0000-7000-8000-0000000000d1";

const mocks = vi.hoisted(() => ({
  loop: null as unknown,
  checkouts: [] as unknown[],
  gitCredential: vi.fn(),
  loadRepositoryConnection: vi.fn(),
}));

vi.mock("@/app/loops/service", () => ({
  loopsService: { findById: vi.fn(() => Promise.resolve(mocks.loop)) },
}));
vi.mock("@/app/projects/project-repository-checkouts", () => ({
  listDocumentRepositoryCheckouts: vi.fn(() =>
    Promise.resolve(mocks.checkouts)
  ),
}));
vi.mock("@/lib/integrations/repositories", () => ({
  loadRepositoryConnection: mocks.loadRepositoryConnection,
}));

function checkout(
  overrides: Partial<ProjectRepositoryCheckout>
): ProjectRepositoryCheckout {
  return {
    id: "repo-1",
    connectionId: "conn-github",
    provider: "github",
    externalId: "1",
    fullName: "acme/api",
    name: "api",
    defaultBranch: "main",
    webUrl: "https://github.com/acme/api",
    cloneUrl: "https://github.com/acme/api.git",
    isPrimary: true,
    ...overrides,
  };
}

const ado = checkout({
  id: "repo-2",
  connectionId: "conn-ado",
  provider: "azure_devops",
  externalId: "guid",
  fullName: "contoso/Payments Team/web",
  name: "web",
  webUrl: "https://dev.azure.com/contoso/Payments%20Team/_git/web",
  cloneUrl: "https://dev.azure.com/contoso/Payments%20Team/_git/web",
  isPrimary: false,
});

function request(path: string | null, host = "github.com") {
  return { protocol: "https", host, path };
}

beforeEach(() => {
  mocks.loop = {
    id: LOOP_ID,
    status: LoopStatus.Running,
    documentId: DOCUMENT_ID,
    repo: { fullName: "acme/api", branch: "main" },
    additionalRepos: [
      { fullName: "contoso/Payments Team/web", branch: "main" },
    ],
  };
  mocks.checkouts = [checkout({}), ado];
  mocks.gitCredential.mockReset();
  mocks.gitCredential.mockResolvedValue({
    username: "x-access-token",
    password: "pat",
    expiresAt: null,
  });
  mocks.loadRepositoryConnection.mockReset();
  mocks.loadRepositoryConnection.mockResolvedValue(
    Result.ok({
      repositories: { gitCredential: mocks.gitCredential },
      context: { connection: {} },
    })
  );
});

describe("parseGitCredentialRequest", () => {
  it("reads protocol, host and path from git's credential description", () => {
    expect(
      parseGitCredentialRequest(
        "protocol=https\nhost=github.com\npath=acme/api.git\n\n"
      )
    ).toEqual({ protocol: "https", host: "github.com", path: "acme/api.git" });
    expect(parseGitCredentialRequest("protocol=https\nhost=x\n")).toEqual({
      protocol: "https",
      host: "x",
      path: null,
    });
    expect(parseGitCredentialRequest("host=github.com\n")).toBeNull();
  });
});

describe("formatGitCredential", () => {
  it("answers in git's format, with the expiry when there is one", () => {
    expect(
      formatGitCredential({ username: "u", password: "p", expiresAt: null })
    ).toBe("username=u\npassword=p\n");
    expect(
      formatGitCredential({
        username: "u",
        password: "p",
        expiresAt: new Date("2026-10-06T10:00:00Z"),
      })
    ).toBe("username=u\npassword=p\npassword_expiry_utc=1791280800\n");
  });
});

describe("issueLoopGitCredential", () => {
  it("issues the credential of the connection that owns the repository", async () => {
    const result = await issueLoopGitCredential({
      loopId: LOOP_ID,
      organizationId: ORG_ID,
      request: request("acme/api.git"),
    });

    expect(result).toEqual(
      Result.ok({
        username: "x-access-token",
        password: "pat",
        expiresAt: null,
      })
    );
    expect(mocks.loadRepositoryConnection).toHaveBeenCalledWith(
      ORG_ID,
      "conn-github"
    );
    expect(mocks.gitCredential.mock.calls[0][1]).toMatchObject({
      fullName: "acme/api",
      namespace: "acme",
      cloneUrl: "https://github.com/acme/api.git",
    });
  });

  it("matches an Azure DevOps path with spaces, encoded or not", async () => {
    for (const path of [
      "contoso/Payments%20Team/_git/web",
      "contoso/Payments Team/_git/web",
    ]) {
      const result = await issueLoopGitCredential({
        loopId: LOOP_ID,
        organizationId: ORG_ID,
        request: request(path, "dev.azure.com"),
      });
      expect(result.ok).toBe(true);
    }
    expect(mocks.loadRepositoryConnection).toHaveBeenCalledWith(
      ORG_ID,
      "conn-ado"
    );
  });

  it("refuses a repository that is not one of the loop's", async () => {
    mocks.checkouts = [
      checkout({}),
      checkout({
        id: "x",
        fullName: "acme/secrets",
        cloneUrl: "https://github.com/acme/secrets.git",
      }),
    ];

    const result = await issueLoopGitCredential({
      loopId: LOOP_ID,
      organizationId: ORG_ID,
      request: request("acme/secrets.git"),
    });

    expect(result).toEqual(
      Result.err({
        status: Status.NotFound,
        message: "No repository of this loop matches the request",
      })
    );
    expect(mocks.gitCredential).not.toHaveBeenCalled();
  });

  it("refuses another host and a finished loop", async () => {
    const otherHost = await issueLoopGitCredential({
      loopId: LOOP_ID,
      organizationId: ORG_ID,
      request: request("acme/api.git", "evil.example.com"),
    });
    expect(otherHost.ok).toBe(false);

    mocks.loop = { ...(mocks.loop as object), status: LoopStatus.Completed };
    const finished = await issueLoopGitCredential({
      loopId: LOOP_ID,
      organizationId: ORG_ID,
      request: request("acme/api.git"),
    });
    expect(finished).toEqual(
      Result.err({ status: Status.Conflict, message: "The loop has finished" })
    );
  });

  it("reports a provider failure as a bad gateway", async () => {
    mocks.gitCredential.mockRejectedValue(new Error("token revoked"));

    const result = await issueLoopGitCredential({
      loopId: LOOP_ID,
      organizationId: ORG_ID,
      request: request(null),
    });

    expect(result).toEqual(
      Result.err({
        status: Status.BadGateway,
        message: "Could not issue a git credential",
      })
    );
  });
});
