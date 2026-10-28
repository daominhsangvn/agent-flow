import {
  parseRunnerCapabilitiesMarkdown,
  RUNNER_CAPABILITIES_MAX_WARNINGS,
} from "@repo/api/src/types/runner-capabilities";

/**
 * What only the runner can check: each declared command or skill exists in
 * a `.claude` tree. `hasFile` answers for a POSIX path relative to the tree's
 * root, and `where` names the tree in the message. A plugin's command cannot
 * be checked this way, so the warning says so instead of calling it missing.
 */
export function collectCapabilityWarningsIn(
  content: string,
  hasFile: (relativePosixPath: string) => boolean,
  where: string
): string[] {
  const parsed = parseRunnerCapabilitiesMarkdown(content);
  if (!parsed.ok) {
    return parsed.problems.slice(0, RUNNER_CAPABILITIES_MAX_WARNINGS);
  }
  const warnings: string[] = [];
  for (const command of parsed.value.commands) {
    const name = command.name.slice(1);
    const commandFile = `.claude/commands/${name.split(":").join("/")}.md`;
    if (!(hasFile(commandFile) || hasFile(skillFile(name)))) {
      warnings.push(
        `${command.name} is not in .claude/commands or .claude/skills of ${where} (fine if a plugin provides it)`
      );
    }
  }
  for (const skill of parsed.value.skills) {
    if (!hasFile(skillFile(skill.name))) {
      warnings.push(
        `skill ${skill.name} is not in .claude/skills of ${where} (fine if a plugin provides it)`
      );
    }
  }
  return warnings.slice(0, RUNNER_CAPABILITIES_MAX_WARNINGS);
}

function skillFile(name: string): string {
  return `.claude/skills/${name}/SKILL.md`;
}
