"""Git baselines of every repository a loop works in (AGENTFLOW_START_SHAS).

A workspace loop runs from a folder that is not a repository, with each of the
project's repositories as a subdirectory (passed as --add-dir). Its work
directory is in no repository, so AGENTFLOW_START_SHA is empty, and Phase 5.5
(behavior-verifier) used to skip for lack of a baseline. These tests pin the
baselines through every boundary they cross: repo-baselines.sh, run-loop.sh
writing config.env, setup-agentflow.sh rewriting it each iteration, and the
orchestrator prompts handing them to the behavior-verifier.
"""

from __future__ import annotations

import os
import subprocess
from pathlib import Path

import pytest
from conftest import AGENTFLOW_STATE_DIR

PLUGIN_ROOT = Path(__file__).resolve().parents[2]
SCRIPTS_DIR = PLUGIN_ROOT / "scripts"
REPO_BASELINES = SCRIPTS_DIR / "repo-baselines.sh"
RUN_LOOP = SCRIPTS_DIR / "run-loop.sh"
SETUP_SCRIPT = SCRIPTS_DIR / "setup-agentflow.sh"

# Git without the developer's own config (signing, hooks, quotePath, ...).
GIT_ENV = {
    "PATH": os.environ.get("PATH", ""),
    "HOME": os.environ.get("HOME", ""),
    "GIT_CONFIG_GLOBAL": os.devnull,
    "GIT_CONFIG_NOSYSTEM": "1",
    "GIT_AUTHOR_NAME": "Test",
    "GIT_AUTHOR_EMAIL": "test@example.com",
    "GIT_COMMITTER_NAME": "Test",
    "GIT_COMMITTER_EMAIL": "test@example.com",
}


def git(repo: Path, *args: str) -> str:
    result = subprocess.run(
        ["git", "-C", str(repo), *args],
        capture_output=True,
        text=True,
        env=GIT_ENV,
        check=True,
    )
    return result.stdout.strip()


def make_repo(path: Path, files: dict[str, str] | None = None) -> str:
    """Create a repository with one commit holding `files`; return its HEAD."""
    path.mkdir(parents=True)
    git(path, "init", "-q")
    for name, content in (files or {"README.md": "readme\n"}).items():
        (path / name).parent.mkdir(parents=True, exist_ok=True)
        (path / name).write_text(content)
    git(path, "add", "-A")
    git(path, "commit", "-q", "-m", "initial")
    return git(path, "rev-parse", "HEAD")


def commit_all(repo: Path, message: str = "change") -> None:
    git(repo, "add", "-A")
    git(repo, "commit", "-q", "-m", message)


def baselines(*args: str, cwd: Path | None = None) -> subprocess.CompletedProcess:
    return subprocess.run(
        ["bash", str(REPO_BASELINES), *args],
        capture_output=True,
        text=True,
        env=GIT_ENV,
        cwd=cwd,
    )


@pytest.fixture
def workspace(tmp_path: Path) -> Path:
    """A loop workspace: a plain folder whose subdirectories are repositories."""
    root = tmp_path.resolve() / "loops" / "pln-7"
    (root / AGENTFLOW_STATE_DIR / "work").mkdir(parents=True)
    return root


# ---------------------------------------------------------------------------
# repo-baselines.sh capture
# ---------------------------------------------------------------------------


def test_capture_records_every_workspace_repository(workspace: Path) -> None:
    api_sha = make_repo(workspace / "api")
    web_sha = make_repo(workspace / "web", {"index.ts": "export {};\n"})
    workdir = workspace / AGENTFLOW_STATE_DIR / "work"

    result = baselines(
        "capture", "--exclude", str(workdir), str(workspace / "api"), str(workspace / "web")
    )

    assert result.returncode == 0, result.stderr
    assert result.stdout.strip() == (
        f"{workspace / 'api'}={api_sha}|{workspace / 'web'}={web_sha}"
    )


