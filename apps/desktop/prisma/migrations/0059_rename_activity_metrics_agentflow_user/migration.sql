-- AgentFlow rebrand: the product's user flag on session activity metrics
-- (`0027_session_activity_metrics`) follows the product name. SQLite (3.25+)
-- renames the column in place; the data and the DEFAULT stay as they were.
ALTER TABLE "session_activity_metrics" RENAME COLUMN "closedloop_user" TO "agentflow_user";
