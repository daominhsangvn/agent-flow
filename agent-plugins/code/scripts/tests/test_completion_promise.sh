#!/usr/bin/env bash
# Tests for stream_has_completion_promise() in run-loop.sh.
#
# The case that motivated these: every iteration's stream quotes the promise
# before any work happens -- the orchestrator reads its prompt, which names the
# token, as a tool result -- so a grep over the whole stream called every
# iteration that exited 0 COMPLETE. A PLAN iteration whose background
# plan-draft-writer Claude Code cut off was judged finished (and failed with
# PLAN_MISSING_AT_COMPLETION) instead of continuing in the next iteration.
#
# run-loop.sh guards main() with [[ "${BASH_SOURCE[0]}" == "$0" ]], so sourcing
# it defines the functions without running the loop.
#
# Usage:
#   bash agent-plugins/code/scripts/tests/test_completion_promise.sh
#
# Exit code: 0 if all tests pass, 1 if any test fails.

set -uo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
RUN_LOOP="$SCRIPT_DIR/../run-loop.sh"

PASS_COUNT=0
FAIL_COUNT=0

pass() {
  echo "  PASS: $1"
  PASS_COUNT=$(( PASS_COUNT + 1 ))
}

fail() {
  echo "  FAIL: $1 -- $2"
  FAIL_COUNT=$(( FAIL_COUNT + 1 ))
}

STREAM=""

# Writes stdin to a fresh stream file and points $STREAM at it.
new_stream() {
  STREAM=$(mktemp)
  cat > "$STREAM"
}

assert_found() {
  local name="$1"
  if stream_has_completion_promise "$STREAM" "COMPLETE"; then
    pass "$name"
  else
    fail "$name" "expected the promise to be found"
  fi
  rm -f "$STREAM"
}

assert_not_found() {
  local name="$1"
  if stream_has_completion_promise "$STREAM" "COMPLETE"; then
    fail "$name" "expected no promise"
  else
    pass "$name"
  fi
  rm -f "$STREAM"
}

unset AGENTFLOW_COMMAND PRD_FILE || true

# shellcheck source=/dev/null
source "$RUN_LOOP"

echo "stream_has_completion_promise"

# --- The reported defect: only the quoted instruction mentions the token -----
new_stream <<'EOF'
{"type":"system","subtype":"init","session_id":"s-1"}
{"type":"user","message":{"role":"user","content":[{"type":"tool_result","tool_use_id":"toolu_1","content":"Your AWAITING_USER_SEQUENCE completion promise token is `<promise>COMPLETE</promise>`."}]},"parent_tool_use_id":null}
{"type":"assistant","message":{"content":[{"type":"text","text":"Plan-draft-writer is running in the background. Waiting for it to complete."}]},"parent_tool_use_id":null}
{"type":"result","subtype":"success","is_error":false,"result":"Plan-draft-writer is running in the background. Waiting for it to complete."}
EOF
assert_not_found "a tool result quoting the token is not a completion"

new_stream <<'EOF'
{"type":"user","message":{"role":"user","content":[{"type":"text","text":"Write state.json with status COMPLETED and output `<promise>COMPLETE</promise>`."}]},"parent_tool_use_id":null}
{"type":"result","subtype":"success","is_error":false,"result":"Writing state.json first."}
EOF
assert_not_found "a hook message quoting the token is not a completion"

# --- The agents' own text still completes the iteration ---------------------
new_stream <<'EOF'
{"type":"user","message":{"role":"user","content":[{"type":"tool_result","tool_use_id":"toolu_1","content":"token is `<promise>COMPLETE</promise>`"}]},"parent_tool_use_id":null}
{"type":"assistant","message":{"content":[{"type":"text","text":"<promise>COMPLETE</promise>"}]},"parent_tool_use_id":null}
{"type":"result","subtype":"success","is_error":false,"result":"<promise>COMPLETE</promise>"}
EOF
assert_found "the orchestrator's promise completes the iteration"

new_stream <<'EOF'
{"type":"assistant","message":{"content":[{"type":"text","text":"All tasks done.\n<promise>COMPLETE</promise>"}]},"parent_tool_use_id":null}
{"type":"assistant","message":{"content":[{"type":"tool_use","id":"toolu_2","name":"Bash","input":{"command":"git status"}}]},"parent_tool_use_id":null}
{"type":"result","subtype":"success","is_error":false,"result":"Wrapped up."}
EOF
assert_found "a promise in an intermediate message still counts"

new_stream <<'EOF'
{"type":"assistant","message":{"content":[{"type":"text","text":"<promise>COMPLETE</promise>"}]},"parent_tool_use_id":"toolu_9"}
EOF
assert_found "a subagent's promise still counts"

new_stream <<'EOF'
{"type":"result","subtype":"success","is_error":false,"result":"Done.\n<promise>COMPLETE</promise>"}
EOF
assert_found "a promise in the result record still counts"

# --- Robustness ---------------------------------------------------------------
new_stream <<'EOF'
not json at all
{"type":"assistant","message":{"content":[{"type":"text","text":"<promise>COMPLETE</promise>"}]},"parent_tool_use_id":null}
EOF
assert_found "lines that are not JSON are skipped"

new_stream <<'EOF'
{"type":"assistant","message":{"content":[{"type":"text","text":"<promise>DONE</promise>"}]},"parent_tool_use_id":null}
EOF
assert_not_found "another promise word does not match"

new_stream < /dev/null
assert_not_found "an empty stream has no promise"

echo
echo "passed: $PASS_COUNT  failed: $FAIL_COUNT"
[[ "$FAIL_COUNT" -eq 0 ]]