def test_capture_skips_non_repositories_empty_repositories_and_repeats(
    workspace: Path,
) -> None:
    api_sha = make_repo(workspace / "api")
    (workspace / "docs").mkdir()
    (workspace / "fresh").mkdir()
    git(workspace / "fresh", "init", "-q")  # no commit: no baseline

    result = baselines(
        "capture",
        str(workspace),
        str(workspace / "docs"),
        str(workspace / "fresh"),
        str(workspace / "api"),
        str(workspace / "api" / "."),
        str(workspace / "missing"),
    )

    assert result.returncode == 0, result.stderr
    assert result.stdout.strip() == f"{workspace / 'api'}={api_sha}"


def test_capture_keys_a_subdirectory_by_its_repository_root(tmp_path: Path) -> None:
    repo = tmp_path.resolve() / "peer"
    sha = make_repo(repo, {"pkg/lib/a.py": "a = 1\n"})

    result = baselines("capture", str(repo / "pkg" / "lib"))

    assert result.stdout.strip() == f"{repo}={sha}"


def test_capture_excludes_the_repository_holding_the_work_directory(
    tmp_path: Path,
) -> None:
    primary = tmp_path.resolve() / "primary"
    make_repo(primary)
    (primary / AGENTFLOW_STATE_DIR / "work").mkdir(parents=True)
    peer_sha = make_repo(tmp_path.resolve() / "peer")

    result = baselines(
        "capture",
        "--exclude",
        str(primary / AGENTFLOW_STATE_DIR / "work"),
        str(primary),
        str(tmp_path / "peer"),
    )

    # The primary repository's baseline is AGENTFLOW_START_SHA, not an entry.
    assert result.stdout.strip() == f"{tmp_path.resolve() / 'peer'}={peer_sha}"


def test_capture_splits_pipe_joined_directories_like_agentflow_add_dirs(
    workspace: Path,
) -> None:
    api_sha = make_repo(workspace / "api")
    web_sha = make_repo(workspace / "web")

    result = baselines("capture", f"{workspace / 'api'}|{workspace / 'web'}")

    assert result.stdout.strip() == (
        f"{workspace / 'api'}={api_sha}|{workspace / 'web'}={web_sha}"
    )


def test_capture_keeps_spaces_but_skips_roots_unsafe_in_config_env(
    tmp_path: Path,
) -> None:
    spaced = tmp_path.resolve() / "my repos" / "api"
    spaced_sha = make_repo(spaced)
    make_repo(tmp_path.resolve() / "price$HOME")
    make_repo(tmp_path.resolve() / 'quote"d')

    result = baselines(
        "capture", str(spaced), str(tmp_path / "price$HOME"), str(tmp_path / 'quote"d')
    )

    assert result.stdout.strip() == f"{spaced}={spaced_sha}"


def test_capture_without_directories_prints_an_empty_value() -> None:
    result = baselines("capture", "--exclude", "/nonexistent")

    assert result.returncode == 0
    assert result.stdout == "\n"


def test_unknown_subcommand_fails_with_usage() -> None:
    result = baselines("diff")

    assert result.returncode == 2
    assert "Usage: repo-baselines.sh capture" in result.stderr


# ---------------------------------------------------------------------------
# repo-baselines.sh changed
# ---------------------------------------------------------------------------


