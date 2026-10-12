-- AlterTable
ALTER TABLE "workflow_run_loops" ADD COLUMN     "step_id" VARCHAR(64);

-- AlterTable
ALTER TABLE "workflow_runs" ADD COLUMN     "process" JSONB,
ADD COLUMN     "step_id" VARCHAR(64),
ADD COLUMN     "step_state" JSONB;

-- CreateTable
CREATE TABLE "project_process_versions" (
    "id" UUID NOT NULL,
    "organization_id" UUID NOT NULL,
    "project_id" UUID NOT NULL,
    "version" INTEGER NOT NULL,
    "definition" JSONB NOT NULL,
    "created_by_id" UUID,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "project_process_versions_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "project_process_versions_project_id_version_key" ON "project_process_versions"("project_id", "version");

-- AddForeignKey
ALTER TABLE "project_process_versions" ADD CONSTRAINT "project_process_versions_organization_id_fkey" FOREIGN KEY ("organization_id") REFERENCES "organizations"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "project_process_versions" ADD CONSTRAINT "project_process_versions_project_id_fkey" FOREIGN KEY ("project_id") REFERENCES "projects"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "project_process_versions" ADD CONSTRAINT "project_process_versions_created_by_id_fkey" FOREIGN KEY ("created_by_id") REFERENCES "users"("id") ON DELETE SET NULL ON UPDATE CASCADE;
