-- AlterTable
ALTER TABLE "compute_targets" ADD COLUMN     "model_provider" JSONB,
ADD COLUMN     "model_provider_token_encrypted" TEXT;

-- AlterTable
ALTER TABLE "integration_connections" ADD COLUMN     "managed_by_workflow_id" UUID;

-- CreateIndex
CREATE UNIQUE INDEX "integration_connections_managed_by_workflow_id_key" ON "integration_connections"("managed_by_workflow_id");

-- AddForeignKey
ALTER TABLE "integration_connections" ADD CONSTRAINT "integration_connections_managed_by_workflow_id_fkey" FOREIGN KEY ("managed_by_workflow_id") REFERENCES "workflows"("id") ON DELETE CASCADE ON UPDATE CASCADE;