def test_changed_lists_each_repository_by_root_from_a_non_repository_folder(
    workspace: Path,
) -> None:
    api, web, docs = workspace / "api", workspace / "web", workspace / "docs"
    api_sha = make_repo(api, {"src/a.ts": "a\n", "src/b.ts": "b\n", "src/c.ts": "c\n"})
    web_sha = make_repo(web)
    docs_sha = make_repo(docs)
    (api / "src" / "a.ts").write_text("a2\n")
    commit_all(api)  # committed since the baseline
    (api / "src" / "b.ts").write_text("b2\n")  # unstaged
    (api / "src" / "new.ts").write_text("new\n")
    git(api, "add", "src/new.ts")  # staged
    (web / "README.md").write_text("changed\n")
    commit_all(web)
    (web / "README.md").write_text("changed again\n")  # committed and unstaged

    result = baselines(
        "changed",
        "--start-sha",
        "",
        "--start-shas",
        f"{api}={api_sha}|{web}={web_sha}|{docs}={docs_sha}",
        cwd=workspace,
    )

    assert result.returncode == 0, result.stderr
    assert result.stdout.splitlines() == [
        f"{api}/src/a.ts",
        f"{api}/src/b.ts",
        f"{api}/src/new.ts",
        f"{web}/README.md",
    ]


def test_changed_keeps_the_current_repository_relative_next_to_other_repositories(
    tmp_path: Path,
) -> None:
    primary = tmp_path.resolve() / "primary"
    peer = tmp_path.resolve() / "peer"
    primary_sha = make_repo(primary, {"app.py": "x = 1\n"})
    peer_sha = make_repo(peer, {"lib.py": "y = 1\n"})
    (primary / "app.py").write_text("x = 2\n")
    (peer / "lib.py").write_text("y = 2\n")
    commit_all(peer)

    result = baselines(
        "changed",
        "--start-sha",
        primary_sha,
        "--start-shas",
        f"{peer}={peer_sha}",
        cwd=primary,
    )

    assert result.stdout.splitlines() == [f"{peer}/lib.py", "app.py"]


def test_changed_ignores_malformed_and_unknown_entries(workspace: Path) -> None:
    api = workspace / "api"
    api_sha = make_repo(api)
    (api / "README.md").write_text("changed\n")

    result = baselines(
        "changed",
        "--start-shas",
        f"no-separator|={api_sha}|{api}=|{workspace / 'gone'}={api_sha}|{api}={api_sha}",
        cwd=workspace,
    )

    assert result.returncode == 0, result.stderr
    assert result.stdout.splitlines() == [f"{api}/README.md"]


def test_changed_without_baselines_lists_nothing(workspace: Path) -> None:
    make_repo(workspace / "api")
    (workspace / "api" / "README.md").write_text("changed\n")

    result = baselines("changed", "--start-sha", "", "--start-shas", "", cwd=workspace)

    assert result.returncode == 0
    assert result.stdout == ""


# ---------------------------------------------------------------------------
# run-loop.sh -> config.env -> setup-agentflow.sh
# ---------------------------------------------------------------------------


def run_loop_start(workspace: Path, workdir: Path, add_dirs: list[Path]) -> str:
    """Run run-loop.sh's start-of-loop baseline capture; return config.env."""
    add_dir_args = " ".join(f'"{d}"' for d in add_dirs)
    script = f"""
set --
source "{RUN_LOOP}"
WORKDIR="{workdir}"
ADD_DIRS=({add_dir_args})
STATE_FILE="{workspace}/{AGENTFLOW_STATE_DIR}/agentflow-loop.local.md"
PROGRESS_LOG=/dev/null
MAX_ITERATIONS=1
COMPLETION_PROMISE=COMPLETE
PRD_FILE=""
RUN_ID=test-run
SELF_LEARNING=false
PROMPT_NAME=""
capture_start_sha "$WORKDIR"
capture_repo_start_shas "$WORKDIR"
create_state_file
"""
    result = subprocess.run(
        ["bash", "-c", script],
        capture_output=True,
        text=True,
        env=GIT_ENV,
        cwd=workspace,
        timeout=30,
    )
    assert result.returncode == 0, result.stderr
    return (workdir / AGENTFLOW_STATE_DIR / "config.env").read_text()


def source_config_value(workdir: Path, key: str) -> str:
    """The value a hook sees when it sources config.env."""
    result = subprocess.run(
        ["bash", "-c", f'source "$0/{AGENTFLOW_STATE_DIR}/config.env"; printf %s "${key}"', workdir],
        capture_output=True,
        text=True,
        env=GIT_ENV,
        check=True,
    )
    return result.stdout


