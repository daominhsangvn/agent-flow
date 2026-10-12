#!/bin/bash
# Reads AgentFlow config and outputs environment variables
# Usage: get-env.sh <AGENTFLOW_WORKDIR>

# Single source of truth for the state directory name
AGENTFLOW_STATE_DIR=".agentflow-ai"

WORKDIR="${1:-.}"
CONFIG_FILE="$WORKDIR/$AGENTFLOW_STATE_DIR/config.env"

if [[ ! -f "$CONFIG_FILE" ]]; then
    echo "Error: Config file not found at $CONFIG_FILE" >&2
    exit 1
fi

# Source the config and output as structured data
source "$CONFIG_FILE"

cat << EOF
AGENTFLOW_WORKDIR=$AGENTFLOW_WORKDIR
CLAUDE_PLUGIN_ROOT=$CLAUDE_PLUGIN_ROOT
AGENTFLOW_PRD_FILE=$AGENTFLOW_PRD_FILE
AGENTFLOW_PLAN_FILE=$AGENTFLOW_PLAN_FILE
AGENTFLOW_MAX_ITERATIONS=$AGENTFLOW_MAX_ITERATIONS
PLAN_SCHEMA_PATH=$CLAUDE_PLUGIN_ROOT/schemas/plan-schema.json
PLAN_FILE_PATH=$AGENTFLOW_WORKDIR/plan.json
EOF
