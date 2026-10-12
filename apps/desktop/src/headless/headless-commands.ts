/**
 * @file headless-commands.ts
 * @description Which cloud commands the headless runner executes, and how it
 * prepares them. A runner is a build machine, not a developer workstation: it
 * runs agent loops and answers health checks, and refuses everything the web
 * app uses to browse or drive a person's desktop (filesystem, chats, git
 * actions on local checkouts, deploys, updates, pack installs).
 */

import { z } from "zod";
import {
  type OperationId,
  resolveOperationId,
} from "../main/approvals/approval-operations.js";
import type { DesktopCommandEvent } from "../main/cloud/cloud-protocol.js";

const LOOP_COMMAND_PATH = "/api/gateway/symphony/loop";

const loopBodyWithCallbackSchema = z.looseObject({ apiBaseUrl: z.string() });

/** Operations a headless runner advertises and executes. */
export const HEADLESS_RUNNER_OPERATION_IDS = [
  "symphony_loop",
  "symphony_loop_kill",
  "symphony_status",
  "symphony_logs",
  "health_check",
] as const satisfies readonly OperationId[];

const allowedOperations: ReadonlySet<string> = new Set(
  HEADLESS_RUNNER_OPERATION_IDS
);

export const HeadlessCommandRejection = {
  UnknownOperation: "operationId/path mismatch",
  NotSupported: "operation not supported by the headless runner",
} as const;
export type HeadlessCommandRejection =
  (typeof HeadlessCommandRejection)[keyof typeof HeadlessCommandRejection];

export type HeadlessCommandDecision =
  | { accepted: true; operationId: OperationId }
  | { accepted: false; reason: HeadlessCommandRejection };

/** Decides whether a cloud command may run on the headless runner. */
export function classifyHeadlessCommand(path: string): HeadlessCommandDecision {
  const operationId = resolveOperationId(stripQuery(path));
  if (!operationId) {
    return {
      accepted: false,
      reason: HeadlessCommandRejection.UnknownOperation,
    };
  }
  if (!allowedOperations.has(operationId)) {
    return { accepted: false, reason: HeadlessCommandRejection.NotSupported };
  }
  return { accepted: true, operationId };
}

/**
 * Points a loop command's callbacks (events, artifact uploads, heartbeats) at
 * the API origin the runner itself reaches. The API stamps the command with
 * its own API_BASE_URL, which is frequently a host-local address such as
 * `http://localhost:3002` that a container or a remote machine cannot reach.
 * Other commands, and loop bodies without an `apiBaseUrl`, pass through.
 */
export function rewriteLoopCallbackUrl(
  command: DesktopCommandEvent,
  apiUrl: string
): DesktopCommandEvent {
  if (stripQuery(command.path) !== LOOP_COMMAND_PATH) {
    return command;
  }
  const parsed = loopBodyWithCallbackSchema.safeParse(command.body);
  if (!parsed.success) {
    return command;
  }
  return { ...command, body: { ...parsed.data, apiBaseUrl: apiUrl } };
}

function stripQuery(path: string): string {
  const queryStart = path.indexOf("?");
  return queryStart === -1 ? path : path.slice(0, queryStart);
}
