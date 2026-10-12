-- CreateTable
CREATE TABLE "integration_connections" (
    "id" UUID NOT NULL,
    "organization_id" UUID NOT NULL,
    "provider" VARCHAR(32) NOT NULL,
    "name" VARCHAR(120) NOT NULL,
    "status" VARCHAR(16) NOT NULL DEFAULT 'active',
    "config" JSONB NOT NULL DEFAULT '{}',
    "credentials_encrypted" TEXT,
    "credential_hints" JSONB NOT NULL DEFAULT '{}',
    "account" JSONB,
    "inbound_key" VARCHAR(64) NOT NULL,
    "inbound_secret_encrypted" TEXT,
    "delivery_mode" VARCHAR(16) NOT NULL DEFAULT 'none',
    "poll_interval_seconds" INTEGER NOT NULL DEFAULT 120,
    "poll_cursor" JSONB,
    "next_poll_at" TIMESTAMP(3),
    "last_polled_at" TIMESTAMP(3),
    "last_delivery_at" TIMESTAMP(3),
    "last_validated_at" TIMESTAMP(3),
    "last_error" TEXT,
    "created_by_id" UUID,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "integration_connections_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "integration_deliveries" (
    "id" UUID NOT NULL,
    "organization_id" UUID NOT NULL,
    "connection_id" UUID NOT NULL,
    "delivery_id" VARCHAR(255) NOT NULL,
    "source" VARCHAR(16) NOT NULL,
    "event_type" VARCHAR(128),
    "outcome" VARCHAR(16) NOT NULL,
    "detail" TEXT,
    "run_count" INTEGER NOT NULL DEFAULT 0,
    "payload" JSONB,
    "received_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "integration_deliveries_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "workflows" (
    "id" UUID NOT NULL,
    "organization_id" UUID NOT NULL,
    "name" VARCHAR(120) NOT NULL,
    "description" TEXT NOT NULL DEFAULT '',
    "enabled" BOOLEAN NOT NULL DEFAULT true,
    "project_id" UUID,
    "run_as_user_id" UUID,
    "agent_config" JSONB NOT NULL DEFAULT '{}',
    "created_by_id" UUID,
    "last_run_at" TIMESTAMP(3),
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "workflows_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "workflow_triggers" (
    "id" UUID NOT NULL,
    "organization_id" UUID NOT NULL,
    "workflow_id" UUID NOT NULL,
    "connection_id" UUID NOT NULL,
    "type" VARCHAR(64) NOT NULL,
    "config" JSONB NOT NULL DEFAULT '{}',
    "enabled" BOOLEAN NOT NULL DEFAULT true,
    "position" INTEGER NOT NULL DEFAULT 0,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "workflow_triggers_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "workflow_actions" (
    "id" UUID NOT NULL,
    "organization_id" UUID NOT NULL,
    "workflow_id" UUID NOT NULL,
    "connection_id" UUID NOT NULL,
    "type" VARCHAR(64) NOT NULL,
    "config" JSONB NOT NULL DEFAULT '{}',
    "stage" VARCHAR(8) NOT NULL DEFAULT 'post',
    "continue_on_error" BOOLEAN NOT NULL DEFAULT false,
    "events" TEXT[] DEFAULT ARRAY[]::TEXT[],
    "enabled" BOOLEAN NOT NULL DEFAULT true,
    "position" INTEGER NOT NULL DEFAULT 0,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "workflow_actions_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "workflow_runs" (
    "id" UUID NOT NULL,
    "organization_id" UUID NOT NULL,
    "workflow_id" UUID NOT NULL,
    "trigger_id" UUID,
    "connection_id" UUID,
    "delivery_id" UUID,
    "run_as_user_id" UUID,
    "dedup_key" VARCHAR(255) NOT NULL,
    "occurrence_keys" TEXT[] DEFAULT ARRAY[]::TEXT[],
    "source_key" VARCHAR(255) NOT NULL,
    "status" VARCHAR(16) NOT NULL DEFAULT 'received',
    "source" JSONB NOT NULL,
    "agent_config" JSONB NOT NULL DEFAULT '{}',
    "feature_document_id" UUID,
    "plan_document_id" UUID,
    "pr_url" TEXT,
    "branch_name" TEXT,
    "error" JSONB,
    "cycle" INTEGER NOT NULL DEFAULT 1,
    "step_attempts" INTEGER NOT NULL DEFAULT 0,
    "next_step_at" TIMESTAMP(3),
    "lease_until" TIMESTAMP(3),
    "phase_started_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "completed_at" TIMESTAMP(3),
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "workflow_runs_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "workflow_run_loops" (
    "id" UUID NOT NULL,
    "organization_id" UUID NOT NULL,
    "run_id" UUID NOT NULL,
    "loop_id" UUID NOT NULL,
    "command" VARCHAR(32) NOT NULL,
    "adopted" BOOLEAN NOT NULL DEFAULT false,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "workflow_run_loops_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "workflow_action_runs" (
    "id" UUID NOT NULL,
    "organization_id" UUID NOT NULL,
    "run_id" UUID NOT NULL,
    "action_id" UUID,
    "action_type" VARCHAR(64) NOT NULL,
    "stage" VARCHAR(8) NOT NULL DEFAULT 'post',
    "event" VARCHAR(32) NOT NULL,
    "cycle" INTEGER NOT NULL DEFAULT 1,
    "status" VARCHAR(16) NOT NULL DEFAULT 'pending',
    "attempts" INTEGER NOT NULL DEFAULT 0,
    "next_attempt_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "last_error" TEXT,
    "external_ref" TEXT,
    "completed_at" TIMESTAMP(3),
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "workflow_action_runs_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "integration_connections_inbound_key_key" ON "integration_connections"("inbound_key");

-- CreateIndex
CREATE INDEX "integration_connections_organization_id_provider_idx" ON "integration_connections"("organization_id", "provider");

-- CreateIndex
CREATE INDEX "integration_connections_delivery_mode_next_poll_at_idx" ON "integration_connections"("delivery_mode", "next_poll_at");

-- CreateIndex
CREATE INDEX "integration_deliveries_organization_id_received_at_idx" ON "integration_deliveries"("organization_id", "received_at");

-- CreateIndex
CREATE UNIQUE INDEX "integration_deliveries_connection_id_delivery_id_key" ON "integration_deliveries"("connection_id", "delivery_id");

-- CreateIndex
CREATE INDEX "workflows_organization_id_idx" ON "workflows"("organization_id");

-- CreateIndex
CREATE INDEX "workflow_triggers_workflow_id_idx" ON "workflow_triggers"("workflow_id");

-- CreateIndex
CREATE INDEX "workflow_triggers_connection_id_type_idx" ON "workflow_triggers"("connection_id", "type");

-- CreateIndex
CREATE INDEX "workflow_actions_workflow_id_idx" ON "workflow_actions"("workflow_id");

-- CreateIndex
CREATE INDEX "workflow_actions_connection_id_idx" ON "workflow_actions"("connection_id");

-- CreateIndex
CREATE INDEX "workflow_runs_organization_id_created_at_idx" ON "workflow_runs"("organization_id", "created_at");

-- CreateIndex
CREATE INDEX "workflow_runs_workflow_id_source_key_idx" ON "workflow_runs"("workflow_id", "source_key");

-- CreateIndex
CREATE INDEX "workflow_runs_status_updated_at_idx" ON "workflow_runs"("status", "updated_at");

-- CreateIndex
CREATE INDEX "workflow_runs_plan_document_id_idx" ON "workflow_runs"("plan_document_id");

-- CreateIndex
CREATE UNIQUE INDEX "workflow_runs_workflow_id_dedup_key_key" ON "workflow_runs"("workflow_id", "dedup_key");

-- CreateIndex
CREATE UNIQUE INDEX "workflow_run_loops_loop_id_key" ON "workflow_run_loops"("loop_id");

-- CreateIndex
CREATE INDEX "workflow_run_loops_run_id_idx" ON "workflow_run_loops"("run_id");

-- CreateIndex
CREATE INDEX "workflow_action_runs_status_next_attempt_at_idx" ON "workflow_action_runs"("status", "next_attempt_at");

-- CreateIndex
CREATE UNIQUE INDEX "workflow_action_runs_run_id_action_id_event_cycle_key" ON "workflow_action_runs"("run_id", "action_id", "event", "cycle");

-- AddForeignKey
ALTER TABLE "integration_connections" ADD CONSTRAINT "integration_connections_organization_id_fkey" FOREIGN KEY ("organization_id") REFERENCES "organizations"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "integration_connections" ADD CONSTRAINT "integration_connections_created_by_id_fkey" FOREIGN KEY ("created_by_id") REFERENCES "users"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "integration_deliveries" ADD CONSTRAINT "integration_deliveries_organization_id_fkey" FOREIGN KEY ("organization_id") REFERENCES "organizations"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "integration_deliveries" ADD CONSTRAINT "integration_deliveries_connection_id_fkey" FOREIGN KEY ("connection_id") REFERENCES "integration_connections"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "workflows" ADD CONSTRAINT "workflows_organization_id_fkey" FOREIGN KEY ("organization_id") REFERENCES "organizations"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "workflows" ADD CONSTRAINT "workflows_project_id_fkey" FOREIGN KEY ("project_id") REFERENCES "projects"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "workflows" ADD CONSTRAINT "workflows_run_as_user_id_fkey" FOREIGN KEY ("run_as_user_id") REFERENCES "users"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "workflows" ADD CONSTRAINT "workflows_created_by_id_fkey" FOREIGN KEY ("created_by_id") REFERENCES "users"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "workflow_triggers" ADD CONSTRAINT "workflow_triggers_workflow_id_fkey" FOREIGN KEY ("workflow_id") REFERENCES "workflows"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "workflow_triggers" ADD CONSTRAINT "workflow_triggers_connection_id_fkey" FOREIGN KEY ("connection_id") REFERENCES "integration_connections"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "workflow_actions" ADD CONSTRAINT "workflow_actions_workflow_id_fkey" FOREIGN KEY ("workflow_id") REFERENCES "workflows"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "workflow_actions" ADD CONSTRAINT "workflow_actions_connection_id_fkey" FOREIGN KEY ("connection_id") REFERENCES "integration_connections"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "workflow_runs" ADD CONSTRAINT "workflow_runs_organization_id_fkey" FOREIGN KEY ("organization_id") REFERENCES "organizations"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "workflow_runs" ADD CONSTRAINT "workflow_runs_workflow_id_fkey" FOREIGN KEY ("workflow_id") REFERENCES "workflows"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "workflow_runs" ADD CONSTRAINT "workflow_runs_trigger_id_fkey" FOREIGN KEY ("trigger_id") REFERENCES "workflow_triggers"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "workflow_runs" ADD CONSTRAINT "workflow_runs_connection_id_fkey" FOREIGN KEY ("connection_id") REFERENCES "integration_connections"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "workflow_runs" ADD CONSTRAINT "workflow_runs_delivery_id_fkey" FOREIGN KEY ("delivery_id") REFERENCES "integration_deliveries"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "workflow_runs" ADD CONSTRAINT "workflow_runs_run_as_user_id_fkey" FOREIGN KEY ("run_as_user_id") REFERENCES "users"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "workflow_runs" ADD CONSTRAINT "workflow_runs_feature_document_id_fkey" FOREIGN KEY ("feature_document_id") REFERENCES "artifacts"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "workflow_runs" ADD CONSTRAINT "workflow_runs_plan_document_id_fkey" FOREIGN KEY ("plan_document_id") REFERENCES "artifacts"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "workflow_run_loops" ADD CONSTRAINT "workflow_run_loops_run_id_fkey" FOREIGN KEY ("run_id") REFERENCES "workflow_runs"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "workflow_run_loops" ADD CONSTRAINT "workflow_run_loops_loop_id_fkey" FOREIGN KEY ("loop_id") REFERENCES "loops"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "workflow_action_runs" ADD CONSTRAINT "workflow_action_runs_run_id_fkey" FOREIGN KEY ("run_id") REFERENCES "workflow_runs"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "workflow_action_runs" ADD CONSTRAINT "workflow_action_runs_action_id_fkey" FOREIGN KEY ("action_id") REFERENCES "workflow_actions"("id") ON DELETE SET NULL ON UPDATE CASCADE;
