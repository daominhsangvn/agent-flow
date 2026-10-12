-- AgentFlow rebrand: the stored ClosedLoop identifiers of process definitions,
-- workflow agent configs and run snapshots become AgentFlow ones, so saved
-- processes and runs in progress keep parsing:
--   * step types "closedloop.plan" / "closedloop.execute" -> "agentflow.*"
--   * the agent work directory ".closedloop-ai/" -> ".agentflow-ai/"
-- Logs, events and user-written text are history and stay as they were.

UPDATE "project_process_versions"
SET "definition" = replace(replace(replace("definition"::text,
      '"closedloop.plan"', '"agentflow.plan"'),
      '"closedloop.execute"', '"agentflow.execute"'),
      '.closedloop-ai/', '.agentflow-ai/')::jsonb
WHERE "definition"::text LIKE '%closedloop%';

UPDATE "workflows"
SET "agent_config" = replace(replace(replace("agent_config"::text,
      '"closedloop.plan"', '"agentflow.plan"'),
      '"closedloop.execute"', '"agentflow.execute"'),
      '.closedloop-ai/', '.agentflow-ai/')::jsonb
WHERE "agent_config"::text LIKE '%closedloop%';

UPDATE "workflow_runs"
SET "agent_config" = replace(replace(replace("agent_config"::text,
      '"closedloop.plan"', '"agentflow.plan"'),
      '"closedloop.execute"', '"agentflow.execute"'),
      '.closedloop-ai/', '.agentflow-ai/')::jsonb
WHERE "agent_config"::text LIKE '%closedloop%';

UPDATE "workflow_runs"
SET "process" = replace(replace(replace("process"::text,
      '"closedloop.plan"', '"agentflow.plan"'),
      '"closedloop.execute"', '"agentflow.execute"'),
      '.closedloop-ai/', '.agentflow-ai/')::jsonb
WHERE "process" IS NOT NULL AND "process"::text LIKE '%closedloop%';
