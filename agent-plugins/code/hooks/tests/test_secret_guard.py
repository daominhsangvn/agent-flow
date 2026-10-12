#!/usr/bin/env python3
"""Tests for secret-guard.py: each case pipes a PreToolUse event into the hook.

Usage:
    python3 agent-plugins/code/hooks/tests/test_secret_guard.py

Fake credentials are assembled at run time so this file holds no string a
secret scanner would flag.
"""

from __future__ import annotations

import json
import os
import subprocess
import sys
import tempfile
import unittest
from pathlib import Path

HOOK = Path(__file__).resolve().parent.parent / "secret-guard.py"

FAKE_AWS = "AKIA" + "Q" * 4 + "7" * 12
FAKE_GITHUB = "ghp" + "_" + "a1B2" * 9
FAKE_PRIVATE_KEY = "-----BEGIN " + "OPENSSH PRIVATE KEY-----\nabc\n"
FAKE_SK = "sk" + "-" + "9f8e7d6c" * 4


def run(event: dict, overrides: dict | None = None) -> str:
    """"deny" or "allow" for this event."""
    env = dict(os.environ)
    with tempfile.TemporaryDirectory() as home:
        location = Path(home) / "security-overrides.json"
        if overrides is not None:
            location.write_text(json.dumps({"overrides": overrides}), encoding="utf-8")
        env["CLAUDE_SECURITY_OVERRIDES"] = str(location)
        result = subprocess.run(
            [sys.executable, str(HOOK)],
            input=json.dumps(event).encode("utf-8"),
            capture_output=True,
            env=env,
            timeout=30,
            check=False,
        )
    if result.returncode != 0:
        raise AssertionError(f"hook exited {result.returncode}: {result.stderr!r}")
    out = result.stdout.decode("utf-8").strip()
    if not out:
        return "allow"
    return json.loads(out)["hookSpecificOutput"]["permissionDecision"]


def bash(command: str, cwd: str = "/workspace/repo") -> dict:
    return {"tool_name": "Bash", "tool_input": {"command": command}, "cwd": cwd}


def read(path: str, cwd: str = "/workspace/repo") -> dict:
    return {"tool_name": "Read", "tool_input": {"file_path": path}, "cwd": cwd}