def test_run_loop_writes_every_workspace_repository_baseline(workspace: Path) -> None:
    api_sha = make_repo(workspace / "api")
    web_sha = make_repo(workspace / "web")
    workdir = workspace / AGENTFLOW_STATE_DIR / "work"
    (workdir / AGENTFLOW_STATE_DIR).mkdir()
    (workdir / AGENTFLOW_STATE_DIR / "config.env").write_text(
        'AGENTFLOW_START_SHAS="/stale/repo=0000000"\n'
    )

    config = run_loop_start(workspace, workdir, [workspace / "api", workspace / "web"])

    expected = f"{workspace / 'api'}={api_sha}|{workspace / 'web'}={web_sha}"
    assert "AGENTFLOW_START_SHA=\n" in config  # the workspace folder is no repository
    assert config.count("AGENTFLOW_START_SHAS=") == 1
    assert source_config_value(workdir, "AGENTFLOW_START_SHAS") == expected


def test_run_loop_keeps_the_primary_baseline_out_of_the_peer_baselines(
    tmp_path: Path,
) -> None:
    primary = tmp_path.resolve() / "primary"
    primary_sha = make_repo(primary)
    workdir = primary / AGENTFLOW_STATE_DIR / "work"
    workdir.mkdir(parents=True)
    peer_sha = make_repo(tmp_path.resolve() / "peer")

    config = run_loop_start(primary, workdir, [primary, tmp_path / "peer"])

    assert f"AGENTFLOW_START_SHA={primary_sha}\n" in config
    assert source_config_value(workdir, "AGENTFLOW_START_SHAS") == (
        f"{tmp_path.resolve() / 'peer'}={peer_sha}"
    )


def test_setup_keeps_the_repository_baselines_across_iterations(tmp_path: Path) -> None:
    root = tmp_path.resolve() / "my loops" / "pln-7"
    api_sha = make_repo(root / "api")
    workdir = root / AGENTFLOW_STATE_DIR / "work"
    (workdir / AGENTFLOW_STATE_DIR).mkdir(parents=True)
    value = f"{root / 'api'}={api_sha}"
    (workdir / AGENTFLOW_STATE_DIR / "config.env").write_text(
        f'AGENTFLOW_START_SHA=\nAGENTFLOW_START_SHAS="{value}"\n'
    )

    for _ in range(2):  # setup-agentflow.sh runs on every /code:code iteration
        result = subprocess.run(
            ["bash", str(SETUP_SCRIPT), str(workdir), "--add-dir", str(root / "api")],
            capture_output=True,
            text=True,
            cwd=str(workdir),
        )
        assert result.returncode == 0, result.stderr

    config = (workdir / AGENTFLOW_STATE_DIR / "config.env").read_text()
    assert config.count("AGENTFLOW_START_SHAS=") == 1
    assert source_config_value(workdir, "AGENTFLOW_START_SHAS") == value


# ---------------------------------------------------------------------------
# Orchestrator prompts -> behavior-verifier
# ---------------------------------------------------------------------------


@pytest.mark.parametrize("prompt", ["prompts/prompt.md", "prompts/execute-prompt.md"])
def test_phase_5_5_runs_on_repository_baselines_alone(prompt: str) -> None:
    text = (PLUGIN_ROOT / prompt).read_text()

    assert "grep '^AGENTFLOW_START_SHAS='" in text
    assert 'If `startSha` and `startShas` are both `""`' in text
    assert "START_SHA=$startSha. START_SHAS=$startShas." in text


def test_behavior_verifier_builds_changed_files_from_every_baseline() -> None:
    text = (PLUGIN_ROOT / "agents" / "behavior-verifier.md").read_text()

    assert (
        'scripts/repo-baselines.sh" changed --start-sha "$START_SHA" '
        '--start-shas "$START_SHAS"'
    ) in text
