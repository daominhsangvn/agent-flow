"use client";

import {
  type ComputeTargetCapabilities,
  RUNNER_CAPABILITIES_FILE_NAME,
  RunnerCapabilitiesRefreshStatus,
  RunnerCapabilitiesSource,
  RunnerCommandMode,
} from "@repo/api/src/types/runner-capabilities";
// Cross-slice: same retryable error block as the runners list.
import { QueryErrorMessage } from "@repo/app/integrations/components/query-error-message";
import { Badge } from "@repo/design-system/components/ui/badge";
import { Button } from "@repo/design-system/components/ui/button";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@repo/design-system/components/ui/select";
import { useState } from "react";
import { useProjectRepositories } from "../hooks/use-project-repositories";
import { useProjectRunnerCapabilities } from "../hooks/use-project-runner-capabilities";
import { useAssignableComputers } from "../hooks/use-project-runners";
import {
  type RunnerCapabilitiesRefreshRef,
  useRequestRunnerCapabilitiesRefresh,
  useRunnerCapabilitiesRefresh,
} from "../hooks/use-runner-capabilities-refresh";

export type ProjectRunnerCapabilitiesProps = {
  projectId: string;
  isAdmin: boolean;
};

const PROCESS_TOOLKIT_VALUE = "__process_toolkit__";

/**
 * Project → Runners → Commands: what each runner declares it can do for the
 * project in its `AGENTFLOW.md` (the commands and skills the orchestrator
 * chooses from). Loaded when opened: the panel above already reads the runners.
 */
export function ProjectRunnerCapabilities({
  projectId,
  isAdmin,
}: Readonly<ProjectRunnerCapabilitiesProps>) {
  const [isOpen, setIsOpen] = useState(false);
  const files = useProjectRunnerCapabilities(projectId, { enabled: isOpen });

  return (
    <div className="space-y-3" data-testid="project-runner-capabilities">
      <div className="flex items-center justify-between gap-2">
        <div>
          <h4 className="font-medium text-sm">Commands</h4>
          <p className="text-muted-foreground text-xs">
            What each runner says it can do, from the{" "}
            {RUNNER_CAPABILITIES_FILE_NAME} in its project folder (a personal
            runner, uploaded when it connects and whenever it changes) or in its
            toolkit repository (an auto runner, read daily, when the project's
            process toolkit changes, or on Refresh).
          </p>
        </div>
        <Button
          onClick={() => setIsOpen((value) => !value)}
          size="sm"
          type="button"
          variant={isOpen ? "ghost" : "outline"}
        >
          {isOpen ? "Hide" : "Show"}
        </Button>
      </div>
      {isOpen ? (
        <CapabilitiesBody
          files={files}
          isAdmin={isAdmin}
          projectId={projectId}
        />
      ) : null}
    </div>
  );
}

function CapabilitiesBody({
  files,
  isAdmin,
  projectId,
}: Readonly<{
  files: ReturnType<typeof useProjectRunnerCapabilities>;
  isAdmin: boolean;
  projectId: string;
}>) {
  if (files.error) {
    return (
      <QueryErrorMessage
        error={files.error}
        onRetry={() => files.refetch()}
        title="Couldn't load the runners' commands"
      />
    );
  }
  if (files.isLoading) {
    return <p className="text-muted-foreground text-sm">Loading…</p>;
  }
  const list = files.data ?? [];
  return (
    <div className="space-y-3">
      {list.length === 0 ? (
        <p className="rounded-md border border-dashed p-3 text-muted-foreground text-sm">
          No runner has uploaded an {RUNNER_CAPABILITIES_FILE_NAME} for this
          project yet.
        </p>
      ) : (
        <ul className="divide-y rounded-md border">
          {list.map((file) => (
            <CapabilitiesRow
              file={file}
              isAdmin={isAdmin}
              key={file.id}
              projectId={projectId}
            />
          ))}
        </ul>
      )}
      {isAdmin ? <ReadFromToolkitForm projectId={projectId} /> : null}
    </div>
  );
}

