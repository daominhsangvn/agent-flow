"use client";

import { PROJECT_AGENT_INSTRUCTIONS_MAX } from "@repo/api/src/types/project-agent-instructions";
// Cross-slice: same retryable error block as the repositories list.
import { QueryErrorMessage } from "@repo/app/integrations/components/query-error-message";
import { Button } from "@repo/design-system/components/ui/button";
import { Textarea } from "@repo/design-system/components/ui/textarea";
import { useState } from "react";
import {
  useProjectAgentInstructions,
  useSaveProjectAgentInstructions,
} from "../hooks/use-project-agent-instructions";

const PLACEHOLDER = `## About the project
Online store for B2B customers. An "account" is a customer company, not a user.

## Repositories
- shop: the storefront (Next.js). Talks to api over REST.
- api: the backend (NestJS). Owns the database schema.

## Conventions
- Changes to the public API need a matching change in shop.
- Every change ships with tests.`;

export type ProjectAgentInstructionsPanelProps = {
  projectId: string;
  /** Org admins change the instructions; members read them (the API enforces it). */
  isAdmin: boolean;
};

/**
 * Project → Overview → Agent instructions: the root CLAUDE.md of every agent
 * loop workspace of the project. It carries project-wide context (goal,
 * domain, conventions, how the repositories fit together); each repository's
 * own CLAUDE.md / AGENTS.md still applies inside it.
 */
export function ProjectAgentInstructionsPanel({
  projectId,
  isAdmin,
}: Readonly<ProjectAgentInstructionsPanelProps>) {
  const saved = useProjectAgentInstructions(projectId);
  const save = useSaveProjectAgentInstructions(projectId);
  // null: not edited since the last load or save.
  const [draft, setDraft] = useState<string | null>(null);
  const value = draft ?? saved.data ?? "";
  const isDirty = draft !== null && draft !== (saved.data ?? "");

  return (
    <div className="space-y-3">
      <div>
        <h4 className="font-medium text-sm">Agent instructions</h4>
        <p className="text-muted-foreground text-xs">
          Every agent working on this project reads these first. Describe the
          project — its goal, domain terms, conventions and rules — and what
          each repository does and how they fit together. They become the
          CLAUDE.md of the agent's workspace, which holds all of the project's
          repositories; each repository's own CLAUDE.md or AGENTS.md still
          applies inside it.
          {isAdmin ? null : " Only organization admins can change them."}
        </p>
      </div>
      {saved.error ? (
        <QueryErrorMessage
          error={saved.error}
          onRetry={() => saved.refetch()}
          title="Couldn't load the agent instructions"
        />
      ) : (
        <form
          className="space-y-2"
          onSubmit={(event) => {
            event.preventDefault();
            save.mutate(
              { instructions: value },
              { onSuccess: () => setDraft(null) }
            );
          }}
        >
          <Textarea
            aria-label="Agent instructions"
            className="min-h-48 font-mono text-sm"
            disabled={saved.isLoading}
            maxLength={PROJECT_AGENT_INSTRUCTIONS_MAX}
            onChange={(event) => setDraft(event.target.value)}
            placeholder={saved.isLoading ? "Loading…" : PLACEHOLDER}
            readOnly={!isAdmin}
            value={value}
          />
          <div className="flex items-center justify-between gap-2">
            <span className="text-muted-foreground text-xs">
              {value.length.toLocaleString()} /{" "}
              {PROJECT_AGENT_INSTRUCTIONS_MAX.toLocaleString()}
            </span>
            {isAdmin ? (
              <div className="flex gap-2">
                {isDirty ? (
                  <Button
                    onClick={() => setDraft(null)}
                    size="sm"
                    type="button"
                    variant="ghost"
                  >
                    Discard
                  </Button>
                ) : null}
                <Button
                  disabled={!isDirty || save.isPending}
                  size="sm"
                  type="submit"
                >
                  {save.isPending ? "Saving…" : "Save instructions"}
                </Button>
              </div>
            ) : null}
          </div>
        </form>
      )}
    </div>
  );
}