class SecretFiles(unittest.TestCase):
    def test_env_files_are_denied(self) -> None:
        for path in (
            "/workspace/repo/.env",
            "/workspace/repo/apps/api/.env.local",
            "/workspace/repo/.env.production",
            "/workspace/repo/deploy/prod.env",
            "/workspace/repo/.envrc",
        ):
            with self.subTest(path=path):
                self.assertEqual(run(read(path)), "deny")

    def test_key_and_credential_files_are_denied(self) -> None:
        for path in (
            "/workspace/repo/certs/server.pem",
            "/workspace/repo/certs/server.key",
            "/workspace/repo/android/release.jks",
            "/workspace/repo/gcp/service-account.json",
            "/workspace/repo/config/credentials.json",
            "/workspace/repo/config/secrets.yml",
            "/workspace/repo/infra/prod.tfvars",
            "/workspace/repo/infra/terraform.tfstate",
            "/workspace/repo/.npmrc",
            "/home/runner/.ssh/id_ed25519",
            "/home/runner/.aws/credentials",
            "/home/runner/.claude/.credentials.json",
            "/home/runner/.agentflow-runner/identity.json",
            "/etc/agentflow-runner/runner.env",
            "/var/lib/agentflow-runner/data/jobs.db",
        ):
            with self.subTest(path=path):
                self.assertEqual(run(read(path)), "deny")

    def test_examples_and_ordinary_files_are_allowed(self) -> None:
        for path in (
            "/workspace/repo/.env.example",
            "/workspace/repo/apps/api/.env.local.example",
            "/workspace/repo/.env.sample",
            "/workspace/repo/infra/prod.tfvars.example",
            "/workspace/repo/src/index.ts",
            "/workspace/repo/deploy/id_ed25519.pub",
            "/workspace/repo/package.json",
            "/workspace/loops/pln-6/.agentflow-ai/work/.agentflow-ai/config.env",
        ):
            with self.subTest(path=path):
                self.assertEqual(run(read(path)), "allow")

    def test_the_loop_settings_file_is_allowed_but_other_config_env_is_not(self) -> None:
        # The orchestrator prompt reads startSha and the repo map from it.
        command = "START_SHA=$(grep '^AGENTFLOW_START_SHA=' \"$AGENTFLOW_WORKDIR/.agentflow-ai/config.env\" | cut -d= -f2-)"
        self.assertEqual(run(bash(command)), "allow")
        self.assertEqual(run(bash("cat /srv/app/config.env")), "deny")
        self.assertEqual(run(bash("cat config.env")), "deny")
        self.assertEqual(run(bash("cat .agentflow-ai/config.env .env")), "deny")
        # Seen live: the orchestrator labels its output with the bare name.
        script = (
            "W=/workspace/loops/pln-12/.agentflow-ai/work\n"
            'echo "=== config.env (selected) ==="\n'
            "grep -E '^(AGENTFLOW_START_SHA|AGENTFLOW_ADD_DIRS)=' \"$W/.agentflow-ai/config.env\""
        )
        self.assertEqual(run(bash(script)), "allow")
        with tempfile.TemporaryDirectory() as work:
            settings = Path(work) / ".agentflow-ai" / "config.env"
            settings.parent.mkdir()
            settings.write_text(f"AGENTFLOW_WORKDIR=/w\nLEAKED={FAKE_GITHUB}\n", encoding="utf-8")
            # A secret that ever lands in it is still caught by its content.
            self.assertEqual(run(read(str(settings))), "deny")

    def test_shell_reads_are_denied(self) -> None:
        for command in (
            "cat .env",
            "grep DATABASE_URL apps/api/.env.local",
            "source .env && npm test",
            "head -3 ~/.ssh/id_rsa",
            "cp .env /tmp/copy.txt",
            "ls .env | xargs cat",
            "test -f .env && cat .env",
            "cd apps/api && cat .env.local",
            "cat ~/.agentflow-runner/identity.json",
            "type .env.local",
            "Get-Content .env.local",
        ):
            with self.subTest(command=command):
                self.assertEqual(run(bash(command)), "deny")

    def test_shell_writes_and_existence_checks_are_allowed(self) -> None:
        for command in (
            "cp .env.example .env",
            "mv .env.example .env.local",
            "echo DATABASE_URL=postgres://localhost/db >> .env",
            "touch .env",
            "ls -la .env.local",
            "test -f .env && echo present",
            "cd apps/api && ls .env.local",
            "docker run --rm --env-file .env app:test npm test",
            "cat .env.example",
            'git grep -n "process.env.API_URL"',
            'rg "import.meta.env"',
            "npx vitest run src",
        ):
            with self.subTest(command=command):
                self.assertEqual(run(bash(command)), "allow")


class EnvironmentDumps(unittest.TestCase):
    def test_dumps_are_denied(self) -> None:
        for command in (
            "env",
            "env | grep KEY",
            "printenv",
            "printenv ANTHROPIC_API_KEY",
            "export -p",
            "set",
            "cat /proc/self/environ",
            "echo $AGENTFLOW_API_KEY",
            'echo "Bearer ${GITHUB_TOKEN}"',
            'node -e "console.log(process.env)"',
            'python3 -c "import os; print(os.environ)"',
            "docker inspect web",
            "docker inspect -f '{{json .Config}}' web",
            "docker exec web env",
            "docker run --env-file .env alpine env",
            "docker compose config",
            "git credential fill",
            "gh auth token",
            "Get-ChildItem Env:",
            "$env:OPENAI_API_KEY",
        ):
            with self.subTest(command=command):
                self.assertEqual(run(bash(command)), "deny")

    def test_ordinary_commands_are_allowed(self) -> None:
        for command in (
            "env NODE_ENV=test npx vitest run",
            "set -euo pipefail; npm test",
            "docker inspect -f '{{.State.Status}}' web",
            "docker compose config --services",
            "docker exec web ls /app",
            'curl -s -H "Authorization: Bearer $TOKEN" http://localhost:3000/health',
            "jq -r '.[] | .key' data.json",
            "echo $PATH",
        ):
            with self.subTest(command=command):
                self.assertEqual(run(bash(command)), "allow")


