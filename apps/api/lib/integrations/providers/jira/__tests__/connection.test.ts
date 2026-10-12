import { IntegrationFieldKind } from "@repo/api/src/types/integration";
import { describe, expect, it } from "vitest";
import { HttpMethod, ValidateConnectionReason } from "../../../types";
import { JIRA_CLOUD_CREDENTIALS_REJECTED } from "../client";
import { JIRA_CONNECTION_FIELDS, validateJiraConnection } from "../connection";
import { JiraDeployment } from "../constants";
import { JiraAccountDetail } from "../identity";
import { jiraConnectionConfigSchema, jiraSecretsSchema } from "../schemas";
import { CLOUD_MYSELF, DC_MYSELF } from "./jira.test-fixtures";
import {
  API_TOKEN,
  BOT_ACCOUNT_ID,
  BOT_DC_KEY,
  BOT_DC_NAME,
  BOT_EMAIL,
  CLOUD_SITE_URL,
  DC_SITE_URL,
  dataCenterConfig,
  jsonResponse,
  makeJiraContext,
  networkFailure,
  routedHttp,
} from "./jira.test-helpers";

describe("jiraConnectionConfigSchema", () => {
  it("defaults to Cloud and normalizes the site URL to its origin", () => {
    const parsed = jiraConnectionConfigSchema.parse({
      siteUrl:
        "  https://acme.atlassian.net/jira/software/projects/PROJ/boards/1?x=1  ",
      email: ` ${BOT_EMAIL} `,
    });
    expect(parsed).toEqual({
      deployment: JiraDeployment.Cloud,
      siteUrl: CLOUD_SITE_URL,
      email: BOT_EMAIL,
    });
  });

  it("keeps a Data Center context path without trailing slashes and drops the email", () => {
    const parsed = jiraConnectionConfigSchema.parse({
      deployment: JiraDeployment.DataCenter,
      siteUrl: "https://jira.example.com/jira///",
      email: "ignored@example.com",
    });
    expect(parsed).toEqual({
      deployment: JiraDeployment.DataCenter,
      siteUrl: DC_SITE_URL,
      email: null,
    });
  });

  it("is idempotent on a stored config", () => {
    const stored = jiraConnectionConfigSchema.parse({
      deployment: JiraDeployment.DataCenter,
      siteUrl: DC_SITE_URL,
      email: null,
    });
    expect(jiraConnectionConfigSchema.parse(stored)).toEqual(stored);
  });

  it("requires https except for a local Jira", () => {
    expect(
      jiraConnectionConfigSchema.safeParse({
        siteUrl: "http://acme.atlassian.net",
        email: BOT_EMAIL,
      }).success
    ).toBe(false);
    expect(
      jiraConnectionConfigSchema.parse({
        deployment: JiraDeployment.DataCenter,
        siteUrl: "http://localhost:8080/",
      }).siteUrl
    ).toBe("http://localhost:8080");
  });

  it("rejects invalid URLs, embedded credentials and a missing or invalid Cloud email", () => {
    const issues = (input: Record<string, unknown>) => {
      const result = jiraConnectionConfigSchema.safeParse(input);
      return result.success
        ? []
        : result.error.issues.map((issue) => issue.path.join("."));
    };
    expect(issues({ siteUrl: "not a url", email: BOT_EMAIL })).toEqual([
      "siteUrl",
    ]);
    expect(
      issues({
        siteUrl: "https://user:pw@acme.atlassian.net",
        email: BOT_EMAIL,
      })
    ).toEqual(["siteUrl"]);
    expect(issues({ siteUrl: CLOUD_SITE_URL })).toEqual(["email"]);
    expect(issues({ siteUrl: CLOUD_SITE_URL, email: "nope" })).toEqual([
      "email",
    ]);
    expect(
      issues({ deployment: JiraDeployment.DataCenter, siteUrl: DC_SITE_URL })
    ).toEqual([]);
  });

  it("requires a non-empty API token", () => {
    expect(jiraSecretsSchema.safeParse({ apiToken: "   " }).success).toBe(
      false
    );
    expect(jiraSecretsSchema.parse({ apiToken: ` ${API_TOKEN} ` })).toEqual({
      apiToken: API_TOKEN,
    });
  });
});

describe("JIRA_CONNECTION_FIELDS", () => {
  it("declares deployment, site, Cloud-only email and the secret token", () => {
    expect(
      JIRA_CONNECTION_FIELDS.map((field) => [field.key, field.kind])
    ).toEqual([
      ["deployment", IntegrationFieldKind.Select],
      ["siteUrl", IntegrationFieldKind.Url],
      ["email", IntegrationFieldKind.Email],
      ["apiToken", IntegrationFieldKind.Secret],
    ]);
    const email = JIRA_CONNECTION_FIELDS.find((field) => field.key === "email");
    expect(email?.showWhen).toEqual({
      field: "deployment",
      equals: JiraDeployment.Cloud,
    });
  });
});

