import path from "node:path";

/**
 * Git access to project repositories (repositories added to a project from an
 * integration connection such as GitHub or Azure DevOps).
 *
 * The computer holds no repository token. Every git command of the loop runs
 * with a credential helper, set through `GIT_CONFIG_*` environment variables,
 * that asks the API for a credential with the loop's token
 * (`POST {api}/loops/{loopId}/git-credential`) and prints what it returns.
 * Nothing is written to disk or to the repository's git config, and the API
 * stops answering once the loop has finished.
 *
 * The loop's own processes (the agent, the commit step) get the variables in
 * their environment. Git commands the gateway runs while preparing a loop
 * (clone, fetch, worktree creation) find them through `loopGitEnvForPath`,
 * which knows the repositories a running loop was granted.
 */

export const LOOP_GIT_CREDENTIAL_URL_ENV = "AGENTFLOW_GIT_CREDENTIAL_URL";
export const LOOP_GIT_CREDENTIAL_TOKEN_ENV = "AGENTFLOW_GIT_CREDENTIAL_TOKEN";
const TRAILING_SLASHES_RE = /\/+$/;

/**
 * Answers `get` only (git also calls helpers with `store` and `erase`). The
 * request body is git's own credential description (protocol, host, path);
 * `curl -f` prints nothing on an error, so git reports the failure itself.
 */
const CREDENTIAL_HELPER = [
  "!f() {",
  'test "$1" = get || exit 0;',
  "curl -fsS --max-time 30 -X POST",
  `-H "Authorization: Bearer $${LOOP_GIT_CREDENTIAL_TOKEN_ENV}"`,
  '-H "Content-Type: text/plain"',
  `--data-binary @- "$${LOOP_GIT_CREDENTIAL_URL_ENV}";`,
  "}; f",
].join(" ");

export type LoopGitAccessInput = {
  apiBaseUrl: string;
  loopId: string;
  token: string;
};

/** Environment that lets git authenticate to the loop's project repositories. */
export function buildLoopGitEnv(
  input: LoopGitAccessInput
): Record<string, string> {
  const apiBaseUrl = input.apiBaseUrl.replace(TRAILING_SLASHES_RE, "");
  return buildGitCredentialEnv({
    credentialUrl: `${apiBaseUrl}/loops/${encodeURIComponent(input.loopId)}/git-credential`,
    token: input.token,
  });
}

/**
 * Environment that lets git authenticate through any credential endpoint of
 * the API: the helper posts git's credential description to `credentialUrl`
 * with `token` as the bearer.
 */
export function buildGitCredentialEnv(input: {
  credentialUrl: string;
  token: string;
}): Record<string, string> {
  return {
    [LOOP_GIT_CREDENTIAL_URL_ENV]: input.credentialUrl,
    [LOOP_GIT_CREDENTIAL_TOKEN_ENV]: input.token,
    // Never wait for a password on a terminal nobody is watching.
    GIT_TERMINAL_PROMPT: "0",
    // Only network transports: no ext::, fd:: or file:: through a URL.
    GIT_ALLOW_PROTOCOL: "https:http",
    GIT_CONFIG_COUNT: "3",
    // An empty helper clears the ones configured on the machine (a keychain
    // or credential manager), so only the API's credential is used.
    GIT_CONFIG_KEY_0: "credential.helper",
    GIT_CONFIG_VALUE_0: "",
    GIT_CONFIG_KEY_1: "credential.helper",
    GIT_CONFIG_VALUE_1: CREDENTIAL_HELPER,
    // Send the repository path so the API can tell repositories on one host apart.
    GIT_CONFIG_KEY_2: "credential.useHttpPath",
    GIT_CONFIG_VALUE_2: "true",
  };
}

type LoopGitGrant = { env: Record<string, string>; roots: Set<string> };

const grants = new Map<string, LoopGitGrant>();

/**
 * Lets git commands run in `roots` (repository and worktree directories) use
 * the loop's credentials until `revokeLoopGitAccess`. Calling it again for the
 * same loop adds roots and refreshes the environment.
 */
export function grantLoopGitAccess(
  loopId: string,
  env: Record<string, string>,
  roots: readonly string[]
): void {
  const grant = grants.get(loopId) ?? { env, roots: new Set<string>() };
  grant.env = env;
  for (const root of roots) {
    grant.roots.add(path.resolve(root));
  }
  grants.set(loopId, grant);
}

export function revokeLoopGitAccess(loopId: string): void {
  grants.delete(loopId);
}

/**
 * Environment for a git command run in `cwd`: the process environment plus
 * the credentials of the loop whose root contains `cwd` most closely, the
 * most recently granted one among equals, or `undefined` (inherit the process
 * environment) when none does. Loops sharing a checkout (one repository in
 * two projects, or two issues of a project) are all allowed to use its
 * repository, so the credentials of any of them work there.
 */
export function loopGitEnvForPath(cwd: string): NodeJS.ProcessEnv | undefined {
  const target = path.resolve(cwd);
  let match: Record<string, string> | undefined;
  let matchLength = -1;
  for (const grant of grants.values()) {
    for (const root of grant.roots) {
      const contains = target === root || target.startsWith(root + path.sep);
      if (contains && root.length >= matchLength) {
        match = grant.env;
        matchLength = root.length;
      }
    }
  }
  return match ? { ...process.env, ...match } : undefined;
}
