import { existsSync } from "node:fs";
import path from "node:path";
import { LoopArtifactFile } from "@agentflow-ai/loops-api/artifacts";
import { LoopCommand } from "@agentflow-ai/loops-api/commands";
import { outputInstructionForCommand } from "./command-pack-factory.js";

/**
 * Prompts of the AgentFlow Web Command Pack: the native-prompt launcher used
 * when a harness runs PLAN / EXECUTE / REQUEST_CHANGES without the bundled
 * `run-loop.sh` (see command-pack-factory.ts), and the output contract that
 * native-prompt commands append to their prompt.
 */

export function appendCommandPackOutputInstruction(
  command: LoopCommand,
  prompt: string,
  workDir: string
): string {
  return [
    prompt.trimEnd(),
    "",
    "AgentFlow command-pack output contract:",
    outputInstructionForCommand(command),
    `Use work directory: ${workDir}.`,
    "Do not finish until every required output file exists.",
  ].join("\n");
}

export const COMMAND_PACK_NATIVE_LOOP_COMMANDS = new Set<LoopCommand>([
  LoopCommand.Plan,
  LoopCommand.Execute,
  LoopCommand.RequestChanges,
]);
export const LEGACY_CLAUDE_RUN_LOOP_COMMANDS = new Set<LoopCommand>([
  LoopCommand.Plan,
  LoopCommand.Execute,
]);

function commandPackPlanOutputContract(): string {
  return [
    `Write ${LoopArtifactFile.Plan} as JSON.`,
    'The JSON must include a top-level "content" string containing the full markdown plan.',
    `Also write the same markdown to ${LoopArtifactFile.PlanMarkdown} when practical.`,
    `If there are unresolved questions, write them to ${LoopArtifactFile.OpenQuestions}.`,
    `If you run plan evaluation, write judge output to ${LoopArtifactFile.Judges}.`,
  ].join("\n");
}

function commandPackExecutionResultContract(): string {
  return [
    `Always write ${LoopArtifactFile.ExecutionResult} before finishing.`,
    "Use this JSON shape:",
    "{",
    '  "has_changes": true,',
    '  "pr_url": "https://github.com/OWNER/REPO/pull/123",',
    '  "pr_number": 123,',
    '  "pr_title": "PR title",',
    '  "branch_name": "current-branch",',
    '  "base_ref": "base-branch",',
    '  "base_branch": "base-branch",',
    '  "commit_sha": "HEAD_SHA"',
    "}",
    'If there are no changes to push, set "has_changes" to false, "pr_number" to 0, and string fields to "".',
  ].join("\n");
}

export function buildCommandPackLoopPrompt(params: {
  command: LoopCommand;
  workDir: string;
  worktreeDir: string;
  repoPath: string | null;
  planFile: string | null;
  prompt: string | null | undefined;
  mountedPathsFooter: string;
}): string {
  const prdPath = path.join(params.workDir, LoopArtifactFile.Prd);
  const planJsonPath = path.join(params.workDir, LoopArtifactFile.Plan);
  const promptPath = path.join(params.workDir, "prompt.md");
  const lines = [
    "You are running the AgentFlow Web Command Pack.",
    `Command: ${params.command}.`,
    `Primary worktree: ${params.worktreeDir}.`,
    `AgentFlow work directory: ${params.workDir}.`,
  ];

  if (params.repoPath) {
    lines.push(`Source repository path: ${params.repoPath}.`);
  }

  if (existsSync(prdPath)) {
    lines.push(`PRD input: ${prdPath}.`);
  }
  if (params.planFile) {
    lines.push(`Imported plan source: ${params.planFile}.`);
  }
  if (existsSync(planJsonPath)) {
    lines.push(`Existing plan JSON: ${planJsonPath}.`);
  }
  if (existsSync(promptPath)) {
    lines.push(`Requested-change prompt: ${promptPath}.`);
  }
  if (params.prompt) {
    lines.push("", "User prompt:", params.prompt.trim());
  }

  lines.push(
    "",
    "Command behavior:",
    commandPackBehaviorForCommand(params.command),
    "",
    "Output contract:",
    outputInstructionForCommand(params.command),
    params.command === LoopCommand.Execute
      ? commandPackExecutionResultContract()
      : commandPackPlanOutputContract(),
    "",
    "Rules:",
    "- Do not require or invoke claude-plugins, /code:* slash commands, or run-loop.sh.",
    "- Work inside the primary worktree unless a mounted path is explicitly listed.",
    "- Do not finish until every required output file exists in the AgentFlow work directory.",
    params.mountedPathsFooter
  );

  return lines.filter((line) => line.length > 0).join("\n");
}

function commandPackBehaviorForCommand(command: LoopCommand): string {
  switch (command) {
    case LoopCommand.Plan:
      return [
        `Read ${LoopArtifactFile.Prd} from the AgentFlow work directory.`,
        "Inspect the repository enough to produce an implementation plan grounded in the current codebase.",
        "Do not modify source files for PLAN.",
      ].join("\n");
    case LoopCommand.Execute:
      return [
        `Read the plan from ${LoopArtifactFile.Plan}, imported-plan.md, or plan-source.md in the AgentFlow work directory.`,
        "Implement the plan in the worktree.",
        "Commit, push, and open or update a pull request when changes are produced.",
      ].join("\n");
    case LoopCommand.RequestChanges:
      return [
        `Read the current plan from ${LoopArtifactFile.Plan}, imported-plan.md, or plan-source.md in the AgentFlow work directory.`,
        "Read requested changes from prompt.md or the user prompt.",
        "Amend the plan only; do not modify source files.",
      ].join("\n");
    default:
      return "Follow the command-specific user prompt.";
  }
}
