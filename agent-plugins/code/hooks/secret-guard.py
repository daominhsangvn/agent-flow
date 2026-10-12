#!/usr/bin/env python3
"""AgentFlow secret guard - PreToolUse hook (Bash|PowerShell|Monitor|Read|Grep).

Keeps secrets out of an agent session's transcript, for every session that
loads this plugin (the runner and the desktop app pass it to each loop with
--plugin-dir). A repository can hold real keys; the agent's process also
inherits the runner's environment (its API key, the model token). Denied by
default:

  secret-files      reading a file whose name marks it as secret (also via a
                    content search over a directory that holds one: the Grep
                    tool in content mode, grep -r, rg): .env and
                    .env.* (not .env.example/.sample/.template), .envrc, key
                    and certificate files, ssh keys, credential files
                    (.npmrc, .pypirc, .netrc, .git-credentials, docker
                    config, kubeconfig, service-account/credentials JSON,
                    secrets.yml, *.tfvars, terraform.tfstate), the runner's
                    own data (~/.agentflow-runner, /etc/agentflow-runner,
                    /var/lib/agentflow-runner/data) and host credential
                    directories (~/.ssh, ~/.aws, ~/.azure, ~/.kube,
                    ~/.config/gh, ~/.config/gcloud, ~/.claude/.credentials.json)
  secret-content    reading a file whose content holds a credential: a private
                    key block, a provider token (AWS, GitHub, GitLab, Slack,
                    Stripe, Google, Anthropic, OpenAI-style sk-, npm, PyPI,
                    SendGrid, Azure storage key) or, in a config file, a
                    password/secret/token/api key assigned a real-looking value
  environment-dump  printing the environment or a credential: env, printenv,
                    set, export -p, /proc/*/environ, Get-ChildItem Env:,
                    process.env / os.environ dumps, echo $..._KEY/_TOKEN,
                    docker inspect (Config.Env), docker exec ... env,
                    docker compose config, git credential fill, gh auth token

Still allowed: .env.example files, the loop's own .agentflow-ai/config.env
(settings only; its content is still scanned), checking that a file exists (ls, test -f,
Test-Path, stat), writing env files (cp .env.example .env, echo X=1 >> .env,
touch), `docker run --env-file`, and scripts or tests that use secrets without
printing them. A guard, not a sandbox: a program the agent runs can still open
these files itself.

A runner can allow a category in ~/.claude/security-overrides.json (or
$CLAUDE_SECURITY_OVERRIDES), the file pretooluse-hook.sh reads:
    {"overrides": {"secret-content": true}}

Denies with permissionDecision "deny" (the reason goes back to the agent);
fails closed when the event cannot be checked.
"""

from __future__ import annotations

import fnmatch
import json
import os
import re
import shlex
import sys
from pathlib import Path
from typing import NoReturn

SECRET_FILES = "secret-files"
SECRET_CONTENT = "secret-content"
ENVIRONMENT_DUMP = "environment-dump"

REASON = (
    "Blocked by the AgentFlow secret guard: {what}. Secrets must not reach the "
    "session transcript. Do not try another way to read it (another command, a "
    "copy, a script that prints it). Check that a file exists with ls or test -f; "
    "take variable names from .env.example. If the task needs the value, say so "
    "in your result or in your questions."
)

SCAN_LIMIT_BYTES = 2 * 1024 * 1024
SCAN_MAX_FILES = 20
# Directory walk of a recursive search: bounded, skipping what searches skip.
WALK_SKIP_DIRS = {
    ".git", "node_modules", ".venv", "venv", "__pycache__", "dist", "build",
    "target", ".next", ".turbo",
}
WALK_MAX_DEPTH = 8
WALK_MAX_ENTRIES = 20_000

# ---------------------------------------------------------------- file names

