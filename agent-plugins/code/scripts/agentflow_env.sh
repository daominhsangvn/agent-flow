#!/bin/bash
# agentflow_env.sh - Shared helper to hydrate AGENTFLOW_* env vars from
# config.env without letting the file clobber values already present in the
# environment.
#
# Source this file, then call:
#   load_agentflow_env "$CONFIG_FILE"
#
# Existing non-empty AGENTFLOW_WORKDIR / AGENTFLOW_RUN_ID /
# AGENTFLOW_ITERATION / AGENTFLOW_COMMAND values take precedence over whatever
# config.env defines (the environment is the source of truth; config.env is the
# fallback). No-op when CONFIG_FILE is absent.
#
# config.env is parsed line-by-line (NOT sourced) so a malformed or hostile file
# can never execute arbitrary shell. Only the allowlisted keys are read; all
# other lines are ignored. Backslash-escaped spaces are decoded so values written
# by `printf %q` for common paths still round-trip without eval/source.
#
# Single source of truth for both record_iteration.sh and record_phase.sh.

decode_agentflow_env_value() {
  local val="$1"
  val="${val//\\ / }"
  printf '%s' "$val"
}

load_agentflow_env() {
  local config_file="$1"
  [[ -f "$config_file" ]] || return 0

  local line key val
  while IFS= read -r line || [[ -n "$line" ]]; do
    case "$line" in
      AGENTFLOW_WORKDIR=*|AGENTFLOW_RUN_ID=*|AGENTFLOW_ITERATION=*|AGENTFLOW_COMMAND=*)
        key="${line%%=*}"
        val="$(decode_agentflow_env_value "${line#*=}")"
        # Environment is the source of truth; only fall back to config.env
        # when the corresponding env var is unset or empty.
        case "$key" in
          AGENTFLOW_WORKDIR)
            if [[ -z "${AGENTFLOW_WORKDIR:-}" ]]; then AGENTFLOW_WORKDIR="$val"; fi
            ;;
          AGENTFLOW_RUN_ID)
            if [[ -z "${AGENTFLOW_RUN_ID:-}" ]]; then AGENTFLOW_RUN_ID="$val"; fi
            ;;
          AGENTFLOW_ITERATION)
            if [[ -z "${AGENTFLOW_ITERATION:-}" ]]; then AGENTFLOW_ITERATION="$val"; fi
            ;;
          AGENTFLOW_COMMAND)
            if [[ -z "${AGENTFLOW_COMMAND:-}" ]]; then AGENTFLOW_COMMAND="$val"; fi
            ;;
        esac
        ;;
    esac
  done < "$config_file"
}
