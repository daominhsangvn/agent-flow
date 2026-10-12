#!/usr/bin/env bash
# AgentFlow Performance Tracking - PreToolUse Sentinel Hook
# Writes a sentinel file for each tool call so downstream hooks can compute
# tool-call duration and attribution.
#
# Designed to be non-blocking: exits 0 on any failure (fail-open pattern).
#
# Sentinel file location:
#   $AGENTFLOW_WORKDIR/.tool-calls/{TOOL_USE_ID}
# Sentinel file contents (JSON):
#   {
#     "started_at": "...",   # ISO-8601 UTC timestamp when the tool call began
#     "tool_name": "...",    # e.g. "Read", "Bash", "Write", "Edit"
#     "agent_id": "...",     # agent identifier from hook input
#     "run_id": "...",       # AGENTFLOW_RUN_ID — links sentinel to a loop run
#     "command": "...",      # AGENTFLOW_COMMAND — the slash-command that triggered the run
#     "iteration": 0         # AGENTFLOW_ITERATION — loop iteration counter (integer)
#   }
# The desktop scanner uses these fields to construct a complete `tool` event with
# ended_at: null, duration_s: null, ok: null for sentinels that were never cleaned
# up by the post-hook (i.e. orphaned tool calls).

# Fail open: any unexpected error exits 0 so the caller is unaffected.
trap 'exit 0' ERR

# Single source of truth for the state directory name
AGENTFLOW_STATE_DIR=".agentflow-ai"
SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/../scripts" && pwd)"
# shellcheck source=../scripts/agentflow_env.sh
source "$SCRIPT_DIR/agentflow_env.sh"

# Read hook input from stdin (JSON)
INPUT=$(</dev/stdin)

# Parse all hook input fields in a single jq invocation. Use a here-string
# (`<<<`) instead of `echo "$INPUT" |` to match the post-tool-use-hook idiom
# — symmetric hooks should read stdin the same way.
eval "$(jq -r '
    @sh "TOOL_NAME=\(.tool_name // empty)",
    @sh "SESSION_ID=\(.session_id // empty)",
    @sh "CWD=\(.cwd // empty)",
    @sh "AGENT_ID=\(.agent_id // empty)",
    @sh "TOOL_USE_ID_RAW=\(.tool_use_id // empty)",
    @sh "TOOL_CALL_ID=\(.tool_call_id // empty)",
    @sh "PLANNED_SUBAGENT_TYPE=\(.tool_input.subagent_type // .tool_input.description // empty)"
' <<< "$INPUT")"

# Resolve a tool-call correlation id. Prefer `tool_use_id` (Claude Code's documented
# field), fall back to `tool_call_id` (PRD spelling). If neither is present we
# cannot safely correlate this pre-hook with its post-hook — a counter-file
# fallback would race under parallel tool invocations (two hooks reading the
# same value, the post hook matching the wrong sentinel) and produce silently
# wrong telemetry. Skip the pre-hook silently in that case; the post-hook will
# also skip, so no orphaned sentinels accumulate.
TOOL_USE_ID="$TOOL_USE_ID_RAW"
if [[ -z "$TOOL_USE_ID" ]]; then
    TOOL_USE_ID="$TOOL_CALL_ID"
fi
if [[ -z "$TOOL_USE_ID" ]]; then
    exit 0
fi

# Discover WORKDIR via session_id mapping (same pattern as pretooluse-hook.sh and subagent-start-hook.sh)
AGENTFLOW_WORKDIR=""
if [[ -n "$SESSION_ID" ]]; then
    WORKDIR_FILE="${CWD:-.}/$AGENTFLOW_STATE_DIR/session-$SESSION_ID.workdir"
    if [[ -f "$WORKDIR_FILE" ]]; then
        AGENTFLOW_WORKDIR=$(cat "$WORKDIR_FILE")
    fi
fi

# Exit early if not in a agentflow session
if [[ -z "$AGENTFLOW_WORKDIR" ]]; then
    exit 0
fi

AGENTFLOW_CONFIG="$AGENTFLOW_WORKDIR/$AGENTFLOW_STATE_DIR/config.env"
load_agentflow_env "$AGENTFLOW_CONFIG"

# Sanitize AGENTFLOW_ITERATION after hydrating persisted metadata: must be a
# non-negative integer or jq's --argjson will fail and abort this hook silently.
ITERATION="${AGENTFLOW_ITERATION:-0}"
if ! [[ "$ITERATION" =~ ^[0-9]+$ ]]; then
    ITERATION=0
fi

# Write sentinel file: $AGENTFLOW_WORKDIR/.tool-calls/{TOOL_USE_ID}
TOOL_CALLS_DIR="$AGENTFLOW_WORKDIR/.tool-calls"
[[ -d "$TOOL_CALLS_DIR" ]] || mkdir -p "$TOOL_CALLS_DIR"

STARTED_AT=$(date -u +"%Y-%m-%dT%H:%M:%SZ" 2>/dev/null || echo "")

jq -n -c \
    --arg started_at "$STARTED_AT" \
    --arg tool_name "${TOOL_NAME:-}" \
    --arg agent_id "${AGENT_ID:-}" \
    --arg run_id "${AGENTFLOW_RUN_ID:-}" \
    --arg command "${AGENTFLOW_COMMAND:-}" \
    --argjson iteration "$ITERATION" \
    '{started_at:$started_at,tool_name:$tool_name,agent_id:$agent_id,run_id:$run_id,command:$command,iteration:$iteration}' \
    > "$TOOL_CALLS_DIR/$TOOL_USE_ID"

# When the tool being invoked is "Agent", emit a spawn event to perf.jsonl
if [[ "$TOOL_NAME" == "Agent" ]]; then
    PERF_FILE="$AGENTFLOW_WORKDIR/perf.jsonl"
    jq -n -c \
        --arg event "spawn" \
        --arg run_id "${AGENTFLOW_RUN_ID:-unknown}" \
        --arg command "${AGENTFLOW_COMMAND:-interactive}" \
        --argjson iteration "$ITERATION" \
        --arg parent_session_id "${SESSION_ID:-}" \
        --arg parent_agent_id "${AGENT_ID:-}" \
        --arg planned_subagent_type "${PLANNED_SUBAGENT_TYPE:-}" \
        --arg started_at "$STARTED_AT" \
        '{event:$event,run_id:$run_id,command:$command,iteration:$iteration,parent_session_id:$parent_session_id,parent_agent_id:$parent_agent_id,planned_subagent_type:$planned_subagent_type,started_at:$started_at}' \
        >> "$PERF_FILE"
fi

exit 0
