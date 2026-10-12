// AgentFlow domain sample data for Storybook.
//
// FEA-4296: these fixtures used to live in
// `@repo/design-system/storybook/mock-data.ts`, which made the generic component
// library import `@agentflow-ai/loops-api` domain status configs — the exact thing
// `packages/design-system/AGENTS.md` bans. The generic half of that module
// (users, invoice rows, chart series, sidebar nav) stayed behind; everything
// typed by a AgentFlow contract moved here, to the package that already owns
// domain code for both the web app and the desktop renderer.
//
// Story-only fixtures: nothing in a shipped render path imports this module.

import { LoopCommand, LoopStatus } from "@agentflow-ai/loops-api/commands";
import { Priority } from "@agentflow-ai/loops-api/common";
import type { BackendMismatchBody } from "@agentflow-ai/loops-api/compute-target";
import {
  DocumentStatus,
  IssueStatus,
  type PullRequestInfo,
  PullRequestState,
} from "@agentflow-ai/loops-api/document";
import { LoopErrorCode } from "@agentflow-ai/loops-api/error-codes";
import type { FriendlyErrorInput } from "@agentflow-ai/loops-api/friendly-error";
import type { GitHubRepository } from "@agentflow-ai/loops-api/github";

export const mockBackendMismatch = {
  error: "backend_mismatch",
  message: "Artifact was last run on a different compute target.",
  originalComputeTargetId: "ct-original",
  originalComputeTargetName: "Local GPU Runner",
  preferredComputeTargetId: "ct-preferred",
  documentId: "doc-42",
} satisfies BackendMismatchBody;

export const mockFriendlyError = {
  code: LoopErrorCode.RunnerError,
  message: "Claude CLI exited before the loop completed.",
  details: {
    runnerSubcode: "CLAUDE_RATE_LIMIT",
    repoPath: "/Users/example/repo",
  },
  timestamp: "2026-05-28T14:32:00.000Z",
} satisfies FriendlyErrorInput;

export const mockGitHubRepository = {
  id: "repo-1",
  fullName: "agentflow-ai/symphony-alpha",
  name: "symphony-alpha",
  owner: "agentflow-ai",
  private: true,
  githubRepoId: "123456789",
  lastPushedAt: "2026-05-27T15:45:00.000Z",
} satisfies GitHubRepository;

export const mockPullRequest = {
  id: "pr-1",
  number: 1323,
  title: "Catalog app-owned composites in Storybook",
  htmlUrl: "https://github.com/agentflow-ai/symphony-alpha/pull/1323",
  state: PullRequestState.Open,
  isDraft: false,
  headBranch: "feat/design-system-storybook-catalog",
  baseBranch: "main",
  createdAt: new Date("2026-05-28T12:00:00.000Z"),
  checksStatus: null,
  reviewDecision: null,
  externalLinkId: null,
  repoFullName: "agentflow-ai/symphony-alpha",
} satisfies PullRequestInfo;

export const mockDocumentStatusOptions = [
  DocumentStatus.Draft,
  DocumentStatus.InReview,
  DocumentStatus.ChangesRequested,
  DocumentStatus.Approved,
  DocumentStatus.Executed,
  DocumentStatus.Obsolete,
] as const;

export const mockIssueStatusOptions = [
  IssueStatus.Triage,
  IssueStatus.Backlog,
  IssueStatus.Todo,
  IssueStatus.InProgress,
  IssueStatus.InReview,
  IssueStatus.Blocked,
  IssueStatus.Done,
  IssueStatus.Canceled,
] as const;

export const mockIssuePriorityOptions = [
  Priority.Low,
  Priority.Medium,
  Priority.High,
  Priority.Urgent,
] as const;

export const mockLoopStatusOptions = [
  LoopStatus.Pending,
  LoopStatus.Running,
  LoopStatus.Completed,
  LoopStatus.Failed,
  LoopStatus.Cancelled,
] as const;

export const mockLoopCommandOptions = [
  LoopCommand.Plan,
  LoopCommand.Execute,
  LoopCommand.Chat,
  LoopCommand.Explore,
  LoopCommand.EvaluateCode,
] as const;
