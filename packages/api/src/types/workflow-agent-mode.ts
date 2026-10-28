/**
 * What a workflow's built-in AgentFlow flow does (WorkflowAgentConfig.mode).
 * Its own module so the process types can use it while the workflow types
 * use the process schema (a workflow can carry its own process).
 */
export const WorkflowAgentMode = {
  /** Generate the implementation plan only. */
  Plan: "plan",
  /** Generate the plan, approve it automatically and implement it (opens a PR). */
  PlanAndExecute: "plan_and_execute",
  /**
   * Start no run: hand each request to the project's orchestrator
   * (docs/orchestrator.md), which chooses the runners' commands.
   */
  Orchestrated: "orchestrated",
} as const;
export type WorkflowAgentMode =
  (typeof WorkflowAgentMode)[keyof typeof WorkflowAgentMode];
