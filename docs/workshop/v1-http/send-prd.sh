#!/bin/bash
# Sends a PRD file to the Calculator workflow's HTTP trigger.
#
# Usage: send-prd.sh <prd.md> [id]
#   The first line of the file is "# <KEY>: <Title>"; the rest is the PRD body.
#   [id] is the request id (default: <KEY>-<timestamp>). The same id starts at
#   most one run per workflow: sending it again is recorded as a duplicate.
#
# Needs AGENTFLOW_TRIGGER_URL and AGENTFLOW_TRIGGER_SECRET (the workflow's
# "Show URL and secret"), for example:
#   set -a; source ~/.agentflow/calculator-trigger.env; set +a

set -euo pipefail

file=${1:?Usage: send-prd.sh <prd.md> [id]}
: "${AGENTFLOW_TRIGGER_URL:?Set AGENTFLOW_TRIGGER_URL}"
: "${AGENTFLOW_TRIGGER_SECRET:?Set AGENTFLOW_TRIGGER_SECRET}"

heading_re='^# ([A-Za-z0-9_-]+): (.+)$'
heading=$(head -n 1 "$file")
if [[ ! "$heading" =~ $heading_re ]]; then
  echo "The first line of $file must be '# <KEY>: <Title>'" >&2
  exit 1
fi
key=${BASH_REMATCH[1]}
title=${BASH_REMATCH[2]}
id=${2:-$key-$(date +%Y%m%d-%H%M%S)}

tail -n +2 "$file" |
  jq -Rs --arg id "$id" --arg key "$key" --arg title "$title" \
    '{id: $id, key: $key, title: $title, type: "prd",
      labels: ["calculator", "workshop"], description: sub("^\\s+"; "")}' |
  curl -sS -X POST "$AGENTFLOW_TRIGGER_URL" \
    -H 'content-type: application/json' \
    -H "X-AgentFlow-Token: $AGENTFLOW_TRIGGER_SECRET" \
    --data-binary @- -w '\nHTTP %{http_code}\n'
echo "Sent $key ($title) with id $id"