class SecretContent(unittest.TestCase):
    def setUp(self) -> None:
        self.dir = tempfile.TemporaryDirectory()
        self.root = Path(self.dir.name)

    def tearDown(self) -> None:
        self.dir.cleanup()

    def write(self, name: str, text: str) -> str:
        path = self.root / name
        path.write_text(text, encoding="utf-8")
        return path.as_posix()

    def test_files_holding_credentials_are_denied(self) -> None:
        cases = {
            "settings.py": f"AWS_ACCESS_KEY_ID = '{FAKE_AWS}'\n",
            "deploy.sh": f"export GH={FAKE_GITHUB}\n",
            "notes.txt": FAKE_PRIVATE_KEY,
            "client.ts": f'const key = "{FAKE_SK}";\n',
            "appsettings.json": '{"Db": {"Password": "Pr0dPassw0rd-2026x"}}\n',
            "config.yml": "database:\n  password: s3cr3tValue2026abc\n",
        }
        for name, text in cases.items():
            with self.subTest(name=name):
                self.assertEqual(run(read(self.write(name, text))), "deny")

    def test_shell_reads_of_such_files_are_denied(self) -> None:
        self.write("settings.py", f"KEY = '{FAKE_AWS}'\n")
        for command in ("cat settings.py", "grep KEY settings.py", "head -1 ./settings.py"):
            with self.subTest(command=command):
                self.assertEqual(run(bash(command, cwd=self.root.as_posix())), "deny")

    def test_placeholders_and_code_are_allowed(self) -> None:
        cases = {
            "config.yml": "database:\n  password: ${DB_PASSWORD}\n  api_key: your-api-key-here\n",
            "appsettings.json": '{"Db": {"Password": "changeme"}}\n',
            "auth.ts": "const password = form.password; // checked by hashPassword(password1234)\n",
            "README.md": "Set API_KEY in .env.example\n",
        }
        for name, text in cases.items():
            with self.subTest(name=name):
                self.assertEqual(run(read(self.write(name, text))), "allow")

    def test_running_a_script_that_holds_a_key_is_allowed(self) -> None:
        self.write("seed.py", f"KEY = '{FAKE_AWS}'\n")
        self.assertEqual(run(bash("python3 seed.py", cwd=self.root.as_posix())), "allow")


class Overrides(unittest.TestCase):
    def test_a_category_can_be_allowed(self) -> None:
        self.assertEqual(run(read("/workspace/repo/.env"), {"secret-files": True}), "allow")
        self.assertEqual(run(bash("env"), {"environment-dump": True}), "allow")

    def test_other_categories_stay_denied(self) -> None:
        self.assertEqual(run(read("/workspace/repo/.env"), {"environment-dump": True}), "deny")

    def test_a_malformed_override_file_denies(self) -> None:
        self.assertEqual(run(read("/workspace/repo/.env"), {"secret-files": "yes"}), "deny")


class Robustness(unittest.TestCase):
    def test_other_tools_and_empty_events_are_allowed(self) -> None:
        self.assertEqual(run({"tool_name": "Edit", "tool_input": {"file_path": "/w/.env"}}), "allow")
        self.assertEqual(run({}), "allow")

    def test_grep_on_secret_files_is_denied(self) -> None:
        event = {"tool_name": "Grep", "tool_input": {"pattern": "KEY", "glob": "**/.env*"}, "cwd": "/w"}
        self.assertEqual(run(event), "deny")
        event = {"tool_name": "Grep", "tool_input": {"pattern": "x", "glob": "*.ts"}, "cwd": "/w"}
        self.assertEqual(run(event), "allow")