function CapabilitiesRow({
  file,
  isAdmin,
  projectId,
}: Readonly<{
  file: ComputeTargetCapabilities;
  isAdmin: boolean;
  projectId: string;
}>) {
  const [showFile, setShowFile] = useState(false);
  const [refresh, setRefresh] = useState<RunnerCapabilitiesRefreshRef | null>(
    null
  );
  const request = useRequestRunnerCapabilitiesRefresh();
  const canRefresh =
    isAdmin && file.source === RunnerCapabilitiesSource.Toolkit;
  const commands = file.capabilities?.commands ?? [];
  const skills = file.capabilities?.skills ?? [];
  return (
    <li className="space-y-2 px-3 py-2" data-testid="runner-capabilities-row">
      <div className="flex items-start gap-2">
        <span
          aria-hidden="true"
          className={`mt-1.5 size-2 shrink-0 rounded-full ${file.isOnline ? "bg-green-500" : "bg-muted-foreground/40"}`}
        />
        <div className="min-w-0 flex-1">
          <span className="block truncate font-medium text-sm">
            {file.capabilities?.runner ?? file.runnerName}
          </span>
          <span className="block truncate text-muted-foreground text-xs">
            {file.runnerName} · {file.source} · updated{" "}
            {new Date(file.uploadedAt).toLocaleString()}
          </span>
        </div>
        {canRefresh ? (
          <Button
            disabled={request.isPending}
            onClick={() =>
              request.mutate(
                {
                  computeTargetId: file.computeTargetId,
                  project: file.projectId,
                },
                {
                  onSuccess: (started) =>
                    setRefresh({
                      computeTargetId: started.computeTargetId,
                      refreshId: started.refreshId,
                    }),
                }
              )
            }
            size="sm"
            type="button"
            variant="ghost"
          >
            Refresh
          </Button>
        ) : null}
        <Button
          onClick={() => setShowFile((value) => !value)}
          size="sm"
          type="button"
          variant="ghost"
        >
          {showFile ? "Hide file" : "View file"}
        </Button>
      </div>
      <RefreshStatus projectId={projectId} refresh={refresh} />
      <MessageList items={file.problems} tone="error" />
      <MessageList items={file.warnings} tone="warning" />
      {commands.length > 0 ? (
        <ul aria-label="Commands" className="space-y-1">
          {commands.map((command) => (
            <li
              className="flex flex-wrap items-center gap-1.5 text-xs"
              key={command.name}
            >
              <code className="font-mono">
                {command.name}
                {command.args ? ` ${command.args}` : ""}
              </code>
              <Badge
                variant={
                  command.mode === RunnerCommandMode.Write ? "warning" : "muted"
                }
              >
                {command.mode}
              </Badge>
              {command.produces ? (
                <Badge variant="outline">→ {command.produces}</Badge>
              ) : null}
              {command.description ? (
                <span className="text-muted-foreground">
                  {command.description}
                </span>
              ) : null}
            </li>
          ))}
        </ul>
      ) : null}
      {file.capabilities?.toolkit ? (
        <p className="text-muted-foreground text-xs">
          Toolkit: <code>{file.capabilities.toolkit.repository}</code> (
          {file.capabilities.toolkit.mounts.join(", ")})
        </p>
      ) : null}
      {skills.length > 0 ? (
        <p className="text-muted-foreground text-xs">
          Skills: {skills.map((skill) => skill.name).join(", ")}
        </p>
      ) : null}
      {showFile ? (
        <pre className="max-h-80 overflow-auto whitespace-pre-wrap rounded bg-muted p-2 text-xs">
          {file.content}
        </pre>
      ) : null}
    </li>
  );
}