# `.env`, `.env.local`, `.env.*`: not preceded by a word character, so
# `process.env` and `import.meta.env` are code, not files.
ENV_FILE = re.compile(r"(?<![\w.$-])\.env(?P<rest>(?:\.[\w*-]+)*)(?![\w-])")
SAFE_SUFFIX = re.compile(r"\.(example|sample|template|dist|defaults|schema)\b")
# `<stem>.env`, e.g. runner.env, prod.env.
STEM_ENV = re.compile(r"(?<![\w.$-])(?P<stem>[\w-]+)\.env(?![\w.])")
CODE_STEMS = {"process", "meta"}

SECRET_NAMES = [
    (re.compile(r"(?<![\w.-])\.envrc\b"), ".envrc"),
    (re.compile(r"(?<![\w-])\.ssh(?![\w-])"), "~/.ssh"),
    (re.compile(r"(?<![\w-])\.aws(?![\w-])"), "~/.aws"),
    (re.compile(r"(?<![\w-])\.azure(?![\w-])"), "~/.azure"),
    (re.compile(r"(?<![\w-])\.kube(?![\w-])"), "~/.kube"),
    (re.compile(r"(?<![\w-])kubeconfig\b"), "a kubeconfig"),
    (re.compile(r"\.config/(gh|gcloud)(?![\w-])"), "gh/gcloud credentials"),
    (re.compile(r"\.docker/config\.json"), "docker credentials"),
    (re.compile(r"\.claude/\.credentials\.json"), "Claude credentials"),
    (re.compile(r"\.git-credentials"), ".git-credentials"),
    (re.compile(r"(?<![\w-])[._]netrc\b"), ".netrc"),
    (re.compile(r"(?<![\w-])\.(npmrc|pypirc|dockercfg|htpasswd)\b"), "a credential file"),
    (re.compile(r"(?<![\w-])\.agentflow-runner(?![\w-])"), "the runner's data"),
    (re.compile(r"/etc/agentflow-runner\b"), "the runner's configuration"),
    (re.compile(r"/var/lib/agentflow-runner/data\b"), "the runner's data"),
    (re.compile(r"\bid_(rsa|dsa|ecdsa|ed25519)\b(?!\.pub)"), "an ssh key"),
    (re.compile(r"[\w-]\.(pem|p12|pfx|p8|ppk|jks|keystore|kdbx)(?![\w-])"), "a key or keystore file"),
    (re.compile(r"(?<![\w-])(service[-_]account[\w.-]*|[\w-]*credentials)\.json\b"), "a credentials file"),
    (re.compile(r"(?<![\w-])secrets?\.(ya?ml|json|toml|ini|env)\b"), "a secrets file"),
    (re.compile(r"[\w-]\.tfvars(?![\w.-]|\.example)"), "Terraform variables"),
    (re.compile(r"terraform\.tfstate\b"), "Terraform state"),
]
# The loop harness's settings: `<workdir>/.agentflow-ai/config.env`.
LOOP_CONFIG = re.compile(r"\.agentflow-ai/config\.env\b")
BARE_CONFIG = re.compile(r"(?<![\w.-])config\.env\b")
# Only for Read/Grep paths: `.key` is too common in shell code (`r.key`).
KEY_FILE = re.compile(r"[\w-]\.key$")


def secret_name(text: str, loop_config: bool = False) -> str | None:
    # The loop's own settings file (written by run-loop.sh, read by the
    # orchestrator prompt for startSha and the repo map): no secrets in it,
    # and a file that ever held one is still caught by the content scan.
    # In a command that reads it, a bare `config.env` (a label, a variable)
    # names that same file.
    text = LOOP_CONFIG.sub(" ", text)
    if loop_config:
        text = BARE_CONFIG.sub(" ", text)
    for m in ENV_FILE.finditer(text):
        if not SAFE_SUFFIX.search(m.group("rest") or ""):
            return f"env file {m.group(0)!r}"
    for m in STEM_ENV.finditer(text):
        if m.group("stem") not in CODE_STEMS:
            return f"env file {m.group(0)!r}"
    for pattern, what in SECRET_NAMES:
        if pattern.search(text):
            return what
    return None


