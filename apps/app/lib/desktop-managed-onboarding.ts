export type DesktopOnboardingCommandInput = {
  onboardingAttemptId: string;
  webAppOrigin: string;
  desktopDownloadUrl: string;
  installerScriptUrl: string;
  sandboxBaseDirectory?: string;
};

/**
 * Builds the copyable terminal command for the web-app-first Desktop onboarding flow.
 */
export function buildDesktopOnboardingCommand(
  input: DesktopOnboardingCommandInput
): string {
  const assignments = [
    ["AF_ONBOARDING_ATTEMPT_ID", input.onboardingAttemptId],
    ["AF_WEB_APP_ORIGIN", input.webAppOrigin],
    ["AF_DESKTOP_DOWNLOAD_URL", input.desktopDownloadUrl],
  ];
  if (input.sandboxBaseDirectory?.trim()) {
    assignments.push([
      "AF_SANDBOX_BASE_DIRECTORY",
      input.sandboxBaseDirectory.trim(),
    ]);
  }

  const installerScript = [
    "set -e",
    'install_script="$(mktemp)"',
    "trap 'rm -f \"$install_script\"' EXIT",
    `curl -fsSL ${shellQuote(input.installerScriptUrl)} -o "$install_script"`,
    '/bin/bash "$install_script"',
  ].join(" && ");

  return `${assignments
    .map(([key, value]) => `${key}=${shellQuote(value)}`)
    .join(" ")} /bin/bash -c ${shellQuote(installerScript)}`;
}

function shellQuote(value: string): string {
  return `'${value.replaceAll("'", "'\\''")}'`;
}
