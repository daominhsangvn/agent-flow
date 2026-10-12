import { describe, expect, it } from "vitest";
import {
  BOT,
  connectionDataResponse,
  createAdoContext,
  createFakeAdo,
  type FakeRoute,
  SIGN_IN_PAGE_HTML,
  TEST_PAT,
} from "@/lib/integrations/providers/azure-devops/__tests__/azure-devops.test-fixtures";
import { ADO_TOKEN_REJECTED_MESSAGE } from "@/lib/integrations/providers/azure-devops/client";
import { validateAdoConnection } from "@/lib/integrations/providers/azure-devops/connection";
import { HttpMethod } from "@/lib/integrations/types";

const CONNECTION_DATA_PATH = "/contoso/_apis/connectionData";
const WIQL_PATH = "/contoso/_apis/wit/wiql";

const connectionDataOk: FakeRoute = {
  method: HttpMethod.Get,
  path: CONNECTION_DATA_PATH,
  json: connectionDataResponse(),
};
const wiqlOk: FakeRoute = {
  method: HttpMethod.Post,
  path: WIQL_PATH,
  json: { queryType: "flat", workItems: [] },
};

describe("validateAdoConnection", () => {
  it("identifies the PAT owner as the bot and normalizes the organization URL", async () => {
    const fake = createFakeAdo([connectionDataOk, wiqlOk]);
    const ctx = createAdoContext(fake, {
      organizationUrl: "https://dev.azure.com/contoso/Fabrikam%20Web/",
    });

    const result = await validateAdoConnection(ctx);

    expect(result).toEqual({
      ok: true,
      account: {
        externalAccountId: BOT.id,
        displayName: BOT.displayName,
        aliases: [BOT.uniqueName, BOT.descriptor],
        details: {
          organization: "contoso",
          organizationUrl: "https://dev.azure.com/contoso",
        },
      },
      config: { organizationUrl: "https://dev.azure.com/contoso" },
    });
  });

  it("authenticates with Basic ':' + PAT and asks ADO not to redirect to sign-in", async () => {
    const fake = createFakeAdo([connectionDataOk, wiqlOk]);

    await validateAdoConnection(createAdoContext(fake));

    const [request] = fake.requestsTo(HttpMethod.Get, CONNECTION_DATA_PATH);
    expect(request?.headers.get("authorization")).toBe(
      `Basic ${Buffer.from(`:${TEST_PAT}`).toString("base64")}`
    );
    expect(request?.headers.get("x-tfs-fedauthredirect")).toBe("Suppress");
    expect(request?.url.searchParams.get("connectOptions")).toBe("none");
    expect(request?.url.searchParams.get("lastChangeId")).toBe("-1");
  });

  it("checks work item access with an empty WIQL query", async () => {
    const fake = createFakeAdo([connectionDataOk, wiqlOk]);

    await validateAdoConnection(createAdoContext(fake));

    const [request] = fake.requestsTo(HttpMethod.Post, WIQL_PATH);
    expect(request?.url.searchParams.get("api-version")).toBe("7.1");
    expect(JSON.parse(request?.body ?? "{}")).toEqual({
      query: "SELECT [System.Id] FROM WorkItems WHERE [System.Id] < 0",
    });
  });

  it.each([
    [
      "203 with the HTML sign-in page",
      { status: 203, text: SIGN_IN_PAGE_HTML },
    ],
    ["401", { status: 401, json: { message: "TF400813: not authorized" } }],
    [
      "200 with the HTML sign-in page",
      { status: 200, text: SIGN_IN_PAGE_HTML },
    ],
  ])("rejects a bad PAT answered with %s", async (_label, response) => {
    const fake = createFakeAdo([
      { method: HttpMethod.Get, path: CONNECTION_DATA_PATH, ...response },
    ]);

    const result = await validateAdoConnection(createAdoContext(fake));

    expect(result).toEqual({ ok: false, error: ADO_TOKEN_REJECTED_MESSAGE });
    expect(JSON.stringify(result)).not.toContain(TEST_PAT);
  });

  it("rejects the anonymous identity connectionData returns without credentials", async () => {
    const fake = createFakeAdo([
      {
        method: HttpMethod.Get,
        path: CONNECTION_DATA_PATH,
        json: connectionDataResponse("aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa"),
      },
    ]);

    const result = await validateAdoConnection(createAdoContext(fake));

    expect(result).toEqual({ ok: false, error: ADO_TOKEN_REJECTED_MESSAGE });
  });

  it("reports an unknown organization", async () => {
    const fake = createFakeAdo([
      {
        method: HttpMethod.Get,
        path: CONNECTION_DATA_PATH,
        status: 404,
        json: {},
      },
    ]);

    const result = await validateAdoConnection(createAdoContext(fake));

    expect(result).toEqual({
      ok: false,
      error:
        "No Azure DevOps organization found at https://dev.azure.com/contoso",
    });
  });

  it("explains a token without the Work Items scope", async () => {
    const fake = createFakeAdo([
      connectionDataOk,
      { method: HttpMethod.Post, path: WIQL_PATH, status: 401, json: {} },
    ]);

    const result = await validateAdoConnection(createAdoContext(fake));

    expect(result.ok).toBe(false);
    expect(result.ok ? null : result.error).toContain(
      "Work Items (Read & write)"
    );
  });

  it("reports network failures as unreachable", async () => {
    const fake = createFakeAdo([
      {
        method: HttpMethod.Get,
        path: CONNECTION_DATA_PATH,
        networkError: true,
      },
    ]);

    const result = await validateAdoConnection(createAdoContext(fake));

    expect(result.ok).toBe(false);
    expect(result.ok ? null : result.error).toContain(
      "Could not reach Azure DevOps"
    );
  });

  it("rejects an unsupported organization URL without calling ADO", async () => {
    const fake = createFakeAdo([]);

    const result = await validateAdoConnection(
      createAdoContext(fake, { organizationUrl: "https://example.com/contoso" })
    );

    expect(result.ok).toBe(false);
    expect(fake.requests).toHaveLength(0);
  });
});