describe("validateJiraConnection", () => {
  it("identifies the Cloud bot with Basic auth against REST v3", async () => {
    const fake = routedHttp([
      {
        method: HttpMethod.Get,
        path: "/rest/api/3/myself",
        respond: jsonResponse(200, CLOUD_MYSELF),
      },
    ]);
    const ctx = makeJiraContext({ http: fake.http, account: null });
    const result = await validateJiraConnection(
      ctx,
      ValidateConnectionReason.Save
    );
    expect(result).toEqual({
      ok: true,
      account: {
        externalAccountId: BOT_ACCOUNT_ID,
        displayName: "AgentFlow Bot",
        aliases: [BOT_EMAIL],
        details: {
          [JiraAccountDetail.Deployment]: JiraDeployment.Cloud,
          [JiraAccountDetail.TimeZone]: "Europe/Berlin",
        },
      },
      config: ctx.connection.config,
    });
    const expectedAuth = `Basic ${Buffer.from(`${BOT_EMAIL}:${API_TOKEN}`).toString("base64")}`;
    expect(fake.requests[0]?.headers?.authorization).toBe(expectedAuth);
    expect(fake.requests[0]?.url).toBe(`${CLOUD_SITE_URL}/rest/api/3/myself`);
  });

  it("identifies the Data Center bot with a Bearer PAT against REST v2", async () => {
    const fake = routedHttp([
      {
        method: HttpMethod.Get,
        path: "/jira/rest/api/2/myself",
        respond: jsonResponse(200, DC_MYSELF),
      },
    ]);
    const ctx = makeJiraContext({
      http: fake.http,
      config: dataCenterConfig(),
      account: null,
    });
    const result = await validateJiraConnection(
      ctx,
      ValidateConnectionReason.Test
    );
    expect(result.ok && result.account).toEqual({
      externalAccountId: BOT_DC_KEY,
      displayName: "AgentFlow Bot",
      aliases: [BOT_EMAIL, BOT_DC_NAME],
      details: {
        [JiraAccountDetail.Deployment]: JiraDeployment.DataCenter,
        [JiraAccountDetail.TimeZone]: "America/New_York",
        [JiraAccountDetail.UserName]: BOT_DC_NAME,
      },
    });
    expect(fake.requests[0]?.headers?.authorization).toBe(
      `Bearer ${API_TOKEN}`
    );
  });

  it("maps 401 to a credentials message that never contains the token", async () => {
    const fake = routedHttp([
      {
        method: HttpMethod.Get,
        path: "/rest/api/3/myself",
        respond: jsonResponse(401, {
          errorMessages: [
            "You are not authenticated. Authentication required to perform this operation.",
          ],
        }),
      },
    ]);
    const result = await validateJiraConnection(
      makeJiraContext({ http: fake.http }),
      ValidateConnectionReason.Save
    );
    expect(result).toEqual({
      ok: false,
      error: JIRA_CLOUD_CREDENTIALS_REJECTED,
    });
    expect(JSON.stringify(result)).not.toContain(API_TOKEN);
  });

  it("explains a CAPTCHA-locked bot account", async () => {
    const fake = routedHttp([
      {
        method: HttpMethod.Get,
        path: "/rest/api/3/myself",
        respond: jsonResponse(
          403,
          {},
          { "x-seraph-loginreason": "AUTHENTICATION_DENIED" }
        ),
      },
    ]);
    const result = await validateJiraConnection(
      makeJiraContext({ http: fake.http }),
      ValidateConnectionReason.Save
    );
    expect(result.ok).toBe(false);
    expect(!result.ok && result.error).toContain("CAPTCHA");
  });

  it("includes Jira's message for other 403s", async () => {
    const fake = routedHttp([
      {
        method: HttpMethod.Get,
        path: "/rest/api/3/myself",
        respond: jsonResponse(403, {
          errorMessages: ["Site temporarily unavailable for this user"],
        }),
      },
    ]);
    const result = await validateJiraConnection(
      makeJiraContext({ http: fake.http }),
      ValidateConnectionReason.Save
    );
    expect(!result.ok && result.error).toBe(
      "Jira denied access (HTTP 403); check the bot account's project permissions: Site temporarily unavailable for this user"
    );
  });

  it("points at the site URL and deployment for a 404", async () => {
    const fake = routedHttp([]);
    const result = await validateJiraConnection(
      makeJiraContext({ http: fake.http }),
      ValidateConnectionReason.Save
    );
    expect(!result.ok && result.error).toBe(
      `No Jira REST API was found at ${CLOUD_SITE_URL}. Check the site URL and the deployment type.`
    );
  });

  it("reports an unreachable site", async () => {
    const fake = routedHttp([
      {
        method: HttpMethod.Get,
        path: "/rest/api/3/myself",
        respond: networkFailure(),
      },
    ]);
    const result = await validateJiraConnection(
      makeJiraContext({ http: fake.http }),
      ValidateConnectionReason.Save
    );
    expect(!result.ok && result.error).toContain(
      `Could not reach Jira at ${CLOUD_SITE_URL}`
    );
  });

  it("rejects an HTML page answered with 200", async () => {
    const fake = routedHttp([
      {
        method: HttpMethod.Get,
        path: "/rest/api/3/myself",
        respond: {
          ok: true,
          status: 200,
          headers: new Headers({ "content-type": "text/html" }),
          text: "<html>login</html>",
          json: undefined,
          error: null,
          retryable: false,
        },
      },
    ]);
    const result = await validateJiraConnection(
      makeJiraContext({ http: fake.http }),
      ValidateConnectionReason.Save
    );
    expect(!result.ok && result.error).toContain("unexpected response");
  });

  it("detects a deployment mismatch", async () => {
    const fake = routedHttp([
      {
        method: HttpMethod.Get,
        path: "/rest/api/3/myself",
        respond: jsonResponse(200, DC_MYSELF),
      },
    ]);
    const result = await validateJiraConnection(
      makeJiraContext({ http: fake.http }),
      ValidateConnectionReason.Save
    );
    expect(!result.ok && result.error).toContain("choose that deployment");
  });

  it("rejects a deactivated account", async () => {
    const fake = routedHttp([
      {
        method: HttpMethod.Get,
        path: "/rest/api/3/myself",
        respond: jsonResponse(200, { ...CLOUD_MYSELF, active: false }),
      },
    ]);
    const result = await validateJiraConnection(
      makeJiraContext({ http: fake.http }),
      ValidateConnectionReason.Save
    );
    expect(!result.ok && result.error).toContain("deactivated");
  });
});
