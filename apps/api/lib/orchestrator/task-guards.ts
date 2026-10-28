import path from "node:path";
import { Result } from "@repo/api/src/types/result";
import {
  type ComputeTargetCapabilities,
  type RunnerCommand,
  RunnerCommandMode,
} from "@repo/api/src/types/runner-capabilities";
import { withDb } from "@repo/database";
import { createProviderContext } from "@/lib/integrations/connection-service";
import { loadProjectConnectionRuntime } from "@/lib/integrations/project-connections";
import { readChannel } from "./channel";

/**
 * What a task may start with (docs/orchestrator.md "Tasks and waits", F10):
 * the command must be declared by the runner's AGENTFLOW.md, a read command
 * does not run in write mode, and the files the command `needs` must exist,
 * either passed in or already attached to the ticket.
 */

const LOG_PREFIX = "[orchestrator/task-guards]";

export type NeedGap = { need: string; patterns: string[]; producers: string[] };

type CheckedCommand = { declared: RunnerCommand; mode: RunnerCommandMode };

export function checkTaskCommand(
  runner: ComputeTargetCapabilities,
  command: string,
  mode: RunnerCommandMode | null
): Result<CheckedCommand, string> {
  if (runner.capabilities === null) {
    const why = runner.problems.join("; ") || "no front matter";
    return Result.err(
      `${runner.runnerName}'s AGENTFLOW.md does not parse (${why}): fix it and refresh its capabilities; none of its commands can run.`
    );
  }
  const commands = runner.capabilities.commands;
  const declared = commands.find((entry) => entry.name === command);
  if (!declared) {
    const names =
      commands.map((entry) => entry.name).join(", ") || "no commands";
    return Result.err(
      `${command} is not declared in ${runner.runnerName}'s AGENTFLOW.md (it declares ${names}): run one of its declared commands (runners_list).`
    );
  }
  if (
    mode === RunnerCommandMode.Write &&
    declared.mode === RunnerCommandMode.Read
  ) {
    return Result.err(
      `${command} is declared mode: read on ${runner.runnerName}: it cannot run in write mode.`
    );
  }
  return Result.ok({ declared, mode: mode ?? declared.mode });
}

export function missingNeeds(
  files: ComputeTargetCapabilities[],
  declared: RunnerCommand,
  names: string[]
): NeedGap[] {
  const gaps: NeedGap[] = [];
  for (const need of declared.needs ?? []) {
    const gap = gapFor(files, need, names);
    if (gap) {
      gaps.push(gap);
    }
  }
  return gaps;
}

export async function checkTaskNeeds(input: {
  organizationId: string;
  conversationId: string;
  files: ComputeTargetCapabilities[];
  declared: RunnerCommand;
  inputNames: string[];
}): Promise<Result<void, string>> {
  if (
    missingNeeds(input.files, input.declared, input.inputNames).length === 0
  ) {
    return Result.ok(undefined);
  }
  const ticketNames = await ticketAttachmentNames(
    input.organizationId,
    input.conversationId
  );
  if (ticketNames === null) {
    return Result.ok(undefined);
  }
  const gaps = missingNeeds(input.files, input.declared, [
    ...input.inputNames,
    ...ticketNames,
  ]);
  const gap = gaps[0];
  if (!gap) {
    return Result.ok(undefined);
  }
  return Result.err(
    `${input.declared.name} needs ${gap.need} (${gap.patterns.join(", ")}, produced by ${gap.producers.join(", ")}): pass that file in files ([{taskId, name}] of the task that wrote it) or attach it to the ticket first.`
  );
}

function gapFor(
  files: ComputeTargetCapabilities[],
  need: string,
  names: string[]
): NeedGap | null {
  const producers: string[] = [];
  const patterns = new Set<string>();
  for (const file of files) {
    for (const command of file.capabilities?.commands ?? []) {
      if (command.produces !== need) {
        continue;
      }
      producers.push(`${command.name} on ${file.runnerName}`);
      for (const pattern of command.attach ?? []) {
        patterns.add(pattern);
      }
    }
  }
  if (patterns.size === 0) {
    return null;
  }
  const met = [...patterns].some((pattern) =>
    names.some((name) =>
      path.posix.matchesGlob(
        path.posix.basename(name),
        path.posix.basename(pattern)
      )
    )
  );
  return met ? null : { need, patterns: [...patterns], producers };
}

async function ticketAttachmentNames(
  organizationId: string,
  conversationId: string
): Promise<string[] | null> {
  const conversation = await withDb((db) =>
    db.orchestratorConversation.findFirst({
      where: { id: conversationId, organizationId },
      select: { projectConnectionId: true, channel: true },
    })
  );
  const channel = readChannel(conversation?.channel);
  if (!(conversation?.projectConnectionId && channel)) {
    return null;
  }
  const loaded = await loadProjectConnectionRuntime(
    organizationId,
    conversation.projectConnectionId
  );
  const fetchItem = loaded?.connection.provider.source?.fetchItem;
  if (!(loaded && fetchItem)) {
    return null;
  }
  try {
    const item = await fetchItem(
      createProviderContext(loaded.connection.runtime, LOG_PREFIX),
      channel.item
    );
    return item.attachments.map((attachment) => attachment.name);
  } catch {
    return null;
  }
}
