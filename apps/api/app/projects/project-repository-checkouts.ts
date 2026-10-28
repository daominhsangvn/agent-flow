import type { AdditionalRepoRef } from "@repo/api/src/types/loop";
import { readProjectAgentInstructions } from "@repo/api/src/types/project-agent-instructions";
import { type Prisma, type ProjectRepository, withDb } from "@repo/database";

/**
 * The repositories a project's loops work in: its project repositories whose
 * integration connection still exists, with what a computer needs to clone
 * them (the connection keeps the credentials; the computer asks the API for a
 * git credential per loop). Loops on a project with project repositories use
 * these; they replaced the former GitHub App team pool.
 */

/** Branch a loop starts from when the provider reported no default branch. */
const FALLBACK_BRANCH = "main";

export type ProjectRepositoryCheckout = {
  /** ProjectRepository id. */
  id: string;
  connectionId: string;
  provider: string;
  externalId: string;
  fullName: string;
  name: string;
  defaultBranch: string | null;
  webUrl: string;
  cloneUrl: string;
  isPrimary: boolean;
};

/** Primary repository plus the others, as a loop's `repo` / `additionalRepos`. */
export type LoopRepositorySelection = {
  primary: AdditionalRepoRef;
  additional: AdditionalRepoRef[];
};

const CHECKOUT_WHERE = { connectionId: { not: null } } as const;
const CHECKOUT_ORDER = [
  { isPrimary: "desc" },
  { createdAt: "asc" },
] as const satisfies Prisma.ProjectRepositoryOrderByWithRelationInput[];

/** Primary first, then in the order they were added. */
export async function listProjectRepositoryCheckouts(
  organizationId: string,
  projectId: string
): Promise<ProjectRepositoryCheckout[]> {
  const records = await withDb((db) =>
    db.projectRepository.findMany({
      where: { organizationId, projectId, ...CHECKOUT_WHERE },
      orderBy: [...CHECKOUT_ORDER],
    })
  );
  return records.flatMap(toCheckout);
}

/**
 * The project a document belongs to, that project's repositories and agent
 * instructions, in one query; null when the document has no project.
 */
export async function findDocumentRepositoryCheckouts(
  organizationId: string,
  documentId: string | null | undefined
): Promise<{
  projectId: string;
  checkouts: ProjectRepositoryCheckout[];
  /** The project's agent instructions ("" when unset). */
  instructions: string;
} | null> {
  if (!documentId) {
    return null;
  }
  const artifact = await withDb((db) =>
    db.artifact.findFirst({
      where: { id: documentId, organizationId },
      select: {
        projectId: true,
        project: {
          select: {
            settings: true,
            repositories: {
              where: CHECKOUT_WHERE,
              orderBy: [...CHECKOUT_ORDER],
            },
          },
        },
      },
    })
  );
  if (!artifact?.projectId) {
    return null;
  }
  return {
    projectId: artifact.projectId,
    checkouts: (artifact.project?.repositories ?? []).flatMap(toCheckout),
    instructions: readProjectAgentInstructions(artifact.project?.settings),
  };
}

/** The project repositories of the project a document belongs to. */
export async function listDocumentRepositoryCheckouts(
  organizationId: string,
  documentId: string | null | undefined
): Promise<ProjectRepositoryCheckout[]> {
  const found = await findDocumentRepositoryCheckouts(
    organizationId,
    documentId
  );
  return found?.checkouts ?? [];
}

export function findRepositoryCheckout(
  checkouts: readonly ProjectRepositoryCheckout[],
  fullName: string | null | undefined
): ProjectRepositoryCheckout | undefined {
  if (!fullName) {
    return undefined;
  }
  const wanted = fullName.toLowerCase();
  return checkouts.find(
    (checkout) => checkout.fullName.toLowerCase() === wanted
  );
}

/** The branch a loop on this repository starts from. */
export function checkoutBaseBranch(
  checkout: ProjectRepositoryCheckout
): string {
  return checkout.defaultBranch || FALLBACK_BRANCH;
}

/**
 * Selection for a loop: `primaryFullName` when it is one of the project
 * repositories (else the project's primary), and every other repository.
 */
export function toLoopRepositorySelection(
  checkouts: readonly ProjectRepositoryCheckout[],
  primaryFullName?: string | null
): LoopRepositorySelection | null {
  const primary =
    findRepositoryCheckout(checkouts, primaryFullName) ?? checkouts[0];
  if (!primary) {
    return null;
  }
  return {
    primary: {
      fullName: primary.fullName,
      branch: checkoutBaseBranch(primary),
    },
    additional: checkouts
      .filter((checkout) => checkout.id !== primary.id)
      .map((checkout) => ({
        fullName: checkout.fullName,
        branch: checkoutBaseBranch(checkout),
      })),
  };
}

function toCheckout(record: ProjectRepository): ProjectRepositoryCheckout[] {
  return record.connectionId
    ? [
        {
          id: record.id,
          connectionId: record.connectionId,
          provider: record.provider,
          externalId: record.externalId,
          fullName: record.fullName,
          name: record.name,
          defaultBranch: record.defaultBranch,
          webUrl: record.webUrl,
          cloneUrl: record.cloneUrl,
          isPrimary: record.isPrimary,
        },
      ]
    : [];
}
