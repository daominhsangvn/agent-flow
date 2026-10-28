/**
 * @file loop-claude-env.ts
 * @description Claude Code settings every loop process gets. A loop runs
 * `claude -p`, and its orchestrator launches subagents in the background and
 * waits for them across turns. Print mode stops background tasks that are
 * still running some time after the main agent's last turn (10 minutes in
 * Claude Code 2.1.296), which cut off a plan-draft-writer before it wrote
 * plan.json. A loop waits for its subagents instead; a stuck loop is
 * cancelled from AgentFlow.
 */

export const LoopClaudeEnvVar = {
  PrintBackgroundWaitCeilingMs: "CLAUDE_CODE_PRINT_BG_WAIT_CEILING_MS",
} as const;

/** `0` makes print mode wait for background tasks indefinitely. */
export const LOOP_CLAUDE_ENV: Readonly<Record<string, string>> = {
  [LoopClaudeEnvVar.PrintBackgroundWaitCeilingMs]: "0",
};
