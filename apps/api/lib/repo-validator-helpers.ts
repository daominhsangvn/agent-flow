import {
  REPOSITORY_FULL_NAME_ERROR,
  REPOSITORY_FULL_NAME_REGEX,
} from "@agentflow-ai/loops-api/context-pack";
import { BRANCH_NAME_REGEX } from "@agentflow-ai/loops-api/execution-result";
import { BRANCH_NAME_MAX_LENGTH } from "@repo/api/src/types/artifact";
import { z } from "zod";

/**
 * Shared Zod building blocks for validators that accept repository selections
 * (Loop dispatch, document creation, etc.). Centralizing avoids drift between
 * the various repo-input surfaces — e.g. document creation's
 * `repositorySelection` and Loop dispatch's `repo` / `additionalRepos` must
 * apply the same constraints so values are interoperable round-trip.
 */

export const REPO_FULL_NAME_MAX_LENGTH = 256;
/** `owner/repo` (GitHub) or `organization/project/repo` (Azure DevOps). */
export const REPO_FULL_NAME_REGEX = REPOSITORY_FULL_NAME_REGEX;
export const REPO_FULL_NAME_ERROR = REPOSITORY_FULL_NAME_ERROR;
export const BRANCH_NAME_ERROR = "Branch name contains invalid characters";

export const repoFullNameSchema = z
  .string()
  .max(REPO_FULL_NAME_MAX_LENGTH)
  .regex(REPO_FULL_NAME_REGEX, REPO_FULL_NAME_ERROR);

export const repoBranchSchema = z
  .string()
  .max(BRANCH_NAME_MAX_LENGTH)
  .regex(BRANCH_NAME_REGEX, BRANCH_NAME_ERROR);