# -------------------------------------------------------------- file content

CREDENTIALS = [
    (re.compile(rb"-----BEGIN ((RSA|EC|DSA|OPENSSH|ENCRYPTED|PGP) )?PRIVATE KEY( BLOCK)?-----"), "a private key"),
    (re.compile(rb"\b(AKIA|ASIA)[0-9A-Z]{16}\b"), "an AWS access key"),
    (re.compile(rb"\b(ghp|gho|ghu|ghs|ghr)_[A-Za-z0-9]{36}\b"), "a GitHub token"),
    (re.compile(rb"\bgithub_pat_[A-Za-z0-9_]{60,}"), "a GitHub token"),
    (re.compile(rb"\bglpat-[A-Za-z0-9_-]{20,}"), "a GitLab token"),
    (re.compile(rb"\bxox[abprs]-[A-Za-z0-9-]{10,}"), "a Slack token"),
    (re.compile(rb"\b(sk|rk)_live_[A-Za-z0-9]{20,}"), "a Stripe key"),
    (re.compile(rb"\bAIza[0-9A-Za-z_-]{35}\b"), "a Google API key"),
    (re.compile(rb"\bsk-ant-[A-Za-z0-9_-]{40,}"), "an Anthropic key"),
    (re.compile(rb"\bsk-(proj-|svcacct-)?[A-Za-z0-9_-]{32,}"), "an API key (sk-)"),
    (re.compile(rb"\bnpm_[A-Za-z0-9]{36}\b"), "an npm token"),
    (re.compile(rb"\bpypi-AgEIcHlwaS5vcmc[A-Za-z0-9_-]{50,}"), "a PyPI token"),
    (re.compile(rb"\bSG\.[A-Za-z0-9_-]{22}\.[A-Za-z0-9_-]{43}\b"), "a SendGrid key"),
    (re.compile(rb"AccountKey=[A-Za-z0-9+/]{80,}={0,2}"), "an Azure storage key"),
]
# In config files only: `password: <real-looking value>`.
CONFIG_SUFFIXES = {
    ".yml", ".yaml", ".json", ".ini", ".toml", ".properties", ".xml", ".conf",
    ".cfg", ".config", ".tfvars", ".settings",
}
SECRET_ASSIGNMENT = re.compile(
    rb"(?i)[\"']?[\w.-]*(password|passwd|secret|api[_-]?key|access[_-]?key|private[_-]?key"
    rb"|auth[_-]?token|access[_-]?token|client[_-]?secret|connection[_-]?string)[\w.-]*[\"']?"
    rb"\s*[:=]\s*[\"']?(?P<value>[^\s\"',;<>{}]{12,})"
)
PLACEHOLDER = re.compile(
    rb"(?i)^(x{4,}|\*{4,}|\$|%|your|<|changeme|change[_-]?me|placeholder|example|dummy|sample"
    rb"|test|fake|redacted|none|null|todo|secret|password)"
)


def credential_in(data: bytes, suffix: str) -> str | None:
    for pattern, what in CREDENTIALS:
        if pattern.search(data):
            return what
    if suffix in CONFIG_SUFFIXES:
        for m in SECRET_ASSIGNMENT.finditer(data):
            value = m.group("value")
            if not PLACEHOLDER.search(value) and re.search(rb"\d", value) and re.search(rb"[A-Za-z]", value):
                return "a secret assigned in a config file"
    return None


def scan_file(path: Path) -> str | None:
    try:
        if not path.is_file():
            return None
        with path.open("rb") as handle:
            data = handle.read(SCAN_LIMIT_BYTES)
    except OSError:
        return None
    if b"\x00" in data[:8192]:
        return None  # binary
    found = credential_in(data, path.suffix.lower())
    return f"{path.name} holds {found}" if found else None


