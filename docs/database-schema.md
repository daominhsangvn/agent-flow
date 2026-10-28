# Database Schema Overview

The source of truth is `packages/database/prisma/schema.prisma` (about 130
models); this page maps the main relationships. Almost every table carries
`organizationId`, and every query is scoped by it. For commands and
conventions, see `packages/database/CLAUDE.md`.

## Identity and organization

```
AuthUser / AuthOrganization / AuthMember / AuthSession / AuthInvitation / AuthJwks
        (Better Auth tables, auth_*)
                    │  id copied into clerkId on first use
                    ▼
┌──────────────┐ 1:N ┌──────────────┐ 1:N ┌────────────────┐
│ Organization │────▶│     User     │────▶│ ComputeTarget  │──1:1── ComputeTargetHealthCheck
│ clerkId      │     │ clerkId      │     │ machineName    │
│ slug         │     │ email, role  │     │ isSharedWithOrg│
│ settings     │     └──────────────┘     └────────────────┘
└──────┬───────┘
       │ 1:N
       ▼
     Team ──1:N── TeamMember (User) · TeamRepository · ProjectTeam (Project)
```

`Organization.clerkId` and `User.clerkId` keep their hosted-edition column
names but hold the Better Auth organization and user ids
(`apps/api/lib/auth/identity-service.ts` provisions the rows lazily).
`User.role` is the approver role; organization roles (owner/admin/member)
live in `AuthMember`.

## Projects, artifacts and loops

```
┌──────────────┐ 1:N ┌───────────────────┐
│   Project    │────▶│ ProjectRepository │──N:1── IntegrationConnection (optional)
│ name, slug   │     │ provider, fullName│
│ settings     │     │ isPrimary         │
└──────┬───────┘     └───────────────────┘
       │ 1:N ──▶ ProjectProcessVersion (version, definition)
       │ 1:N ──▶ ProjectConnection ──1:N── ProjectConnectionScope
       │ 1:N
       ▼
┌────────────────────┐ 1:1 ┌──────────────────────────────────────────────┐
│      Artifact      │────▶│ DocumentDetail · BranchDetail · PullRequest-  │
│ type, subtype      │     │ Detail · DeploymentDetail · SessionDetail     │
│ name, status       │     └──────────────────────────────────────────────┘
└──────┬─────────────┘
       │ 1:N ──▶ ArtifactLink (source/target) · CommentThread ──1:N── Comment
       │         FileAttachment · ArtifactEvaluation ──1:N── JudgeScore
       │ 1:N
       ▼
┌──────────────────┐ 1:N ┌───────────┐
│       Loop       │────▶│ LoopEvent │
│ command, status  │     └───────────┘
│ computeTargetId  │──N:1── ComputeTarget
│ parentLoopId     │──self── child loops
└──────────────────┘
```

- `Artifact.type` is `DOCUMENT`, `BRANCH`, `DEPLOYMENT` or `SESSION`. Documents
  have a `subtype` (`PRD`, `IMPLEMENTATION_PLAN`, `TEMPLATE`, `FEATURE`, `DOC`,
  `ISSUE`) and versions in `DocumentVersion`.
- `Loop.command` is the agent command run on a compute target (`PLAN`,
  `EXECUTE`, `STEP`, `GENERATE_PRD`, the `EVALUATE_*` commands, ...).

## Integrations and workflows

```
┌───────────────────────┐ 1:N ┌─────────────────────┐
│ IntegrationConnection │────▶│ IntegrationDelivery │ (inbound webhook / poll deliveries)
│ provider, config      │     └─────────┬───────────┘
│ credentialsEncrypted  │               │ 1:N
└──────────┬────────────┘               ▼
           │ 1:N               ┌──────────────────┐ 1:N ┌─────────────────┐
           ▼                   │   WorkflowRun    │────▶│ WorkflowRunLoop │──1:1── Loop
   ProjectConnection ─────────▶│ status, stepId   │     └─────────────────┘
   (key, settings)        N:1  │ source, process  │ 1:N ┌───────────────────┐
           │                   │ projectConnection│────▶│ WorkflowActionRun │
           │ 1:N               └────────┬─────────┘     └───────────────────┘
           ▼                            │ N:1
   WorkflowTrigger ────N:1────▶ ┌──────────────┐ 1:N ┌────────────────┐
                                │   Workflow   │────▶│ WorkflowAction │
                                │ projectId    │     │ connectionKey  │
                                │ agentConfig  │     │ stage, events  │
                                └──────────────┘     └────────────────┘

WorkflowRun 1:N IntegrationToolSession 1:N IntegrationToolCall
```

See [workflows.md](workflows.md) for how these are used. `WorkflowRun`
also links its feature and plan documents (`featureDocumentId`,
`planDocumentId` → `Artifact`).

## Other groups

| Group | Models |
|-------|--------|
| Agent sessions | `SessionDetail`, `SessionTranscript`, `AgentSessionEvent`, `AgentSessionTokenUsage`, `AgentSessionTokenEvent`, `AgentSessionActivitySegment`, `AgentSessionUsageRollup` |
| Desktop and auth tokens | `DesktopSession`, `DesktopRefreshToken`, `DesktopCommand`, `DesktopCommandEvent`, `DesktopAuthorizationCode`, `DesktopOnboarding*`, `UserPublicKey`, `ApiKey`, `OAuth*` |
| Git providers | `GitHubInstallation`, `GitHubInstallationRepository`, `GitHubUserConnection`, `GitHubAccessCapability`, `GitHubRepoSyncState`, `GitHubPRReview`, `PublicRepository`, `BranchStatusCheck`, `CommitDetail` |
| Agent components and catalog | `Agent`, `AgentVersion`, `AgentComponent*`, `DefinitionVersion*`, `SourceOccurrence`, `CatalogItem*`, `Distribution*` |
| Routines and audit | `Routine`, `RoutineRun`, `AuditEntry`, `AuditOutbox` |
| Metadata | `Tag` (+ `TagProject`, `TagArtifact`, `TagLoop`), `CustomField*`, `FavoriteProject`, `FavoriteArtifact`, `Prompt`, `SearchDocument` |
| Hosted-edition integrations | `LinearIntegration`, `LinearSubtask`, `SlackIntegration`, `GoogleIntegration`, `PreviewSchema*`. Jira, Azure DevOps, Microsoft Teams, Confluence, Bitbucket, Local Git, GitHub and generic webhooks use `IntegrationConnection` instead. |
