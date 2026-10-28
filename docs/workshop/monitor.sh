#!/bin/bash
# What AgentFlow recorded for the workshop project: Jira deliveries, runs (PRD
# or Issue and why), action runs (each event and what its action did), the
# integration tool calls of the agents, loops, documents, sessions and agents.
# Read-only.
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

echo "## Jira deliveries (webhook requests of the project's Jira connections)"
q "select d.event_type, d.outcome, left(coalesce(d.detail, ''), 60) as detail,
       d.run_count, to_char(d.received_at, 'MM-DD HH24:MI:SS') as received
  from integration_deliveries d
 where d.connection_id in (
         select pc.connection_id from project_connections pc
           join projects p on p.id = pc.project_id
          where p.name = '$project_sql')
 order by d.received_at desc
 limit 15"

echo "## Runs"
q "select r.source_key as key, r.status, r.cycle, r.step_id as step,
       r.source_classification->>'type' as imported_as,
       left(coalesce(r.source_classification->>'reason', ''), 50) as why,
       r.error->>'code' as error, src.slug as source_doc, plan.slug as plan,
       r.pr_url, to_char(r.created_at, 'MM-DD HH24:MI') as created,
       to_char(coalesce(r.completed_at, now()) - r.created_at, 'HH24:MI:SS') as took
  from workflow_runs r
  join projects p on p.id = r.project_id
  left join artifacts src on src.id = r.feature_document_id
  left join artifacts plan on plan.id = r.plan_document_id
 where p.name = '$project_sql'
 order by r.created_at"

echo "## Action runs (one row per action and run event)"
q "select r.source_key as key, ar.cycle, ar.event,
       case when ar.action_type = 'agentflow.instruction'
            then 'instruction: ' || left(a.config->>'instruction', 32)
            else ar.action_type end as action,
       ar.status, ar.attempts,
       left(coalesce(ar.last_error, ar.detail->>'note', ''), 70) as error_or_note,
       to_char(ar.created_at, 'HH24:MI:SS') as at
  from workflow_action_runs ar
  join workflow_runs r on r.id = ar.run_id
  join projects p on p.id = r.project_id
  left join workflow_actions a on a.id = ar.action_id
 where p.name = '$project_sql'
 order by ar.created_at, a.position"

echo "## Integration tool calls (what the agents read and wrote)"
q "select r.source_key as key, c.tool, c.operation_type as operation,
       c.connection_key as conn, c.status,
       left(coalesce(c.error, c.external_ref, ''), 50) as error_or_ref,
       to_char(c.created_at, 'HH24:MI:SS') as at
  from integration_tool_calls c
  join workflow_runs r on r.id = c.run_id
  join projects p on p.id = r.project_id
 where p.name = '$project_sql'
 order by c.created_at"

echo "## Loops (PLAN, EXECUTE, STEP)"
q "select r.source_key as key, rl.command, rl.step_id as step, l.status,
       to_char(l.completed_at - l.started_at, 'HH24:MI:SS') as took,
       l.tokens_input + l.tokens_output as tokens,
       round(l.estimated_cost::numeric, 2) as cost_usd, l.branch_name,
       left(coalesce(l.error->>'message', l.error::text, ''), 60) as error
  from workflow_run_loops rl
  join workflow_runs r on r.id = rl.run_id
  join loops l on l.id = rl.loop_id
  join projects p on p.id = r.project_id
 where p.name = '$project_sql'
 order by l.created_at"

echo "## Documents (PRD or Issue, plan, published documents) and their links"
q "select a.slug, a.subtype, a.status, dd.latest_version as version, left(a.name, 60) as name
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

echo "## Sessions (Sessions page): one per loop"
q "select doc.slug as doc, l.command, session.status, s.model, s.agent_count as agents,
       s.tool_use_count as tools, s.input_tokens + s.output_tokens as tokens,
       round(s.estimated_cost::numeric, 2) as cost_usd, s.repository_full_name as repo
  from session_detail s
  join artifacts session on session.id = s.artifact_id
  join loops l on l.id::text = s.source_loop_id
  join artifacts doc on doc.id = l.artifact_id
  join projects p on p.id = doc.project_id
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