class RecursiveSearches(unittest.TestCase):
    """A content search over a directory must not print a secret file in it."""

    def setUp(self) -> None:
        self._dir = tempfile.TemporaryDirectory()
        self.root = self._dir.name
        repo = Path(self.root)
        (repo / "src").mkdir()
        (repo / "src" / "app.js").write_text("const token = process.env.API_TOKEN;\n", encoding="utf-8")
        (repo / ".env").write_text("API_TOKEN=planted\n", encoding="utf-8")
        (repo / ".env.example").write_text("API_TOKEN=\n", encoding="utf-8")
        (repo / "node_modules" / "x").mkdir(parents=True)
        (repo / "node_modules" / "x" / ".env").write_text("A=1\n", encoding="utf-8")

    def tearDown(self) -> None:
        self._dir.cleanup()

    def grep(self, **tool_input: str) -> str:
        return run({"tool_name": "Grep", "tool_input": {"pattern": "API_TOKEN", **tool_input}, "cwd": self.root})

    def test_grep_tool_content_over_a_directory_holding_env_is_denied(self) -> None:
        self.assertEqual(self.grep(output_mode="content"), "deny")
        self.assertEqual(self.grep(output_mode="content", path=self.root), "deny")
        self.assertEqual(self.grep(output_mode="content", glob="*"), "deny")

    def test_grep_tool_that_keeps_secret_files_out_is_allowed(self) -> None:
        self.assertEqual(self.grep(), "allow")  # files_with_matches: names only
        self.assertEqual(self.grep(output_mode="count"), "allow")
        self.assertEqual(self.grep(output_mode="content", glob="*.{js,ts}"), "allow")
        self.assertEqual(self.grep(output_mode="content", type="js"), "allow")
        self.assertEqual(self.grep(output_mode="content", path="src"), "allow")
        self.assertEqual(self.grep(output_mode="content", path="src/app.js"), "allow")

    def test_recursive_shell_searches_are_denied(self) -> None:
        for command in (
            "grep -rn API_TOKEN .",
            "grep -R API_TOKEN",
            "grep --recursive -i api_token .",
            "rg API_TOKEN",
            "rg -n API_TOKEN .",
            "cd src && grep -rn x . ; rg API_TOKEN",
            "grep -rn -e API_TOKEN .",
        ):
            with self.subTest(command=command):
                self.assertEqual(run(bash(command, cwd=self.root)), "deny")

    def test_shell_searches_that_keep_secret_files_out_are_allowed(self) -> None:
        for command in (
            "grep -n API_TOKEN src/app.js",
            "grep -rl API_TOKEN .",
            "grep -rc API_TOKEN .",
            "grep -rn --include='*.js' API_TOKEN .",
            "grep -rn API_TOKEN src",
            "rg -g '*.js' API_TOKEN",
            "rg -tjs API_TOKEN",
            "rg --type js API_TOKEN",
            "rg -l API_TOKEN",
        ):
            with self.subTest(command=command):
                self.assertEqual(run(bash(command, cwd=self.root)), "allow")

    def test_naming_an_env_file_stays_denied_even_to_exclude_it(self) -> None:
        # The file-name rule sees the env file in the call; include filters work.
        self.assertEqual(self.grep(output_mode="content", glob="!.env*"), "deny")
        self.assertEqual(run(bash("grep -rn --exclude='.env*' API_TOKEN .", cwd=self.root)), "deny")

    def test_only_example_env_files_are_allowed(self) -> None:
        os.remove(Path(self.root) / ".env")
        self.assertEqual(self.grep(output_mode="content"), "allow")
        self.assertEqual(run(bash("grep -rn API_TOKEN .", cwd=self.root)), "allow")


if __name__ == "__main__":
    unittest.main(verbosity=1)
