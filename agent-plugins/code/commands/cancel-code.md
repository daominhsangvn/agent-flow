---
description: "Cancel active AgentFlow Loop"
allowed-tools: ["Bash(test -f .agentflow-ai/agentflow-loop.local.md:*)", "Bash(rm .agentflow-ai/agentflow-loop.local.md)", "Read(.agentflow-ai/agentflow-loop.local.md)"]
hide-from-slash-command-tool: "true"
---

# Cancel AgentFlow Loop

To cancel the AgentFlow loop:

1. Check if `.agentflow-ai/agentflow-loop.local.md` exists using Bash: `test -f .agentflow-ai/agentflow-loop.local.md && echo "EXISTS" || echo "NOT_FOUND"`

2. **If NOT_FOUND**: Say "No active AgentFlow loop found."

3. **If EXISTS**:
   - Read `.agentflow-ai/agentflow-loop.local.md` to get the current iteration number from the `iteration:` field
   - Remove the file using Bash: `rm .agentflow-ai/agentflow-loop.local.md`
   - Report: "Cancelled AgentFlow loop (was at iteration N)" where N is the iteration value
