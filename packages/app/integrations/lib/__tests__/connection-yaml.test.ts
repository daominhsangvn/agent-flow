import {
  IntegrationConnectionStatus,
  IntegrationDeliveryMode,
} from "@repo/api/src/types/integration";
import { YamlProblemSeverity } from "@repo/app/shared/lib/yaml-problems";
import { describe, expect, it } from "vitest";
import {
  DEPLOYMENT_CLOUD,
  DEPLOYMENT_DATA_CENTER,
  jiraProvider,
  makeConnection,
  teamsProvider,
  webhookProvider,
} from "../../__tests__/integration-fixtures";
import {
  type ConnectionYamlContext,
  connectionToYaml,
  POLL_INTERVAL_ERROR,
  parseConnectionYaml,
} from "../connection-yaml";
import { REQUIRED_FIELD_MESSAGE } from "../integration-field-values";

const NEW_JIRA: ConnectionYamlContext = {
  provider: jiraProvider,
  isEdit: false,
};
const EDIT_JIRA: ConnectionYamlContext = {
  provider: jiraProvider,
  isEdit: true,
};

const VALID_JIRA = `name: Acme Jira
config:
  deployment: cloud
  siteUrl: https://acme.atlassian.net
  email: bot@acme.dev
inbound:
  mode: poll
  pollIntervalSeconds: 300
`;

function messages(text: string, context = NEW_JIRA) {
  return parseConnectionYaml(text, context).problems.map((problem) => [
    problem.line,
    problem.severity,
    problem.message,
  ]);
}

describe("parseConnectionYaml", () => {
  it("reads the name, the settings and the inbound mode", () => {
    const result = parseConnectionYaml(VALID_JIRA, NEW_JIRA);

    expect(result.problems).toEqual([]);
    expect(result.value).toEqual({
      name: "Acme Jira",
      enabled: true,
      config: {
        deployment: DEPLOYMENT_CLOUD,
        siteUrl: "https://acme.atlassian.net",
        email: "bot@acme.dev",
      },
      deliveryMode: IntegrationDeliveryMode.Poll,
      pollIntervalSeconds: 300,
    });
  });

  it("defaults the inbound mode to the provider's first one", () => {
    const result = parseConnectionYaml("name: Hook\nconfig: {}\n", {
      provider: webhookProvider,
      isEdit: false,
    });

    expect(result.value?.deliveryMode).toBe(IntegrationDeliveryMode.Webhook);
    expect(result.value?.pollIntervalSeconds).toBe(120);
  });

  it("places syntax errors and missing settings on their lines", () => {
    expect(messages("name: [unclosed\n")[0]?.[1]).toBe(
      YamlProblemSeverity.Error
    );
    expect(messages("name: Acme\nconfig:\n  deployment: cloud\n")).toEqual([
      [
        2,
        YamlProblemSeverity.Error,
        `Add the setting siteUrl (Site URL): ${REQUIRED_FIELD_MESSAGE}`,
      ],
      [
        2,
        YamlProblemSeverity.Error,
        `Add the setting email (Bot email): ${REQUIRED_FIELD_MESSAGE}`,
      ],
    ]);
  });

  it("checks values against the descriptors: formats and options", () => {
    const text = VALID_JIRA.replace("deployment: cloud", "deployment: on_prem");

    expect(messages(text)).toEqual([
      [
        3,
        YamlProblemSeverity.Error,
        '"on_prem" is not an option of deployment. Options: cloud, data_center',
      ],
    ]);
    expect(messages(VALID_JIRA.replace("bot@acme.dev", "nope"))).toEqual([
      [5, YamlProblemSeverity.Error, "Enter a valid email address"],
    ]);
  });

  it("refuses secrets in the YAML and points to their field", () => {
    const result = parseConnectionYaml(
      VALID_JIRA.replace(
        "  email: bot@acme.dev",
        "  email: bot@acme.dev\n  apiToken: tok-123"
      ),
      NEW_JIRA
    );

    expect(result.value).toBeNull();
    expect(result.problems.map((problem) => problem.message)).toEqual([
      'apiToken is a secret: type it in the "API token" field under the editor. Secrets are never written in the YAML.',
    ]);
  });

  it("warns about unknown keys and settings that do not apply", () => {
    const text = `name: Jira DC
config:
  deployment: ${DEPLOYMENT_DATA_CENTER}
  siteUrl: https://jira.example.com
  email: bot@acme.dev
  sitURL: typo
inbound:
  mode: webhook
  interval: 5
colour: blue
`;
    const result = parseConnectionYaml(text, NEW_JIRA);

    expect(result.value).not.toBeNull();
    expect(
      result.problems.map((problem) => [problem.severity, problem.message])
    ).toEqual([
      [
        YamlProblemSeverity.Warning,
        "email is not used: it only applies when deployment is cloud",
      ],
      [
        YamlProblemSeverity.Warning,
        'Unknown setting "sitURL". Settings: deployment, siteUrl, email',
      ],
      [YamlProblemSeverity.Warning, 'Unknown key "interval" in inbound'],
      [
        YamlProblemSeverity.Warning,
        'Unknown key "colour" in the Jira connection',
      ],
    ]);
  });

  it("checks the inbound mode against the provider and the poll interval range", () => {
    const teams: ConnectionYamlContext = {
      provider: teamsProvider,
      isEdit: false,
    };
    expect(
      messages("name: Teams\nconfig: {}\ninbound:\n  mode: webhook\n", teams)
    ).toEqual([
      [
        4,
        YamlProblemSeverity.Error,
        "Microsoft Teams does not receive events by webhook. Modes: none",
      ],
    ]);
    expect(
      messages(
        VALID_JIRA.replace("pollIntervalSeconds: 300", "pollIntervalSeconds: 5")
      )
    ).toEqual([[8, YamlProblemSeverity.Error, POLL_INTERVAL_ERROR]]);
  });

  it("reads settings even when another part has a problem", () => {
    const result = parseConnectionYaml(
      VALID_JIRA.replace("mode: poll", "mode: sometimes"),
      NEW_JIRA
    );

    expect(result.value).toBeNull();
    expect(result.settings).toMatchObject({
      siteUrl: "https://acme.atlassian.net",
    });
  });

  it("only takes enabled on an existing connection", () => {
    expect(
      parseConnectionYaml(`${VALID_JIRA}enabled: false\n`, EDIT_JIRA).value
        ?.enabled
    ).toBe(false);
    expect(messages(`${VALID_JIRA}enabled: false\n`)).toEqual([
      [
        9,
        YamlProblemSeverity.Warning,
        "A new connection starts enabled: disable it after creating it",
      ],
    ]);
  });
});