function MessageList({
  items,
  tone,
}: Readonly<{ items: string[]; tone: "error" | "warning" }>) {
  if (items.length === 0) {
    return null;
  }
  const color =
    tone === "error"
      ? "text-destructive"
      : "text-amber-600 dark:text-amber-400";
  return (
    <ul className={`space-y-0.5 text-xs ${color}`}>
      {items.map((item) => (
        <li key={item}>{item}</li>
      ))}
    </ul>
  );
}

function RefreshStatus({
  projectId,
  refresh,
}: Readonly<{
  projectId: string;
  refresh: RunnerCapabilitiesRefreshRef | null;
}>) {
  const { data } = useRunnerCapabilitiesRefresh(projectId, refresh);
  if (!refresh) {
    return null;
  }
  if (data?.status === RunnerCapabilitiesRefreshStatus.Failed) {
    return (
      <p className="text-destructive text-xs" role="alert">
        {data.error ?? "The runner could not read its toolkit."}
      </p>
    );
  }
  if (data?.status === RunnerCapabilitiesRefreshStatus.Succeeded) {
    return null;
  }
  return (
    <p className="text-muted-foreground text-xs">
      Reading {RUNNER_CAPABILITIES_FILE_NAME}
      {data ? ` from ${data.repository}` : ""}…
    </p>
  );
}

function ReadFromToolkitForm({ projectId }: Readonly<{ projectId: string }>) {
  const [isOpen, setIsOpen] = useState(false);
  const [computeTargetId, setComputeTargetId] = useState("");
  const [repository, setRepository] = useState(PROCESS_TOOLKIT_VALUE);
  const [refresh, setRefresh] = useState<RunnerCapabilitiesRefreshRef | null>(
    null
  );
  const computers = useAssignableComputers(isOpen);
  const repositories = useProjectRepositories(projectId, { enabled: isOpen });
  const request = useRequestRunnerCapabilitiesRefresh();

  if (!isOpen) {
    return (
      <Button
        onClick={() => setIsOpen(true)}
        size="sm"
        type="button"
        variant="outline"
      >
        Read from a runner's toolkit
      </Button>
    );
  }

  const submit = () => {
    request.mutate(
      {
        computeTargetId,
        project: projectId,
        repository:
          repository === PROCESS_TOOLKIT_VALUE ? undefined : repository,
      },
      {
        onSuccess: (started) =>
          setRefresh({
            computeTargetId: started.computeTargetId,
            refreshId: started.refreshId,
          }),
      }
    );
  };

  return (
    <div className="space-y-2 rounded-md border p-3">
      <div className="flex flex-wrap items-center gap-2">
        <Select onValueChange={setComputeTargetId} value={computeTargetId}>
          <SelectTrigger aria-label="Runner" className="flex-1">
            <SelectValue placeholder="Choose a runner" />
          </SelectTrigger>
          <SelectContent>
            {(computers.data ?? []).map((computer) => (
              <SelectItem key={computer.id} value={computer.id}>
                {computer.machineName}
              </SelectItem>
            ))}
          </SelectContent>
        </Select>
        <Select onValueChange={setRepository} value={repository}>
          <SelectTrigger aria-label="Toolkit repository" className="flex-1">
            <SelectValue />
          </SelectTrigger>
          <SelectContent>
            <SelectItem value={PROCESS_TOOLKIT_VALUE}>
              Default: the file's toolkit, else the process toolkit
            </SelectItem>
            {(repositories.data ?? []).map((repo) => (
              <SelectItem key={repo.id} value={repo.fullName}>
                {repo.fullName}
              </SelectItem>
            ))}
          </SelectContent>
        </Select>
        <Button
          disabled={!computeTargetId || request.isPending}
          onClick={submit}
          size="sm"
          type="button"
        >
          Read
        </Button>
        <Button
          onClick={() => setIsOpen(false)}
          size="sm"
          type="button"
          variant="ghost"
        >
          Close
        </Button>
      </div>
      <RefreshStatus projectId={projectId} refresh={refresh} />
    </div>
  );
}
