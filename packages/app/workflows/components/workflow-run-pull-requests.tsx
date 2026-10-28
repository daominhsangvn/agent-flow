"use client";

import type { WorkflowRunPullRequest } from "@repo/api/src/types/workflow";
import { ExternalLinkIcon, GitPullRequestIcon } from "lucide-react";

export type WorkflowRunPullRequestsProps = {
  pullRequests: WorkflowRunPullRequest[];
  /**
   * compact: one short link per repository (runs table). detailed: the full
   * repository name and the branch (run detail).
   */
  variant: "compact" | "detailed";
  emptyText: string;
};

/** The pull requests a run opened, one per repository it changed. */
export function WorkflowRunPullRequests({
  pullRequests,
  variant,
  emptyText,
}: Readonly<WorkflowRunPullRequestsProps>) {
  if (pullRequests.length === 0) {
    return <span className="text-muted-foreground">{emptyText}</span>;
  }
  return (
    <ul className="space-y-1">
      {pullRequests.map((pullRequest) => (
        <li className="min-w-0" key={pullRequest.url}>
          {variant === "compact" ? (
            <CompactPullRequestLink pullRequest={pullRequest} />
          ) : (
            <DetailedPullRequestLink pullRequest={pullRequest} />
          )}
        </li>
      ))}
    </ul>
  );
}

function CompactPullRequestLink({
  pullRequest,
}: Readonly<{ pullRequest: WorkflowRunPullRequest }>) {
  return (
    <a
      className="inline-flex max-w-full items-center gap-1 whitespace-nowrap text-[var(--link)] hover:underline"
      href={pullRequest.url}
      rel="noreferrer noopener"
      target="_blank"
      title={pullRequest.repository ?? pullRequest.url}
    >
      <span className="truncate">{compactLabel(pullRequest)}</span>
      <ExternalLinkIcon className="size-3 shrink-0" />
    </a>
  );
}

function DetailedPullRequestLink({
  pullRequest,
}: Readonly<{ pullRequest: WorkflowRunPullRequest }>) {
  return (
    <div className="flex min-w-0 flex-wrap items-center gap-x-2">
      <a
        className="inline-flex min-w-0 items-center gap-1 text-[var(--link)] hover:underline"
        href={pullRequest.url}
        rel="noreferrer noopener"
        target="_blank"
      >
        <GitPullRequestIcon className="size-3.5 shrink-0" />
        <span className="truncate">{detailedLabel(pullRequest)}</span>
      </a>
      {pullRequest.branch ? (
        <span className="font-mono text-muted-foreground text-xs">
          {pullRequest.branch}
        </span>
      ) : null}
    </div>
  );
}

function compactLabel(pullRequest: WorkflowRunPullRequest): string {
  const name = pullRequest.repository?.split("/").at(-1);
  if (!name) {
    return pullRequest.number === null ? "Open" : `#${pullRequest.number}`;
  }
  return pullRequest.number === null ? name : `${name} #${pullRequest.number}`;
}

function detailedLabel(pullRequest: WorkflowRunPullRequest): string {
  if (!pullRequest.repository) {
    return pullRequest.url;
  }
  return pullRequest.number === null
    ? pullRequest.repository
    : `${pullRequest.repository} #${pullRequest.number}`;
}
