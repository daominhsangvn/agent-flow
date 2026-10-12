---
description: Exports pending AgentFlow learnings to global location with deduplication
---

# Export AgentFlow Learnings Command

Merges AgentFlow-specific learnings from the current project into a global learnings store at `~/.agentflow-ai/learnings/agentflow-learnings.json` with automatic deduplication.

## Purpose

When learnings are captured that improve AgentFlow itself (agents, workflows, hooks), they should be automatically exported to a global location where they persist across projects. This command handles deduplication to prevent redundant entries.

## Process

1. **Read pending agentflow learnings**: Load `$AGENTFLOW_WORKDIR/.learnings/pending-agentflow.json`
2. **Read existing global learnings**: Load `~/.agentflow-ai/learnings/agentflow-learnings.json` (create if missing)
3. **Deduplicate**: For each pending learning:
   - If exact `trigger` match exists → skip (already exists)
   - If 80%+ word overlap on `summary` → skip (duplicate)
   - Otherwise → add as new learning with unique ID
4. **Merge and write**: Append non-duplicate learnings with `merged_at` timestamp
5. **Clear pending**: Remove `pending-agentflow.json` after successful merge

## Input Format

`pending-agentflow.json`:
```json
{
  "learnings": [
    {
      "id": "L-001",
      "scope": "agentflow",
      "category": "pattern",
      "trigger": "plan-writer error handling",
      "summary": "Plan-writer should validate task dependencies before writing",
      "detail": "Found that missing dependency validation causes plan failures",
      "source_project": "my-project",
      "captured_at": "ISO8601"
    }
  ]
}
```

## Output Format

Global file at `~/.agentflow-ai/learnings/agentflow-learnings.json`:
```json
{
  "schema_version": "1.0",
  "last_updated": "ISO8601",
  "learnings": [
    {
      "id": "SL-001",
      "trigger": "plan-writer error handling",
      "summary": "Plan-writer should validate task dependencies before writing",
      "detail": "Found that missing dependency validation causes plan failures",
      "category": "pattern",
      "source_project": "my-project",
      "captured_at": "ISO8601",
      "merged_at": "ISO8601"
    }
  ]
}
```

## Deduplication Logic

1. **Exact trigger match**: If a learning with the same `trigger` field already exists, skip the new learning entirely.

2. **Summary word overlap**: Compute word overlap between the new learning's `summary` and all existing summaries:
   - Tokenize both summaries into lowercase words
   - Calculate: `overlap = intersection_count / max(len(words1), len(words2))`
   - If overlap >= 0.8 (80%), skip as duplicate

3. **New learning**: If neither condition is met, assign a new sequential ID (`SL-{N}`) and append.

## Usage

```bash
# Typically invoked automatically by run-loop.sh after each iteration
# Can also be invoked manually:
claude -p "/self-learning:export-agentflow-learnings $WORKDIR"
```

## Instructions

When invoked:
1. Determine the workdir from the first argument or use current directory
2. Check if `$workdir/.learnings/pending-agentflow.json` exists - if not, output "No pending agentflow learnings" and exit
3. Read the pending file
4. Read or create `~/.agentflow-ai/learnings/agentflow-learnings.json` with empty learnings array
5. For each pending learning, apply deduplication logic
6. If any new learnings were added, write the updated global file with `last_updated` timestamp
7. Delete `$workdir/.learnings/pending-agentflow.json`
8. Report: "Exported N new learnings, skipped M duplicates"