# ---------------------------------------------------------- shell commands

SECRETISH = r"\w*(key|secret|token|passw(or)?d|credential|apikey|auth)\w*"
SEP = r"(^|[;&|(]\s*|\bthen\s+|\bdo\s+)"
END = r"\s*($|[|;&)])"

DUMPS = [
    re.compile(SEP + r"env" + END),
    re.compile(SEP + r"printenv\b"),
    re.compile(SEP + r"(set|export|declare\s+-x|export\s+-p|compgen\s+-[ve])" + END),
    re.compile(r"/proc/\S*environ"),
    re.compile(r"\b(get-childitem|gci|ls|dir|get-item|gi)\s+env:"),
    re.compile(r"\[(system\.)?environment\]::getenvironmentvariables"),
    re.compile(r"(console\.(log|dir|error|info)|json\.stringify|util\.inspect)\s*\(\s*process\.env\s*[),]"),
    re.compile(r"\bprint\s*\([^)]*\bos\.environ\b(?!\s*(\[|\.get))"),
    re.compile(r"\b(echo|printf|print|write-output|write-host|out-host)\b[^;&|]*\$\{?(env:)?" + SECRETISH),
    re.compile(r"^\s*\$env:" + SECRETISH + r"\s*$"),
    re.compile(r"\bgit\s+credential(-manager)?\s+(fill|get)\b"),
    re.compile(r"\bgh\s+auth\s+token\b"),
    re.compile(r"--show-token\b"),
    re.compile(r"\bdocker\s+(compose\s+)?exec\b[^;&|]*[\s'\"](env|printenv)\b"),
    re.compile(r"\bdocker\s+run\b[^;&|]*--env-file\b[^;&|]*\s(env|printenv)" + END),
    re.compile(r"\bdocker[\s-]compose\b[^;&|]*\sconfig\b(?![^;&|]*--(services|volumes|profiles|images|hash))"),
]
DOCKER_INSPECT = re.compile(r"\bdocker\s+((container|image|compose)\s+)?inspect\b")
INSPECT_FORMAT = re.compile(r"(?:\s-f|--format)(?:\s+|=)('[^']*'|\"[^\"]*\"|\S+)")

# Shows that a file exists, never its content.
CD_PREFIX = r"^\s*(cd\s+[^;&|`$<>()]+&&\s*)?"
NAMES_ONLY = re.compile(
    CD_PREFIX
    + r"(ls|ll|dir|stat|file|wc\s+-l|test\s+-[efs]|\[\s+-[efs]|test-path)\b[^;&|`$<>()]*"
    + r"(\|\s*(head|tail)(\s+-n)?(\s+-?\d+)?\s*)?$"
)
# Writes into a file without reading it: redirect targets, the destination of
# cp/mv/install, the files of touch/rm/chmod/chown, --env-file arguments.
WRITE_TARGETS = [
    re.compile(r">>?\s*\S+"),
    re.compile(r"\b(cp|mv|install)\b(\s+-\S+)*\s+\S+\s+(?P<dst>\S+)"),
    re.compile(r"\b(touch|rm|chmod|chown|mkdir)\b[^;&|]*"),
    re.compile(r"--env-file(\s+|=)\S+"),
]
READ_COMMANDS = {
    "cat", "head", "tail", "less", "more", "bat", "batcat", "nl", "tac", "strings",
    "xxd", "od", "hexdump", "base64", "sed", "awk", "grep", "egrep", "fgrep", "rg",
    "ag", "jq", "yq", "sort", "uniq", "cut", "diff", "cmp", "type", "get-content",
    "gc", "select-string", "sls",
}
SEGMENTS = re.compile(r"&&|\|\||[;|&\n]")
COMMAND_LIST = re.compile(r"&&|\|\||[;\n]")


