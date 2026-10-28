#!/bin/bash
# Git baselines of the repositories a loop works in.
#
# run-loop.sh records the HEAD of the repository holding the work directory as
# AGENTFLOW_START_SHA. A loop also works in its --add-dir repositories, and a
# workspace loop works only in them: its work directory sits in a folder that
# is not a repository, with every repository of the project as a subdirectory.
# Their baselines are AGENTFLOW_START_SHAS, "<repository root>=<sha>" entries
# joined by "|".
#
# Usage:
#   repo-baselines.sh capture [--exclude <dir>] <dir>...
#       Print the AGENTFLOW_START_SHAS value for the <dir>s (an argument may
#       join several with "|", as AGENTFLOW_ADD_DIRS does): the HEAD of each
#       repository holding one, once per repository. Skips a directory outside
#       a repository, a repository without a commit, a repository root that
#       cannot be written into config.env as a quoted value, and the repository
#       holding --exclude (the work directory, whose baseline is
#       AGENTFLOW_START_SHA).
#   repo-baselines.sh changed [--start-sha <sha>] [--start-shas <entries>]
#       Print the files changed since the baselines, unique, in byte order:
#       committed since the baseline, unstaged and staged. --start-sha is the
#       repository of the current directory (paths relative to its root); each
#       --start-shas entry is its own repository (paths prefixed with its root).

set -euo pipefail

usage() {
  echo "Usage: repo-baselines.sh capture [--exclude <dir>] <dir>..."
  echo "       repo-baselines.sh changed [--start-sha <sha>] [--start-shas <entries>]"
}

capture() {
  local exclude_root="" dirs=() joined=() dir root sha seen="|" entries=""
  while [[ $# -gt 0 ]]; do
    if [[ "$1" == "--exclude" ]]; then
      if [[ -n "${2:-}" ]]; then
        exclude_root=$(git -C "$2" rev-parse --show-toplevel 2>/dev/null || true)
      fi
      shift
      [[ $# -gt 0 ]] && shift
    else
      IFS='|' read -r -a joined <<< "$1"
      dirs+=(${joined[@]+"${joined[@]}"})
      shift
    fi
  done

  for dir in ${dirs[@]+"${dirs[@]}"}; do
    [[ -n "$dir" ]] || continue
    root=$(git -C "$dir" rev-parse --show-toplevel 2>/dev/null) || continue
    sha=$(git -C "$dir" rev-parse --verify --quiet HEAD 2>/dev/null) || continue
    if [[ -z "$root" || -z "$sha" || "$root" == "$exclude_root" ]]; then
      continue
    fi
    # "|" separates entries; the others would break the double-quoted value
    # that sourcing config.env expands.
    case "$root" in
      *'|'* | *'"'* | *'$'* | *'`'* | *'\'* | *$'\n'*) continue ;;
    esac
    case "$seen" in
      *"|$root|"*) continue ;;
    esac
    seen="$seen$root|"
    entries="${entries:+$entries|}$root=$sha"
  done
  printf '%s\n' "$entries"
}

changed() {
  local start_sha="" start_shas="" entries=() entry root sha file
  while [[ $# -gt 0 ]]; do
    case "$1" in
      --start-sha) start_sha="${2:-}" ;;
      --start-shas) start_shas="${2:-}" ;;
      *)
        usage >&2
        exit 2
        ;;
    esac
    shift
    [[ $# -gt 0 ]] && shift
  done

  IFS='|' read -r -a entries <<< "$start_shas"
  {
    if [[ -n "$start_sha" ]]; then
      changed_since "$start_sha" .
    fi
    for entry in ${entries[@]+"${entries[@]}"}; do
      root="${entry%=*}"
      sha="${entry##*=}"
      if [[ "$entry" != *=* || -z "$root" || -z "$sha" ]]; then
        continue
      fi
      changed_since "$sha" "$root" | while IFS= read -r file; do
        printf '%s/%s\n' "$root" "$file"
      done
    done
  } | LC_ALL=C sort -u
}

# Files of the repository at <dir> committed since <sha>, unstaged and staged,
# relative to its root.
changed_since() {
  local sha="$1" dir="$2"
  git -C "$dir" -c core.quotePath=false diff --name-only "$sha" HEAD 2>/dev/null || true
  git -C "$dir" -c core.quotePath=false diff --name-only 2>/dev/null || true
  git -C "$dir" -c core.quotePath=false diff --name-only --cached 2>/dev/null || true
}

case "${1:-}" in
  capture)
    shift
    capture "$@"
    ;;
  changed)
    shift
    changed "$@"
    ;;
  *)
    usage >&2
    exit 2
    ;;
esac
