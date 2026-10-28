#!/bin/bash
# What AgentFlow recorded for a workshop project: deliveries, runs, documents
# (PRD, plan), loops, sessions, agents and post actions. Read-only.
#
# Usage: docs/workshop/monitor.sh [project name]   (default: Calculator)
# Runs psql in the docker compose `postgres` service of this repository.

set -euo pipefail

cd "$(dirname "$0")/../.."
project=${1:-Calculator}
project_sql=${project//\'/\'\'}

q() {
  docker compose exec -T postgres psql -U "${POSTGRES_USER:-postgres}" \
    -d "${POSTGRES_DB:-agentflow_ai}" -P pager=off -c "$1"
}

echo "## Deliveries (HTTP trigger requests)"
q "select d.delivery_id, d.outcome, d.detail, d.run_count,
       to_char(d.received_at, 'MM-DD HH24:MI:SS') as received
  from integration_deliveries d
  join integration_connections c on c.id = d.connection_id
  join workflows w on w.id = c.managed_by_workflow_id
  join projects p on p.id = w.project_id
 where p.name = '$project_sql'
 order by d.received_at"

echo "## Runs"
q "select r.source_key as key, r.status, r.cycle, r.error->>'code' as error,
       prd.slug as prd, plan.slug as plan, r.branch_name, r.pr_url,
       to_char(r.created_at, 'MM-DD HH24:MI') as created,
       to_char(r.completed_at - r.created_at, 'HH24:MI:SS') as took
  from workflow_runs r
  join workflows w on w.id = r.workflow_id
  join projects p on p.id = w.project_id
  left join artifacts prd on prd.id = r.feature_document_id
  left join artifacts plan on plan.id = r.plan_document_id
 where p.name = '$project_sql'
 order by r.created_at"

echo "## Documents (PRD, implementation plan) and their links"
q "select a.slug, a.subtype, a.status, dd.latest_version as version, a.name
  from artifacts a
  join projects p on p.id = a.project_id
  left join document_detail dd on dd.artifact_id = a.id
 where p.name = '$project_sql' and a.type = 'DOCUMENT'
 order by a.created_at"
q "select s.slug as source, l.link_type, t.slug as target
  from artifact_links l
  join artifacts s on s.id = l.source_id
  join artifacts t on t.id = l.target_id
  join projects p on p.id = s.project_id
 where p.name = '$project_sql' and s.type = 'DOCUMENT' and t.type = 'DOCUMENT'
 order by l.created_at"

echo "## Loops (PLAN, EXECUTE)"
q "select a.slug as doc, l.command, l.status, l.branch_name,
       to_char(l.completed_at - l.started_at, 'HH24:MI:SS') as took,
       l.tokens_input + l.tokens_output as tokens,
       round(l.estimated_cost::numeric, 2) as cost_usd,
       left(coalesce(l.error->>'message', l.error::text, ''), 80) as error
  from loops l
  join artifacts a on a.id = l.artifact_id
  join projects p on p.id = a.project_id
 where p.name = '$project_sql'
 order by l.created_at"

echo "## Sessions (Sessions page)"
q "select loop_doc.slug as doc, l.command, session.status, s.model, s.agent_count as agents,
       s.tool_use_count as tools, s.input_tokens + s.output_tokens as tokens,
       round(s.estimated_cost::numeric, 2) as cost_usd, s.repository_full_name as repo
  from session_detail s
  join artifacts session on session.id = s.artifact_id
  join loops l on l.id::text = s.source_loop_id
  join artifacts loop_doc on loop_doc.id = l.artifact_id
  join projects p on p.id = loop_doc.project_id
 where p.name = '$project_sql'
 order by s.session_started_at"

echo "## Agents used in those sessions (Agents page)"
q "select u.component_kind as kind, u.component_key as agent,
       sum(u.invocation_count) as invocations, sum(u.error_count) as errors
  from agent_component_session_usage u
  join session_detail s on s.artifact_id = u.agent_session_id
  join loops l on l.id::text = s.source_loop_id
  join artifacts a on a.id = l.artifact_id
  join projects p on p.id = a.project_id
 where p.name = '$project_sql'
 group by 1, 2
 order by 3 desc, 2"

echo "## Post actions (pull requests)"
q "select r.source_key as key, a.type, ar.event, ar.status, ar.attempts,
       left(coalesce(ar.last_error, ''), 80) as error
  from workflow_action_runs ar
  join workflow_actions a on a.id = ar.action_id
  join workflow_runs r on r.id = ar.run_id
  join workflows w on w.id = r.workflow_id
  join projects p on p.id = w.project_id
 where p.name = '$project_sql'
 order by ar.created_at"