def docker_inspect(text: str) -> str | None:
    if not DOCKER_INSPECT.search(text):
        return None
    fmt = INSPECT_FORMAT.search(text)
    if not fmt:
        return "docker inspect without --format prints the container environment"
    value = fmt.group(1)
    if "env" in value or re.search(r"json\s+\.\s*(config)?\s*}}", value):
        return "docker inspect of the container environment"
    return None


def without_writes(text: str) -> str:
    for pattern in WRITE_TARGETS:
        if "dst" in pattern.groupindex:
            text = pattern.sub(lambda m: m.group(0)[: m.start("dst") - m.start()], text)
        else:
            text = pattern.sub(" ", text)
    return text


def read_targets(command: str, cwd: str) -> list[Path]:
    """Existing files named by commands that print their content."""
    found: list[Path] = []
    for segment in SEGMENTS.split(command):
        try:
            words = shlex.split(segment, posix=True)
        except ValueError:
            words = segment.split()
        if not words or Path(words[0]).name.lower() not in READ_COMMANDS:
            continue
        for word in words[1:]:
            if word.startswith("-") or len(found) >= SCAN_MAX_FILES:
                continue
            path = Path(os.path.expanduser(word))
            if not path.is_absolute() and cwd:
                path = Path(cwd) / path
            if path.is_file():
                found.append(path)
    return found


def check_command(command: str, cwd: str) -> tuple[str, str] | None:
    text = command.replace("\\", "/").lower()
    for pattern in DUMPS:
        m = pattern.search(text)
        if m:
            return ENVIRONMENT_DUMP, f"this prints the environment or a credential ({m.group(0).strip()!r})"
    inspect = docker_inspect(text)
    if inspect:
        return ENVIRONMENT_DUMP, inspect
    # Each `&&` / `||` / `;` part on its own; a pipeline stays one part, so
    # `ls .env | xargs cat` is not an existence check.
    loop_config = bool(LOOP_CONFIG.search(text))
    for part in COMMAND_LIST.split(text):
        if part.strip() and not NAMES_ONLY.search(part):
            name = secret_name(without_writes(part), loop_config)
            if name:
                return SECRET_FILES, f"the command reads {name}"
    for path in read_targets(command, cwd):
        content = scan_file(path)
        if content:
            return SECRET_CONTENT, content
    for segment in SEGMENTS.split(command):
        found = recursive_search(segment, cwd)
        if found:
            return SECRET_FILES, found
    return None


# ------------------------------------------------------- recursive searches

# A content search over a directory prints the matching lines of every file it
# reaches, `.env` included, whatever the paths named in the call. It is denied
# when the directory holds a secret file the search's filters do not keep out.
BRACES = re.compile(r"\{([^{}]*)\}")
# grep -r / -R / -rn ... (short option clusters), --recursive.
GREP_RECURSIVE = re.compile(r"^(-[a-zA-Z]*[rR][a-zA-Z]*|--recursive|--dereference-recursive)$")
# Print file names or counts, never a line of content.
NAMES_OR_COUNTS = {
    "-l", "-L", "-c", "-q", "--files-with-matches", "--files-without-match",
    "--count", "--quiet", "--files",
}
# A short option cluster holding one of them: grep -rl, -rc, -Rq.
SHORT_NAMES_OR_COUNTS = re.compile(r"^-[a-zA-Z]*[lLcq][a-zA-Z]*$")
# grep/rg options whose value is the next word.
VALUE_OPTIONS = {
    "-e", "-f", "-m", "-A", "-B", "-C", "-g", "-t", "-T", "-M", "-d",
    "--glob", "--iglob", "--type", "--type-not", "--include", "--exclude",
    "--exclude-dir", "--max-count", "--regexp", "--file", "--context",
    "--after-context", "--before-context", "--directories", "--max-columns",
}
SEARCH_COMMANDS = {"grep", "egrep", "fgrep", "rg", "ag"}


