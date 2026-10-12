import os from "node:os";
import path from "node:path";

/**
 * Which credential Claude Code would use on this computer, checked in Claude
 * Code's own precedence order: ANTHROPIC_AUTH_TOKEN (custom endpoints such as
 * DeepSeek), ANTHROPIC_API_KEY, CLAUDE_CODE_OAUTH_TOKEN (`claude
 * setup-token`), then the `/login` credentials file. On macOS `/login`
 * stores the credential in the keychain instead of the file; callers that can
 * run `security` check that separately.
 */

export const ClaudeCredentialSource = {
  AuthToken: "ANTHROPIC_AUTH_TOKEN",
  ApiKey: "ANTHROPIC_API_KEY",
  OAuthToken: "CLAUDE_CODE_OAUTH_TOKEN",
  CredentialsFile: "credentials file",
  Keychain: "macOS keychain",
  None: "none",
} as const;
export type ClaudeCredentialSource =
  (typeof ClaudeCredentialSource)[keyof typeof ClaudeCredentialSource];

export type ClaudeCredentialProbe = {
  env: Record<string, string | undefined>;
  fileExists: (filePath: string) => boolean;
  homeDir?: string;
};

export function detectClaudeCredentialSource(
  probe: ClaudeCredentialProbe
): ClaudeCredentialSource {
  const { env } = probe;
  if (env.ANTHROPIC_AUTH_TOKEN) {
    return ClaudeCredentialSource.AuthToken;
  }
  if (env.ANTHROPIC_API_KEY) {
    return ClaudeCredentialSource.ApiKey;
  }
  if (env.CLAUDE_CODE_OAUTH_TOKEN) {
    return ClaudeCredentialSource.OAuthToken;
  }
  const configDir =
    env.CLAUDE_CONFIG_DIR ??
    path.join(probe.homeDir ?? os.homedir(), ".claude");
  return probe.fileExists(path.join(configDir, ".credentials.json"))
    ? ClaudeCredentialSource.CredentialsFile
    : ClaudeCredentialSource.None;
}
