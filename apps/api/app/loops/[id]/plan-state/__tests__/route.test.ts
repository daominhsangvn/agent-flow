import { beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("../../../plan-state-service", () => ({
  planStateService: {
    latestDownloadUrl: vi.fn(),
    uploadUrls: vi.fn(),
  },
}));

vi.mock("@/lib/auth/loop-runner-jwt", () => ({
  authenticateLoopRunnerRequest: vi.fn(),
}));

import { authenticateLoopRunnerRequest } from "@/lib/auth/loop-runner-jwt";
import { planStateService } from "../../../plan-state-service";
import { GET, POST } from "../route";

const LOOP = "loop-1";
const ORG = "org-1";
const context = { params: Promise.resolve({ id: LOOP }) };

function request(method: "GET" | "POST", body?: unknown): Request {
  return new Request(`http://localhost/api/loops/${LOOP}/plan-state`, {
    method,
    headers: {
      authorization: "Bearer runner-token",
      ...(body === undefined ? {} : { "content-type": "application/json" }),
    },
    ...(body === undefined ? {} : { body: JSON.stringify(body) }),
  });
}

beforeEach(() => {
  vi.clearAllMocks();
  vi.mocked(authenticateLoopRunnerRequest).mockResolvedValue({
    loopId: LOOP,
    organizationId: ORG,
    tokenId: "jti-1",
  });
});

describe("GET /api/loops/:id/plan-state", () => {
  it("returns the latest state's URL", async () => {
    vi.mocked(planStateService.latestDownloadUrl).mockResolvedValue(
      "https://storage/state.json.gz"
    );
    const response = await GET(request("GET"), context);
    expect(response.status).toBe(200);
    expect((await response.json()).data).toEqual({
      state: { url: "https://storage/state.json.gz" },
    });
    expect(planStateService.latestDownloadUrl).toHaveBeenCalledWith(LOOP, ORG);
  });

  it("returns no state when the plan has none", async () => {
    vi.mocked(planStateService.latestDownloadUrl).mockResolvedValue(null);
    const response = await GET(request("GET"), context);
    expect((await response.json()).data).toEqual({ state: null });
  });

  it("passes an authentication failure through", async () => {
    vi.mocked(authenticateLoopRunnerRequest).mockResolvedValue(
      new Response("forbidden", { status: 403 })
    );
    const response = await GET(request("GET"), context);
    expect(response.status).toBe(403);
    expect(planStateService.latestDownloadUrl).not.toHaveBeenCalled();
  });
});

describe("POST /api/loops/:id/plan-state", () => {
  it("returns the upload URLs", async () => {
    vi.mocked(planStateService.uploadUrls).mockResolvedValue([
      "https://storage/loops/loop-1.json.gz",
    ]);
    const response = await POST(request("POST", { latest: false }), context);
    expect(response.status).toBe(200);
    expect((await response.json()).data).toEqual({
      urls: ["https://storage/loops/loop-1.json.gz"],
    });
    expect(planStateService.uploadUrls).toHaveBeenCalledWith(LOOP, ORG, false);
  });

  it("is 404 for a loop that does not work on a plan", async () => {
    vi.mocked(planStateService.uploadUrls).mockResolvedValue(null);
    const response = await POST(request("POST", { latest: true }), context);
    expect(response.status).toBe(404);
  });

  it("rejects a body without the latest flag", async () => {
    const response = await POST(request("POST", {}), context);
    expect(response.status).toBe(400);
    expect(planStateService.uploadUrls).not.toHaveBeenCalled();
  });
});