def expand_braces(glob: str) -> list[str]:
    m = BRACES.search(glob)
    if not m:
        return [glob]
    out: list[str] = []
    for option in m.group(1).split(","):
        out.extend(expand_braces(glob[: m.start()] + option + glob[m.end() :]))
    return out


def glob_matches(globs: list[str], rel: str) -> bool:
    name = rel.rsplit("/", 1)[-1]
    for glob in globs:
        for pattern in expand_braces(glob):
            bare = pattern[3:] if pattern.startswith("**/") else pattern
            if (
                fnmatch.fnmatchcase(name, bare)
                or fnmatch.fnmatchcase(rel, pattern)
                or fnmatch.fnmatchcase(rel, bare)
            ):
                return True
    return False


def secret_in_tree(root: Path, includes: list[str], excludes: list[str]) -> str | None:
    """The first secret-named file a recursive search of `root` would read."""
    seen = 0
    stack = [(root, 0)]
    while stack:
        directory, depth = stack.pop()
        try:
            entries = list(os.scandir(directory))
        except OSError:
            continue
        for entry in entries:
            seen += 1
            if seen > WALK_MAX_ENTRIES:
                return None
            rel = Path(entry.path).relative_to(root).as_posix()
            if excludes and glob_matches(excludes, rel):
                continue
            if entry.is_dir(follow_symlinks=False):
                if entry.name not in WALK_SKIP_DIRS and depth < WALK_MAX_DEPTH:
                    stack.append((Path(entry.path), depth + 1))
                continue
            if includes and not glob_matches(includes, rel):
                continue
            text = "/" + rel.lower()
            name = secret_name(text) or ("a key file" if KEY_FILE.search(text) else None)
            if name:
                return f"{name} ({rel})"
    return None


def search_root(value: str | None, cwd: str) -> Path | None:
    path = Path(os.path.expanduser(value)) if value else Path(cwd or ".")
    if not path.is_absolute() and cwd:
        path = Path(cwd) / path
    return path if path.is_dir() else None


def check_grep_tool(tool_input: dict, cwd: str) -> tuple[str, str] | None:
    if tool_input.get("output_mode") != "content":
        return None  # file names or counts only
    if tool_input.get("type"):
        return None  # a language type never covers env or key files
    target = tool_input.get("path") if isinstance(tool_input.get("path"), str) else None
    root = search_root(target, cwd)
    if root is None:
        return None  # a single file: check_path covers it
    glob = tool_input.get("glob") if isinstance(tool_input.get("glob"), str) else ""
    includes = [glob] if glob and not glob.startswith("!") else []
    excludes = [glob[1:]] if glob.startswith("!") else []
    found = secret_in_tree(root, includes, excludes)
    if found:
        return SECRET_FILES, (
            f"a content search over {target or 'the working directory'} would print "
            f"{found}; search source files only, with a type (e.g. \"js\") or a glob (e.g. \"*.{{js,ts}}\")"
        )
    return None


def search_options(words: list[str]) -> tuple[bool, bool, list[str], list[str], list[str]]:
    """(recursive, typed, includes, excludes, paths) of a grep/rg command."""
    rg = Path(words[0]).name.lower() in ("rg", "ag")
    recursive, typed = rg, False
    includes: list[str] = []
    excludes: list[str] = []
    positional: list[str] = []
    pattern_given = False
    i = 1
    while i < len(words):
        word = words[i]
        i += 1
        if word == "--":
            positional.extend(words[i:])
            break
        if not word.startswith("-") or word == "-":
            positional.append(word)
            continue
        option, has_inline, inline = word.partition("=")
        value: str | None = inline if has_inline else None
        if value is None and option in VALUE_OPTIONS and i < len(words):
            value = words[i]
            i += 1
        if option in NAMES_OR_COUNTS or SHORT_NAMES_OR_COUNTS.match(word):
            return False, False, [], [], []
        if GREP_RECURSIVE.match(word) or (option in ("-d", "--directories") and value == "recurse"):
            recursive = True
        if option in ("-e", "-f", "--regexp", "--file"):
            pattern_given = True
        elif option == "--include" and value:
            includes.append(value)
        elif option in ("--exclude", "--exclude-dir") and value:
            excludes.append(value)
        elif option in ("-g", "--glob", "--iglob") and value:
            (excludes if value.startswith("!") else includes).append(value.lstrip("!"))
        elif option in ("-t", "--type") or (rg and word.startswith("-t") and len(word) > 2):
            typed = True
    paths = positional if pattern_given else positional[1:]
    return recursive, typed, includes, excludes, paths


