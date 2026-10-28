import {
  IntegrationFieldKind,
  IntegrationProviderKey,
} from "@repo/api/src/types/integration";
import { describe, expect, it } from "vitest";
import { TriggerConditionMatch } from "../../../trigger-conditions";
import type { ConnectionRuntime, InboundEvent } from "../../../types";
import {
  JiraEventAttribute,
  JiraLabelChange,
  JiraTriggerType,
} from "../constants";
import type { JiraConnectionConfig } from "../schemas";
import {
  jiraIssueAssignedConfigSchema,
  jiraIssueAssignedTrigger,
  jiraIssueConditionsConfigSchema,
  jiraIssueConditionsTrigger,
  jiraIssueLabeledConfigSchema,
  jiraIssueLabeledTrigger,
  jiraIssueStatusChangedConfigSchema,
  jiraIssueStatusChangedTrigger,
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
        change: JiraLabelChange.Added,
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

  it("reacts to removals only when change allows it", () => {
    const removed = event(JiraTriggerType.IssueLabeled, {
      [JiraEventAttribute.ProjectKey]: "PROJ",
      [JiraEventAttribute.AddedLabels]: [],
      [JiraEventAttribute.RemovedLabels]: ["create-prd"],
    });
    expect(labeledMatches({ label: "create-prd" }, removed)).toBe(false);
    expect(
      labeledMatches(
        { label: "create-prd", change: JiraLabelChange.Removed },
        removed
      )
    ).toBe(true);
    expect(
      labeledMatches(
        { label: "other", change: JiraLabelChange.Removed },
        removed
      )
    ).toBe(false);
    expect(
      labeledMatches(
        { label: "ai-ready", change: JiraLabelChange.Removed },
        labeled
      )
    ).toBe(false);
    expect(
      labeledMatches(
        { label: "create-prd", change: JiraLabelChange.Both },
        removed
      )
    ).toBe(true);
    expect(
      labeledMatches(
        { label: "ai-ready", change: JiraLabelChange.Both },
        labeled
      )
    ).toBe(true);
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

describe("jira.issue_conditions", () => {
  /** A jira.issue_conditions event: what the occurrence did and the issue state after it. */
  function occurrence(facts: {
    assignedToBot?: boolean;
    becameAssigned?: boolean;
    labels?: string[];
    addedLabels?: string[];
    mentioned?: boolean;
    status?: string;
  }): InboundEvent {
    return event(JiraTriggerType.IssueConditions, {
      [JiraEventAttribute.ProjectKey]: "PROJ",
      [JiraEventAttribute.IssueType]: "Story",
      [JiraEventAttribute.Status]: facts.status ?? "To Do",
      [JiraEventAttribute.Labels]: facts.labels ?? [],
      [JiraEventAttribute.AssignedToBot]: facts.assignedToBot ?? false,
      [JiraEventAttribute.BecameAssigned]: facts.becameAssigned ?? false,
      [JiraEventAttribute.AddedLabels]: facts.addedLabels ?? [],
      [JiraEventAttribute.Mentioned]: facts.mentioned ?? false,
    });
  }

  function conditionsMatch(
    config: Record<string, unknown>,
    target: InboundEvent
  ): boolean {
    return jiraIssueConditionsTrigger.matches(
      target,
      jiraIssueConditionsConfigSchema.parse(config),
      connection
    );
  }

  const assignedWithoutLabel = occurrence({
    assignedToBot: true,
    becameAssigned: true,
  });
  const labeledWhileAssigned = occurrence({
    assignedToBot: true,
    labels: ["ai-ready"],
    addedLabels: ["ai-ready"],
  });
  const assignedWhileLabeled = occurrence({
    assignedToBot: true,
    becameAssigned: true,
    labels: ["ai-ready"],
  });
  const labeledUnassigned = occurrence({
    labels: ["ai-ready"],
    addedLabels: ["ai-ready"],
  });

  it("declares the conditions, how they combine and the filters", () => {
    expect(
      jiraIssueConditionsTrigger.configFields.map((field) => [
        field.key,
        field.kind,
      ])
    ).toEqual([
      ["match", IntegrationFieldKind.Select],
      ["assigned", IntegrationFieldKind.Boolean],
      ["labels", IntegrationFieldKind.StringList],
      ["mentioned", IntegrationFieldKind.Boolean],
      ["projectKeys", IntegrationFieldKind.StringList],
      ["issueTypes", IntegrationFieldKind.StringList],
      ["statuses", IntegrationFieldKind.StringList],
    ]);
    expect(jiraIssueConditionsConfigSchema.parse({ assigned: true })).toEqual({
      match: TriggerConditionMatch.All,
      assigned: true,
      labels: [],
      mentioned: false,
      projectKeys: [],
      issueTypes: [],
      statuses: [],
    });
  });

  it("requires at least one condition and labels without spaces", () => {
    expect(jiraIssueConditionsConfigSchema.safeParse({}).success).toBe(false);
    expect(
      jiraIssueConditionsConfigSchema.safeParse({ statuses: ["To Do"] }).success
    ).toBe(false);
    expect(
      jiraIssueConditionsConfigSchema.safeParse({ labels: ["ai ready"] })
        .success
    ).toBe(false);
    expect(
      jiraIssueConditionsConfigSchema.safeParse({ match: "most" }).success
    ).toBe(false);
  });

  it("starts on the second of assigned + labeled, in either order (all)", () => {
    const config = { assigned: true, labels: ["AI-Ready"] };
    expect(conditionsMatch(config, assignedWithoutLabel)).toBe(false);
    expect(conditionsMatch(config, labeledUnassigned)).toBe(false);
    expect(conditionsMatch(config, labeledWhileAssigned)).toBe(true);
    expect(conditionsMatch(config, assignedWhileLabeled)).toBe(true);
  });

  it("starts on any condition with any", () => {
    const config = {
      match: TriggerConditionMatch.Any,
      assigned: true,
      labels: ["ai-ready"],
    };
    expect(conditionsMatch(config, assignedWithoutLabel)).toBe(true);
    expect(conditionsMatch(config, labeledUnassigned)).toBe(true);
    expect(conditionsMatch(config, occurrence({ mentioned: true }))).toBe(
      false
    );
  });

  it("needs the occurrence to make a chosen condition true", () => {
    const config = { assigned: true, labels: ["ai-ready"] };
    // Assigned and labeled already; this change added an unrelated label.
    const otherLabel = occurrence({
      assignedToBot: true,
      labels: ["ai-ready", "backend"],
      addedLabels: ["backend"],
    });
    expect(conditionsMatch(config, otherLabel)).toBe(false);
  });

  it("treats a mention as a moment: it starts the run while the other conditions hold", () => {
    const config = { assigned: true, labels: ["ai-ready"], mentioned: true };
    const mentionWhileReady = occurrence({
      mentioned: true,
      assignedToBot: true,
      labels: ["ai-ready"],
    });
    const mentionUnassigned = occurrence({
      mentioned: true,
      labels: ["ai-ready"],
    });
    expect(conditionsMatch(config, mentionWhileReady)).toBe(true);
    expect(conditionsMatch(config, mentionUnassigned)).toBe(false);
    // Assigning after a mention does not count: the mention is over.
    expect(conditionsMatch(config, assignedWhileLabeled)).toBe(false);
  });

  it("applies the project, issue type and status filters", () => {
    const config = { assigned: true };
    expect(
      conditionsMatch({ ...config, statuses: ["to do"] }, assignedWithoutLabel)
    ).toBe(true);
    expect(
      conditionsMatch({ ...config, statuses: ["Done"] }, assignedWithoutLabel)
    ).toBe(false);
    expect(
      conditionsMatch({ ...config, projectKeys: ["OPS"] }, assignedWithoutLabel)
    ).toBe(false);
    expect(
      conditionsMatch({ ...config, issueTypes: ["Bug"] }, assignedWithoutLabel)
    ).toBe(false);
  });
});

describe("jira.issue_status_changed", () => {
  const moved = event(JiraTriggerType.IssueStatusChanged, {
    [JiraEventAttribute.ProjectKey]: "PROJ",
    [JiraEventAttribute.IssueType]: "Story",
    [JiraEventAttribute.FromStatus]: "PRD Review",
    [JiraEventAttribute.ToStatus]: "Ready for Dev",
  });

  function statusMatches(config: Record<string, unknown>): boolean {
    return jiraIssueStatusChangedTrigger.matches(
      moved,
      jiraIssueStatusChangedConfigSchema.parse(config),
      connection
    );
  }

  it("declares its fields and has no manual run", () => {
    expect(
      jiraIssueStatusChangedTrigger.configFields.map((field) => field.key)
    ).toEqual(["from", "to", "projectKeys", "issueTypes"]);
    expect(jiraIssueStatusChangedTrigger.manualRun).toBeUndefined();
  });

  it("matches anything with an empty config", () => {
    expect(statusMatches({})).toBe(true);
  });

  it("filters the target status case-insensitively", () => {
    expect(statusMatches({ to: ["ready for dev"] })).toBe(true);
    expect(statusMatches({ to: ["PRD Review"] })).toBe(false);
  });

  it("filters the source status", () => {
    expect(statusMatches({ from: ["prd review"] })).toBe(true);
    expect(statusMatches({ from: ["To Do"] })).toBe(false);
  });

  it("ANDs from and to", () => {
    expect(statusMatches({ from: ["PRD Review"], to: ["Done"] })).toBe(false);
    expect(statusMatches({ from: ["PRD Review"], to: ["Ready for Dev"] })).toBe(
      true
    );
  });

  it("applies the project filter", () => {
    expect(statusMatches({ projectKeys: ["OTHER"] })).toBe(false);
    expect(statusMatches({ projectKeys: ["PROJ"] })).toBe(true);
  });
});
