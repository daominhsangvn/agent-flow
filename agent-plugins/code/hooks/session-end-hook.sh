#!/usr/bin/env bash
# AgentFlow Self-Learning System - Session End Hook
# Cleans up session-level artifacts when Claude Code session ends

set -e

# Single source of truth for the state directory name
AGENTFLOW_STATE_DIR=".agentflow-ai"

# Debug logging (redirected once CWD is known)
DEBUG_LOG="/dev/null"

# Read hook input from stdin (JSON)
INPUT=$(cat)

# Parse hook input
SESSION_ID=$(echo "$INPUT" | jq -r '.session_id // empty')
CWD=$(echo "$INPUT" | jq -r '.cwd // empty')
REASON=$(echo "$INPUT" | jq -r '.reason // empty')

# Redirect debug logs into project dir (not shared /tmp)
if [[ -n "$CWD" ]]; then
    mkdir -p "$CWD/$AGENTFLOW_STATE_DIR"
    DEBUG_LOG="$CWD/$AGENTFLOW_STATE_DIR/session-end-hook-debug.log"
fi
echo "$(date): Session end hook started, session=$SESSION_ID, reason=$REASON" >> "$DEBUG_LOG"

# ============================================================================
# CLEANUP: Session Mappings
# Remove session-specific files from .agentflow-ai/
# ============================================================================

AGENTFLOW_DIR="$CWD/$AGENTFLOW_STATE_DIR"

# Discover AGENTFLOW_WORKDIR before cleaning up mappings
AGENTFLOW_WORKDIR=""
if [[ -n "$SESSION_ID" ]] && [[ -f "$AGENTFLOW_DIR/session-$SESSION_ID.workdir" ]]; then
    AGENTFLOW_WORKDIR=$(cat "$AGENTFLOW_DIR/session-$SESSION_ID.workdir")
fi

if [[ -d "$AGENTFLOW_DIR" ]]; then
    # Clean up session workdir mapping
    SESSION_WORKDIR_FILE="$AGENTFLOW_DIR/session-$SESSION_ID.workdir"
    if [[ -f "$SESSION_WORKDIR_FILE" ]]; then
        echo "$(date): Removing session workdir mapping: $SESSION_WORKDIR_FILE" >> "$DEBUG_LOG"
        rm -f "$SESSION_WORKDIR_FILE"
    fi

    # Clean up stale PID->session mappings (processes that no longer exist)
    for pid_file in "$AGENTFLOW_DIR"/pid-*.session; do
        if [[ -f "$pid_file" ]]; then
            # Extract PID from filename
            PID=$(basename "$pid_file" | sed 's/pid-\(.*\)\.session/\1/')
            # Check if process still exists
            if ! ps -p "$PID" &>/dev/null; then
                echo "$(date): Removing stale PID mapping (PID $PID no longer exists): $pid_file" >> "$DEBUG_LOG"
                rm -f "$pid_file"
            fi
        fi
    done

    # Clean up stale session workdir mappings (older than 24 hours)
    find "$AGENTFLOW_DIR" -name "session-*.workdir" -mmin +1440 -delete 2>/dev/null || true

    # Remove directory if empty
    rmdir "$AGENTFLOW_DIR" 2>/dev/null || true
fi

# ============================================================================
# CLEANUP: Agent Type Tracking
# Remove any orphaned .agent-types files in AGENTFLOW_WORKDIR (if known)
# ============================================================================

if [[ -n "$AGENTFLOW_WORKDIR" ]] && [[ -d "$AGENTFLOW_WORKDIR/.agent-types" ]]; then
    echo "$(date): Cleaning up agent-types directory: $AGENTFLOW_WORKDIR/.agent-types" >> "$DEBUG_LOG"

    # Remove all agent type files and retry tracking files
    rm -f "$AGENTFLOW_WORKDIR/.agent-types"/* 2>/dev/null || true

    # Remove directory if empty
    rmdir "$AGENTFLOW_WORKDIR/.agent-types" 2>/dev/null || true
fi

# ============================================================================
# CLEANUP: Project Root Orphans
# Clean up any orphaned .agent-types in project root (from old code versions)
# ============================================================================

PROJECT_ROOT_AGENT_TYPES="$CWD/.agent-types"
if [[ -d "$PROJECT_ROOT_AGENT_TYPES" ]]; then
    echo "$(date): Cleaning up orphaned .agent-types in project root: $PROJECT_ROOT_AGENT_TYPES" >> "$DEBUG_LOG"

    # Remove all files in the directory
    rm -f "$PROJECT_ROOT_AGENT_TYPES"/* 2>/dev/null || true

    # Remove directory if empty
    rmdir "$PROJECT_ROOT_AGENT_TYPES" 2>/dev/null || true
fi

echo "$(date): Session cleanup complete" >> "$DEBUG_LOG"

# SessionEnd hooks cannot block, so just exit success
exit 0