def recursive_search(segment: str, cwd: str) -> str | None:
    try:
        words = shlex.split(segment, posix=True)
    except ValueError:
        return None
    if not words or Path(words[0]).name.lower() not in SEARCH_COMMANDS:
        return None
    recursive, typed, includes, excludes, paths = search_options(words)
    if not recursive or typed:
        return None  # a language type never covers env or key files
    for target in paths or [""]:
        root = search_root(target, cwd)
        if root is None:
            continue
        found = secret_in_tree(root, includes, excludes)
        if found:
            return (
                f"a recursive search over {target or 'the working directory'} would print "
                f"{found}; search source files only, e.g. --include='*.js' (grep) or -t js / -g '*.js' (rg)"
            )
    return None


# ------------------------------------------------------------ Read and Grep


def check_path(value: str, cwd: str) -> tuple[str, str] | None:
    text = value.replace("\\", "/").lower()
    name = secret_name(text)
    if name:
        return SECRET_FILES, name
    if KEY_FILE.search(text):
        return SECRET_FILES, "a key file"
    path = Path(os.path.expanduser(value))
    if not path.is_absolute() and cwd:
        path = Path(cwd) / path
    content = scan_file(path)
    if content:
        return SECRET_CONTENT, content
    return None


# ------------------------------------------------------------------- event


def overridden(category: str) -> bool:
    location = os.environ.get("CLAUDE_SECURITY_OVERRIDES") or str(
        Path.home() / ".claude" / "security-overrides.json"
    )
    try:
        data = json.loads(Path(location).read_text(encoding="utf-8"))
    except (OSError, ValueError):
        return False
    overrides = data.get("overrides") if isinstance(data, dict) else None
    return isinstance(overrides, dict) and overrides.get(category) is True


def deny(what: str) -> NoReturn:
    sys.stdout.write(
        json.dumps(
            {
                "hookSpecificOutput": {
                    "hookEventName": "PreToolUse",
                    "permissionDecision": "deny",
                    "permissionDecisionReason": REASON.format(what=what),
                }
            }
        )
        + "\n"
    )
    sys.exit(0)


def check(event: dict) -> tuple[str, str] | None:
    tool = event.get("tool_name") or ""
    tool_input = event.get("tool_input") or {}
    cwd = event.get("cwd") if isinstance(event.get("cwd"), str) else ""
    if not isinstance(tool_input, dict):
        return None
    if tool in ("Bash", "PowerShell", "Monitor"):
        command = tool_input.get("command")
        return check_command(command, cwd) if isinstance(command, str) and command else None
    if tool not in ("Read", "Grep"):
        return None
    for key in ("file_path", "path", "glob"):
        value = tool_input.get(key)
        if isinstance(value, str) and value:
            found = check_path(value, cwd)
            if found:
                return found
    return check_grep_tool(tool_input, cwd) if tool == "Grep" else None


def main() -> None:
    try:
        raw = sys.stdin.buffer.read().decode("utf-8", errors="replace")
        event = json.loads(raw) if raw.strip() else {}
        found = check(event if isinstance(event, dict) else {})
    except Exception as error:  # fail closed: a broken guard must not wave reads through
        deny(f"the secret guard could not check this call ({type(error).__name__})")
    if found and not overridden(found[0]):
        deny(found[1])
    sys.exit(0)


if __name__ == "__main__":
    main()
