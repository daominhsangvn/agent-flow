import {
  type ArtifactRepositoryEntry,
  type ArtifactRepositorySnapshot,
  artifactRepositorySnapshotSchema,
  RepositoryRole,
  type RepositorySelectionInput,
  SnapshotSource,
} from "@repo/api/src/types/document";
import { log } from "@repo/observability/log";
import { listProjectRepositoryCheckouts } from "@/app/projects/project-repository-checkouts";

/**
 * Helpers for populating the per-document `repository_snapshot` JSON column
 * introduced in PLN-602. The snapshot is server-owned, immutable post-create,
 * and produced from one of: project defaults, an explicit Loop selection, or
 * an inherited parent-artifact snapshot.
 */

function emptySnapshot(): ArtifactRepositorySnapshot {
  return {
    repositories: [],
    source: SnapshotSource.None,
    createdAt: new Date().toISOString(),
  };
}

/**
 * Build a snapshot from a project's repositories (integration connections).
 * Used as the fallback when no explicit snapshot is provided to
 * `createDocumentRecord`.
 *
 * Returns:
 *   - A `project_defaults` snapshot listing the project's repositories, the
 *     primary at position 0 as `role: 'primary'` and the rest as
 *     `role: 'additional'`. Branch/ref are omitted; projects don't pin
 *     branches (PLN-237 Q-002).
 *   - An empty `none` snapshot when the project has no repositories.
 */
export async function buildSnapshotFromProjectDefaults(
  projectId: string,
  organizationId: string
): Promise<ArtifactRepositorySnapshot> {
  // Project repositories (integration connections), primary first.
  const checkouts = await listProjectRepositoryCheckouts(
    organizationId,
    projectId
  );
  if (checkouts.length > 0) {
    return {
      repositories: checkouts.map((checkout, position) => ({
        fullName: checkout.fullName,
        role:
          position === 0 ? RepositoryRole.Primary : RepositoryRole.Additional,
        position,
      })),
      source: SnapshotSource.ProjectDefaults,
      createdAt: new Date().toISOString(),
    };
  }

  return emptySnapshot();
}

/**
 * Build a snapshot from a Loop-style repo selection (primary + additional).
 * Used by both Loop-completion callers and the create-document path, which
 * forward the user's modal-time `repositorySelection`.
 */
export function buildSnapshotFromLoopSelection(
  input: RepositorySelectionInput
): ArtifactRepositorySnapshot {
  const repositories: ArtifactRepositoryEntry[] = [
    {
      fullName: input.primary.fullName,
      role: RepositoryRole.Primary,
      position: 0,
      ...(input.primary.branch ? { branch: input.primary.branch } : {}),
    },
    ...(input.additional ?? []).map<ArtifactRepositoryEntry>((repo, index) => ({
      fullName: repo.fullName,
      role: RepositoryRole.Additional,
      position: index + 1,
      ...(repo.branch ? { branch: repo.branch } : {}),
    })),
  ];

  return {
    repositories,
    source: SnapshotSource.LoopSelection,
    createdAt: new Date().toISOString(),
  };
}

/**
 * Rewrite an existing snapshot's `source` to `parent_artifact`. Used by the
 * derived-artifact inheritance path (T-2.4) so that a Plan inherited from a
 * PRD records the inheritance step in its provenance.
 */
export function inheritSnapshotFromParent(
  parentSnapshot: ArtifactRepositorySnapshot
): ArtifactRepositorySnapshot {
  return {
    repositories: parentSnapshot.repositories,
    source: SnapshotSource.ParentArtifact,
    createdAt: new Date().toISOString(),
  };
}

/**
 * Parse a stored JSON value into an `ArtifactRepositorySnapshot`. Returns null
 * (and logs) when the value does not match the schema — callers decide how to
 * surface the failure. Post-backfill (PLN-602 Migration A) every row matches;
 * a null return indicates corruption.
 */
export function parseStoredSnapshot(
  value: unknown
): ArtifactRepositorySnapshot | null {
  const parsed = artifactRepositorySnapshotSchema.safeParse(value);
  if (!parsed.success) {
    log.warn("Failed to parse stored repository_snapshot", {
      issues: parsed.error.issues,
    });
    return null;
  }
  return parsed.data;
}
