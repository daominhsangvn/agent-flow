import type { BranchHeadShaSource } from "@repo/api/src/types/artifact";
import {
  BranchActivityAtomVersion,
  BranchActivityAttributionKind,
  BranchActivityEvidenceCompleteness,
  BranchActivitySource,
} from "@repo/api/src/types/branch-activity";
import { GitHubPRState } from "@repo/api/src/types/github";
import { ArtifactType, withDb } from "@repo/database";
import { keys } from "@repo/database/keys";
import { describe, expect, it } from "vitest";
import {
  BranchActivityPersistStatus,
  persistBranchActivityAtom,
} from "@/app/branches/branch-activity-evidence";
import {
  autoRollbackTransaction,
  createTestOrganization,
} from "../utils/db-helpers";

const hasDatabase = Boolean(keys().DATABASE_URL);
const occurredAt = "2026-08-12T10:00:00.000Z";
const olderAt = "2026-08-11T10:00:00.000Z";

describe.skipIf(!hasDatabase)(
  "ISS-6058 Branch activity evidence (real Postgres)",
  () => {
    it("keeps immutable evidence, ownership, replay, and scalar compatibility atomic", async () => {
      await autoRollbackTransaction(async () => {
        const primary = await seedBranch("primary");
        const isolated = await seedBranch("isolated");
        const relinked = await seedBranchForOrganization(
          primary.organizationId,
          "relinked"
        );
        const primaryPullRequestId = await seedPullRequest(primary, 6058);
        const isolatedPullRequestId = await seedPullRequest(isolated, 6059);
        const input = {
          organizationId: primary.organizationId,
          branchArtifactId: primary.branchArtifactId,
          atom: branchAtom("head-sha-1", occurredAt),
        };

        await expect(persistBranchActivityAtom(input)).resolves.toEqual({
          status: BranchActivityPersistStatus.Inserted,
        });
        await expect(persistBranchActivityAtom(input)).resolves.toEqual({
          status: BranchActivityPersistStatus.Replayed,
        });
        await expect(
          persistBranchActivityAtom({
            ...input,
            atom: branchAtom("head-sha-0", olderAt),
          })
        ).resolves.toEqual({ status: BranchActivityPersistStatus.Inserted });
        await expect(
          persistBranchActivityAtom({
            ...input,
            atom: pullRequestAtom(primaryPullRequestId),
          })
        ).resolves.toEqual({ status: BranchActivityPersistStatus.Inserted });
        await withDb((db) =>
          db.pullRequestDetail.update({
            where: { id: primaryPullRequestId },
            data: { branchArtifactId: relinked.branchArtifactId },
          })
        );

        await expect(
          persistBranchActivityAtom({
            ...input,
            branchArtifactId: isolated.branchArtifactId,
          })
        ).resolves.toEqual({ status: BranchActivityPersistStatus.NotFound });
        await expect(
          persistBranchActivityAtom({
            ...input,
            atom: pullRequestAtom(isolatedPullRequestId),
          })
        ).resolves.toEqual({
          status: BranchActivityPersistStatus.InvalidAttribution,
        });

        const persisted = await withDb((db) =>
          db.branchDetail.findUniqueOrThrow({
            where: { artifactId: primary.branchArtifactId },
            select: {
              lastActivityAt: true,
              activityAtoms: {
                orderBy: [
                  { occurredAt: "desc" },
                  { source: "asc" },
                  { sourceEventId: "asc" },
                ],
                select: {
                  source: true,
                  sourceEventId: true,
                  occurredAt: true,
                  pullRequestDetailId: true,
                },
              },
            },
          })
        );

        expect(persisted.lastActivityAt?.toISOString()).toBe(occurredAt);
        expect(persisted.activityAtoms).toHaveLength(3);
        expect(
          persisted.activityAtoms.filter(
            ({ sourceEventId }) => sourceEventId === "head-sha-1"
          )
        ).toHaveLength(1);
        expect(persisted.activityAtoms).toContainEqual(
          expect.objectContaining({
            source: BranchActivitySource.PullRequestLifecycle,
            pullRequestDetailId: primaryPullRequestId,
          })
        );
        await expect(
          withDb((db) =>
            db.branchActivityAtom.count({
              where: { branchArtifactId: relinked.branchArtifactId },
            })
          )
        ).resolves.toBe(0);
      });
    });
  }
);

function branchAtom(sourceEventId: string, activityAt: string) {
  return {
    version: BranchActivityAtomVersion.V1,
    source: BranchActivitySource.GitHead,
    sourceEventId,
    occurredAt: activityAt,
    attribution: { kind: BranchActivityAttributionKind.Branch },
    completeness: BranchActivityEvidenceCompleteness.Complete,
  } as const;
}

function pullRequestAtom(pullRequestId: string) {
  return {
    version: BranchActivityAtomVersion.V1,
    source: BranchActivitySource.PullRequestLifecycle,
    sourceEventId: `${pullRequestId}:opened`,
    occurredAt,
    attribution: {
      kind: BranchActivityAttributionKind.PullRequest,
      pullRequestId,
    },
    completeness: BranchActivityEvidenceCompleteness.Complete,
  } as const;
}

async function seedBranch(
  label: string,
  evidence: {
    headSha?: string;
    headShaObservedAt?: Date;
    headShaSource?: BranchHeadShaSource;
  } = {}
) {
  const organizationId = await createTestOrganization();
  return seedBranchForOrganization(organizationId, label, evidence);
}

function seedBranchForOrganization(
  organizationId: string,
  label: string,
  evidence: {
    headSha?: string;
    headShaObservedAt?: Date;
    headShaSource?: BranchHeadShaSource;
  } = {}
): Promise<{ organizationId: string; branchArtifactId: string }> {
  return withDb(async (db) => {
    const artifact = await db.artifact.create({
      data: {
        organizationId,
        name: `ISS-6058 ${label}`,
        status: GitHubPRState.Open,
        type: ArtifactType.BRANCH,
        branch: {
          create: {
            organizationId,
            repositoryFullName: `iss-6058/${label}`,
            branchName: "feature/canonical-activity-evidence",
            ...evidence,
          },
        },
      },
      select: { id: true },
    });
    return { organizationId, branchArtifactId: artifact.id };
  });
}

function seedPullRequest(
  owner: { organizationId: string; branchArtifactId: string },
  number: number,
  lifecycle: {
    githubCreatedAt?: Date;
    mergedAt?: Date;
    closedAt?: Date;
  } = {}
): Promise<string> {
  return withDb(async (db) => {
    const pullRequest = await db.pullRequestDetail.create({
      data: {
        organizationId: owner.organizationId,
        branchArtifactId: owner.branchArtifactId,
        repositoryFullName: `iss-6058/pr-${number}`,
        number,
        isCurrent: false,
        ...lifecycle,
      },
      select: { id: true },
    });
    return pullRequest.id;
  });
}
