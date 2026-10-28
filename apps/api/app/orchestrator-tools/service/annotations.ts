/** Annotations and shared schemas of the orchestrator's tool descriptors. */

/** A file of an earlier task of this case. */
export const TASK_FILE_REF = {
  type: "object",
  properties: { taskId: { type: "string" }, name: { type: "string" } },
  required: ["taskId", "name"],
  additionalProperties: false,
};

/** Reads AgentFlow or the item. */
export const READS = {
  readOnlyHint: true,
  destructiveHint: false,
  idempotentHint: true,
  openWorldHint: false,
};
/** Changes the case or the turn in AgentFlow only. */
export const KEEPS = {
  readOnlyHint: false,
  destructiveHint: false,
  idempotentHint: true,
  openWorldHint: false,
};
/** Stops work in AgentFlow (a task's loop) without posting outside it. */
export const STOPS = {
  readOnlyHint: false,
  destructiveHint: true,
  idempotentHint: true,
  openWorldHint: false,
};
/** Posts outside AgentFlow (a comment, a Teams message). */
export const POSTS = {
  readOnlyHint: false,
  destructiveHint: false,
  idempotentHint: false,
  openWorldHint: true,
};

export const NO_ARGUMENTS = {
  type: "object",
  properties: {},
  additionalProperties: false,
};