describe("connectionToYaml", () => {
  it("writes a stored connection that reads back unchanged", () => {
    const disabled = makeConnection({
      status: IntegrationConnectionStatus.Disabled,
      deliveryMode: IntegrationDeliveryMode.Poll,
      pollIntervalSeconds: 600,
    });
    const text = connectionToYaml(jiraProvider, disabled);

    expect(text).toContain("enabled: false");
    expect(text).not.toContain("apiToken");
    expect(parseConnectionYaml(text, EDIT_JIRA)).toEqual({
      problems: [],
      value: {
        name: disabled.name,
        enabled: false,
        config: disabled.config,
        deliveryMode: IntegrationDeliveryMode.Poll,
        pollIntervalSeconds: 600,
      },
      settings: disabled.config,
    });
  });

  it("starts a new connection with comments, defaults and empty required settings", () => {
    const text = connectionToYaml(jiraProvider);

    expect(
      text
    ).toBe(`# Jira connection. Ctrl+Space suggests the settings and their values.
# Secrets (API token) go in the fields under the editor, never in the YAML.
name: Jira
config:
  # Deployment (required): cloud (Cloud) | data_center (Data Center)
  deployment: cloud
  # Site URL (required)
  siteUrl: ""
  # Bot email (required)
  email: ""
inbound:
  # webhook (Webhook) | poll (Polling) | none (Actions only)
  mode: webhook
  pollIntervalSeconds: 120
`);
    expect(
      parseConnectionYaml(text, NEW_JIRA).problems.map(
        (problem) => problem.message
      )
    ).toEqual([REQUIRED_FIELD_MESSAGE, REQUIRED_FIELD_MESSAGE]);
  });

  it("leaves the inbound mapping out for a provider without inbound events", () => {
    const text = connectionToYaml(teamsProvider);

    expect(text).toContain("config: {}");
    expect(text).not.toContain("inbound:");
    expect(
      parseConnectionYaml(text, { provider: teamsProvider, isEdit: false })
        .value?.deliveryMode
    ).toBe(IntegrationDeliveryMode.None);
  });

  it("quotes values that would not read back as text", () => {
    const text = connectionToYaml(
      jiraProvider,
      makeConnection({ name: "yes: #1" })
    );

    expect(text).toContain('name: "yes: #1"');
    expect(parseConnectionYaml(text, EDIT_JIRA).value?.name).toBe("yes: #1");
  });
});
