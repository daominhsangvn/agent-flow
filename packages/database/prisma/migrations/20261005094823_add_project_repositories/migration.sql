-- AlterTable
ALTER TABLE "workflow_runs" ADD COLUMN     "repository" JSONB;

-- CreateTable
CREATE TABLE "project_repositories" (
    "id" UUID NOT NULL,
    "organization_id" UUID NOT NULL,
    "project_id" UUID NOT NULL,
    "connection_id" UUID,
    "provider" VARCHAR(32) NOT NULL,
    "external_id" VARCHAR(255) NOT NULL,
    "full_name" VARCHAR(512) NOT NULL,
    "name" VARCHAR(255) NOT NULL,
    "default_branch" VARCHAR(255),
    "web_url" TEXT NOT NULL,
    "clone_url" TEXT NOT NULL,
    "is_primary" BOOLEAN NOT NULL DEFAULT false,
    "created_by_id" UUID,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "project_repositories_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "project_repositories_organization_id_project_id_idx" ON "project_repositories"("organization_id", "project_id");

-- CreateIndex
CREATE INDEX "project_repositories_connection_id_idx" ON "project_repositories"("connection_id");

-- CreateIndex
CREATE UNIQUE INDEX "project_repositories_project_id_provider_external_id_key" ON "project_repositories"("project_id", "provider", "external_id");

-- AddForeignKey
ALTER TABLE "project_repositories" ADD CONSTRAINT "project_repositories_organization_id_fkey" FOREIGN KEY ("organization_id") REFERENCES "organizations"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "project_repositories" ADD CONSTRAINT "project_repositories_project_id_fkey" FOREIGN KEY ("project_id") REFERENCES "projects"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "project_repositories" ADD CONSTRAINT "project_repositories_connection_id_fkey" FOREIGN KEY ("connection_id") REFERENCES "integration_connections"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "project_repositories" ADD CONSTRAINT "project_repositories_created_by_id_fkey" FOREIGN KEY ("created_by_id") REFERENCES "users"("id") ON DELETE SET NULL ON UPDATE CASCADE;
