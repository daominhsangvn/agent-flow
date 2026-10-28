import {
  type RunnerCapabilitiesParseResult,
  RunnerCommandMode,
} from "@repo/api/src/types/runner-capabilities";
import { redactSecrets } from "@repo/lib/security/redact-secrets";

/**
 * Warnings the API adds when a runner's `AGENTFLOW.md` is uploaded (F10):
 * lines that look like secrets and read commands that declare `push`. They
 * never block the upload and never include a secret value.
 */
export function serverCapabilityWarnings(
  content: string,
  parsed: RunnerCapabilitiesParseResult
): string[] {
  return [...secretLineWarnings(content), ...readPushWarnings(parsed)];
}

const SECRET_WARNINGS_MAX = 10;
const REDACTED_LABEL_RE = /\[REDACTED:([^\]]+)\]/;
const PRIVATE_KEY_RE = /-----BEGIN [A-Z ]*PRIVATE KEY-----/;
const GENERIC_SECRET_RE =
  /\b[\w-]*(?:password|passwd|secret|token|api[_-]?key|private[_-]?key|access[_-]?key)[\w-]*["']?\s*[:=]\s*["']?([A-Za-z0-9._~+/=-]{12,})/i;
const ENV_REFERENCE_RE = /^(?:process\.env\.|import\.meta\.env\.)/;
const PLAIN_WORD_RE = /^[A-Za-z_-]+$/;
const MIXED_CASE_RE = /^(?=.*[a-z])(?=.*[A-Z])/;
const LINE_SPLIT_RE = /\r?\n/;

function secretLineWarnings(content: string): string[] {
  const warnings: string[] = [];
  const lines = content.split(LINE_SPLIT_RE);
  for (let index = 0; index < lines.length; index++) {
    const kind = secretKind(lines[index] ?? "");
    if (kind) {
      warnings.push(
        `AGENTFLOW.md line ${index + 1} looks like it holds a secret (${kind}): remove it and rotate it; runners and the orchestrator read this file.`
      );
      if (warnings.length >= SECRET_WARNINGS_MAX) {
        break;
      }
    }
  }
  return warnings;
}

function secretKind(line: string): string | null {
  const redacted = redactSecrets(line);
  if (redacted !== line) {
    return REDACTED_LABEL_RE.exec(redacted)?.[1] ?? "credential";
  }
  if (PRIVATE_KEY_RE.test(line)) {
    return "private key";
  }
  if (looksLikeSecretValue(GENERIC_SECRET_RE.exec(line)?.[1])) {
    return "credential";
  }
  return null;
}

/** Env references and plain words (enabled_for_all_repos) are not secrets. */
function looksLikeSecretValue(value: string | undefined): boolean {
  if (!value || ENV_REFERENCE_RE.test(value)) {
    return false;
  }
  return !PLAIN_WORD_RE.test(value) || MIXED_CASE_RE.test(value);
}

function readPushWarnings(parsed: RunnerCapabilitiesParseResult): string[] {
  if (!parsed.ok) {
    return [];
  }
  return parsed.value.commands
    .filter(
      (command) =>
        command.mode === RunnerCommandMode.Read && command.push === true
    )
    .map(
      (command) =>
        `${command.name}: push is ignored for a read command (mode: read changes nothing).`
    );
}
