import {
  IntegrationFieldKind,
  IntegrationProviderKey,
} from "@repo/api/src/types/integration";
import { describe, expect, it } from "vitest";
import type { ConnectionRuntime, InboundEvent } from "../../../types";
import { JiraEventAttribute, JiraTriggerType } from "../constants";
import type { JiraConnectionConfig } from "../schemas";
import {
  jiraIssueAssignedConfigSchema,
  jiraIssueAssignedTrigger,
  jiraIssueLabeledConfigSchema,
  jiraIssueLabeledTrigger,
} from "../triggers";
import { CLOUD_BOT_ACCOUNT, cloudConfig, NOW } from "./jira.test-helpers";

const connection: ConnectionRuntime<JiraConnectionConfig> = {
  id: "conn-1",
  organizationId: "org-1",
  provider: IntegrationProviderKey.Jira,
  name: "Acme Jira",
  config: cloudConfig(),
  secrets: {},
  account: CLOUD_BOT_ACCOUNT,
};

function event(
  triggerType: JiraTriggerType,
  attributes: InboundEvent["attributes"]
): InboundEvent {
  return {
    triggerType,
    dedupKey: "PROJ-1:assignee:1",
    occurredAt: NOW,
    actor: null,
    item: {
      provider: IntegrationProviderKey.Jira,
      externalId: "1",
      key: "PROJ-1",
      url: null,
      title: null,
      container: "PROJ",
    },
    attributes,
  };
}

const assigned = event(JiraTriggerType.IssueAssigned, {
  [JiraEventAttribute.ProjectKey]: "PROJ",
  [JiraEventAttribute.IssueType]: "Story",
  [JiraEventAttribute.Labels]: ["ai-ready", "Reports"],
  [JiraEventAttribute.Status]: "To Do",
});

function assignedMatches(
  config: Record<string, unknown>,
  target = assigned
): boolean {
  return jiraIssueAssignedTrigger.matches(
    target,
    jiraIssueAssignedConfigSchema.parse(config),
    connection
  );
}

function labeledMatches(
  config: Record<string, unknown>,
  target: InboundEvent
): boolean {
  return jiraIssueLabeledTrigger.matches(
    target,
    jiraIssueLabeledConfigSchema.parse(config),
    connection
  );
}

describe("jira.issue_assigned", () => {
  it("declares its filters and a manual run by issue key", () => {
    expect(jiraIssueAssignedTrigger.key).toBe(JiraTriggerType.IssueAssigned);
    expect(
      jiraIssueAssignedTrigger.configFields.map((field) => [
        field.key,
        field.kind,
      ])
    ).toEqual([
      ["projectKeys", IntegrationFieldKind.StringList],
      ["issueTypes", IntegrationFieldKind.StringList],
      ["labels", IntegrationFieldKind.StringList],
    ]);
    expect(jiraIssueAssignedTrigger.manualRun).toEqual({
      label: "Issue key",
      placeholder: "PROJ-123",
    });
  });

  it("parses an empty config and cleans filter lists", () => {
    expect(jiraIssueAssignedConfigSchema.parse({})).toEqual({
      projectKeys: [],
      issueTypes: [],
      labels: [],
    });
    expect(
      jiraIssueAssignedConfigSchema.parse({
        projectKeys: [" PROJ ", "", "proj", "OPS"],
      }).projectKeys
    ).toEqual(["PROJ", "OPS"]);
    expect(
      jiraIssueAssignedConfigSchema.safeParse({ projectKeys: "PROJ" }).success
    ).toBe(false);
  });

  it("matches anything with empty filters", () => {
    expect(assignedMatches({})).toBe(true);
  });

  it("filters by project and issue type, case-insensitively", () => {
    expect(assignedMatches({ projectKeys: ["proj"] })).toBe(true);
    expect(assignedMatches({ projectKeys: ["OPS"] })).toBe(false);
    expect(assignedMatches({ issueTypes: ["story", "Bug"] })).toBe(true);
    expect(assignedMatches({ issueTypes: ["Bug"] })).toBe(false);
    expect(
      assignedMatches({ projectKeys: ["PROJ"], issueTypes: ["Bug"] })
    ).toBe(false);
  });

  it("requires any of the labels", () => {
    expect(assignedMatches({ labels: ["reports"] })).toBe(true);
    expect(assignedMatches({ labels: ["backend", "AI-READY"] })).toBe(true);
    expect(assignedMatches({ labels: ["backend"] })).toBe(false);
    const unlabeled = event(JiraTriggerType.IssueAssigned, {
      [JiraEventAttribute.ProjectKey]: "PROJ",
      [JiraEventAttribute.Labels]: [],
    });
    expect(assignedMatches({ labels: ["reports"] }, unlabeled)).toBe(false);
  });

  it("fails a filter when the attribute is missing", () => {
    const bare = event(JiraTriggerType.IssueAssigned, {});
    expect(assignedMatches({}, bare)).toBe(true);
    expect(assignedMatches({ issueTypes: ["Story"] }, bare)).toBe(false);
  });
});

describe("jira.issue_labeled", () => {
  const labeled = event(JiraTriggerType.IssueLabeled, {
    [JiraEventAttribute.ProjectKey]: "PROJ",
    [JiraEventAttribute.IssueType]: "Bug",
    [JiraEventAttribute.Labels]: ["ai-ready", "old"],
    [JiraEventAttribute.AddedLabels]: ["ai-ready"],
  });

  it("requires a label without spaces", () => {
    expect(jiraIssueLabeledConfigSchema.safeParse({}).success).toBe(false);
    expect(
      jiraIssueLabeledConfigSchema.safeParse({ label: "  " }).success
    ).toBe(false);
    expect(
      jiraIssueLabeledConfigSchema.safeParse({ label: "ai ready" }).success
    ).toBe(false);
    expect(jiraIssueLabeledConfigSchema.parse({ label: " ai-ready " })).toEqual(
      {
        label: "ai-ready",
        projectKeys: [],
        issueTypes: [],
      }
    );
    const labelField = jiraIssueLabeledTrigger.configFields.find(
      (field) => field.key === "label"
    );
    expect(labelField?.required).toBe(true);
  });

  it("matches only when the configured label was added", () => {
    expect(labeledMatches({ label: "AI-Ready" }, labeled)).toBe(true);
    expect(labeledMatches({ label: "old" }, labeled)).toBe(false);
  });

  it("applies the project and issue type filters", () => {
    expect(
      labeledMatches({ label: "ai-ready", projectKeys: ["PROJ"] }, labeled)
    ).toBe(true);
    expect(
      labeledMatches({ label: "ai-ready", issueTypes: ["Story"] }, labeled)
    ).toBe(false);
  });
});
