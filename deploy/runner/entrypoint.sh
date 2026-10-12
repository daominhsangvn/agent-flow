#!/usr/bin/env bash
# Prepares git and gh for unattended use, then runs the given command
# (the runner by default). See docs/runner.md.
set -euo pipefail

# Identity for commits made outside a loop's own committer settings.
git config --global user.name "${GIT_AUTHOR_NAME:-AgentFlow Runner}"
git config --global user.email "${GIT_AUTHOR_EMAIL:-runner@agentflow.invalid}"
git config --global init.defaultBranch main
# Repositories on mounted volumes may be owned by another uid.
git config --global --add safe.directory '*'

# With GH_TOKEN (or GITHUB_TOKEN), gh is authenticated; let git use it for
# HTTPS clone/push too.
if [[ -n "${GH_TOKEN:-${GITHUB_TOKEN:-}}" ]]; then
  gh auth setup-git >/dev/null
fi

exec "$@"
