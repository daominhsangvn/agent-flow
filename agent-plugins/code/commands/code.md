---
description: "Begin coding session"
argument-hint: [working-directory] [--prompt <name>] [--prd <requirements-file>] [--plan <plan-file>]
allowed-tools: Bash, Edit, Write, Task, TodoWrite, SendMessage
---

# Bootstrap AgentFlow

!`bash "${CLAUDE_PLUGIN_ROOT}/scripts/setup-agentflow.sh" $ARGUMENTS`

Follow the orchestrator instructions in the prompt file specified by `AGENTFLOW_PROMPT_FILE` in the config output above. You are running inside a AgentFlow loop which provides fresh context on each iteration. Your previous work is visible in files and git history.

IMPORTANT: You are an ORCHESTRATOR. After reading the prompt file, your FIRST action must be TodoWrite. Do NOT read project files (PRD, plan.json, code, etc.). Delegate all project file reading to subagents.

CRITICAL RULE: If a completion promise is set (check the iteration message), you may ONLY output it when the statement is completely and unequivocally TRUE. Do not output false promises to escape the loop.
