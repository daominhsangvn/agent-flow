import {
  type IntegrationFieldDescriptor,
  IntegrationFieldKind,
} from "@repo/api/src/types/integration";
import { HttpMethod, type ValidateConnectionResult } from "../../types";
import {
  type LocalGitContext,
  LocalGitErrorKind,
  localGitRequest,
  pathSegment,
} from "./client";
import {
  LOCAL_GIT_DEFAULT_URL,
  type LocalGitConnectionConfig,
  localGitUserSchema,
  normalizeBaseUrl,
  RUNNER_URL_HINT,
  SERVER_URL_HINT,
} from "./schemas";

/**
 * Connection form and credential check. The token's account is the "bot":
 * agents push and pull requests are opened as this account.
 */

export const LOCAL_GIT_TOKEN_SCOPES =
  "write:repository, write:organization, write:user, write:issue";

export const localGitConnectionFields: IntegrationFieldDescriptor[] = [
  {
    key: "serverUrl",
    label: "Server URL",
    kind: IntegrationFieldKind.Url,
    required: true,
    defaultValue: LOCAL_GIT_DEFAULT_URL,
    placeholder: LOCAL_GIT_DEFAULT_URL,
    description:
      "Address of Local Git as the AgentFlow API reaches it (docker compose publishes it on http://localhost:3300).",
  },
  {
    key: "runnerUrl",
    label: "Runner URL",
    kind: IntegrationFieldKind.Url,
    placeholder: "http://host.docker.internal:3300",
    description:
      "How runners reach Local Git to clone and push, when that differs: http://host.docker.internal:3300 for a runner container on this machine, or this machine's network address for runners elsewhere. Empty: the server URL.",
  },
  {
    key: "token",
    label: "Access token",
    kind: IntegrationFieldKind.Secret,
    required: true,
    description: `Access token of the Local Git account agents push as, with the scopes ${LOCAL_GIT_TOKEN_SCOPES}. \`pnpm local-git:init --no-env\` creates the account and prints one (without --no-env it writes it to the API's environment, and the API provides this connection to every organization).`,
  },
  {
    key: "owner",
    label: "Owner",
    kind: IntegrationFieldKind.Text,
    placeholder: "my-team",
    description:
      "User or organization whose repositories projects can add, and where new repositories are created. Empty: every repository the token can access; new ones go to the token's account.",
  },
];

/** Changing where the API or runners send the token requires entering it again. */
export const LOCAL_GIT_CREDENTIAL_ORIGIN_FIELDS: Array<
  keyof LocalGitConnectionConfig
> = ["serverUrl", "runnerUrl"];

export async function validateLocalGitConnection(
  ctx: LocalGitContext
): Promise<ValidateConnectionResult<LocalGitConnectionConfig>> {
  const serverUrl = normalizeBaseUrl(ctx.connection.config.serverUrl);
  if (!serverUrl) {
    return { ok: false, error: SERVER_URL_HINT };
  }
  const rawRunnerUrl = ctx.connection.config.runnerUrl.trim();
  const runnerUrl = rawRunnerUrl ? normalizeBaseUrl(rawRunnerUrl) : "";
  if (runnerUrl === null) {
    return { ok: false, error: RUNNER_URL_HINT };
  }
  const owner = ctx.connection.config.owner.trim();
  const config: LocalGitConnectionConfig = { serverUrl, runnerUrl, owner };
  const checked: LocalGitContext = {
    ...ctx,
    connection: { ...ctx.connection, config },
  };
  const user = await localGitRequest(
    checked,
    { method: HttpMethod.Get, path: "/user" },
    localGitUserSchema
  );
  if (!user.ok) {
    return { ok: false, error: user.error.message };
  }
  if (owner) {
    const found = await localGitRequest(
      checked,
      { method: HttpMethod.Get, path: `/users/${pathSegment(owner)}` },
      localGitUserSchema
    );
    if (!found.ok) {
      return {
        ok: false,
        error:
          found.error.kind === LocalGitErrorKind.NotFound
            ? `No user or organization "${owner}" on Local Git`
            : found.error.message,
      };
    }
  }
  const { login } = user.value;
  return {
    ok: true,
    config,
    account: {
      externalAccountId: String(user.value.id),
      displayName: user.value.full_name?.trim() || login,
      aliases: [login],
      details: { serverUrl, owner: owner || null },
    },
  };
}
