-- Baseline: the whole schema, squashed from the earlier migrations (pg_dump --schema-only).
CREATE TYPE public."ApiKeySource" AS ENUM (
    'USER_CREATED',
    'DESKTOP_MANAGED'
);

CREATE TYPE public."ApproverRole" AS ENUM (
    'PM',
    'DESIGNER',
    'TECH_LEAD',
    'ENGINEER',
    'STAKEHOLDER'
);

CREATE TYPE public."ArtifactSubtype" AS ENUM (
    'PRD',
    'IMPLEMENTATION_PLAN',
    'TEMPLATE',
    'FEATURE',
    'DOC',
    'ISSUE'
);

CREATE TYPE public."ArtifactType" AS ENUM (
    'DOCUMENT',
    'BRANCH',
    'DEPLOYMENT',
    'SESSION'
);

CREATE TYPE public."ChecksStatus" AS ENUM (
    'UNKNOWN',
    'PENDING',
    'PASSING',
    'FAILING'
);

CREATE TYPE public."CustomFieldEntityType" AS ENUM (
    'PROJECT',
    'DOCUMENT'
);

CREATE TYPE public."CustomFieldType" AS ENUM (
    'TEXT',
    'NUMBER',
    'ENUM',
    'MULTI_ENUM',
    'DATE',
    'PEOPLE'
);

CREATE TYPE public."DocumentStatus" AS ENUM (
    'DRAFT',
    'IN_REVIEW',
    'CHANGES_REQUESTED',
    'APPROVED',
    'EXECUTED',
    'OBSOLETE'
);

CREATE TYPE public."EvalStatus" AS ENUM (
    'FAILED',
    'NEEDS_IMPROVEMENT',
    'PASSED'
);

CREATE TYPE public."EvaluationReportType" AS ENUM (
    'PLAN',
    'CODE',
    'PRD',
    'FEATURE'
);

CREATE TYPE public."ExternalCommentProvider" AS ENUM (
    'GITHUB'
);

CREATE TYPE public."FeatureStatus" AS ENUM (
    'TRIAGE',
    'BACKLOG',
    'TODO',
    'IN_PROGRESS',
    'IN_REVIEW',
    'BLOCKED',
    'DONE',
    'CANCELED'
);

CREATE TYPE public."GitHubCommentThreadKind" AS ENUM (
    'REVIEW_THREAD',
    'ISSUE_COMMENT'
);

CREATE TYPE public."GitHubDiffSide" AS ENUM (
    'LEFT',
    'RIGHT'
);

CREATE TYPE public."GitHubInstallationStatus" AS ENUM (
    'PENDING_CLAIM',
    'ACTIVE',
    'SUSPENDED',
    'UNINSTALLED'
);

CREATE TYPE public."GitHubLegacyCommentState" AS ENUM (
    'PENDING',
    'ADDRESSED',
    'DISMISSED'
);

CREATE TYPE public."GitHubPRState" AS ENUM (
    'OPEN',
    'MERGED',
    'CLOSED'
);

CREATE TYPE public."LabelPosition" AS ENUM (
    'PREFIX',
    'SUFFIX'
);

CREATE TYPE public."LinkType" AS ENUM (
    'PRODUCES',
    'BLOCKS',
    'RELATES_TO'
);

CREATE TYPE public."LoopCommand" AS ENUM (
    'PLAN',
    'EXECUTE',
    'CHAT',
    'EXPLORE',
    'REQUEST_CHANGES',
    'DECOMPOSE',
    'EVALUATE_PRD',
    'GENERATE_PRD',
    'EVALUATE_PLAN',
    'EVALUATE_CODE',
    'REQUEST_PRD_CHANGES',
    'BOOTSTRAP',
    'MANUAL',
    'EVALUATE_FEATURE',
    'STEP'
);

CREATE TYPE public."LoopStatus" AS ENUM (
    'PENDING',
    'CLAIMED',
    'RUNNING',
    'COMPLETED',
    'FAILED',
    'CANCELLED',
    'TIMED_OUT',
    'BLOCKED'
);

CREATE TYPE public."NumberFormat" AS ENUM (
    'NONE',
    'CURRENCY',
    'PERCENTAGE',
    'CUSTOM'
);

CREATE TYPE public."PreferredComputeMode" AS ENUM (
    'LOCAL',
    'CLOUD'
);

CREATE TYPE public."Priority" AS ENUM (
    'LOW',
    'MEDIUM',
    'HIGH',
    'URGENT'
);

CREATE TYPE public."ProjectStatus" AS ENUM (
    'NOT_STARTED',
    'IN_PROGRESS',
    'COMPLETED',
    'ARCHIVED'
);

CREATE TYPE public."PromptType" AS ENUM (
    'AGENT',
    'JUDGE'
);

CREATE TYPE public."ReviewDecision" AS ENUM (
    'APPROVED',
    'CHANGES_REQUESTED',
    'COMMENTED',
    'DISMISSED'
);

CREATE TYPE public."RoutineComponentKind" AS ENUM (
    'SUBAGENT',
    'COMMAND',
    'SKILL'
);

CREATE TYPE public."RoutineNotifyMode" AS ENUM (
    'ALL_RUNS',
    'FAILED_RUNS_ONLY'
);

CREATE TYPE public."RoutineOrigin" AS ENUM (
    'CREATED',
    'DISCOVERED'
);

CREATE TYPE public."RoutineProvider" AS ENUM (
    'CLAUDE',
    'CODEX',
    'OPENCODE'
);

CREATE TYPE public."RoutineRunStatus" AS ENUM (
    'PENDING',
    'RUNNING',
    'SUCCESS',
    'FAILED',
    'SKIPPED',
    'TIMEOUT',
    'CANCELED'
);

CREATE TYPE public."RoutineRunsIn" AS ENUM (
    'NEW_CHAT',
    'EXISTING_CHAT'
);

CREATE TYPE public."RoutineRunsOn" AS ENUM (
    'LOCAL',
    'CLOUD'
);

CREATE TYPE public."RoutineScheduleKind" AS ENUM (
    'MANUAL',
    'HOURLY',
    'DAILY',
    'WEEKDAYS',
    'WEEKLY',
    'CUSTOM'
);

CREATE TYPE public."RoutineStatus" AS ENUM (
    'ACTIVE',
    'PAUSED',
    'DRAFT'
);

CREATE TYPE public."SessionOrigin" AS ENUM (
    'DESKTOP_SYNC',
    'LOOP'
);

CREATE TYPE public."ThreadSource" AS ENUM (
    'NATIVE',
    'LIVEBLOCKS',
    'GITHUB'
);

CREATE TYPE public."ThreadStatus" AS ENUM (
    'OPEN',
    'RESOLVED'
);

CREATE TYPE public.component_resolved_state AS ENUM (
    'resolved',
    'unresolved',
    'inaccessible',
    'missing'
);

CREATE TYPE public.definition_version_editor_role AS ENUM (
    'discoverer',
    'editor'
);

CREATE TYPE public.source_access_state AS ENUM (
    'accessible',
    'inaccessible'
);

CREATE TYPE public.source_occurrence_type AS ENUM (
    'repository',
    'local',
    'pack',
    'static_file',
    'distributed',
    'builtin_claude',
    'builtin_codex'
);

CREATE FUNCTION public.audit_entries_reject_mutation() RETURNS trigger
    LANGUAGE plpgsql
    AS $$
BEGIN
    IF (TG_OP = 'DELETE') THEN
        -- Allow the delete only when it is a cascade re-entry from a parent
        -- (e.g. Organization) delete; reject a direct DELETE (tampering).
        IF pg_trigger_depth() > 1 THEN
            RETURN OLD;
        END IF;
        RAISE EXCEPTION 'audit_entries is append-only: DELETE is not permitted (row org=%, seq=%)', OLD.organization_id, OLD.seq
            USING ERRCODE = 'restrict_violation';
    END IF;
    RAISE EXCEPTION 'audit_entries is append-only: UPDATE is not permitted (row org=%, seq=%)', OLD.organization_id, OLD.seq
        USING ERRCODE = 'restrict_violation';
END;
$$;

CREATE FUNCTION public.audit_entries_reject_truncate() RETURNS trigger
    LANGUAGE plpgsql
    AS $$
BEGIN
    RAISE EXCEPTION 'audit_entries is append-only: TRUNCATE is not permitted'
        USING ERRCODE = 'restrict_violation';
END;
$$;

CREATE FUNCTION public.delete_github_comment_thread_projection_base_row() RETURNS trigger
    LANGUAGE plpgsql
    AS $$
BEGIN
  DELETE FROM "comment_threads"
  WHERE "id" = OLD."thread_id"
    AND "source" = 'GITHUB';

  RETURN OLD;
END;
$$;

CREATE FUNCTION public.ensure_comments_parent_same_thread() RETURNS trigger
    LANGUAGE plpgsql
    AS $$
BEGIN
  IF NEW."parent_comment_id" IS NOT NULL
  THEN
    PERFORM 1
    FROM "comments" parent
    WHERE parent."id" = NEW."parent_comment_id"
      AND parent."thread_id" = NEW."thread_id"
    FOR SHARE;

    IF NOT FOUND THEN
      RAISE EXCEPTION 'comments.parent_comment_id must reference a comment in the same thread'
        USING ERRCODE = 'foreign_key_violation';
    END IF;
  END IF;

  IF TG_OP = 'UPDATE'
    AND NEW."thread_id" IS DISTINCT FROM OLD."thread_id"
    AND EXISTS (
      SELECT 1
      FROM "comments" child
      WHERE child."parent_comment_id" = NEW."id"
        AND child."thread_id" IS DISTINCT FROM NEW."thread_id"
    )
  THEN
    RAISE EXCEPTION 'comments with replies cannot move to a different thread'
      USING ERRCODE = 'foreign_key_violation';
  END IF;

  RETURN NEW;
END;
$$;

CREATE FUNCTION public.ensure_github_comment_thread_projection_owner() RETURNS trigger
    LANGUAGE plpgsql
    AS $$
BEGIN
  IF NOT EXISTS (
    SELECT 1
    FROM "comment_threads" thread
    JOIN "artifacts" artifact
      ON artifact."id" = thread."artifact_id"
    JOIN "branch_detail" branch
      ON branch."artifact_id" = artifact."id"
    JOIN "pull_request_detail" pr
      ON pr."id" = NEW."pull_request_detail_id"
     AND pr."branch_artifact_id" = NEW."branch_artifact_id"
    WHERE thread."id" = NEW."thread_id"
      AND thread."artifact_id" = NEW."branch_artifact_id"
      AND thread."source" = 'GITHUB'
      AND artifact."type" = 'BRANCH'
      AND artifact."organization_id" = thread."organization_id"
  )
  THEN
    RAISE EXCEPTION 'github_comment_thread_projections must reference a GitHub thread on the same branch artifact and organization as the pull request detail'
      USING ERRCODE = 'foreign_key_violation';
  END IF;

  RETURN NEW;
END;
$$;

CREATE FUNCTION public.guard_pull_request_head_ref_pair() RETURNS trigger
    LANGUAGE plpgsql
    AS $$
BEGIN
  IF OLD."head_ref_name" IS NOT NULL
    AND OLD."head_ref_oid" IS NOT NULL
    AND NEW."head_ref_oid" IS DISTINCT FROM OLD."head_ref_oid"
    AND NEW."head_ref_name" IS NOT DISTINCT FROM OLD."head_ref_name"
    AND NEW."head_repository_default_branch_source"
      IS NOT DISTINCT FROM OLD."head_repository_default_branch_source"
    AND NEW."head_repository_default_branch_observation_key"
      IS NOT DISTINCT FROM OLD."head_repository_default_branch_observation_key"
    AND NEW."head_repository_default_branch_observed_at"
      IS NOT DISTINCT FROM OLD."head_repository_default_branch_observed_at"
    AND NEW."head_repository_default_branch_event_at"
      IS NOT DISTINCT FROM OLD."head_repository_default_branch_event_at"
  THEN
    NEW."head_ref_name" := NULL;
  END IF;
  RETURN NEW;
END;
$$;

CREATE FUNCTION public.prevent_github_comment_thread_projection_artifact_drift() RETURNS trigger
    LANGUAGE plpgsql
    AS $$
BEGIN
  IF EXISTS (
    SELECT 1
    FROM "github_comment_thread_projections" projection
    WHERE projection."branch_artifact_id" = OLD."id"
      AND projection."deleted_at" IS NULL
  )
    AND (
      NEW."type" IS DISTINCT FROM OLD."type"
      OR NEW."organization_id" IS DISTINCT FROM OLD."organization_id"
    )
  THEN
    RAISE EXCEPTION 'artifacts with GitHub comment projections cannot change type or organization'
      USING ERRCODE = 'foreign_key_violation';
  END IF;

  RETURN NEW;
END;
$$;

CREATE FUNCTION public.prevent_github_comment_thread_projection_thread_drift() RETURNS trigger
    LANGUAGE plpgsql
    AS $$
BEGIN
  IF EXISTS (
    SELECT 1
    FROM "github_comment_thread_projections" projection
    WHERE projection."thread_id" = OLD."id"
      AND projection."deleted_at" IS NULL
  )
    AND (
      NEW."source" IS DISTINCT FROM OLD."source"
      OR NEW."organization_id" IS DISTINCT FROM OLD."organization_id"
      OR NEW."artifact_id" IS DISTINCT FROM OLD."artifact_id"
    )
  THEN
    RAISE EXCEPTION 'comment_threads with GitHub projections cannot change source, organization, or artifact'
      USING ERRCODE = 'foreign_key_violation';
  END IF;

  RETURN NEW;
END;
$$;

CREATE TABLE public.agent_component_invocation_generations (
    id uuid NOT NULL,
    agent_session_id uuid NOT NULL,
    external_generation_id text NOT NULL,
    source_updated_at timestamp(3) without time zone NOT NULL,
    data_revision integer NOT NULL,
    source_sequence integer NOT NULL,
    expected_part_count integer NOT NULL,
    active_at timestamp(3) without time zone,
    completed_at timestamp(3) without time zone,
    created_at timestamp(3) without time zone DEFAULT CURRENT_TIMESTAMP NOT NULL,
    updated_at timestamp(3) without time zone NOT NULL
);

CREATE TABLE public.agent_component_invocation_parts (
    id uuid NOT NULL,
    generation_id uuid NOT NULL,
    part_index integer NOT NULL,
    part_hash text NOT NULL,
    item_count integer NOT NULL,
    payload_bytes integer NOT NULL,
    received_at timestamp(3) without time zone DEFAULT CURRENT_TIMESTAMP NOT NULL
);

CREATE TABLE public.agent_component_invocations (
    id uuid NOT NULL,
    generation_id uuid NOT NULL,
    part_id uuid NOT NULL,
    external_invocation_id text NOT NULL,
    source_session_id text NOT NULL,
    child_session_id text,
    parent_external_invocation_id text,
    external_agent_id text,
    component_kind text NOT NULL,
    component_key text NOT NULL,
    raw_name text,
    normalized_name text,
    relationship text NOT NULL,
    invoked_at timestamp(3) without time zone,
    sequence integer NOT NULL,
    anchor jsonb NOT NULL,
    provider_invocation_id text,
    attribution_status text NOT NULL,
    evidence_class text NOT NULL,
    definition_hash text,
    normalizer_contract_version integer,
    definition_content text,
    definition_format text,
    source_path text,
    source_modified_at timestamp(3) without time zone,
    captured_at timestamp(3) without time zone,
    repository_full_name text,
    repository_commit text,
    pack_id text,
    branch_name text,
    agent_component_id uuid,
    definition_version_id uuid,
    source_occurrence_id uuid,
    created_at timestamp(3) without time zone DEFAULT CURRENT_TIMESTAMP NOT NULL,
    updated_at timestamp(3) without time zone NOT NULL,
    cache_read_tokens bigint,
    cache_write_tokens bigint,
    estimated_cost numeric(14,6),
    footprint_tokens bigint,
    input_tokens bigint,
    model text,
    output_tokens bigint
);

CREATE TABLE public.agent_component_session_usage (
    id uuid NOT NULL,
    agent_session_id uuid NOT NULL,
    component_kind text NOT NULL,
    component_key text NOT NULL,
    agent_component_id uuid,
    harness text,
    invocation_count integer DEFAULT 0 NOT NULL,
    error_count integer DEFAULT 0 NOT NULL,
    first_invoked_at timestamp(3) without time zone,
    last_invoked_at timestamp(3) without time zone,
    created_at timestamp(3) without time zone DEFAULT CURRENT_TIMESTAMP NOT NULL,
    updated_at timestamp(3) without time zone NOT NULL,
    git_branch text DEFAULT ''::text NOT NULL,
    component_version_hash text,
    definition_version_id uuid
);

CREATE TABLE public.agent_component_versions (
    id uuid NOT NULL,
    organization_id uuid NOT NULL,
    component_kind text NOT NULL,
    component_key text NOT NULL,
    source text DEFAULT ''::text NOT NULL,
    content_hash text NOT NULL,
    content text NOT NULL,
    format text,
    first_seen_at timestamp(3) without time zone,
    last_seen_at timestamp(3) without time zone,
    created_at timestamp(3) without time zone DEFAULT CURRENT_TIMESTAMP NOT NULL,
    updated_at timestamp(3) without time zone NOT NULL,
    definition_version_id uuid
);

CREATE TABLE public.agent_components (
    id uuid NOT NULL,
    organization_id uuid NOT NULL,
    compute_target_id uuid NOT NULL,
    component_kind text NOT NULL,
    external_component_id text NOT NULL,
    harness text,
    name text,
    component_key text,
    version text,
    description text,
    source_url text,
    install_path text,
    pack_id text,
    scope text,
    project_path text,
    metadata jsonb,
    first_seen_at timestamp(3) without time zone,
    last_seen_at timestamp(3) without time zone,
    uninstalled_at timestamp(3) without time zone,
    created_at timestamp(3) without time zone DEFAULT CURRENT_TIMESTAMP NOT NULL,
    updated_at timestamp(3) without time zone NOT NULL,
    content text,
    content_hash text,
    resolved_state public.component_resolved_state DEFAULT 'unresolved'::public.component_resolved_state NOT NULL,
    variants_truncated boolean DEFAULT false NOT NULL,
    variants_truncated_reason text
);

CREATE TABLE public.agent_session_activity_segments (
    id uuid NOT NULL,
    agent_session_id uuid NOT NULL,
    phase text NOT NULL,
    start_ms bigint NOT NULL,
    end_ms bigint NOT NULL,
    confidence double precision NOT NULL,
    evidence_layers jsonb NOT NULL,
    classifier_version integer NOT NULL,
    work_item_ref text,
    subagent_id text,
    created_at timestamp(3) without time zone DEFAULT CURRENT_TIMESTAMP NOT NULL
);

CREATE TABLE public.agent_session_events (
    id uuid NOT NULL,
    agent_session_id uuid NOT NULL,
    external_event_id text NOT NULL,
    agent_external_id text,
    event_type text NOT NULL,
    tool_name text,
    event_created_at timestamp(3) without time zone NOT NULL,
    created_at timestamp(3) without time zone DEFAULT CURRENT_TIMESTAMP NOT NULL
);

CREATE TABLE public.agent_session_token_events (
    id uuid NOT NULL,
    agent_session_id uuid NOT NULL,
    external_event_id text NOT NULL,
    agent_external_id text,
    model text NOT NULL,
    input_tokens bigint DEFAULT 0 NOT NULL,
    output_tokens bigint DEFAULT 0 NOT NULL,
    cache_read_tokens bigint DEFAULT 0 NOT NULL,
    cache_write_tokens bigint DEFAULT 0 NOT NULL,
    estimated_cost numeric(14,6),
    event_created_at timestamp(3) without time zone NOT NULL,
    created_at timestamp(3) without time zone DEFAULT CURRENT_TIMESTAMP NOT NULL,
    source_identity jsonb,
    cost_completeness text,
    cost_completeness_reason text,
    subscription_equivalent_cost numeric(14,6),
    api_estimated_cost numeric(14,6)
);

CREATE TABLE public.agent_session_token_usage (
    id uuid NOT NULL,
    agent_session_id uuid NOT NULL,
    model text NOT NULL,
    input_tokens bigint DEFAULT 0 NOT NULL,
    output_tokens bigint DEFAULT 0 NOT NULL,
    cache_read_tokens bigint DEFAULT 0 NOT NULL,
    cache_write_tokens bigint DEFAULT 0 NOT NULL,
    estimated_cost numeric(14,6) DEFAULT 0 NOT NULL,
    created_at timestamp(3) without time zone DEFAULT CURRENT_TIMESTAMP NOT NULL,
    updated_at timestamp(3) without time zone NOT NULL,
    cache_write_1h_tokens bigint,
    cache_write_5m_tokens bigint
);

CREATE TABLE public.agent_session_usage_rollups (
    artifact_id uuid NOT NULL,
    started_at timestamp(3) without time zone,
    started_day text,
    status text,
    harness text,
    is_human boolean DEFAULT false NOT NULL,
    human_turns integer DEFAULT 0 NOT NULL,
    agent_turns integer DEFAULT 0 NOT NULL,
    event_count integer DEFAULT 0 NOT NULL,
    tool_invocations integer DEFAULT 0 NOT NULL,
    error_events integer DEFAULT 0 NOT NULL,
    input_tokens bigint DEFAULT 0 NOT NULL,
    output_tokens bigint DEFAULT 0 NOT NULL,
    cache_read_tokens bigint DEFAULT 0 NOT NULL,
    cache_write_tokens bigint DEFAULT 0 NOT NULL,
    estimated_cost numeric(14,6) DEFAULT 0 NOT NULL,
    runtime_ms bigint,
    rollup_updated_at timestamp(3) without time zone,
    last_synced_at timestamp(3) without time zone DEFAULT CURRENT_TIMESTAMP NOT NULL,
    created_at timestamp(3) without time zone DEFAULT CURRENT_TIMESTAMP NOT NULL,
    updated_at timestamp(3) without time zone NOT NULL
);

CREATE TABLE public.agent_versions (
    id uuid NOT NULL,
    agent_id uuid NOT NULL,
    version integer NOT NULL,
    name text NOT NULL,
    prompt text NOT NULL,
    change_note text,
    changed_by_id uuid NOT NULL,
    created_at timestamp(3) without time zone DEFAULT CURRENT_TIMESTAMP NOT NULL
);

CREATE TABLE public.agents (
    id uuid NOT NULL,
    organization_id uuid NOT NULL,
    name text NOT NULL,
    slug text NOT NULL,
    role text NOT NULL,
    description text,
    prompt text NOT NULL,
    enabled boolean DEFAULT true NOT NULL,
    source_repo text DEFAULT ''::text NOT NULL,
    bootstrap_run_id text,
    current_version integer DEFAULT 1 NOT NULL,
    created_by_id uuid NOT NULL,
    created_at timestamp(3) without time zone DEFAULT CURRENT_TIMESTAMP NOT NULL,
    updated_at timestamp(3) without time zone NOT NULL
);

CREATE TABLE public.api_keys (
    id uuid NOT NULL,
    organization_id uuid NOT NULL,
    user_id uuid NOT NULL,
    name text NOT NULL,
    key_hash text NOT NULL,
    key_prefix text NOT NULL,
    expires_at timestamp(3) without time zone,
    last_used_at timestamp(3) without time zone,
    created_at timestamp(3) without time zone DEFAULT CURRENT_TIMESTAMP NOT NULL,
    revoked_at timestamp(3) without time zone,
    scopes text[] DEFAULT ARRAY[]::text[] NOT NULL,
    bound_public_key text,
    gateway_id text,
    source public."ApiKeySource" DEFAULT 'USER_CREATED'::public."ApiKeySource" NOT NULL
);

CREATE TABLE public.artifact_activity_events (
    id uuid NOT NULL,
    organization_id uuid NOT NULL,
    artifact_id uuid NOT NULL,
    actor_type text NOT NULL,
    actor_id text,
    action text NOT NULL,
    before jsonb,
    after jsonb,
    created_at timestamp(3) without time zone DEFAULT CURRENT_TIMESTAMP NOT NULL
);

CREATE TABLE public.artifact_evaluations (
    id uuid NOT NULL,
    report_id text NOT NULL,
    created_at timestamp(3) without time zone DEFAULT CURRENT_TIMESTAMP NOT NULL,
    loop_id uuid,
    report_type public."EvaluationReportType" NOT NULL,
    organization_id uuid NOT NULL,
    artifact_id uuid NOT NULL
);

CREATE TABLE public.artifact_generation_status_dismissals (
    id uuid NOT NULL,
    artifact_id uuid NOT NULL,
    dismissed_by_id uuid NOT NULL,
    run_key text NOT NULL,
    dismissed_at timestamp(3) without time zone DEFAULT CURRENT_TIMESTAMP NOT NULL,
    created_at timestamp(3) without time zone DEFAULT CURRENT_TIMESTAMP NOT NULL,
    updated_at timestamp(3) without time zone NOT NULL
);

CREATE TABLE public.artifact_links (
    id uuid NOT NULL,
    organization_id uuid NOT NULL,
    source_id uuid NOT NULL,
    target_id uuid NOT NULL,
    link_type public."LinkType" NOT NULL,
    metadata jsonb,
    created_at timestamp(3) without time zone DEFAULT CURRENT_TIMESTAMP NOT NULL,
    branch_participation character varying(32),
    branch_participation_method character varying(200),
    branch_participation_observed_at timestamp(3) without time zone
);

CREATE TABLE public.artifact_ratings (
    id uuid NOT NULL,
    artifact_id uuid NOT NULL,
    user_id uuid NOT NULL,
    organization_id uuid NOT NULL,
    score integer NOT NULL,
    comment character varying(500),
    artifact_version integer,
    created_at timestamp(3) without time zone DEFAULT CURRENT_TIMESTAMP NOT NULL,
    updated_at timestamp(3) without time zone NOT NULL
);

CREATE TABLE public.artifacts (
    id uuid NOT NULL,
    organization_id uuid NOT NULL,
    project_id uuid,
    type public."ArtifactType" NOT NULL,
    subtype public."ArtifactSubtype",
    name text NOT NULL,
    slug text,
    assignee_id uuid,
    status text NOT NULL,
    priority public."Priority",
    due_date timestamp(3) without time zone,
    external_url text,
    sort_order integer,
    created_at timestamp(3) without time zone DEFAULT CURRENT_TIMESTAMP NOT NULL,
    created_by_id uuid,
    updated_at timestamp(3) without time zone NOT NULL,
    template_for_type public."ArtifactSubtype"
);

CREATE TABLE public.audit_entries (
    organization_id uuid NOT NULL,
    seq bigint NOT NULL,
    hash character(64) NOT NULL,
    prev_hash character(64) NOT NULL,
    action text NOT NULL,
    actor_type text NOT NULL,
    actor_id uuid,
    object_type text NOT NULL,
    object_id text NOT NULL,
    detail jsonb NOT NULL,
    created_at timestamp(3) without time zone DEFAULT CURRENT_TIMESTAMP NOT NULL
);

CREATE TABLE public.audit_outbox (
    id uuid NOT NULL,
    organization_id uuid NOT NULL,
    action text NOT NULL,
    actor_type text NOT NULL,
    actor_id uuid,
    object_type text NOT NULL,
    object_id text NOT NULL,
    detail jsonb NOT NULL,
    attempts integer DEFAULT 0 NOT NULL,
    last_error text,
    created_at timestamp(3) without time zone DEFAULT CURRENT_TIMESTAMP NOT NULL
);

CREATE TABLE public.auth_accounts (
    id text NOT NULL,
    account_id text NOT NULL,
    provider_id text NOT NULL,
    user_id text NOT NULL,
    access_token text,
    refresh_token text,
    id_token text,
    access_token_expires_at timestamp(3) without time zone,
    refresh_token_expires_at timestamp(3) without time zone,
    scope text,
    password text,
    created_at timestamp(3) without time zone DEFAULT CURRENT_TIMESTAMP NOT NULL,
    updated_at timestamp(3) without time zone NOT NULL
);

CREATE TABLE public.auth_invitations (
    id text NOT NULL,
    organization_id text NOT NULL,
    email text NOT NULL,
    role text,
    status text DEFAULT 'pending'::text NOT NULL,
    expires_at timestamp(3) without time zone NOT NULL,
    created_at timestamp(3) without time zone DEFAULT CURRENT_TIMESTAMP NOT NULL,
    inviter_id text NOT NULL
);

CREATE TABLE public.auth_jwks (
    id text NOT NULL,
    public_key text NOT NULL,
    private_key text NOT NULL,
    created_at timestamp(3) without time zone NOT NULL,
    expires_at timestamp(3) without time zone,
    alg text,
    crv text
);

CREATE TABLE public.auth_members (
    id text NOT NULL,
    organization_id text NOT NULL,
    user_id text NOT NULL,
    role text DEFAULT 'member'::text NOT NULL,
    created_at timestamp(3) without time zone NOT NULL
);

CREATE TABLE public.auth_organizations (
    id text NOT NULL,
    name text NOT NULL,
    slug text NOT NULL,
    logo text,
    created_at timestamp(3) without time zone NOT NULL,
    metadata text
);

CREATE TABLE public.auth_sessions (
    id text NOT NULL,
    expires_at timestamp(3) without time zone NOT NULL,
    token text NOT NULL,
    created_at timestamp(3) without time zone DEFAULT CURRENT_TIMESTAMP NOT NULL,
    updated_at timestamp(3) without time zone NOT NULL,
    ip_address text,
    user_agent text,
    user_id text NOT NULL,
    active_organization_id text
);

CREATE TABLE public.auth_users (
    id text NOT NULL,
    name text NOT NULL,
    email text NOT NULL,
    email_verified boolean DEFAULT false NOT NULL,
    image text,
    created_at timestamp(3) without time zone DEFAULT CURRENT_TIMESTAMP NOT NULL,
    updated_at timestamp(3) without time zone DEFAULT CURRENT_TIMESTAMP NOT NULL
);

CREATE TABLE public.auth_verifications (
    id text NOT NULL,
    identifier text NOT NULL,
    value text NOT NULL,
    expires_at timestamp(3) without time zone NOT NULL,
    created_at timestamp(3) without time zone DEFAULT CURRENT_TIMESTAMP NOT NULL,
    updated_at timestamp(3) without time zone DEFAULT CURRENT_TIMESTAMP NOT NULL
);

CREATE TABLE public.branch_activity_atoms (
    id uuid NOT NULL,
    version integer NOT NULL,
    organization_id uuid NOT NULL,
    branch_artifact_id uuid NOT NULL,
    source character varying(128) NOT NULL,
    source_event_id character varying(512) NOT NULL,
    occurred_at timestamp(3) without time zone NOT NULL,
    attribution_kind character varying(32) NOT NULL,
    pull_request_detail_id uuid,
    completeness character varying(32) NOT NULL,
    created_at timestamp(3) without time zone DEFAULT CURRENT_TIMESTAMP NOT NULL,
    CONSTRAINT branch_activity_atoms_attribution_check CHECK (((((attribution_kind)::text = 'branch'::text) AND (pull_request_detail_id IS NULL)) OR (((attribution_kind)::text = 'pull_request'::text) AND (pull_request_detail_id IS NOT NULL)))),
    CONSTRAINT branch_activity_atoms_attribution_kind_check CHECK (((attribution_kind)::text = ANY (ARRAY[('branch'::character varying)::text, ('pull_request'::character varying)::text]))),
    CONSTRAINT branch_activity_atoms_completeness_check CHECK (((completeness)::text = ANY (ARRAY[('complete'::character varying)::text, ('partial'::character varying)::text]))),
    CONSTRAINT branch_activity_atoms_source_event_nonempty CHECK ((((source_event_id)::text = btrim((source_event_id)::text)) AND (length((source_event_id)::text) > 0))),
    CONSTRAINT branch_activity_atoms_source_nonempty CHECK ((((source)::text = btrim((source)::text)) AND (length((source)::text) > 0))),
    CONSTRAINT branch_activity_atoms_version_check CHECK ((version >= 1))
);

CREATE TABLE public.branch_detail (
    artifact_id uuid NOT NULL,
    repository_id uuid,
    branch_name text NOT NULL,
    base_branch text,
    base_branch_source text,
    head_sha text,
    head_sha_source text,
    head_sha_observed_at timestamp(3) without time zone,
    last_push_before_sha text,
    current_pull_request_detail_id uuid,
    deleted_at timestamp(3) without time zone,
    checks_status public."ChecksStatus" DEFAULT 'UNKNOWN'::public."ChecksStatus" NOT NULL,
    file_cache_status text DEFAULT 'absent'::text NOT NULL,
    file_cache_head_sha text,
    file_cache_file_count integer DEFAULT 0 NOT NULL,
    file_cache_patch_bytes integer DEFAULT 0 NOT NULL,
    file_cache_updated_at timestamp(3) without time zone,
    sync_status text DEFAULT 'idle'::text NOT NULL,
    last_sync_started_at timestamp(3) without time zone,
    last_sync_completed_at timestamp(3) without time zone,
    last_sync_error_code text,
    last_sync_error_message text,
    created_at timestamp(3) without time zone DEFAULT CURRENT_TIMESTAMP NOT NULL,
    updated_at timestamp(3) without time zone NOT NULL,
    checks_detail_head_sha text,
    checks_detail_provider_state text,
    checks_detail_total_count integer DEFAULT 0 NOT NULL,
    checks_detail_truncated boolean DEFAULT false NOT NULL,
    checks_detail_unavailable_reason text,
    checks_detail_updated_at timestamp(3) without time zone,
    last_activity_at timestamp(3) without time zone,
    check_run_retry_state character varying(32),
    check_run_retry_head_sha text,
    check_run_retry_resource_id character varying(255),
    check_run_retry_idempotency_key character varying(255),
    check_run_retry_attempts integer DEFAULT 0 NOT NULL,
    check_run_retry_next_at timestamp(3) without time zone,
    check_run_retry_last_attempt_at timestamp(3) without time zone,
    check_run_retry_reason character varying(64),
    fetch_credential_owner_id uuid,
    fetch_credential_type character varying(32),
    fetch_mechanism character varying(32),
    fetch_observed_at timestamp(3) without time zone,
    fetch_result_reason character varying(64),
    fetch_trigger character varying(32),
    organization_id uuid NOT NULL,
    repository_full_name text NOT NULL,
    first_pushed_at timestamp(3) without time zone,
    push_source text,
    CONSTRAINT branch_detail_check_run_retry_attempts_nonnegative CHECK ((check_run_retry_attempts >= 0)),
    CONSTRAINT branch_detail_check_run_retry_identity_present CHECK (((check_run_retry_state IS NULL) OR ((check_run_retry_head_sha IS NOT NULL) AND (check_run_retry_resource_id IS NOT NULL) AND (check_run_retry_idempotency_key IS NOT NULL)))),
    CONSTRAINT branch_detail_check_run_retry_state_valid CHECK (((check_run_retry_state IS NULL) OR ((check_run_retry_state)::text = ANY (ARRAY[('pending'::character varying)::text, ('claimed'::character varying)::text, ('dead_letter'::character varying)::text]))))
);

CREATE TABLE public.branch_file_changes (
    id uuid DEFAULT gen_random_uuid() NOT NULL,
    branch_artifact_id uuid NOT NULL,
    head_sha text NOT NULL,
    path text NOT NULL,
    previous_path text,
    status text NOT NULL,
    additions integer,
    deletions integer,
    changes integer,
    patch text,
    patch_bytes integer DEFAULT 0 NOT NULL,
    patch_omitted_reason text,
    is_binary boolean DEFAULT false NOT NULL,
    created_at timestamp(3) without time zone DEFAULT CURRENT_TIMESTAMP NOT NULL,
    updated_at timestamp(3) without time zone NOT NULL
);

CREATE TABLE public.branch_status_checks (
    id uuid DEFAULT gen_random_uuid() NOT NULL,
    branch_artifact_id uuid NOT NULL,
    head_sha text NOT NULL,
    provider_key character varying(160) NOT NULL,
    kind character varying(32) NOT NULL,
    provider_node_id character varying(255),
    name character varying(255) NOT NULL,
    status character varying(64),
    conclusion character varying(64),
    target_url character varying(2048),
    "position" integer NOT NULL,
    created_at timestamp(3) without time zone DEFAULT CURRENT_TIMESTAMP NOT NULL,
    updated_at timestamp(3) without time zone NOT NULL,
    fetch_credential_owner_id uuid,
    fetch_credential_type character varying(32),
    fetch_mechanism character varying(32),
    fetch_observed_at timestamp(3) without time zone,
    fetch_result_reason character varying(64),
    fetch_trigger character varying(32)
);

CREATE TABLE public.catalog_item_versions (
    id uuid NOT NULL,
    catalog_item_id uuid NOT NULL,
    version integer NOT NULL,
    name text NOT NULL,
    content text,
    change_note text,
    changed_by_id uuid,
    created_at timestamp(3) without time zone DEFAULT CURRENT_TIMESTAMP NOT NULL,
    definition_version_id uuid
);

CREATE TABLE public.catalog_items (
    id uuid NOT NULL,
    organization_id uuid,
    target_kind text NOT NULL,
    source text NOT NULL,
    scope text NOT NULL,
    name text NOT NULL,
    description text,
    version text DEFAULT '1.0.0'::text NOT NULL,
    sort_order integer DEFAULT 0 NOT NULL,
    zip_asset_bucket text,
    zip_asset_key text,
    logo_asset_bucket text,
    logo_asset_key text,
    files_asset_key text,
    enabled boolean DEFAULT true NOT NULL,
    archived boolean DEFAULT false NOT NULL,
    legacy_agent_id uuid,
    source_repo text,
    role text,
    agent_slug text,
    source_loop_id text,
    created_by_id uuid,
    created_at timestamp(3) without time zone DEFAULT CURRENT_TIMESTAMP NOT NULL,
    updated_at timestamp(3) without time zone NOT NULL,
    coaching boolean DEFAULT false NOT NULL,
    coaching_config jsonb,
    source_agent_component_id uuid,
    parent_pack_id uuid,
    component_uuid uuid
);

CREATE TABLE public.chat_sessions (
    id uuid NOT NULL,
    chat_key text NOT NULL,
    user_id uuid NOT NULL,
    organization_id uuid NOT NULL,
    provider text NOT NULL,
    model text NOT NULL,
    messages jsonb DEFAULT '[]'::jsonb NOT NULL,
    session_id text,
    session_source_id text,
    context text,
    created_at timestamp(3) without time zone DEFAULT CURRENT_TIMESTAMP NOT NULL,
    updated_at timestamp(3) without time zone NOT NULL
);

CREATE TABLE public.comment_attachments (
    id uuid NOT NULL,
    comment_id uuid NOT NULL,
    external_id text,
    name text NOT NULL,
    size integer,
    mime_type text,
    url text,
    created_at timestamp(3) without time zone DEFAULT CURRENT_TIMESTAMP NOT NULL
);

CREATE TABLE public.comment_reactions (
    id uuid NOT NULL,
    comment_id uuid NOT NULL,
    user_id uuid NOT NULL,
    emoji text NOT NULL,
    created_at timestamp(3) without time zone DEFAULT CURRENT_TIMESTAMP NOT NULL
);

CREATE TABLE public.comment_threads (
    id uuid NOT NULL,
    organization_id uuid NOT NULL,
    source public."ThreadSource" DEFAULT 'NATIVE'::public."ThreadSource" NOT NULL,
    external_id text,
    room_id text,
    status public."ThreadStatus" DEFAULT 'OPEN'::public."ThreadStatus" NOT NULL,
    metadata jsonb,
    resolved_at timestamp(3) without time zone,
    resolved_by_id uuid,
    created_by_id uuid,
    created_at timestamp(3) without time zone DEFAULT CURRENT_TIMESTAMP NOT NULL,
    updated_at timestamp(3) without time zone NOT NULL,
    artifact_id uuid,
    created_at_version integer
);

CREATE TABLE public.comments (
    id uuid NOT NULL,
    thread_id uuid NOT NULL,
    author_id uuid NOT NULL,
    body jsonb NOT NULL,
    plain_text text,
    external_id text,
    edited_at timestamp(3) without time zone,
    deleted_at timestamp(3) without time zone,
    created_at timestamp(3) without time zone DEFAULT CURRENT_TIMESTAMP NOT NULL,
    updated_at timestamp(3) without time zone NOT NULL,
    parent_comment_id uuid
);

CREATE TABLE public.commit_detail (
    id uuid NOT NULL,
    organization_id uuid NOT NULL,
    repository_full_name text NOT NULL,
    sha text NOT NULL,
    branch_artifact_id uuid NOT NULL,
    message text,
    committed_at timestamp(3) without time zone,
    authored_at timestamp(3) without time zone,
    author_name text,
    author_email text,
    author_login text,
    lines_added integer,
    lines_removed integer,
    files_changed integer,
    is_merge boolean DEFAULT false NOT NULL,
    merge_commit_sha text,
    source text NOT NULL,
    created_at timestamp(3) without time zone DEFAULT CURRENT_TIMESTAMP NOT NULL,
    updated_at timestamp(3) without time zone NOT NULL
);

CREATE TABLE public.compute_target_capabilities (
    id uuid NOT NULL,
    organization_id uuid NOT NULL,
    compute_target_id uuid NOT NULL,
    project_id uuid NOT NULL,
    source character varying(16) NOT NULL,
    content text NOT NULL,
    capabilities jsonb,
    problems jsonb DEFAULT '[]'::jsonb NOT NULL,
    warnings jsonb DEFAULT '[]'::jsonb NOT NULL,
    content_hash character varying(64) NOT NULL,
    uploaded_at timestamp(3) without time zone NOT NULL,
    created_at timestamp(3) without time zone DEFAULT CURRENT_TIMESTAMP NOT NULL,
    updated_at timestamp(3) without time zone NOT NULL
);

CREATE TABLE public.compute_target_health_checks (
    id uuid NOT NULL,
    organization_id uuid NOT NULL,
    compute_target_id uuid NOT NULL,
    checked_at timestamp(3) without time zone NOT NULL,
    expected_mcp_url text,
    latest_version text,
    result jsonb NOT NULL,
    all_required_passed boolean NOT NULL,
    required_failure_ids jsonb DEFAULT '[]'::jsonb NOT NULL,
    schema_version integer DEFAULT 1 NOT NULL,
    created_at timestamp(3) without time zone DEFAULT CURRENT_TIMESTAMP NOT NULL,
    updated_at timestamp(3) without time zone NOT NULL,
    plugin_auto_update_enabled boolean DEFAULT false NOT NULL
);

CREATE TABLE public.compute_targets (
    id uuid NOT NULL,
    organization_id uuid NOT NULL,
    user_id uuid NOT NULL,
    machine_name text NOT NULL,
    platform text NOT NULL,
    capabilities jsonb DEFAULT '{}'::jsonb NOT NULL,
    supported_operations jsonb DEFAULT '[]'::jsonb NOT NULL,
    last_seen_at timestamp(3) without time zone DEFAULT CURRENT_TIMESTAMP NOT NULL,
    is_online boolean DEFAULT false NOT NULL,
    created_at timestamp(3) without time zone DEFAULT CURRENT_TIMESTAMP NOT NULL,
    updated_at timestamp(3) without time zone NOT NULL,
    is_shared_with_org boolean DEFAULT false NOT NULL,
    gateway_id text,
    last_agent_session_sync_at timestamp(3) without time zone,
    selected_harness text DEFAULT 'claude'::text NOT NULL,
    is_cloud_sentinel boolean DEFAULT false NOT NULL,
    last_agent_session_sync_attempt_at timestamp(3) without time zone,
    model_provider jsonb,
    model_provider_token_encrypted text
);

CREATE TABLE public.custom_field_enum_options (
    id uuid NOT NULL,
    custom_field_id uuid NOT NULL,
    name text NOT NULL,
    color text DEFAULT 'none'::text NOT NULL,
    enabled boolean DEFAULT true NOT NULL,
    sort_order integer DEFAULT 0 NOT NULL
);

CREATE TABLE public.custom_field_settings (
    id uuid NOT NULL,
    custom_field_id uuid NOT NULL,
    organization_id uuid NOT NULL,
    entity_type public."CustomFieldEntityType" NOT NULL,
    entity_id uuid NOT NULL,
    is_important boolean DEFAULT false NOT NULL,
    is_required boolean DEFAULT false NOT NULL,
    sort_order integer DEFAULT 0 NOT NULL,
    created_at timestamp(3) without time zone DEFAULT CURRENT_TIMESTAMP NOT NULL
);

CREATE TABLE public.custom_field_values (
    id uuid NOT NULL,
    custom_field_id uuid NOT NULL,
    organization_id uuid NOT NULL,
    entity_type public."CustomFieldEntityType" NOT NULL,
    entity_id uuid NOT NULL,
    text_value text,
    number_value double precision,
    date_value timestamp(3) without time zone,
    enum_value_id uuid,
    multi_enum_value_ids text[] NOT NULL,
    people_value_ids text[] NOT NULL,
    display_value text,
    updated_at timestamp(3) without time zone NOT NULL,
    updated_by_id uuid
);

CREATE TABLE public.custom_fields (
    id uuid NOT NULL,
    organization_id uuid NOT NULL,
    name text NOT NULL,
    description text,
    field_type public."CustomFieldType" NOT NULL,
    created_by_id uuid,
    "precision" integer,
    number_format public."NumberFormat",
    currency_code text,
    custom_label text,
    custom_label_position public."LabelPosition",
    is_global_to_org boolean DEFAULT true NOT NULL,
    created_at timestamp(3) without time zone DEFAULT CURRENT_TIMESTAMP NOT NULL,
    updated_at timestamp(3) without time zone NOT NULL,
    entity_types public."CustomFieldEntityType"[] DEFAULT ARRAY[]::public."CustomFieldEntityType"[],
    show_in_table boolean DEFAULT false NOT NULL,
    is_searchable boolean DEFAULT false NOT NULL,
    is_sortable boolean DEFAULT false NOT NULL
);

CREATE TABLE public.definition_version_editors (
    id uuid NOT NULL,
    definition_version_id uuid NOT NULL,
    user_id uuid NOT NULL,
    role public.definition_version_editor_role DEFAULT 'editor'::public.definition_version_editor_role NOT NULL,
    first_edited_at timestamp(3) without time zone DEFAULT CURRENT_TIMESTAMP NOT NULL,
    last_edited_at timestamp(3) without time zone DEFAULT CURRENT_TIMESTAMP NOT NULL,
    created_at timestamp(3) without time zone DEFAULT CURRENT_TIMESTAMP NOT NULL,
    updated_at timestamp(3) without time zone NOT NULL
);

CREATE TABLE public.definition_versions (
    id uuid NOT NULL,
    organization_id uuid NOT NULL,
    component_kind text NOT NULL,
    definition_hash text NOT NULL,
    normalizer_contract_version integer NOT NULL,
    content text NOT NULL,
    format text,
    first_seen_at timestamp(3) without time zone DEFAULT CURRENT_TIMESTAMP NOT NULL,
    last_seen_at timestamp(3) without time zone DEFAULT CURRENT_TIMESTAMP NOT NULL,
    created_at timestamp(3) without time zone DEFAULT CURRENT_TIMESTAMP NOT NULL,
    updated_at timestamp(3) without time zone NOT NULL
);

CREATE TABLE public.deployment_detail (
    artifact_id uuid NOT NULL,
    environment text,
    ref text,
    sha text,
    github_status_url text,
    github_deployment_url text,
    transient boolean,
    production boolean,
    branch_artifact_id uuid,
    provider character varying(32) DEFAULT 'github'::character varying NOT NULL,
    provider_detail jsonb
);

CREATE TABLE public.deployment_events (
    id uuid NOT NULL,
    organization_id uuid NOT NULL,
    project_id uuid,
    repository_id uuid,
    branch_artifact_id uuid,
    source character varying(32) NOT NULL,
    external_deployment_id character varying(200) NOT NULL,
    external_event_id character varying(200) NOT NULL,
    state character varying(32) NOT NULL,
    provider_state character varying(64) NOT NULL,
    environment text,
    ref text,
    sha text,
    environment_url text,
    github_status_url text,
    github_deployment_url text,
    production boolean,
    transient boolean,
    occurred_at timestamp(3) without time zone NOT NULL,
    deployment_created_at timestamp(3) without time zone,
    created_at timestamp(3) without time zone DEFAULT CURRENT_TIMESTAMP NOT NULL
);

CREATE TABLE public.desktop_authorization_codes (
    id uuid NOT NULL,
    code_hash text NOT NULL,
    user_id uuid NOT NULL,
    organization_id uuid NOT NULL,
    gateway_id text NOT NULL,
    bound_public_key text NOT NULL,
    code_challenge text NOT NULL,
    redirect_uri text NOT NULL,
    expires_at timestamp(3) without time zone NOT NULL,
    redeemed_at timestamp(3) without time zone,
    created_at timestamp(3) without time zone DEFAULT CURRENT_TIMESTAMP NOT NULL
);

CREATE TABLE public.desktop_command_events (
    command_id uuid NOT NULL,
    sequence integer NOT NULL,
    event_type text NOT NULL,
    event_payload jsonb NOT NULL,
    created_at timestamp(3) without time zone DEFAULT CURRENT_TIMESTAMP NOT NULL
);

CREATE TABLE public.desktop_commands (
    id uuid NOT NULL,
    compute_target_id uuid NOT NULL,
    idempotency_key text,
    request_fingerprint text NOT NULL,
    operation_id text NOT NULL,
    request_payload jsonb NOT NULL,
    status text NOT NULL,
    error text,
    last_sequence_acked integer DEFAULT 0 NOT NULL,
    queued_timeout_ms integer,
    running_timeout_ms integer,
    created_at timestamp(3) without time zone DEFAULT CURRENT_TIMESTAMP NOT NULL,
    started_at timestamp(3) without time zone,
    finished_at timestamp(3) without time zone
);

CREATE TABLE public.desktop_onboarding_attempts (
    attempt_id text NOT NULL,
    user_id uuid NOT NULL,
    organization_id uuid NOT NULL,
    web_app_origin text NOT NULL,
    expires_at timestamp(3) without time zone NOT NULL,
    consumed_at timestamp(3) without time zone,
    compute_target_id uuid,
    flow_type text,
    gateway_id text
);

CREATE TABLE public.desktop_onboarding_device_sessions (
    id uuid NOT NULL,
    device_session_secret_hash text NOT NULL,
    user_code text NOT NULL,
    request_ip_hash text,
    web_app_origin text NOT NULL,
    gateway_id text NOT NULL,
    gateway_public_key_pem text NOT NULL,
    machine_name text NOT NULL,
    platform text NOT NULL,
    desktop_version text NOT NULL,
    desktop_security_upgrade_protocol_version integer NOT NULL,
    status text DEFAULT 'pending'::text NOT NULL,
    user_id uuid,
    organization_id uuid,
    onboarding_attempt_id text,
    denied_at timestamp(3) without time zone,
    approved_at timestamp(3) without time zone,
    expires_at timestamp(3) without time zone NOT NULL,
    created_at timestamp(3) without time zone DEFAULT CURRENT_TIMESTAMP NOT NULL,
    updated_at timestamp(3) without time zone NOT NULL
);

CREATE TABLE public.desktop_refresh_tokens (
    id uuid NOT NULL,
    session_id uuid NOT NULL,
    family_id uuid NOT NULL,
    token_hash text NOT NULL,
    created_at timestamp(3) without time zone DEFAULT CURRENT_TIMESTAMP NOT NULL,
    expires_at timestamp(3) without time zone NOT NULL,
    last_used_at timestamp(3) without time zone,
    revoked_at timestamp(3) without time zone,
    replaced_by_token_id uuid,
    rotated_from_token_id uuid
);

CREATE TABLE public.desktop_sessions (
    id uuid NOT NULL,
    user_id uuid NOT NULL,
    organization_id uuid NOT NULL,
    gateway_id text NOT NULL,
    bound_public_key text NOT NULL,
    metadata jsonb DEFAULT '{}'::jsonb NOT NULL,
    created_at timestamp(3) without time zone DEFAULT CURRENT_TIMESTAMP NOT NULL,
    last_used_at timestamp(3) without time zone,
    revoked_at timestamp(3) without time zone,
    expires_at timestamp(3) without time zone NOT NULL,
    updated_at timestamp(3) without time zone NOT NULL
);

CREATE TABLE public.distribution_target_status (
    id uuid NOT NULL,
    distribution_id uuid NOT NULL,
    compute_target_id uuid,
    user_id uuid,
    status text NOT NULL,
    installed_version text,
    install_run_id text,
    failure_reason text,
    installed_at timestamp(3) without time zone,
    enabled_at timestamp(3) without time zone,
    reported_at timestamp(3) without time zone,
    created_at timestamp(3) without time zone DEFAULT CURRENT_TIMESTAMP NOT NULL,
    updated_at timestamp(3) without time zone NOT NULL,
    overridden_locally boolean DEFAULT false NOT NULL
);

CREATE TABLE public.distribution_targeting_entries (
    id uuid NOT NULL,
    distribution_id uuid NOT NULL,
    compute_target_id uuid,
    user_id uuid,
    created_at timestamp(3) without time zone DEFAULT CURRENT_TIMESTAMP NOT NULL
);

CREATE TABLE public.distributions (
    id uuid NOT NULL,
    organization_id uuid NOT NULL,
    catalog_item_id uuid NOT NULL,
    mode text NOT NULL,
    targeting_type text NOT NULL,
    desired_enabled boolean DEFAULT true NOT NULL,
    created_by_id uuid,
    created_at timestamp(3) without time zone DEFAULT CURRENT_TIMESTAMP NOT NULL,
    updated_at timestamp(3) without time zone NOT NULL,
    withdrawn_at timestamp(3) without time zone,
    withdrawn_by_id uuid
);

CREATE TABLE public.document_detail (
    artifact_id uuid NOT NULL,
    file_name text,
    approver_id uuid,
    template_for_type public."ArtifactSubtype",
    latest_version integer DEFAULT 1 NOT NULL,
    repository_snapshot jsonb NOT NULL
);

CREATE TABLE public.document_versions (
    id uuid NOT NULL,
    artifact_id uuid NOT NULL,
    version integer NOT NULL,
    content text,
    created_by_id uuid,
    created_at timestamp(3) without time zone DEFAULT CURRENT_TIMESTAMP NOT NULL
);

CREATE TABLE public.external_comment_authors (
    id uuid NOT NULL,
    organization_id uuid NOT NULL,
    provider public."ExternalCommentProvider" NOT NULL,
    provider_user_id text NOT NULL,
    provider_node_id text,
    provider_login text NOT NULL,
    normalized_provider_login text NOT NULL,
    display_name text,
    avatar_url text,
    profile_url text,
    user_id uuid NOT NULL,
    first_seen_at timestamp(3) without time zone DEFAULT CURRENT_TIMESTAMP NOT NULL,
    last_seen_at timestamp(3) without time zone DEFAULT CURRENT_TIMESTAMP NOT NULL,
    created_at timestamp(3) without time zone DEFAULT CURRENT_TIMESTAMP NOT NULL,
    updated_at timestamp(3) without time zone NOT NULL,
    provider_detail jsonb
);

CREATE TABLE public.favorite_artifacts (
    id uuid NOT NULL,
    user_id uuid NOT NULL,
    artifact_id uuid NOT NULL,
    created_at timestamp(3) without time zone DEFAULT CURRENT_TIMESTAMP NOT NULL
);

CREATE TABLE public.favorite_projects (
    id uuid NOT NULL,
    user_id uuid NOT NULL,
    project_id uuid NOT NULL,
    created_at timestamp(3) without time zone DEFAULT CURRENT_TIMESTAMP NOT NULL
);

CREATE TABLE public.file_attachments (
    id uuid NOT NULL,
    artifact_id uuid,
    bucket text NOT NULL,
    key text NOT NULL,
    filename text NOT NULL,
    mime_type text NOT NULL,
    size_bytes integer NOT NULL,
    created_at timestamp(3) without time zone DEFAULT CURRENT_TIMESTAMP NOT NULL,
    created_by_id uuid NOT NULL,
    purpose text DEFAULT 'context'::text NOT NULL,
    reconciled_at timestamp(3) without time zone DEFAULT CURRENT_TIMESTAMP NOT NULL,
    reconcile_absent boolean DEFAULT false NOT NULL
);

CREATE TABLE public.github_access_capabilities (
    id uuid NOT NULL,
    organization_id uuid NOT NULL,
    github_user_connection_id uuid NOT NULL,
    target_owner text NOT NULL,
    normalized_target_owner text NOT NULL,
    target_repo text,
    credential_kind text NOT NULL,
    denial_reason text,
    installation_id text,
    checked_at timestamp(3) without time zone NOT NULL,
    expires_at timestamp(3) without time zone NOT NULL,
    created_at timestamp(3) without time zone DEFAULT CURRENT_TIMESTAMP NOT NULL,
    updated_at timestamp(3) without time zone NOT NULL
);

CREATE TABLE public.github_comment_projections (
    comment_id uuid NOT NULL,
    thread_id uuid NOT NULL,
    github_comment_id text,
    github_in_reply_to_comment_id text,
    github_html_url text,
    github_updated_at timestamp(3) without time zone,
    github_deleted_at timestamp(3) without time zone,
    external_author_id uuid,
    fetch_credential_owner_id uuid,
    fetch_credential_type character varying(32),
    fetch_mechanism character varying(32),
    fetch_observed_at timestamp(3) without time zone,
    fetch_result_reason character varying(64),
    fetch_trigger character varying(32)
);

CREATE TABLE public.github_comment_thread_projections (
    thread_id uuid NOT NULL,
    branch_artifact_id uuid NOT NULL,
    pull_request_detail_id uuid NOT NULL,
    thread_kind public."GitHubCommentThreadKind" NOT NULL,
    review_thread_id text,
    root_comment_id text,
    review_id text,
    path text,
    line integer,
    side public."GitHubDiffSide",
    start_line integer,
    start_side public."GitHubDiffSide",
    commit_sha text,
    html_url text,
    resolvable boolean DEFAULT false NOT NULL,
    legacy_state public."GitHubLegacyCommentState",
    deleted_at timestamp(3) without time zone,
    last_synced_at timestamp(3) without time zone,
    fetch_credential_owner_id uuid,
    fetch_credential_type character varying(32),
    fetch_mechanism character varying(32),
    fetch_observed_at timestamp(3) without time zone,
    fetch_result_reason character varying(64),
    fetch_trigger character varying(32)
);

CREATE TABLE public.github_dirty_scope_nudges (
    id uuid NOT NULL,
    organization_id uuid NOT NULL,
    github_installation_repository_id uuid NOT NULL,
    compute_target_id uuid NOT NULL,
    window_started_at timestamp(3) without time zone NOT NULL,
    dirty_scopes jsonb NOT NULL,
    generic_refresh boolean DEFAULT false NOT NULL,
    scheduled_dispatch_at timestamp(3) without time zone NOT NULL,
    dispatch_claimed_at timestamp(3) without time zone,
    dispatched_at timestamp(3) without time zone,
    expires_at timestamp(3) without time zone NOT NULL,
    delivery_result jsonb,
    created_at timestamp(3) without time zone DEFAULT CURRENT_TIMESTAMP NOT NULL,
    updated_at timestamp(3) without time zone NOT NULL
);

CREATE TABLE public.github_installation_repositories (
    id uuid NOT NULL,
    installation_id uuid NOT NULL,
    github_repo_id text NOT NULL,
    full_name text NOT NULL,
    name text NOT NULL,
    owner text NOT NULL,
    private boolean NOT NULL,
    created_at timestamp(3) without time zone DEFAULT CURRENT_TIMESTAMP NOT NULL,
    updated_at timestamp(3) without time zone NOT NULL,
    last_pushed_at timestamp(3) without time zone,
    removed_at timestamp(3) without time zone,
    default_branch_availability character varying(32),
    default_branch_completeness character varying(32),
    default_branch_credential_owner_id uuid,
    default_branch_credential_type character varying(32),
    default_branch_event_at timestamp(3) without time zone,
    default_branch_mechanism character varying(32),
    default_branch_name text,
    default_branch_observation_key text,
    default_branch_observed_at timestamp(3) without time zone,
    default_branch_reason character varying(64),
    default_branch_source character varying(64),
    default_branch_trigger character varying(32)
);

CREATE TABLE public.github_installations (
    id uuid NOT NULL,
    organization_id uuid,
    installation_id text NOT NULL,
    account_login text NOT NULL,
    account_type text NOT NULL,
    created_at timestamp(3) without time zone DEFAULT CURRENT_TIMESTAMP NOT NULL,
    updated_at timestamp(3) without time zone NOT NULL,
    account_id text NOT NULL,
    sender_login text NOT NULL,
    sender_id text NOT NULL,
    status public."GitHubInstallationStatus" DEFAULT 'PENDING_CLAIM'::public."GitHubInstallationStatus" NOT NULL,
    permissions jsonb,
    events jsonb,
    repository_selection text,
    suspended_at timestamp(3) without time zone,
    suspended_by text,
    claimed_at timestamp(3) without time zone,
    claimed_by_user_id uuid,
    pending_new_installation_id text,
    provider character varying(32) DEFAULT 'github'::character varying NOT NULL,
    provider_detail jsonb
);

CREATE TABLE public.github_pr_reviews (
    id uuid NOT NULL,
    pull_request_id uuid NOT NULL,
    github_review_id text NOT NULL,
    author_login text NOT NULL,
    author_avatar_url text,
    state public."ReviewDecision" NOT NULL,
    body text,
    html_url text NOT NULL,
    submitted_at timestamp(3) without time zone NOT NULL,
    created_at timestamp(3) without time zone DEFAULT CURRENT_TIMESTAMP NOT NULL,
    updated_at timestamp(3) without time zone NOT NULL,
    fetch_credential_owner_id uuid,
    fetch_credential_type character varying(32),
    fetch_mechanism character varying(32),
    fetch_observed_at timestamp(3) without time zone,
    fetch_result_reason character varying(64),
    fetch_trigger character varying(32)
);

CREATE TABLE public.github_repo_sync_state (
    id uuid NOT NULL,
    organization_id uuid NOT NULL,
    repository_full_name text NOT NULL,
    tier text DEFAULT 'unsyncable'::text NOT NULL,
    watermark timestamp(3) without time zone,
    cursor text,
    last_swept_at timestamp(3) without time zone,
    last_tier_evaluated_at timestamp(3) without time zone,
    consecutive_failure_count integer DEFAULT 0 NOT NULL,
    deferred_reason text,
    created_at timestamp(3) without time zone DEFAULT CURRENT_TIMESTAMP NOT NULL,
    updated_at timestamp(3) without time zone NOT NULL,
    next_retry_at timestamp(3) without time zone
);

CREATE TABLE public.github_user_connections (
    id uuid NOT NULL,
    organization_id uuid NOT NULL,
    user_id uuid NOT NULL,
    github_user_id text NOT NULL,
    github_node_id text,
    login text NOT NULL,
    normalized_login text NOT NULL,
    avatar_url text,
    profile_url text,
    access_token_encrypted text NOT NULL,
    refresh_token_encrypted text,
    token_expires_at timestamp(3) without time zone,
    refresh_token_expires_at timestamp(3) without time zone,
    scopes text[] DEFAULT ARRAY[]::text[] NOT NULL,
    revoked_at timestamp(3) without time zone,
    last_used_at timestamp(3) without time zone,
    created_at timestamp(3) without time zone DEFAULT CURRENT_TIMESTAMP NOT NULL,
    updated_at timestamp(3) without time zone NOT NULL,
    backoff_until timestamp(3) without time zone,
    health_state text DEFAULT 'healthy'::text NOT NULL,
    observed_limit integer,
    observed_remaining integer,
    observed_reset_at timestamp(3) without time zone,
    rate_limit_tier integer,
    window_spend integer DEFAULT 0 NOT NULL
);

CREATE TABLE public.google_integrations (
    id uuid DEFAULT gen_random_uuid() NOT NULL,
    organization_id uuid NOT NULL,
    google_user_id text NOT NULL,
    google_email character varying(255),
    access_token text NOT NULL,
    refresh_token text,
    token_expires_at timestamp(3) without time zone,
    last_used_at timestamp(3) without time zone,
    created_at timestamp(3) without time zone DEFAULT CURRENT_TIMESTAMP NOT NULL,
    updated_at timestamp(3) without time zone NOT NULL,
    access_token_encrypted text,
    refresh_token_encrypted text
);

CREATE TABLE public.integration_connections (
    id uuid NOT NULL,
    organization_id uuid NOT NULL,
    provider character varying(32) NOT NULL,
    name character varying(120) NOT NULL,
    status character varying(16) DEFAULT 'active'::character varying NOT NULL,
    config jsonb DEFAULT '{}'::jsonb NOT NULL,
    credentials_encrypted text,
    credential_hints jsonb DEFAULT '{}'::jsonb NOT NULL,
    account jsonb,
    inbound_key character varying(64) NOT NULL,
    inbound_secret_encrypted text,
    delivery_mode character varying(16) DEFAULT 'none'::character varying NOT NULL,
    poll_interval_seconds integer DEFAULT 120 NOT NULL,
    poll_cursor jsonb,
    next_poll_at timestamp(3) without time zone,
    last_polled_at timestamp(3) without time zone,
    last_delivery_at timestamp(3) without time zone,
    last_validated_at timestamp(3) without time zone,
    last_error text,
    created_by_id uuid,
    created_at timestamp(3) without time zone DEFAULT CURRENT_TIMESTAMP NOT NULL,
    updated_at timestamp(3) without time zone NOT NULL,
    managed_by_workflow_id uuid
);

CREATE TABLE public.integration_deliveries (
    id uuid NOT NULL,
    organization_id uuid NOT NULL,
    connection_id uuid NOT NULL,
    delivery_id character varying(255) NOT NULL,
    source character varying(16) NOT NULL,
    event_type character varying(128),
    outcome character varying(16) NOT NULL,
    detail text,
    run_count integer DEFAULT 0 NOT NULL,
    payload jsonb,
    received_at timestamp(3) without time zone DEFAULT CURRENT_TIMESTAMP NOT NULL
);

CREATE TABLE public.integration_tool_calls (
    id uuid NOT NULL,
    organization_id uuid NOT NULL,
    session_id uuid NOT NULL,
    action_run_id uuid,
    tool character varying(80) NOT NULL,
    operation_type character varying(64),
    connection_key character varying(40),
    idempotency_key character varying(64) NOT NULL,
    input jsonb NOT NULL,
    status character varying(16) NOT NULL,
    external_ref text,
    error text,
    completed_at timestamp(3) without time zone,
    created_at timestamp(3) without time zone DEFAULT CURRENT_TIMESTAMP NOT NULL,
    decided_at timestamp(3) without time zone,
    decided_by_id uuid,
    loop_id uuid,
    request jsonb,
    run_id uuid NOT NULL
);

CREATE TABLE public.integration_tool_sessions (
    id uuid NOT NULL,
    organization_id uuid NOT NULL,
    action_run_id uuid,
    attempt integer,
    compute_target_id uuid NOT NULL,
    token_hash character varying(64),
    issued_at timestamp(3) without time zone,
    expires_at timestamp(3) without time zone NOT NULL,
    created_at timestamp(3) without time zone DEFAULT CURRENT_TIMESTAMP NOT NULL,
    loop_id uuid,
    run_id uuid NOT NULL,
    step_id character varying(64),
    CONSTRAINT integration_tool_sessions_subject_check CHECK ((((action_run_id IS NOT NULL) AND (attempt IS NOT NULL) AND (loop_id IS NULL)) OR ((action_run_id IS NULL) AND (attempt IS NULL) AND (loop_id IS NOT NULL))))
);

CREATE TABLE public.judge_human_scores (
    id uuid NOT NULL,
    evaluation_id uuid NOT NULL,
    judge_score_id uuid NOT NULL,
    user_id uuid NOT NULL,
    organization_id uuid NOT NULL,
    score double precision NOT NULL,
    created_at timestamp(3) without time zone DEFAULT CURRENT_TIMESTAMP NOT NULL,
    updated_at timestamp(3) without time zone NOT NULL
);

CREATE TABLE public.judge_scores (
    id uuid NOT NULL,
    evaluation_id uuid NOT NULL,
    prompt_id uuid,
    case_id text NOT NULL,
    threshold double precision NOT NULL,
    score double precision NOT NULL,
    justification text NOT NULL,
    final_status public."EvalStatus" NOT NULL,
    created_at timestamp(3) without time zone DEFAULT CURRENT_TIMESTAMP NOT NULL,
    metric_name text NOT NULL
);

CREATE TABLE public.linear_integrations (
    id uuid NOT NULL,
    organization_id uuid NOT NULL,
    access_token text NOT NULL,
    refresh_token text,
    token_expires_at timestamp(3) without time zone,
    linear_org_id text NOT NULL,
    linear_org_name text NOT NULL,
    default_team_id text,
    webhook_id text,
    webhook_secret text,
    created_at timestamp(3) without time zone DEFAULT CURRENT_TIMESTAMP NOT NULL,
    updated_at timestamp(3) without time zone NOT NULL,
    access_token_encrypted text,
    refresh_token_encrypted text
);

CREATE TABLE public.linear_subtasks (
    id uuid NOT NULL,
    linear_id text NOT NULL,
    linear_key text NOT NULL,
    linear_url text NOT NULL,
    title text NOT NULL,
    description text,
    is_completed boolean DEFAULT false NOT NULL,
    created_at timestamp(3) without time zone DEFAULT CURRENT_TIMESTAMP NOT NULL,
    updated_at timestamp(3) without time zone NOT NULL,
    organization_id uuid NOT NULL,
    document_id uuid NOT NULL
);

CREATE TABLE public.local_gateway_challenge_jtis (
    jti text NOT NULL,
    expires_at timestamp(3) without time zone NOT NULL,
    created_at timestamp(3) without time zone DEFAULT CURRENT_TIMESTAMP NOT NULL
);

CREATE TABLE public.loop_events (
    id uuid NOT NULL,
    loop_id uuid NOT NULL,
    type text NOT NULL,
    data jsonb DEFAULT '{}'::jsonb NOT NULL,
    created_at timestamp(3) without time zone DEFAULT CURRENT_TIMESTAMP NOT NULL,
    runner_token_jti text,
    runner_nonce uuid,
    event_source text DEFAULT 'system'::text NOT NULL,
    event_id text NOT NULL,
    CONSTRAINT loop_events_replay_fields_both_or_none CHECK ((((runner_token_jti IS NULL) AND (runner_nonce IS NULL)) OR ((runner_token_jti IS NOT NULL) AND (runner_nonce IS NOT NULL))))
);

CREATE TABLE public.loop_execution_credential_consumptions (
    command_id uuid NOT NULL,
    loop_id uuid NOT NULL,
    compute_target_id uuid NOT NULL,
    gateway_id text NOT NULL,
    action text NOT NULL,
    consumed_at timestamp(3) without time zone DEFAULT CURRENT_TIMESTAMP NOT NULL
);

CREATE TABLE public.loop_token_refresh (
    id uuid NOT NULL,
    loop_id uuid NOT NULL,
    jti text NOT NULL,
    refreshed_at timestamp(3) without time zone NOT NULL,
    created_at timestamp(3) without time zone DEFAULT CURRENT_TIMESTAMP NOT NULL
);

CREATE TABLE public.loops (
    id uuid NOT NULL,
    organization_id uuid NOT NULL,
    user_id uuid NOT NULL,
    status public."LoopStatus" DEFAULT 'PENDING'::public."LoopStatus" NOT NULL,
    command public."LoopCommand" NOT NULL,
    artifact_id uuid,
    parent_loop_id uuid,
    prompt text,
    repo jsonb,
    context_refs jsonb,
    container_id text,
    s3_state_key text,
    tokens_input integer DEFAULT 0 NOT NULL,
    tokens_output integer DEFAULT 0 NOT NULL,
    estimated_cost numeric(10,6),
    started_at timestamp(3) without time zone,
    completed_at timestamp(3) without time zone,
    error jsonb,
    metadata jsonb DEFAULT '{}'::jsonb NOT NULL,
    created_at timestamp(3) without time zone DEFAULT CURRENT_TIMESTAMP NOT NULL,
    updated_at timestamp(3) without time zone NOT NULL,
    tokens_by_model jsonb,
    branch_name text,
    pr_number integer,
    pr_url text,
    session_id text,
    compute_target_id uuid,
    uploaded_artifacts jsonb,
    artifact_version integer,
    additional_repos jsonb,
    active_token_jti text,
    last_runner_heartbeat_at timestamp(3) without time zone,
    runner_capabilities jsonb,
    token_expires_at timestamp(3) without time zone,
    revival_count integer DEFAULT 0 NOT NULL,
    last_revival_at timestamp(3) without time zone,
    harness text DEFAULT 'claude'::text NOT NULL,
    session_artifact_id uuid,
    s3_state_cleaned_at timestamp(3) without time zone
);

CREATE TABLE public.oauth_authorization_codes (
    id uuid NOT NULL,
    encrypted_api_key text NOT NULL,
    key_id text NOT NULL,
    user_id uuid NOT NULL,
    organization_id uuid NOT NULL,
    client_id text NOT NULL,
    redirect_uri text NOT NULL,
    scopes text[] NOT NULL,
    code_challenge text NOT NULL,
    code_challenge_method text NOT NULL,
    expires_at timestamp(3) without time zone NOT NULL,
    consumed_at timestamp(3) without time zone,
    created_at timestamp(3) without time zone DEFAULT CURRENT_TIMESTAMP NOT NULL,
    code_fingerprint text NOT NULL
);

CREATE TABLE public.oauth_rate_limits (
    id uuid NOT NULL,
    bucket text NOT NULL,
    subject text NOT NULL,
    request_count integer DEFAULT 0 NOT NULL,
    window_started_at timestamp(3) without time zone NOT NULL,
    window_expires_at timestamp(3) without time zone NOT NULL,
    updated_at timestamp(3) without time zone NOT NULL
);

CREATE TABLE public.oauth_refresh_tokens (
    id uuid NOT NULL,
    token_fingerprint text NOT NULL,
    encrypted_api_key text NOT NULL,
    key_id text NOT NULL,
    user_id uuid NOT NULL,
    organization_id uuid NOT NULL,
    client_id text NOT NULL,
    scopes text[] NOT NULL,
    family_id uuid NOT NULL,
    expires_at timestamp(3) without time zone NOT NULL,
    last_used_at timestamp(3) without time zone,
    revoked_at timestamp(3) without time zone,
    replaced_by_token_id uuid,
    created_at timestamp(3) without time zone DEFAULT CURRENT_TIMESTAMP NOT NULL
);

CREATE TABLE public.oauth_revoked_tokens (
    id uuid NOT NULL,
    token_fingerprint text NOT NULL,
    expires_at timestamp(3) without time zone NOT NULL,
    revoked_at timestamp(3) without time zone DEFAULT CURRENT_TIMESTAMP NOT NULL
);

CREATE TABLE public.orchestrator_anchors (
    id uuid NOT NULL,
    organization_id uuid NOT NULL,
    conversation_id uuid NOT NULL,
    provider character varying(32) NOT NULL,
    external_ref character varying(255) NOT NULL,
    artifact character varying(40),
    version integer,
    created_at timestamp(3) without time zone DEFAULT CURRENT_TIMESTAMP NOT NULL
);

CREATE TABLE public.orchestrator_cases (
    id uuid NOT NULL,
    organization_id uuid NOT NULL,
    project_id uuid NOT NULL,
    source_key character varying(255),
    title character varying(255) NOT NULL,
    status character varying(16) DEFAULT 'open'::character varying NOT NULL,
    notes text DEFAULT ''::text NOT NULL,
    created_at timestamp(3) without time zone DEFAULT CURRENT_TIMESTAMP NOT NULL,
    updated_at timestamp(3) without time zone NOT NULL,
    workflow_id uuid NOT NULL
);

CREATE TABLE public.orchestrator_conversations (
    id uuid NOT NULL,
    organization_id uuid NOT NULL,
    project_id uuid NOT NULL,
    case_id uuid NOT NULL,
    channel_key character varying(255) NOT NULL,
    project_connection_id uuid,
    channel jsonb NOT NULL,
    session_id character varying(100),
    status character varying(16) DEFAULT 'idle'::character varying NOT NULL,
    lease_until timestamp(3) without time zone,
    next_wake_at timestamp(3) without time zone,
    created_at timestamp(3) without time zone DEFAULT CURRENT_TIMESTAMP NOT NULL,
    updated_at timestamp(3) without time zone NOT NULL
);

CREATE TABLE public.orchestrator_decisions (
    id uuid NOT NULL,
    organization_id uuid NOT NULL,
    case_id uuid NOT NULL,
    conversation_id uuid NOT NULL,
    question text NOT NULL,
    status character varying(16) DEFAULT 'pending'::character varying NOT NULL,
    via character varying(16),
    decided_by_id uuid,
    decided_by character varying(255),
    comment text,
    decided_at timestamp(3) without time zone,
    created_at timestamp(3) without time zone DEFAULT CURRENT_TIMESTAMP NOT NULL,
    updated_at timestamp(3) without time zone NOT NULL
);

CREATE TABLE public.orchestrator_messages (
    id uuid NOT NULL,
    organization_id uuid NOT NULL,
    conversation_id uuid NOT NULL,
    origin character varying(16) NOT NULL,
    kind character varying(16) NOT NULL,
    actor character varying(255),
    text text NOT NULL,
    payload jsonb,
    external_ref character varying(255),
    dedup_key character varying(255) NOT NULL,
    turn_id uuid,
    created_at timestamp(3) without time zone DEFAULT CURRENT_TIMESTAMP NOT NULL
);

CREATE TABLE public.orchestrator_tasks (
    id uuid NOT NULL,
    organization_id uuid NOT NULL,
    case_id uuid NOT NULL,
    conversation_id uuid NOT NULL,
    turn_id uuid,
    compute_target_id uuid,
    command character varying(120) NOT NULL,
    args text DEFAULT ''::text NOT NULL,
    prompt text NOT NULL,
    mode character varying(16) NOT NULL,
    loop_id uuid,
    document_id uuid,
    resume_task_id uuid,
    fork boolean DEFAULT false NOT NULL,
    status character varying(16) NOT NULL,
    result jsonb,
    finished_at timestamp(3) without time zone,
    created_at timestamp(3) without time zone DEFAULT CURRENT_TIMESTAMP NOT NULL,
    updated_at timestamp(3) without time zone NOT NULL
);

CREATE TABLE public.orchestrator_turns (
    id uuid NOT NULL,
    organization_id uuid NOT NULL,
    conversation_id uuid NOT NULL,
    status character varying(16) NOT NULL,
    compute_target_id uuid,
    command_id uuid,
    token_hash character varying(64),
    token_expires_at timestamp(3) without time zone,
    session_id character varying(100),
    ended character varying(16),
    summary text,
    error text,
    usage jsonb,
    started_at timestamp(3) without time zone NOT NULL,
    finished_at timestamp(3) without time zone,
    created_at timestamp(3) without time zone DEFAULT CURRENT_TIMESTAMP NOT NULL,
    updated_at timestamp(3) without time zone NOT NULL
);

CREATE TABLE public.orchestrator_waits (
    id uuid NOT NULL,
    organization_id uuid NOT NULL,
    conversation_id uuid NOT NULL,
    kind character varying(16) NOT NULL,
    task_ids jsonb NOT NULL,
    deadline timestamp(3) without time zone,
    wake_on_failure boolean DEFAULT true NOT NULL,
    fired_at timestamp(3) without time zone,
    created_at timestamp(3) without time zone DEFAULT CURRENT_TIMESTAMP NOT NULL
);

CREATE TABLE public.organizations (
    id uuid NOT NULL,
    clerk_id text NOT NULL,
    active boolean DEFAULT true NOT NULL,
    name text NOT NULL,
    slug text NOT NULL,
    settings jsonb DEFAULT '{}'::jsonb NOT NULL,
    created_at timestamp(3) without time zone DEFAULT CURRENT_TIMESTAMP NOT NULL,
    updated_at timestamp(3) without time zone NOT NULL,
    claude_api_key_encrypted text,
    claude_api_key_last_four text,
    claude_api_key_set_at timestamp(3) without time zone,
    search_include_transcripts boolean DEFAULT false NOT NULL
);

CREATE TABLE public.preview_schemas (
    schema_name text NOT NULL,
    branch text,
    created_at timestamp(3) without time zone DEFAULT CURRENT_TIMESTAMP NOT NULL,
    last_seen_at timestamp(3) without time zone DEFAULT CURRENT_TIMESTAMP NOT NULL
);

CREATE TABLE public.preview_schemas_observations (
    schema_name text NOT NULL,
    first_observed_at timestamp with time zone DEFAULT CURRENT_TIMESTAMP NOT NULL
);

CREATE TABLE public.project_connection_scopes (
    id uuid NOT NULL,
    organization_id uuid NOT NULL,
    project_connection_id uuid NOT NULL,
    scope_key character varying(1024) NOT NULL,
    created_at timestamp(3) without time zone DEFAULT CURRENT_TIMESTAMP NOT NULL
);

CREATE TABLE public.project_connections (
    id uuid NOT NULL,
    organization_id uuid NOT NULL,
    project_id uuid NOT NULL,
    connection_id uuid NOT NULL,
    key character varying(40) NOT NULL,
    name character varying(120) NOT NULL,
    settings jsonb DEFAULT '{}'::jsonb NOT NULL,
    created_by_id uuid,
    created_at timestamp(3) without time zone DEFAULT CURRENT_TIMESTAMP NOT NULL,
    updated_at timestamp(3) without time zone NOT NULL
);

CREATE TABLE public.project_process_versions (
    id uuid NOT NULL,
    organization_id uuid NOT NULL,
    project_id uuid NOT NULL,
    version integer NOT NULL,
    definition jsonb NOT NULL,
    created_by_id uuid,
    created_at timestamp(3) without time zone DEFAULT CURRENT_TIMESTAMP NOT NULL
);

CREATE TABLE public.project_repositories (
    id uuid NOT NULL,
    organization_id uuid NOT NULL,
    project_id uuid NOT NULL,
    connection_id uuid,
    provider character varying(32) NOT NULL,
    external_id character varying(255) NOT NULL,
    full_name character varying(512) NOT NULL,
    name character varying(255) NOT NULL,
    default_branch character varying(255),
    web_url text NOT NULL,
    clone_url text NOT NULL,
    is_primary boolean DEFAULT false NOT NULL,
    created_by_id uuid,
    created_at timestamp(3) without time zone DEFAULT CURRENT_TIMESTAMP NOT NULL,
    updated_at timestamp(3) without time zone NOT NULL
);

CREATE TABLE public.projects (
    id uuid NOT NULL,
    organization_id uuid NOT NULL,
    name text NOT NULL,
    description text,
    priority public."Priority" DEFAULT 'MEDIUM'::public."Priority" NOT NULL,
    assignee_id uuid,
    target_date timestamp(3) without time zone,
    codebase_summary text,
    last_indexed_at timestamp(3) without time zone,
    settings jsonb DEFAULT '{}'::jsonb NOT NULL,
    created_at timestamp(3) without time zone DEFAULT CURRENT_TIMESTAMP NOT NULL,
    updated_at timestamp(3) without time zone NOT NULL,
    sort_order integer,
    created_by_id uuid NOT NULL,
    status public."ProjectStatus" DEFAULT 'NOT_STARTED'::public."ProjectStatus" NOT NULL,
    slug text
);

CREATE TABLE public.prompt_registry (
    id uuid NOT NULL,
    organization_id uuid NOT NULL,
    prompt_type public."PromptType" NOT NULL,
    name text NOT NULL,
    description text NOT NULL,
    model text NOT NULL,
    tools text[],
    file_path text NOT NULL,
    content text NOT NULL,
    version integer NOT NULL,
    created_at timestamp(3) without time zone DEFAULT CURRENT_TIMESTAMP NOT NULL
);

CREATE TABLE public.public_repositories (
    id uuid NOT NULL,
    organization_id uuid NOT NULL,
    github_repo_id text NOT NULL,
    full_name text NOT NULL,
    owner text NOT NULL,
    name text NOT NULL,
    html_url text NOT NULL,
    created_at timestamp(3) without time zone DEFAULT CURRENT_TIMESTAMP NOT NULL,
    updated_at timestamp(3) without time zone NOT NULL,
    default_branch_availability character varying(32),
    default_branch_completeness character varying(32),
    default_branch_credential_owner_id uuid,
    default_branch_credential_type character varying(32),
    default_branch_event_at timestamp(3) without time zone,
    default_branch_mechanism character varying(32),
    default_branch_name text,
    default_branch_observation_key text,
    default_branch_observed_at timestamp(3) without time zone,
    default_branch_reason character varying(64),
    default_branch_source character varying(64),
    default_branch_trigger character varying(32)
);

CREATE TABLE public.pull_request_detail (
    artifact_id uuid,
    repository_id uuid,
    github_id text,
    number integer NOT NULL,
    body text,
    pr_state public."GitHubPRState" DEFAULT 'OPEN'::public."GitHubPRState" NOT NULL,
    is_draft boolean DEFAULT false NOT NULL,
    review_decision public."ReviewDecision",
    closed_at timestamp(3) without time zone,
    merged_at timestamp(3) without time zone,
    merge_commit_sha text,
    last_verified_at timestamp(3) without time zone,
    last_refresh_attempt_at timestamp(3) without time zone,
    branch_artifact_id uuid NOT NULL,
    html_url text,
    id uuid DEFAULT gen_random_uuid() NOT NULL,
    is_current boolean DEFAULT false NOT NULL,
    title text,
    fetch_credential_owner_id uuid,
    fetch_credential_type character varying(32),
    fetch_mechanism character varying(32),
    fetch_observed_at timestamp(3) without time zone,
    fetch_result_reason character varying(64),
    fetch_trigger character varying(32),
    additions integer,
    deletions integer,
    changed_files integer,
    organization_id uuid NOT NULL,
    repository_full_name text,
    github_created_at timestamp(3) without time zone,
    provider character varying(32) DEFAULT 'github'::character varying NOT NULL,
    provider_detail jsonb,
    github_updated_at timestamp(3) without time zone,
    head_ref_oid text,
    author_login text,
    head_repository_default_branch_availability character varying(32),
    head_repository_default_branch_completeness character varying(32),
    head_repository_default_branch_credential_owner_id uuid,
    head_repository_default_branch_credential_type character varying(32),
    head_repository_default_branch_event_at timestamp(3) without time zone,
    head_repository_default_branch_mechanism character varying(32),
    head_repository_default_branch_name text,
    head_repository_default_branch_observation_key text,
    head_repository_default_branch_observed_at timestamp(3) without time zone,
    head_repository_default_branch_reason character varying(64),
    head_repository_default_branch_source character varying(64),
    head_repository_default_branch_trigger character varying(32),
    head_repository_full_name text,
    head_repository_github_id text,
    head_ref_name text
);

CREATE TABLE public.repo_bootstrap_configs (
    id uuid NOT NULL,
    organization_id uuid NOT NULL,
    repo_full_name text NOT NULL,
    critic_gates jsonb NOT NULL,
    bootstrap_run_id text,
    created_at timestamp(3) without time zone DEFAULT CURRENT_TIMESTAMP NOT NULL,
    updated_at timestamp(3) without time zone NOT NULL
);

CREATE TABLE public.repository_default_observation_receipts (
    id uuid NOT NULL,
    organization_id uuid NOT NULL,
    target_kind character varying(64) NOT NULL,
    target_id text NOT NULL,
    source character varying(64) NOT NULL,
    observation_key text NOT NULL,
    observed_at timestamp(3) without time zone NOT NULL,
    created_at timestamp(3) without time zone DEFAULT CURRENT_TIMESTAMP NOT NULL
);

CREATE TABLE public.routine_runs (
    id uuid NOT NULL,
    organization_id uuid NOT NULL,
    routine_id uuid NOT NULL,
    source_run_id text,
    task_name text,
    status public."RoutineRunStatus" DEFAULT 'PENDING'::public."RoutineRunStatus" NOT NULL,
    started_at timestamp(3) without time zone DEFAULT CURRENT_TIMESTAMP NOT NULL,
    finished_at timestamp(3) without time zone,
    provider public."RoutineProvider",
    model_id text,
    summary text DEFAULT ''::text NOT NULL,
    error text,
    log_path text,
    session_id text,
    session_ids text[] DEFAULT ARRAY[]::text[] NOT NULL,
    invoked_components jsonb DEFAULT '[]'::jsonb NOT NULL,
    attempts jsonb DEFAULT '[]'::jsonb NOT NULL,
    created_at timestamp(3) without time zone DEFAULT CURRENT_TIMESTAMP NOT NULL
);

CREATE TABLE public.routines (
    id uuid NOT NULL,
    organization_id uuid NOT NULL,
    source_id text,
    name text NOT NULL,
    description text DEFAULT ''::text NOT NULL,
    instructions text DEFAULT ''::text NOT NULL,
    owner_id uuid,
    owner_name text,
    provider public."RoutineProvider" NOT NULL,
    model_id text NOT NULL,
    runs_on public."RoutineRunsOn" DEFAULT 'LOCAL'::public."RoutineRunsOn" NOT NULL,
    origin public."RoutineOrigin" DEFAULT 'CREATED'::public."RoutineOrigin" NOT NULL,
    status public."RoutineStatus" DEFAULT 'DRAFT'::public."RoutineStatus" NOT NULL,
    schedule_kind public."RoutineScheduleKind" DEFAULT 'MANUAL'::public."RoutineScheduleKind" NOT NULL,
    schedule_detail text DEFAULT ''::text NOT NULL,
    cron text,
    timezone text DEFAULT ''::text NOT NULL,
    enabled boolean DEFAULT true NOT NULL,
    notify_mode public."RoutineNotifyMode" DEFAULT 'ALL_RUNS'::public."RoutineNotifyMode" NOT NULL,
    folder_or_repo text,
    project text,
    runs_in public."RoutineRunsIn",
    host_machine text,
    connector_ids text[] DEFAULT ARRAY[]::text[] NOT NULL,
    auto_fix_pull_requests boolean DEFAULT false NOT NULL,
    permission_mode text,
    reasoning_effort text,
    worktree boolean DEFAULT false NOT NULL,
    route text,
    harness_cascade jsonb DEFAULT '[]'::jsonb NOT NULL,
    catch_up boolean DEFAULT true NOT NULL,
    recurring boolean DEFAULT true NOT NULL,
    durable boolean DEFAULT true NOT NULL,
    pass_kind text,
    pass text,
    crew text DEFAULT ''::text NOT NULL,
    meta jsonb DEFAULT '{}'::jsonb NOT NULL,
    next_run_at timestamp(3) without time zone,
    last_run_at timestamp(3) without time zone,
    last_run_id uuid,
    last_status public."RoutineRunStatus",
    last_run_session_id text,
    created_at timestamp(3) without time zone DEFAULT CURRENT_TIMESTAMP NOT NULL,
    updated_at timestamp(3) without time zone NOT NULL
);

CREATE TABLE public.search_document (
    id uuid NOT NULL,
    organization_id uuid NOT NULL,
    entity_type text NOT NULL,
    entity_id uuid NOT NULL,
    title text NOT NULL,
    body text,
    project_id uuid,
    assignee_id uuid,
    updated_at timestamp(3) without time zone NOT NULL,
    tsv tsvector GENERATED ALWAYS AS (to_tsvector('english'::regconfig, ((COALESCE(title, ''::text) || ' '::text) || COALESCE(body, ''::text)))) STORED,
    anchor_entity_id uuid,
    status text,
    priority text,
    slug text,
    entity_subtype text
);

CREATE TABLE public.session_detail (
    artifact_id uuid NOT NULL,
    user_id uuid,
    compute_target_id uuid NOT NULL,
    external_session_id text NOT NULL,
    harness text DEFAULT 'unknown'::text NOT NULL,
    cwd text,
    repository_full_name text,
    worktree_path text,
    model text,
    session_started_at timestamp(3) without time zone NOT NULL,
    session_updated_at timestamp(3) without time zone NOT NULL,
    session_ended_at timestamp(3) without time zone,
    awaiting_input_since timestamp(3) without time zone,
    source_artifact_id text,
    source_loop_id text,
    base_branch text,
    input_tokens bigint DEFAULT 0 NOT NULL,
    output_tokens bigint DEFAULT 0 NOT NULL,
    cache_read_tokens bigint DEFAULT 0 NOT NULL,
    cache_write_tokens bigint DEFAULT 0 NOT NULL,
    estimated_cost numeric(14,6) DEFAULT 0 NOT NULL,
    agent_count integer DEFAULT 0 NOT NULL,
    tool_use_count integer DEFAULT 0 NOT NULL,
    error_count integer DEFAULT 0 NOT NULL,
    metadata jsonb,
    agents jsonb DEFAULT '[]'::jsonb NOT NULL,
    last_synced_at timestamp(3) without time zone DEFAULT CURRENT_TIMESTAMP NOT NULL,
    created_at timestamp(3) without time zone DEFAULT CURRENT_TIMESTAMP NOT NULL,
    updated_at timestamp(3) without time zone NOT NULL,
    device_time_zone text,
    data_revision integer,
    origin public."SessionOrigin" DEFAULT 'DESKTOP_SYNC'::public."SessionOrigin" NOT NULL,
    active_agent text,
    activity_buckets jsonb,
    autonomy integer,
    branch text,
    files_changed integer,
    lines_added integer,
    lines_removed integer,
    markers jsonb,
    phase_iterations jsonb,
    phase_loopbacks jsonb,
    phases jsonb,
    pull_requests jsonb,
    session_span jsonb,
    state text,
    steering_episodes integer,
    throttles jsonb,
    turns integer,
    waiting_user text,
    wall_clock text,
    trace_phase_sources jsonb,
    throttle_sources jsonb,
    correction_sources jsonb,
    loc_source text,
    last_activity_at timestamp(3) without time zone,
    branch_lines_added integer,
    branch_lines_removed integer,
    branch_files_changed integer,
    branch_loc_source text,
    billing_mode text,
    frustration_raw integer,
    frustration_score_version integer,
    pending_chunk_revision integer,
    pending_chunk_total integer,
    pending_chunk_received integer,
    ends_with_error boolean
);

CREATE TABLE public.session_transcript (
    id uuid NOT NULL,
    organization_id uuid NOT NULL,
    compute_target_id uuid NOT NULL,
    external_session_id text NOT NULL,
    session_detail_id uuid,
    source_harness text NOT NULL,
    file_key text NOT NULL,
    object_storage_key text NOT NULL,
    upload_status text DEFAULT 'pending'::text NOT NULL,
    raw_sha256 text,
    crc64nvme text,
    raw_byte_size bigint,
    stored_etag text,
    synced_byte_offset bigint DEFAULT 0 NOT NULL,
    source_mtime timestamp(3) without time zone,
    source_path_hash text,
    pending_upload_id text,
    pending_upload_started_at timestamp(3) without time zone,
    first_seen_at timestamp(3) without time zone DEFAULT CURRENT_TIMESTAMP NOT NULL,
    last_observed_at timestamp(3) without time zone DEFAULT CURRENT_TIMESTAMP NOT NULL,
    uploaded_at timestamp(3) without time zone,
    created_at timestamp(3) without time zone DEFAULT CURRENT_TIMESTAMP NOT NULL,
    updated_at timestamp(3) without time zone NOT NULL,
    permanent_failure_reason text
);

CREATE TABLE public.slack_integrations (
    id uuid NOT NULL,
    organization_id uuid NOT NULL,
    access_token text NOT NULL,
    bot_user_id text NOT NULL,
    team_id text NOT NULL,
    team_name text NOT NULL,
    default_channel_id text,
    default_channel_name text,
    created_at timestamp(3) without time zone DEFAULT CURRENT_TIMESTAMP NOT NULL,
    updated_at timestamp(3) without time zone NOT NULL,
    access_token_encrypted text
);

CREATE TABLE public.slug_counters (
    id uuid NOT NULL,
    organization_id uuid NOT NULL,
    type_prefix text NOT NULL,
    current_value integer DEFAULT 0 NOT NULL
);

CREATE TABLE public.source_occurrences (
    id uuid NOT NULL,
    organization_id uuid NOT NULL,
    definition_version_id uuid NOT NULL,
    occurrence_type public.source_occurrence_type NOT NULL,
    access_state public.source_access_state DEFAULT 'accessible'::public.source_access_state NOT NULL,
    repo_full_name text,
    repo_path text,
    repo_commit text,
    compute_target_id uuid,
    local_path text,
    pack_id text,
    first_seen_at timestamp(3) without time zone DEFAULT CURRENT_TIMESTAMP NOT NULL,
    last_seen_at timestamp(3) without time zone DEFAULT CURRENT_TIMESTAMP NOT NULL,
    created_at timestamp(3) without time zone DEFAULT CURRENT_TIMESTAMP NOT NULL,
    updated_at timestamp(3) without time zone NOT NULL
);

CREATE TABLE public.tag_artifacts (
    id uuid NOT NULL,
    tag_id uuid NOT NULL,
    artifact_id uuid NOT NULL,
    created_at timestamp(3) without time zone DEFAULT CURRENT_TIMESTAMP NOT NULL
);

CREATE TABLE public.tag_loops (
    id uuid NOT NULL,
    tag_id uuid NOT NULL,
    loop_id uuid NOT NULL,
    created_at timestamp(3) without time zone DEFAULT CURRENT_TIMESTAMP NOT NULL
);

CREATE TABLE public.tag_projects (
    id uuid NOT NULL,
    tag_id uuid NOT NULL,
    project_id uuid NOT NULL,
    created_at timestamp(3) without time zone DEFAULT CURRENT_TIMESTAMP NOT NULL
);

CREATE TABLE public.tags (
    id uuid NOT NULL,
    organization_id uuid NOT NULL,
    name text NOT NULL,
    color text NOT NULL,
    created_by_id uuid NOT NULL,
    created_at timestamp(3) without time zone DEFAULT CURRENT_TIMESTAMP NOT NULL,
    updated_at timestamp(3) without time zone NOT NULL
);

CREATE TABLE public.user_public_keys (
    id uuid NOT NULL,
    user_id uuid NOT NULL,
    organization_id uuid NOT NULL,
    public_key_base64 text NOT NULL,
    fingerprint text NOT NULL,
    created_at timestamp(3) without time zone DEFAULT CURRENT_TIMESTAMP NOT NULL
);

CREATE TABLE public.users (
    id uuid NOT NULL,
    clerk_id text NOT NULL,
    organization_id uuid NOT NULL,
    active boolean DEFAULT true NOT NULL,
    email text NOT NULL,
    first_name text,
    last_name text,
    avatar_url text,
    phone_number text,
    role public."ApproverRole" DEFAULT 'ENGINEER'::public."ApproverRole" NOT NULL,
    linear_id text,
    slack_id text,
    github_username text,
    created_at timestamp(3) without time zone DEFAULT CURRENT_TIMESTAMP NOT NULL,
    updated_at timestamp(3) without time zone NOT NULL,
    claude_api_key_encrypted text,
    claude_api_key_last_four text,
    claude_api_key_set_at timestamp(3) without time zone,
    preferred_compute_mode public."PreferredComputeMode",
    preferred_compute_target_id uuid,
    preferred_harness text
);

CREATE TABLE public.workflow_action_runs (
    id uuid NOT NULL,
    organization_id uuid NOT NULL,
    run_id uuid NOT NULL,
    action_id uuid,
    action_type character varying(64) NOT NULL,
    stage character varying(8) DEFAULT 'post'::character varying NOT NULL,
    event character varying(32) NOT NULL,
    cycle integer DEFAULT 1 NOT NULL,
    status character varying(16) DEFAULT 'pending'::character varying NOT NULL,
    attempts integer DEFAULT 0 NOT NULL,
    next_attempt_at timestamp(3) without time zone DEFAULT CURRENT_TIMESTAMP NOT NULL,
    last_error text,
    external_ref text,
    completed_at timestamp(3) without time zone,
    created_at timestamp(3) without time zone DEFAULT CURRENT_TIMESTAMP NOT NULL,
    updated_at timestamp(3) without time zone NOT NULL,
    command_id uuid,
    detail jsonb
);

CREATE TABLE public.workflow_actions (
    id uuid NOT NULL,
    organization_id uuid NOT NULL,
    workflow_id uuid NOT NULL,
    connection_id uuid,
    type character varying(64) NOT NULL,
    config jsonb DEFAULT '{}'::jsonb NOT NULL,
    stage character varying(8) DEFAULT 'post'::character varying NOT NULL,
    continue_on_error boolean DEFAULT false NOT NULL,
    events text[] DEFAULT ARRAY[]::text[],
    enabled boolean DEFAULT true NOT NULL,
    "position" integer DEFAULT 0 NOT NULL,
    created_at timestamp(3) without time zone DEFAULT CURRENT_TIMESTAMP NOT NULL,
    updated_at timestamp(3) without time zone NOT NULL,
    connection_key character varying(40)
);

CREATE TABLE public.workflow_run_loops (
    id uuid NOT NULL,
    organization_id uuid NOT NULL,
    run_id uuid NOT NULL,
    loop_id uuid NOT NULL,
    command character varying(32) NOT NULL,
    adopted boolean DEFAULT false NOT NULL,
    created_at timestamp(3) without time zone DEFAULT CURRENT_TIMESTAMP NOT NULL,
    step_id character varying(64)
);

CREATE TABLE public.workflow_runs (
    id uuid NOT NULL,
    organization_id uuid NOT NULL,
    workflow_id uuid NOT NULL,
    trigger_id uuid,
    connection_id uuid,
    delivery_id uuid,
    run_as_user_id uuid,
    dedup_key character varying(255) NOT NULL,
    occurrence_keys text[] DEFAULT ARRAY[]::text[],
    source_key character varying(255) NOT NULL,
    status character varying(16) DEFAULT 'received'::character varying NOT NULL,
    source jsonb NOT NULL,
    agent_config jsonb DEFAULT '{}'::jsonb NOT NULL,
    feature_document_id uuid,
    plan_document_id uuid,
    pr_url text,
    branch_name text,
    error jsonb,
    cycle integer DEFAULT 1 NOT NULL,
    step_attempts integer DEFAULT 0 NOT NULL,
    next_step_at timestamp(3) without time zone,
    lease_until timestamp(3) without time zone,
    phase_started_at timestamp(3) without time zone DEFAULT CURRENT_TIMESTAMP NOT NULL,
    completed_at timestamp(3) without time zone,
    created_at timestamp(3) without time zone DEFAULT CURRENT_TIMESTAMP NOT NULL,
    updated_at timestamp(3) without time zone NOT NULL,
    repository jsonb,
    process jsonb,
    step_id character varying(64),
    step_state jsonb,
    project_connection_id uuid,
    project_id uuid NOT NULL,
    source_classification jsonb
);

CREATE TABLE public.workflow_triggers (
    id uuid NOT NULL,
    organization_id uuid NOT NULL,
    workflow_id uuid NOT NULL,
    connection_id uuid NOT NULL,
    type character varying(64) NOT NULL,
    config jsonb DEFAULT '{}'::jsonb NOT NULL,
    enabled boolean DEFAULT true NOT NULL,
    "position" integer DEFAULT 0 NOT NULL,
    created_at timestamp(3) without time zone DEFAULT CURRENT_TIMESTAMP NOT NULL,
    updated_at timestamp(3) without time zone NOT NULL,
    project_connection_id uuid,
    project_id uuid NOT NULL
);

CREATE TABLE public.workflows (
    id uuid NOT NULL,
    organization_id uuid NOT NULL,
    name character varying(120) NOT NULL,
    description text DEFAULT ''::text NOT NULL,
    enabled boolean DEFAULT true NOT NULL,
    project_id uuid,
    run_as_user_id uuid,
    agent_config jsonb DEFAULT '{}'::jsonb NOT NULL,
    created_by_id uuid,
    last_run_at timestamp(3) without time zone,
    created_at timestamp(3) without time zone DEFAULT CURRENT_TIMESTAMP NOT NULL,
    updated_at timestamp(3) without time zone NOT NULL
);

ALTER TABLE ONLY public.agent_component_invocation_generations
    ADD CONSTRAINT agent_component_invocation_generations_pkey PRIMARY KEY (id);

ALTER TABLE ONLY public.agent_component_invocation_parts
    ADD CONSTRAINT agent_component_invocation_parts_pkey PRIMARY KEY (id);

ALTER TABLE ONLY public.agent_component_invocations
    ADD CONSTRAINT agent_component_invocations_pkey PRIMARY KEY (id);

ALTER TABLE ONLY public.agent_component_session_usage
    ADD CONSTRAINT agent_component_session_usage_pkey PRIMARY KEY (id);

ALTER TABLE ONLY public.agent_component_versions
    ADD CONSTRAINT agent_component_versions_pkey PRIMARY KEY (id);

ALTER TABLE ONLY public.agent_components
    ADD CONSTRAINT agent_components_pkey PRIMARY KEY (id);

ALTER TABLE ONLY public.agent_session_activity_segments
    ADD CONSTRAINT agent_session_activity_segments_pkey PRIMARY KEY (id);

ALTER TABLE ONLY public.agent_session_events
    ADD CONSTRAINT agent_session_events_pkey PRIMARY KEY (id);

ALTER TABLE ONLY public.agent_session_token_events
    ADD CONSTRAINT agent_session_token_events_pkey PRIMARY KEY (id);

ALTER TABLE ONLY public.agent_session_token_usage
    ADD CONSTRAINT agent_session_token_usage_pkey PRIMARY KEY (id);

ALTER TABLE ONLY public.agent_session_usage_rollups
    ADD CONSTRAINT agent_session_usage_rollups_pkey PRIMARY KEY (artifact_id);

ALTER TABLE ONLY public.agent_versions
    ADD CONSTRAINT agent_versions_pkey PRIMARY KEY (id);

ALTER TABLE ONLY public.agents
    ADD CONSTRAINT agents_pkey PRIMARY KEY (id);

ALTER TABLE ONLY public.api_keys
    ADD CONSTRAINT api_keys_pkey PRIMARY KEY (id);

ALTER TABLE ONLY public.artifact_activity_events
    ADD CONSTRAINT artifact_activity_events_pkey PRIMARY KEY (id);

ALTER TABLE ONLY public.artifact_evaluations
    ADD CONSTRAINT artifact_evaluations_pkey PRIMARY KEY (id);

ALTER TABLE ONLY public.artifact_generation_status_dismissals
    ADD CONSTRAINT artifact_generation_status_dismissals_pkey PRIMARY KEY (id);

ALTER TABLE ONLY public.artifact_links
    ADD CONSTRAINT artifact_links_pkey PRIMARY KEY (id);

ALTER TABLE ONLY public.artifact_ratings
    ADD CONSTRAINT artifact_ratings_pkey PRIMARY KEY (id);

ALTER TABLE ONLY public.artifacts
    ADD CONSTRAINT artifacts_pkey PRIMARY KEY (id);

ALTER TABLE ONLY public.audit_entries
    ADD CONSTRAINT audit_entries_pkey PRIMARY KEY (organization_id, seq);

ALTER TABLE ONLY public.audit_outbox
    ADD CONSTRAINT audit_outbox_pkey PRIMARY KEY (id);

ALTER TABLE ONLY public.auth_accounts
    ADD CONSTRAINT auth_accounts_pkey PRIMARY KEY (id);

ALTER TABLE ONLY public.auth_invitations
    ADD CONSTRAINT auth_invitations_pkey PRIMARY KEY (id);

ALTER TABLE ONLY public.auth_jwks
    ADD CONSTRAINT auth_jwks_pkey PRIMARY KEY (id);

ALTER TABLE ONLY public.auth_members
    ADD CONSTRAINT auth_members_pkey PRIMARY KEY (id);

ALTER TABLE ONLY public.auth_organizations
    ADD CONSTRAINT auth_organizations_pkey PRIMARY KEY (id);

ALTER TABLE ONLY public.auth_sessions
    ADD CONSTRAINT auth_sessions_pkey PRIMARY KEY (id);

ALTER TABLE ONLY public.auth_users
    ADD CONSTRAINT auth_users_pkey PRIMARY KEY (id);

ALTER TABLE ONLY public.auth_verifications
    ADD CONSTRAINT auth_verifications_pkey PRIMARY KEY (id);

ALTER TABLE ONLY public.branch_activity_atoms
    ADD CONSTRAINT branch_activity_atoms_dedupe_key UNIQUE (organization_id, branch_artifact_id, source, source_event_id);

ALTER TABLE ONLY public.branch_activity_atoms
    ADD CONSTRAINT branch_activity_atoms_pkey PRIMARY KEY (id);

ALTER TABLE ONLY public.branch_detail
    ADD CONSTRAINT branch_detail_pkey PRIMARY KEY (artifact_id);

ALTER TABLE ONLY public.branch_file_changes
    ADD CONSTRAINT branch_file_changes_pkey PRIMARY KEY (id);

ALTER TABLE ONLY public.branch_status_checks
    ADD CONSTRAINT branch_status_checks_pkey PRIMARY KEY (id);

ALTER TABLE ONLY public.catalog_item_versions
    ADD CONSTRAINT catalog_item_versions_pkey PRIMARY KEY (id);

ALTER TABLE ONLY public.catalog_items
    ADD CONSTRAINT catalog_items_pkey PRIMARY KEY (id);

ALTER TABLE ONLY public.chat_sessions
    ADD CONSTRAINT chat_sessions_pkey PRIMARY KEY (id);

ALTER TABLE ONLY public.comment_attachments
    ADD CONSTRAINT comment_attachments_pkey PRIMARY KEY (id);

ALTER TABLE ONLY public.comment_reactions
    ADD CONSTRAINT comment_reactions_pkey PRIMARY KEY (id);

ALTER TABLE ONLY public.comment_threads
    ADD CONSTRAINT comment_threads_pkey PRIMARY KEY (id);

ALTER TABLE ONLY public.comments
    ADD CONSTRAINT comments_pkey PRIMARY KEY (id);

ALTER TABLE ONLY public.commit_detail
    ADD CONSTRAINT commit_detail_pkey PRIMARY KEY (id);

ALTER TABLE ONLY public.compute_target_capabilities
    ADD CONSTRAINT compute_target_capabilities_pkey PRIMARY KEY (id);

ALTER TABLE ONLY public.compute_target_health_checks
    ADD CONSTRAINT compute_target_health_checks_pkey PRIMARY KEY (id);

ALTER TABLE ONLY public.compute_targets
    ADD CONSTRAINT compute_targets_pkey PRIMARY KEY (id);

ALTER TABLE ONLY public.custom_field_enum_options
    ADD CONSTRAINT custom_field_enum_options_pkey PRIMARY KEY (id);

ALTER TABLE ONLY public.custom_field_settings
    ADD CONSTRAINT custom_field_settings_pkey PRIMARY KEY (id);

ALTER TABLE ONLY public.custom_field_values
    ADD CONSTRAINT custom_field_values_pkey PRIMARY KEY (id);

ALTER TABLE ONLY public.custom_fields
    ADD CONSTRAINT custom_fields_pkey PRIMARY KEY (id);

ALTER TABLE ONLY public.definition_version_editors
    ADD CONSTRAINT definition_version_editors_pkey PRIMARY KEY (id);

ALTER TABLE ONLY public.definition_versions
    ADD CONSTRAINT definition_versions_pkey PRIMARY KEY (id);

ALTER TABLE ONLY public.deployment_detail
    ADD CONSTRAINT deployment_detail_pkey PRIMARY KEY (artifact_id);

ALTER TABLE ONLY public.deployment_events
    ADD CONSTRAINT deployment_events_pkey PRIMARY KEY (id);

ALTER TABLE ONLY public.desktop_authorization_codes
    ADD CONSTRAINT desktop_authorization_codes_pkey PRIMARY KEY (id);

ALTER TABLE ONLY public.desktop_command_events
    ADD CONSTRAINT desktop_command_events_pkey PRIMARY KEY (command_id, sequence);

ALTER TABLE ONLY public.desktop_commands
    ADD CONSTRAINT desktop_commands_pkey PRIMARY KEY (id);

ALTER TABLE ONLY public.desktop_onboarding_attempts
    ADD CONSTRAINT desktop_onboarding_attempts_pkey PRIMARY KEY (attempt_id);

ALTER TABLE ONLY public.desktop_onboarding_device_sessions
    ADD CONSTRAINT desktop_onboarding_device_sessions_pkey PRIMARY KEY (id);

ALTER TABLE ONLY public.desktop_refresh_tokens
    ADD CONSTRAINT desktop_refresh_tokens_pkey PRIMARY KEY (id);

ALTER TABLE ONLY public.desktop_sessions
    ADD CONSTRAINT desktop_sessions_pkey PRIMARY KEY (id);

ALTER TABLE ONLY public.distribution_target_status
    ADD CONSTRAINT distribution_target_status_pkey PRIMARY KEY (id);

ALTER TABLE ONLY public.distribution_targeting_entries
    ADD CONSTRAINT distribution_targeting_entries_pkey PRIMARY KEY (id);

ALTER TABLE ONLY public.distributions
    ADD CONSTRAINT distributions_pkey PRIMARY KEY (id);

ALTER TABLE ONLY public.document_detail
    ADD CONSTRAINT document_detail_pkey PRIMARY KEY (artifact_id);

ALTER TABLE ONLY public.document_versions
    ADD CONSTRAINT document_versions_pkey PRIMARY KEY (id);

ALTER TABLE ONLY public.external_comment_authors
    ADD CONSTRAINT external_comment_authors_pkey PRIMARY KEY (id);

ALTER TABLE ONLY public.favorite_artifacts
    ADD CONSTRAINT favorite_artifacts_pkey PRIMARY KEY (id);

ALTER TABLE ONLY public.favorite_projects
    ADD CONSTRAINT favorite_projects_pkey PRIMARY KEY (id);

ALTER TABLE ONLY public.file_attachments
    ADD CONSTRAINT file_attachments_pkey PRIMARY KEY (id);

ALTER TABLE ONLY public.github_access_capabilities
    ADD CONSTRAINT github_access_capabilities_pkey PRIMARY KEY (id);

ALTER TABLE ONLY public.github_comment_projections
    ADD CONSTRAINT github_comment_projections_pkey PRIMARY KEY (comment_id);

ALTER TABLE ONLY public.github_comment_thread_projections
    ADD CONSTRAINT github_comment_thread_projections_pkey PRIMARY KEY (thread_id);

ALTER TABLE ONLY public.github_dirty_scope_nudges
    ADD CONSTRAINT github_dirty_scope_nudges_pkey PRIMARY KEY (id);

ALTER TABLE ONLY public.github_installation_repositories
    ADD CONSTRAINT github_installation_repositories_pkey PRIMARY KEY (id);

ALTER TABLE ONLY public.github_installations
    ADD CONSTRAINT github_installations_pkey PRIMARY KEY (id);

ALTER TABLE ONLY public.github_pr_reviews
    ADD CONSTRAINT github_pr_reviews_pkey PRIMARY KEY (id);

ALTER TABLE ONLY public.github_repo_sync_state
    ADD CONSTRAINT github_repo_sync_state_pkey PRIMARY KEY (id);

ALTER TABLE ONLY public.github_user_connections
    ADD CONSTRAINT github_user_connections_pkey PRIMARY KEY (id);

ALTER TABLE ONLY public.google_integrations
    ADD CONSTRAINT google_integrations_pkey PRIMARY KEY (id);

ALTER TABLE ONLY public.integration_connections
    ADD CONSTRAINT integration_connections_pkey PRIMARY KEY (id);

ALTER TABLE ONLY public.integration_deliveries
    ADD CONSTRAINT integration_deliveries_pkey PRIMARY KEY (id);

ALTER TABLE ONLY public.integration_tool_calls
    ADD CONSTRAINT integration_tool_calls_pkey PRIMARY KEY (id);

ALTER TABLE ONLY public.integration_tool_sessions
    ADD CONSTRAINT integration_tool_sessions_pkey PRIMARY KEY (id);

ALTER TABLE ONLY public.judge_human_scores
    ADD CONSTRAINT judge_human_scores_pkey PRIMARY KEY (id);

ALTER TABLE ONLY public.judge_scores
    ADD CONSTRAINT judge_scores_pkey PRIMARY KEY (id);

ALTER TABLE ONLY public.linear_integrations
    ADD CONSTRAINT linear_integrations_pkey PRIMARY KEY (id);

ALTER TABLE ONLY public.linear_subtasks
    ADD CONSTRAINT linear_subtasks_pkey PRIMARY KEY (id);

ALTER TABLE ONLY public.local_gateway_challenge_jtis
    ADD CONSTRAINT local_gateway_challenge_jtis_pkey PRIMARY KEY (jti);

ALTER TABLE ONLY public.loop_events
    ADD CONSTRAINT loop_events_pkey PRIMARY KEY (id);

ALTER TABLE ONLY public.loop_execution_credential_consumptions
    ADD CONSTRAINT loop_execution_credential_consumptions_pkey PRIMARY KEY (command_id);

ALTER TABLE ONLY public.loop_token_refresh
    ADD CONSTRAINT loop_token_refresh_pkey PRIMARY KEY (id);

ALTER TABLE ONLY public.loops
    ADD CONSTRAINT loops_pkey PRIMARY KEY (id);

ALTER TABLE ONLY public.oauth_authorization_codes
    ADD CONSTRAINT oauth_authorization_codes_pkey PRIMARY KEY (id);

ALTER TABLE ONLY public.oauth_rate_limits
    ADD CONSTRAINT oauth_rate_limits_pkey PRIMARY KEY (id);

ALTER TABLE ONLY public.oauth_refresh_tokens
    ADD CONSTRAINT oauth_refresh_tokens_pkey PRIMARY KEY (id);

ALTER TABLE ONLY public.oauth_revoked_tokens
    ADD CONSTRAINT oauth_revoked_tokens_pkey PRIMARY KEY (id);

ALTER TABLE ONLY public.orchestrator_anchors
    ADD CONSTRAINT orchestrator_anchors_pkey PRIMARY KEY (id);

ALTER TABLE ONLY public.orchestrator_cases
    ADD CONSTRAINT orchestrator_cases_pkey PRIMARY KEY (id);

ALTER TABLE ONLY public.orchestrator_conversations
    ADD CONSTRAINT orchestrator_conversations_pkey PRIMARY KEY (id);

ALTER TABLE ONLY public.orchestrator_decisions
    ADD CONSTRAINT orchestrator_decisions_pkey PRIMARY KEY (id);

ALTER TABLE ONLY public.orchestrator_messages
    ADD CONSTRAINT orchestrator_messages_pkey PRIMARY KEY (id);

ALTER TABLE ONLY public.orchestrator_tasks
    ADD CONSTRAINT orchestrator_tasks_pkey PRIMARY KEY (id);

ALTER TABLE ONLY public.orchestrator_turns
    ADD CONSTRAINT orchestrator_turns_pkey PRIMARY KEY (id);

ALTER TABLE ONLY public.orchestrator_waits
    ADD CONSTRAINT orchestrator_waits_pkey PRIMARY KEY (id);

ALTER TABLE ONLY public.organizations
    ADD CONSTRAINT organizations_pkey PRIMARY KEY (id);

ALTER TABLE ONLY public.preview_schemas_observations
    ADD CONSTRAINT preview_schemas_observations_pkey PRIMARY KEY (schema_name);

ALTER TABLE ONLY public.preview_schemas
    ADD CONSTRAINT preview_schemas_pkey PRIMARY KEY (schema_name);

ALTER TABLE ONLY public.project_connection_scopes
    ADD CONSTRAINT project_connection_scopes_pkey PRIMARY KEY (id);

ALTER TABLE ONLY public.project_connections
    ADD CONSTRAINT project_connections_pkey PRIMARY KEY (id);

ALTER TABLE ONLY public.project_process_versions
    ADD CONSTRAINT project_process_versions_pkey PRIMARY KEY (id);

ALTER TABLE ONLY public.project_repositories
    ADD CONSTRAINT project_repositories_pkey PRIMARY KEY (id);

ALTER TABLE ONLY public.projects
    ADD CONSTRAINT projects_pkey PRIMARY KEY (id);

ALTER TABLE ONLY public.prompt_registry
    ADD CONSTRAINT prompt_registry_pkey PRIMARY KEY (id);

ALTER TABLE ONLY public.public_repositories
    ADD CONSTRAINT public_repositories_pkey PRIMARY KEY (id);

ALTER TABLE ONLY public.pull_request_detail
    ADD CONSTRAINT pull_request_detail_pkey PRIMARY KEY (id);

ALTER TABLE ONLY public.repo_bootstrap_configs
    ADD CONSTRAINT repo_bootstrap_configs_pkey PRIMARY KEY (id);

ALTER TABLE ONLY public.repository_default_observation_receipts
    ADD CONSTRAINT repo_default_observation_receipt_dedupe_key UNIQUE (organization_id, target_kind, target_id, source, observation_key);

ALTER TABLE ONLY public.repository_default_observation_receipts
    ADD CONSTRAINT repository_default_observation_receipts_pkey PRIMARY KEY (id);

ALTER TABLE ONLY public.routine_runs
    ADD CONSTRAINT routine_runs_pkey PRIMARY KEY (id);

ALTER TABLE ONLY public.routines
    ADD CONSTRAINT routines_pkey PRIMARY KEY (id);

ALTER TABLE ONLY public.search_document
    ADD CONSTRAINT search_document_pkey PRIMARY KEY (id);

ALTER TABLE ONLY public.session_detail
    ADD CONSTRAINT session_detail_pkey PRIMARY KEY (artifact_id);

ALTER TABLE ONLY public.session_transcript
    ADD CONSTRAINT session_transcript_pkey PRIMARY KEY (id);

ALTER TABLE ONLY public.slack_integrations
    ADD CONSTRAINT slack_integrations_pkey PRIMARY KEY (id);

ALTER TABLE ONLY public.slug_counters
    ADD CONSTRAINT slug_counters_pkey PRIMARY KEY (id);

ALTER TABLE ONLY public.source_occurrences
    ADD CONSTRAINT source_occurrences_pkey PRIMARY KEY (id);

ALTER TABLE ONLY public.tag_artifacts
    ADD CONSTRAINT tag_artifacts_pkey PRIMARY KEY (id);

ALTER TABLE ONLY public.tag_loops
    ADD CONSTRAINT tag_loops_pkey PRIMARY KEY (id);

ALTER TABLE ONLY public.tag_projects
    ADD CONSTRAINT tag_projects_pkey PRIMARY KEY (id);

ALTER TABLE ONLY public.tags
    ADD CONSTRAINT tags_pkey PRIMARY KEY (id);

ALTER TABLE ONLY public.user_public_keys
    ADD CONSTRAINT user_public_keys_pkey PRIMARY KEY (id);

ALTER TABLE ONLY public.users
    ADD CONSTRAINT users_pkey PRIMARY KEY (id);

ALTER TABLE ONLY public.workflow_action_runs
    ADD CONSTRAINT workflow_action_runs_pkey PRIMARY KEY (id);

ALTER TABLE ONLY public.workflow_actions
    ADD CONSTRAINT workflow_actions_pkey PRIMARY KEY (id);

ALTER TABLE ONLY public.workflow_run_loops
    ADD CONSTRAINT workflow_run_loops_pkey PRIMARY KEY (id);

ALTER TABLE ONLY public.workflow_runs
    ADD CONSTRAINT workflow_runs_pkey PRIMARY KEY (id);

ALTER TABLE ONLY public.workflow_triggers
    ADD CONSTRAINT workflow_triggers_pkey PRIMARY KEY (id);

ALTER TABLE ONLY public.workflows
    ADD CONSTRAINT workflows_pkey PRIMARY KEY (id);

CREATE INDEX agent_component_session_usage_agent_component_id_idx ON public.agent_component_session_usage USING btree (agent_component_id);

CREATE INDEX agent_component_session_usage_agent_session_id_component_ki_idx ON public.agent_component_session_usage USING btree (agent_session_id, component_kind);

CREATE INDEX agent_component_session_usage_component_kind_last_invoked_a_idx ON public.agent_component_session_usage USING btree (component_kind, last_invoked_at);

CREATE INDEX agent_component_session_usage_definition_version_id_idx ON public.agent_component_session_usage USING btree (definition_version_id);

CREATE INDEX agent_component_session_usage_last_invoked_at_idx ON public.agent_component_session_usage USING btree (last_invoked_at);

CREATE INDEX agent_component_versions_definition_version_id_idx ON public.agent_component_versions USING btree (definition_version_id);

CREATE INDEX agent_component_versions_org_kind_content_hash_idx ON public.agent_component_versions USING btree (organization_id, component_kind, content_hash);

CREATE INDEX agent_component_versions_organization_id_component_kind_com_idx ON public.agent_component_versions USING btree (organization_id, component_kind, component_key);

CREATE UNIQUE INDEX agent_component_versions_organization_id_component_kind_com_key ON public.agent_component_versions USING btree (organization_id, component_kind, component_key, source, content_hash);

CREATE UNIQUE INDEX agent_components_compute_target_id_component_kind_external__key ON public.agent_components USING btree (compute_target_id, component_kind, external_component_id);

CREATE INDEX agent_components_org_kind_content_hash_idx ON public.agent_components USING btree (organization_id, component_kind, content_hash);

CREATE INDEX agent_components_org_pack_id_idx ON public.agent_components USING btree (organization_id, pack_id) WHERE (pack_id IS NOT NULL);

CREATE INDEX agent_components_organization_id_component_kind_idx ON public.agent_components USING btree (organization_id, component_kind);

CREATE INDEX agent_components_organization_id_idx ON public.agent_components USING btree (organization_id);

CREATE INDEX agent_session_activity_segments_agent_session_id_idx ON public.agent_session_activity_segments USING btree (agent_session_id);

CREATE UNIQUE INDEX agent_session_activity_segments_agent_session_id_start_ms_key ON public.agent_session_activity_segments USING btree (agent_session_id, start_ms);

CREATE INDEX agent_session_events_agent_session_id_event_created_at_idx ON public.agent_session_events USING btree (agent_session_id, event_created_at);

CREATE UNIQUE INDEX agent_session_events_agent_session_id_external_event_id_key ON public.agent_session_events USING btree (agent_session_id, external_event_id);

CREATE INDEX agent_session_token_events_agent_session_id_event_created_a_idx ON public.agent_session_token_events USING btree (agent_session_id, event_created_at);

CREATE UNIQUE INDEX agent_session_token_events_agent_session_id_external_event__key ON public.agent_session_token_events USING btree (agent_session_id, external_event_id);

CREATE UNIQUE INDEX agent_session_token_usage_agent_session_id_model_key ON public.agent_session_token_usage USING btree (agent_session_id, model);

CREATE INDEX agent_session_token_usage_model_idx ON public.agent_session_token_usage USING btree (model);

CREATE INDEX agent_versions_agent_id_idx ON public.agent_versions USING btree (agent_id);

CREATE UNIQUE INDEX agent_versions_agent_id_version_key ON public.agent_versions USING btree (agent_id, version);

CREATE INDEX agents_organization_id_enabled_idx ON public.agents USING btree (organization_id, enabled);

CREATE INDEX agents_organization_id_idx ON public.agents USING btree (organization_id);

CREATE UNIQUE INDEX agents_organization_id_slug_key ON public.agents USING btree (organization_id, slug);

CREATE UNIQUE INDEX agents_organization_id_source_repo_role_key ON public.agents USING btree (organization_id, source_repo, role);

CREATE UNIQUE INDEX api_keys_active_desktop_managed_gateway_key ON public.api_keys USING btree (organization_id, user_id, gateway_id) WHERE ((source = 'DESKTOP_MANAGED'::public."ApiKeySource") AND (gateway_id IS NOT NULL) AND (revoked_at IS NULL));

CREATE UNIQUE INDEX api_keys_key_hash_key ON public.api_keys USING btree (key_hash);

CREATE INDEX api_keys_organization_id_idx ON public.api_keys USING btree (organization_id);

CREATE INDEX api_keys_organization_id_user_id_gateway_id_idx ON public.api_keys USING btree (organization_id, user_id, gateway_id);

CREATE INDEX artifact_activity_events_organization_id_artifact_id_create_idx ON public.artifact_activity_events USING btree (organization_id, artifact_id, created_at);

CREATE INDEX artifact_evaluations_artifact_id_created_at_idx ON public.artifact_evaluations USING btree (artifact_id, created_at);

CREATE UNIQUE INDEX artifact_evaluations_artifact_id_report_id_key ON public.artifact_evaluations USING btree (artifact_id, report_id);

CREATE INDEX artifact_evaluations_organization_id_created_at_idx ON public.artifact_evaluations USING btree (organization_id, created_at);

CREATE UNIQUE INDEX artifact_generation_status_dismissals_artifact_id_key ON public.artifact_generation_status_dismissals USING btree (artifact_id);

CREATE INDEX artifact_generation_status_dismissals_dismissed_by_id_idx ON public.artifact_generation_status_dismissals USING btree (dismissed_by_id);

CREATE INDEX artifact_links_org_source_link_participation_idx ON public.artifact_links USING btree (organization_id, source_id, link_type, branch_participation);

CREATE INDEX artifact_links_org_target_link_participation_idx ON public.artifact_links USING btree (organization_id, target_id, link_type, branch_participation);

CREATE INDEX artifact_links_organization_id_source_id_link_type_idx ON public.artifact_links USING btree (organization_id, source_id, link_type);

CREATE INDEX artifact_links_organization_id_target_id_link_type_idx ON public.artifact_links USING btree (organization_id, target_id, link_type);

CREATE UNIQUE INDEX artifact_links_source_id_target_id_link_type_key ON public.artifact_links USING btree (source_id, target_id, link_type);

CREATE INDEX artifact_ratings_artifact_id_organization_id_idx ON public.artifact_ratings USING btree (artifact_id, organization_id);

CREATE UNIQUE INDEX artifact_ratings_artifact_id_user_id_organization_id_key ON public.artifact_ratings USING btree (artifact_id, user_id, organization_id);

CREATE INDEX artifacts_org_assignee_created_id_idx ON public.artifacts USING btree (organization_id, assignee_id, created_at DESC, id DESC);

CREATE INDEX artifacts_org_assignee_updated_idx ON public.artifacts USING btree (organization_id, assignee_id, updated_at DESC);

CREATE UNIQUE INDEX artifacts_org_template_for_type_key ON public.artifacts USING btree (organization_id, template_for_type) WHERE (template_for_type IS NOT NULL);

CREATE INDEX artifacts_organization_id_assignee_id_idx ON public.artifacts USING btree (organization_id, assignee_id);

CREATE INDEX artifacts_organization_id_created_by_id_idx ON public.artifacts USING btree (organization_id, created_by_id);

CREATE INDEX artifacts_organization_id_project_id_sort_order_idx ON public.artifacts USING btree (organization_id, project_id, sort_order);

CREATE INDEX artifacts_organization_id_project_id_type_idx ON public.artifacts USING btree (organization_id, project_id, type);

CREATE UNIQUE INDEX artifacts_organization_id_slug_key ON public.artifacts USING btree (organization_id, slug);

CREATE INDEX artifacts_organization_id_type_status_idx ON public.artifacts USING btree (organization_id, type, status);

CREATE INDEX audit_entries_organization_id_object_type_object_id_idx ON public.audit_entries USING btree (organization_id, object_type, object_id);

CREATE INDEX audit_outbox_attempts_created_at_idx ON public.audit_outbox USING btree (attempts, created_at);

CREATE INDEX audit_outbox_organization_id_created_at_idx ON public.audit_outbox USING btree (organization_id, created_at);

CREATE INDEX auth_accounts_user_id_idx ON public.auth_accounts USING btree (user_id);

CREATE INDEX auth_invitations_email_idx ON public.auth_invitations USING btree (email);

CREATE INDEX auth_invitations_organization_id_idx ON public.auth_invitations USING btree (organization_id);

CREATE INDEX auth_members_organization_id_idx ON public.auth_members USING btree (organization_id);

CREATE INDEX auth_members_user_id_idx ON public.auth_members USING btree (user_id);

CREATE UNIQUE INDEX auth_organizations_slug_key ON public.auth_organizations USING btree (slug);

CREATE UNIQUE INDEX auth_sessions_token_key ON public.auth_sessions USING btree (token);

CREATE INDEX auth_sessions_user_id_idx ON public.auth_sessions USING btree (user_id);

CREATE UNIQUE INDEX auth_users_email_key ON public.auth_users USING btree (email);

CREATE INDEX auth_verifications_identifier_idx ON public.auth_verifications USING btree (identifier);

CREATE INDEX branch_activity_atoms_latest_idx ON public.branch_activity_atoms USING btree (organization_id, branch_artifact_id, occurred_at DESC, source, source_event_id);

CREATE INDEX branch_detail_check_run_retry_due_idx ON public.branch_detail USING btree (check_run_retry_state, check_run_retry_next_at);

CREATE INDEX branch_detail_check_run_retry_repo_head_idx ON public.branch_detail USING btree (repository_id, check_run_retry_head_sha);

CREATE UNIQUE INDEX branch_detail_check_run_retry_resource_key_idx ON public.branch_detail USING btree (artifact_id, repository_id, check_run_retry_head_sha, check_run_retry_resource_id, check_run_retry_idempotency_key) WHERE ((check_run_retry_state IS NOT NULL) AND (check_run_retry_head_sha IS NOT NULL) AND (check_run_retry_resource_id IS NOT NULL) AND (check_run_retry_idempotency_key IS NOT NULL));

CREATE INDEX branch_detail_current_pull_request_detail_id_idx ON public.branch_detail USING btree (current_pull_request_detail_id);

CREATE INDEX branch_detail_last_activity_at_idx ON public.branch_detail USING btree (last_activity_at);

CREATE UNIQUE INDEX branch_detail_org_artifact_key ON public.branch_detail USING btree (organization_id, artifact_id);

CREATE INDEX branch_detail_org_first_pushed_at_idx ON public.branch_detail USING btree (organization_id, first_pushed_at);

CREATE UNIQUE INDEX branch_detail_org_repo_full_name_branch_key ON public.branch_detail USING btree (organization_id, repository_full_name, branch_name);

CREATE INDEX branch_detail_remote_head_evidence_idx ON public.branch_detail USING btree (head_sha_source, last_activity_at DESC, artifact_id) WHERE ((head_sha IS NOT NULL) AND (deleted_at IS NULL));

CREATE INDEX branch_detail_repository_id_head_sha_idx ON public.branch_detail USING btree (repository_id, head_sha);

CREATE INDEX branch_detail_sync_status_idx ON public.branch_detail USING btree (sync_status);

CREATE INDEX branch_file_changes_branch_artifact_id_head_sha_idx ON public.branch_file_changes USING btree (branch_artifact_id, head_sha);

CREATE UNIQUE INDEX branch_file_changes_branch_artifact_id_head_sha_path_key ON public.branch_file_changes USING btree (branch_artifact_id, head_sha, path);

CREATE INDEX branch_file_changes_branch_artifact_id_path_idx ON public.branch_file_changes USING btree (branch_artifact_id, path);

CREATE INDEX branch_status_checks_branch_head_position_idx ON public.branch_status_checks USING btree (branch_artifact_id, head_sha, "position");

CREATE UNIQUE INDEX branch_status_checks_branch_head_provider_key ON public.branch_status_checks USING btree (branch_artifact_id, head_sha, provider_key);

CREATE INDEX catalog_item_versions_catalog_item_id_idx ON public.catalog_item_versions USING btree (catalog_item_id);

CREATE UNIQUE INDEX catalog_item_versions_catalog_item_id_version_key ON public.catalog_item_versions USING btree (catalog_item_id, version);

CREATE INDEX catalog_item_versions_definition_version_id_idx ON public.catalog_item_versions USING btree (definition_version_id);

CREATE UNIQUE INDEX catalog_items_organization_id_agent_slug_agent_key ON public.catalog_items USING btree (organization_id, agent_slug) WHERE ((target_kind = 'agent'::text) AND (agent_slug IS NOT NULL));

CREATE INDEX catalog_items_organization_id_archived_idx ON public.catalog_items USING btree (organization_id, archived);

CREATE INDEX catalog_items_organization_id_component_uuid_idx ON public.catalog_items USING btree (organization_id, component_uuid);

CREATE UNIQUE INDEX catalog_items_organization_id_source_agent_component_id_key ON public.catalog_items USING btree (organization_id, source_agent_component_id) WHERE (source_agent_component_id IS NOT NULL);

CREATE UNIQUE INDEX catalog_items_organization_id_source_repo_role_agent_key ON public.catalog_items USING btree (organization_id, source_repo, role) WHERE (target_kind = 'agent'::text);

CREATE INDEX catalog_items_organization_id_target_kind_idx ON public.catalog_items USING btree (organization_id, target_kind);

CREATE INDEX catalog_items_parent_pack_id_idx ON public.catalog_items USING btree (parent_pack_id);

CREATE INDEX catalog_items_source_scope_idx ON public.catalog_items USING btree (source, scope);

CREATE INDEX chat_sessions_organization_id_user_id_idx ON public.chat_sessions USING btree (organization_id, user_id);

CREATE UNIQUE INDEX chat_sessions_user_id_chat_key_key ON public.chat_sessions USING btree (user_id, chat_key);

CREATE INDEX chat_sessions_user_id_idx ON public.chat_sessions USING btree (user_id);

CREATE INDEX comment_attachments_comment_id_idx ON public.comment_attachments USING btree (comment_id);

CREATE UNIQUE INDEX comment_attachments_external_id_key ON public.comment_attachments USING btree (external_id);

CREATE UNIQUE INDEX comment_reactions_comment_id_user_id_emoji_key ON public.comment_reactions USING btree (comment_id, user_id, emoji);

CREATE INDEX comment_threads_created_by_id_idx ON public.comment_threads USING btree (created_by_id);

CREATE UNIQUE INDEX comment_threads_id_artifact_id_key ON public.comment_threads USING btree (id, artifact_id);

CREATE INDEX comment_threads_organization_id_artifact_id_status_idx ON public.comment_threads USING btree (organization_id, artifact_id, status);

CREATE UNIQUE INDEX comment_threads_organization_id_external_id_key ON public.comment_threads USING btree (organization_id, external_id);

CREATE INDEX comment_threads_organization_id_room_id_idx ON public.comment_threads USING btree (organization_id, room_id);

CREATE INDEX comment_threads_organization_id_source_status_created_at_idx ON public.comment_threads USING btree (organization_id, source, status, created_at);

CREATE INDEX comment_threads_organization_id_status_updated_at_idx ON public.comment_threads USING btree (organization_id, status, updated_at);

CREATE INDEX comments_author_id_idx ON public.comments USING btree (author_id);

CREATE UNIQUE INDEX comments_external_id_key ON public.comments USING btree (external_id);

CREATE UNIQUE INDEX comments_id_thread_id_key ON public.comments USING btree (id, thread_id);

CREATE INDEX comments_parent_comment_id_idx ON public.comments USING btree (parent_comment_id);

CREATE INDEX comments_thread_id_created_at_idx ON public.comments USING btree (thread_id, created_at);

CREATE INDEX commit_detail_branch_committed_at_idx ON public.commit_detail USING btree (branch_artifact_id, committed_at);

CREATE UNIQUE INDEX commit_detail_org_repo_full_name_sha_key ON public.commit_detail USING btree (organization_id, repository_full_name, sha);

CREATE UNIQUE INDEX compute_target_capabilities_compute_target_id_project_id_key ON public.compute_target_capabilities USING btree (compute_target_id, project_id);

CREATE INDEX compute_target_capabilities_project_id_idx ON public.compute_target_capabilities USING btree (project_id);

CREATE UNIQUE INDEX compute_target_health_checks_compute_target_id_key ON public.compute_target_health_checks USING btree (compute_target_id);

CREATE INDEX compute_target_health_checks_organization_id_checked_at_idx ON public.compute_target_health_checks USING btree (organization_id, checked_at);

CREATE UNIQUE INDEX compute_targets_gateway_id_unique_idx ON public.compute_targets USING btree (gateway_id) WHERE (gateway_id IS NOT NULL);

CREATE INDEX compute_targets_ingest_group_idx ON public.compute_targets USING btree (organization_id, last_agent_session_sync_at) WHERE ((is_cloud_sentinel = false) AND (last_agent_session_sync_at IS NOT NULL));

CREATE INDEX compute_targets_never_ingested_idx ON public.compute_targets USING btree (organization_id) WHERE ((is_cloud_sentinel = false) AND (last_agent_session_sync_at IS NULL));

CREATE INDEX compute_targets_organization_id_is_shared_with_org_idx ON public.compute_targets USING btree (organization_id, is_shared_with_org);

CREATE INDEX compute_targets_organization_id_user_id_gateway_id_idx ON public.compute_targets USING btree (organization_id, user_id, gateway_id);

CREATE INDEX compute_targets_organization_id_user_id_idx ON public.compute_targets USING btree (organization_id, user_id);

CREATE INDEX compute_targets_presence_group_idx ON public.compute_targets USING btree (organization_id, last_seen_at) INCLUDE (last_agent_session_sync_attempt_at) WHERE (is_cloud_sentinel = false);

CREATE INDEX compute_targets_user_id_is_online_idx ON public.compute_targets USING btree (user_id, is_online);

CREATE UNIQUE INDEX compute_targets_user_id_machine_name_key ON public.compute_targets USING btree (user_id, machine_name);

CREATE UNIQUE INDEX custom_field_enum_options_custom_field_id_name_key ON public.custom_field_enum_options USING btree (custom_field_id, name);

CREATE INDEX custom_field_enum_options_custom_field_id_sort_order_idx ON public.custom_field_enum_options USING btree (custom_field_id, sort_order);

CREATE UNIQUE INDEX custom_field_settings_custom_field_id_entity_type_entity_id_key ON public.custom_field_settings USING btree (custom_field_id, entity_type, entity_id);

CREATE INDEX custom_field_settings_organization_id_entity_type_entity_id_idx ON public.custom_field_settings USING btree (organization_id, entity_type, entity_id);

CREATE UNIQUE INDEX custom_field_values_custom_field_id_entity_type_entity_id_key ON public.custom_field_values USING btree (custom_field_id, entity_type, entity_id);

CREATE INDEX custom_field_values_organization_id_entity_type_entity_id_idx ON public.custom_field_values USING btree (organization_id, entity_type, entity_id);

CREATE UNIQUE INDEX custom_fields_organization_id_name_key ON public.custom_fields USING btree (organization_id, name);

CREATE UNIQUE INDEX definition_version_editors_definition_version_id_user_id_key ON public.definition_version_editors USING btree (definition_version_id, user_id);

CREATE INDEX definition_version_editors_user_id_idx ON public.definition_version_editors USING btree (user_id);

CREATE INDEX definition_versions_organization_id_component_kind_idx ON public.definition_versions USING btree (organization_id, component_kind);

CREATE UNIQUE INDEX definition_versions_organization_id_definition_hash_key ON public.definition_versions USING btree (organization_id, definition_hash);

CREATE INDEX deployment_detail_branch_artifact_id_idx ON public.deployment_detail USING btree (branch_artifact_id);

CREATE INDEX deployment_detail_ref_sha_idx ON public.deployment_detail USING btree (ref, sha);

CREATE UNIQUE INDEX deployment_events_org_source_event_key ON public.deployment_events USING btree (organization_id, source, external_event_id);

CREATE UNIQUE INDEX desktop_authorization_codes_code_hash_key ON public.desktop_authorization_codes USING btree (code_hash);

CREATE INDEX desktop_authorization_codes_expires_at_idx ON public.desktop_authorization_codes USING btree (expires_at);

CREATE UNIQUE INDEX desktop_commands_compute_target_id_idempotency_key_key ON public.desktop_commands USING btree (compute_target_id, idempotency_key) WHERE (idempotency_key IS NOT NULL);

CREATE INDEX desktop_commands_compute_target_id_status_created_at_idx ON public.desktop_commands USING btree (compute_target_id, status, created_at);

CREATE INDEX desktop_commands_operation_id_idx ON public.desktop_commands USING btree (operation_id);

CREATE INDEX desktop_device_sessions_gateway_status_exp_idx ON public.desktop_onboarding_device_sessions USING btree (gateway_id, status, expires_at);

CREATE INDEX desktop_device_sessions_ip_status_exp_idx ON public.desktop_onboarding_device_sessions USING btree (request_ip_hash, status, expires_at);

CREATE INDEX desktop_onboarding_attempts_expires_at_idx ON public.desktop_onboarding_attempts USING btree (expires_at);

CREATE INDEX desktop_onboarding_attempts_organization_id_user_id_idx ON public.desktop_onboarding_attempts USING btree (organization_id, user_id);

CREATE INDEX desktop_onboarding_device_sessions_expires_at_idx ON public.desktop_onboarding_device_sessions USING btree (expires_at);

CREATE UNIQUE INDEX desktop_onboarding_device_sessions_user_code_key ON public.desktop_onboarding_device_sessions USING btree (user_code);

CREATE INDEX desktop_refresh_tokens_expires_at_idx ON public.desktop_refresh_tokens USING btree (expires_at);

CREATE INDEX desktop_refresh_tokens_family_id_revoked_at_idx ON public.desktop_refresh_tokens USING btree (family_id, revoked_at);

CREATE INDEX desktop_refresh_tokens_session_id_revoked_at_idx ON public.desktop_refresh_tokens USING btree (session_id, revoked_at);

CREATE UNIQUE INDEX desktop_refresh_tokens_token_hash_key ON public.desktop_refresh_tokens USING btree (token_hash);

CREATE INDEX desktop_sessions_expires_at_idx ON public.desktop_sessions USING btree (expires_at);

CREATE INDEX desktop_sessions_organization_id_idx ON public.desktop_sessions USING btree (organization_id);

CREATE INDEX desktop_sessions_user_id_idx ON public.desktop_sessions USING btree (user_id);

CREATE INDEX desktop_sessions_user_id_organization_id_gateway_id_revoked_idx ON public.desktop_sessions USING btree (user_id, organization_id, gateway_id, revoked_at);

CREATE INDEX distribution_target_status_compute_target_id_idx ON public.distribution_target_status USING btree (compute_target_id);

CREATE UNIQUE INDEX distribution_target_status_distribution_id_compute_target_id_ke ON public.distribution_target_status USING btree (distribution_id, compute_target_id) WHERE (compute_target_id IS NOT NULL);

CREATE INDEX distribution_target_status_distribution_id_idx ON public.distribution_target_status USING btree (distribution_id);

CREATE INDEX distribution_target_status_distribution_id_status_idx ON public.distribution_target_status USING btree (distribution_id, status);

CREATE INDEX distribution_targeting_entries_compute_target_id_idx ON public.distribution_targeting_entries USING btree (compute_target_id);

CREATE INDEX distribution_targeting_entries_distribution_id_idx ON public.distribution_targeting_entries USING btree (distribution_id);

CREATE INDEX distributions_catalog_item_id_idx ON public.distributions USING btree (catalog_item_id);

CREATE INDEX distributions_organization_id_idx ON public.distributions USING btree (organization_id);

CREATE UNIQUE INDEX document_versions_artifact_id_version_key ON public.document_versions USING btree (artifact_id, version);

CREATE INDEX external_comment_authors_organization_id_provider_normalize_idx ON public.external_comment_authors USING btree (organization_id, provider, normalized_provider_login);

CREATE UNIQUE INDEX external_comment_authors_organization_id_provider_provider__key ON public.external_comment_authors USING btree (organization_id, provider, provider_user_id);

CREATE INDEX external_comment_authors_user_id_idx ON public.external_comment_authors USING btree (user_id);

CREATE INDEX favorite_artifacts_artifact_id_idx ON public.favorite_artifacts USING btree (artifact_id);

CREATE UNIQUE INDEX favorite_artifacts_user_id_artifact_id_key ON public.favorite_artifacts USING btree (user_id, artifact_id);

CREATE INDEX favorite_projects_project_id_idx ON public.favorite_projects USING btree (project_id);

CREATE UNIQUE INDEX favorite_projects_user_id_project_id_key ON public.favorite_projects USING btree (user_id, project_id);

CREATE INDEX file_attachments_artifact_id_idx ON public.file_attachments USING btree (artifact_id);

CREATE INDEX file_attachments_artifact_id_purpose_idx ON public.file_attachments USING btree (artifact_id, purpose);

CREATE INDEX file_attachments_bucket_key_idx ON public.file_attachments USING btree (bucket, key);

CREATE INDEX file_attachments_bucket_reconcile_absent_reconciled_at_idx ON public.file_attachments USING btree (bucket, reconcile_absent, reconciled_at);

CREATE UNIQUE INDEX github_access_capabilities_conn_owner_key ON public.github_access_capabilities USING btree (github_user_connection_id, normalized_target_owner) WHERE (target_repo IS NULL);

CREATE UNIQUE INDEX github_access_capabilities_conn_owner_repo_key ON public.github_access_capabilities USING btree (github_user_connection_id, normalized_target_owner, target_repo) WHERE (target_repo IS NOT NULL);

CREATE INDEX github_access_capabilities_expires_at_idx ON public.github_access_capabilities USING btree (expires_at);

CREATE INDEX github_access_capabilities_github_user_connection_id_idx ON public.github_access_capabilities USING btree (github_user_connection_id);

CREATE INDEX github_access_capabilities_normalized_target_owner_idx ON public.github_access_capabilities USING btree (normalized_target_owner);

CREATE INDEX github_access_capabilities_organization_id_idx ON public.github_access_capabilities USING btree (organization_id);

CREATE UNIQUE INDEX github_comment_projections_comment_thread_key ON public.github_comment_projections USING btree (comment_id, thread_id);

CREATE INDEX github_comment_projections_external_author_id_idx ON public.github_comment_projections USING btree (external_author_id);

CREATE INDEX github_comment_projections_in_reply_to_idx ON public.github_comment_projections USING btree (github_in_reply_to_comment_id);

CREATE INDEX github_comment_projections_thread_github_comment_idx ON public.github_comment_projections USING btree (thread_id, github_comment_id);

CREATE UNIQUE INDEX github_comment_projections_thread_github_comment_unique ON public.github_comment_projections USING btree (thread_id, github_comment_id) WHERE ((github_comment_id IS NOT NULL) AND (github_deleted_at IS NULL));

CREATE INDEX github_comment_thread_projections_last_synced_at_idx ON public.github_comment_thread_projections USING btree (last_synced_at);

CREATE INDEX github_comment_thread_projections_pr_detail_idx ON public.github_comment_thread_projections USING btree (pull_request_detail_id);

CREATE UNIQUE INDEX github_comment_thread_projections_pr_review_thread_unique ON public.github_comment_thread_projections USING btree (pull_request_detail_id, thread_kind, review_thread_id) WHERE ((review_thread_id IS NOT NULL) AND (deleted_at IS NULL));

CREATE UNIQUE INDEX github_comment_thread_projections_pr_root_comment_unique ON public.github_comment_thread_projections USING btree (pull_request_detail_id, thread_kind, root_comment_id) WHERE ((root_comment_id IS NOT NULL) AND (deleted_at IS NULL));

CREATE INDEX github_comment_thread_projections_review_thread_idx ON public.github_comment_thread_projections USING btree (pull_request_detail_id, thread_kind, review_thread_id);

CREATE INDEX github_comment_thread_projections_root_comment_idx ON public.github_comment_thread_projections USING btree (pull_request_detail_id, thread_kind, root_comment_id);

CREATE UNIQUE INDEX github_comment_thread_projections_thread_branch_key ON public.github_comment_thread_projections USING btree (thread_id, branch_artifact_id);

CREATE INDEX github_dirty_scope_nudges_dispatch_claim_idx ON public.github_dirty_scope_nudges USING btree (dispatch_claimed_at);

CREATE INDEX github_dirty_scope_nudges_dispatch_due_idx ON public.github_dirty_scope_nudges USING btree (scheduled_dispatch_at, dispatched_at);

CREATE INDEX github_dirty_scope_nudges_expires_idx ON public.github_dirty_scope_nudges USING btree (expires_at);

CREATE INDEX github_dirty_scope_nudges_org_repo_idx ON public.github_dirty_scope_nudges USING btree (organization_id, github_installation_repository_id);

CREATE UNIQUE INDEX github_dirty_scope_nudges_org_repo_target_window_key ON public.github_dirty_scope_nudges USING btree (organization_id, github_installation_repository_id, compute_target_id, window_started_at);

CREATE INDEX github_installation_repositories_inst_lower_full_name_idx ON public.github_installation_repositories USING btree (installation_id, lower(full_name)) WHERE (removed_at IS NULL);

CREATE UNIQUE INDEX github_installation_repositories_installation_id_github_rep_key ON public.github_installation_repositories USING btree (installation_id, github_repo_id);

CREATE INDEX github_installations_account_id_idx ON public.github_installations USING btree (account_id);

CREATE UNIQUE INDEX github_installations_installation_id_key ON public.github_installations USING btree (installation_id);

CREATE UNIQUE INDEX github_installations_organization_id_key ON public.github_installations USING btree (organization_id);

CREATE INDEX github_installations_status_idx ON public.github_installations USING btree (status);

CREATE UNIQUE INDEX github_pr_reviews_github_review_id_key ON public.github_pr_reviews USING btree (github_review_id);

CREATE UNIQUE INDEX github_pr_reviews_pull_request_id_author_login_key ON public.github_pr_reviews USING btree (pull_request_id, author_login);

CREATE UNIQUE INDEX github_repo_sync_state_organization_id_repository_full_name_key ON public.github_repo_sync_state USING btree (organization_id, repository_full_name);

CREATE UNIQUE INDEX github_user_connections_organization_id_github_user_id_key ON public.github_user_connections USING btree (organization_id, github_user_id);

CREATE INDEX github_user_connections_organization_id_normalized_login_idx ON public.github_user_connections USING btree (organization_id, normalized_login);

CREATE UNIQUE INDEX github_user_connections_organization_id_user_id_key ON public.github_user_connections USING btree (organization_id, user_id);

CREATE INDEX github_user_connections_revoked_at_idx ON public.github_user_connections USING btree (revoked_at);

CREATE UNIQUE INDEX google_integrations_organization_id_key ON public.google_integrations USING btree (organization_id);

CREATE INDEX idx_aci_component_branch_invoked_at ON public.agent_component_invocations USING btree (agent_component_id, branch_name, invoked_at);

CREATE INDEX idx_aci_component_invoked_at ON public.agent_component_invocations USING btree (agent_component_id, invoked_at);

CREATE INDEX idx_aci_definition_version_invoked_at ON public.agent_component_invocations USING btree (definition_version_id, invoked_at);

CREATE UNIQUE INDEX idx_aci_generation_external_invocation ON public.agent_component_invocations USING btree (generation_id, external_invocation_id);

CREATE INDEX idx_aci_generation_sequence ON public.agent_component_invocations USING btree (generation_id, sequence);

CREATE INDEX idx_aci_status_invoked_at ON public.agent_component_invocations USING btree (attribution_status, invoked_at);

CREATE UNIQUE INDEX idx_acig_one_active_per_session ON public.agent_component_invocation_generations USING btree (agent_session_id) WHERE (active_at IS NOT NULL);

CREATE INDEX idx_acig_session_active ON public.agent_component_invocation_generations USING btree (agent_session_id, active_at);

CREATE UNIQUE INDEX idx_acig_session_external_generation_freshness ON public.agent_component_invocation_generations USING btree (agent_session_id, external_generation_id, source_updated_at, data_revision, source_sequence);

CREATE INDEX idx_acig_session_source_freshness ON public.agent_component_invocation_generations USING btree (agent_session_id, source_updated_at, data_revision, source_sequence);

CREATE UNIQUE INDEX idx_acip_generation_part ON public.agent_component_invocation_parts USING btree (generation_id, part_index);

CREATE UNIQUE INDEX idx_acsu_session_kind_key_branch ON public.agent_component_session_usage USING btree (agent_session_id, component_kind, component_key, git_branch);

CREATE UNIQUE INDEX idx_source_occurrence_natural_key ON public.source_occurrences USING btree (definition_version_id, occurrence_type, repo_full_name, repo_path, repo_commit, compute_target_id, local_path, pack_id);

CREATE UNIQUE INDEX idx_source_occurrence_null_target_key ON public.source_occurrences USING btree (definition_version_id, occurrence_type, repo_full_name, repo_path, repo_commit, local_path, pack_id) WHERE (compute_target_id IS NULL);

CREATE UNIQUE INDEX idx_source_occurrence_null_target_natural_key ON public.source_occurrences USING btree (definition_version_id, occurrence_type, COALESCE(repo_full_name, ''::text), COALESCE(repo_path, ''::text), COALESCE(repo_commit, ''::text), COALESCE(local_path, ''::text), COALESCE(pack_id, ''::text)) WHERE (compute_target_id IS NULL);

CREATE INDEX integration_connections_delivery_mode_next_poll_at_idx ON public.integration_connections USING btree (delivery_mode, next_poll_at);

CREATE UNIQUE INDEX integration_connections_inbound_key_key ON public.integration_connections USING btree (inbound_key);

CREATE UNIQUE INDEX integration_connections_managed_by_workflow_id_key ON public.integration_connections USING btree (managed_by_workflow_id);

CREATE INDEX integration_connections_organization_id_provider_idx ON public.integration_connections USING btree (organization_id, provider);

CREATE UNIQUE INDEX integration_deliveries_connection_id_delivery_id_key ON public.integration_deliveries USING btree (connection_id, delivery_id);

CREATE INDEX integration_deliveries_organization_id_received_at_idx ON public.integration_deliveries USING btree (organization_id, received_at);

CREATE INDEX integration_tool_calls_action_run_id_created_at_idx ON public.integration_tool_calls USING btree (action_run_id, created_at);

CREATE UNIQUE INDEX integration_tool_calls_idempotency_key_key ON public.integration_tool_calls USING btree (idempotency_key);

CREATE INDEX integration_tool_calls_loop_id_idx ON public.integration_tool_calls USING btree (loop_id);

CREATE INDEX integration_tool_calls_run_id_created_at_idx ON public.integration_tool_calls USING btree (run_id, created_at);

CREATE INDEX integration_tool_calls_session_id_idx ON public.integration_tool_calls USING btree (session_id);

CREATE UNIQUE INDEX integration_tool_sessions_action_run_id_attempt_key ON public.integration_tool_sessions USING btree (action_run_id, attempt);

CREATE UNIQUE INDEX integration_tool_sessions_loop_id_key ON public.integration_tool_sessions USING btree (loop_id);

CREATE UNIQUE INDEX integration_tool_sessions_token_hash_key ON public.integration_tool_sessions USING btree (token_hash);

CREATE INDEX judge_human_scores_evaluation_id_idx ON public.judge_human_scores USING btree (evaluation_id);

CREATE UNIQUE INDEX judge_human_scores_judge_score_id_user_id_organization_id_key ON public.judge_human_scores USING btree (judge_score_id, user_id, organization_id);

CREATE INDEX judge_human_scores_organization_id_user_id_idx ON public.judge_human_scores USING btree (organization_id, user_id);

CREATE UNIQUE INDEX judge_scores_evaluation_id_case_id_metric_name_key ON public.judge_scores USING btree (evaluation_id, case_id, metric_name);

CREATE INDEX judge_scores_prompt_id_idx ON public.judge_scores USING btree (prompt_id);

CREATE UNIQUE INDEX linear_integrations_organization_id_key ON public.linear_integrations USING btree (organization_id);

CREATE INDEX linear_subtasks_document_id_is_completed_idx ON public.linear_subtasks USING btree (document_id, is_completed);

CREATE UNIQUE INDEX linear_subtasks_linear_id_key ON public.linear_subtasks USING btree (linear_id);

CREATE INDEX linear_subtasks_organization_id_idx ON public.linear_subtasks USING btree (organization_id);

CREATE INDEX local_gateway_challenge_jtis_expires_at_idx ON public.local_gateway_challenge_jtis USING btree (expires_at);

CREATE INDEX loop_events_loop_id_created_at_idx ON public.loop_events USING btree (loop_id, created_at);

CREATE UNIQUE INDEX loop_events_loop_id_event_source_event_id_key ON public.loop_events USING btree (loop_id, event_source, event_id);

CREATE INDEX loop_events_loop_id_type_idx ON public.loop_events USING btree (loop_id, type);

CREATE INDEX loop_execution_credential_consumptions_compute_target_id_gatewa ON public.loop_execution_credential_consumptions USING btree (compute_target_id, gateway_id);

CREATE INDEX loop_execution_credential_consumptions_loop_id_idx ON public.loop_execution_credential_consumptions USING btree (loop_id);

CREATE UNIQUE INDEX loop_token_refresh_jti_key ON public.loop_token_refresh USING btree (jti);

CREATE INDEX loop_token_refresh_loop_id_idx ON public.loop_token_refresh USING btree (loop_id);

CREATE UNIQUE INDEX loops_active_artifact_command_version_key ON public.loops USING btree (artifact_id, command, artifact_version) WHERE (status = ANY (ARRAY['PENDING'::public."LoopStatus", 'CLAIMED'::public."LoopStatus", 'RUNNING'::public."LoopStatus"]));

CREATE INDEX loops_artifact_id_command_artifact_version_idx ON public.loops USING btree (artifact_id, command, artifact_version);

CREATE UNIQUE INDEX loops_blocked_artifact_command_key ON public.loops USING btree (artifact_id, command) WHERE (status = 'BLOCKED'::public."LoopStatus");

CREATE INDEX loops_compute_target_id_idx ON public.loops USING btree (compute_target_id);

CREATE INDEX loops_organization_id_artifact_id_command_idx ON public.loops USING btree (organization_id, artifact_id, command);

CREATE INDEX loops_organization_id_status_idx ON public.loops USING btree (organization_id, status);

CREATE INDEX loops_organization_id_user_id_created_at_idx ON public.loops USING btree (organization_id, user_id, created_at);

CREATE INDEX loops_parent_loop_id_idx ON public.loops USING btree (parent_loop_id);

CREATE UNIQUE INDEX loops_session_artifact_id_key ON public.loops USING btree (session_artifact_id);

CREATE INDEX loops_status_completed_at_idx ON public.loops USING btree (status, completed_at);

CREATE UNIQUE INDEX oauth_authorization_codes_code_fingerprint_key ON public.oauth_authorization_codes USING btree (code_fingerprint);

CREATE INDEX oauth_authorization_codes_consumed_at_idx ON public.oauth_authorization_codes USING btree (consumed_at);

CREATE INDEX oauth_authorization_codes_expires_at_idx ON public.oauth_authorization_codes USING btree (expires_at);

CREATE UNIQUE INDEX oauth_rate_limits_bucket_subject_key ON public.oauth_rate_limits USING btree (bucket, subject);

CREATE INDEX oauth_rate_limits_window_expires_at_idx ON public.oauth_rate_limits USING btree (window_expires_at);

CREATE INDEX oauth_refresh_tokens_expires_at_idx ON public.oauth_refresh_tokens USING btree (expires_at);

CREATE INDEX oauth_refresh_tokens_family_id_revoked_at_idx ON public.oauth_refresh_tokens USING btree (family_id, revoked_at);

CREATE UNIQUE INDEX oauth_refresh_tokens_token_fingerprint_key ON public.oauth_refresh_tokens USING btree (token_fingerprint);

CREATE INDEX oauth_revoked_tokens_expires_at_idx ON public.oauth_revoked_tokens USING btree (expires_at);

CREATE UNIQUE INDEX oauth_revoked_tokens_token_fingerprint_key ON public.oauth_revoked_tokens USING btree (token_fingerprint);

CREATE UNIQUE INDEX orchestrator_anchors_organization_id_provider_external_ref_key ON public.orchestrator_anchors USING btree (organization_id, provider, external_ref);

CREATE UNIQUE INDEX orchestrator_cases_workflow_id_source_key_key ON public.orchestrator_cases USING btree (workflow_id, source_key);

CREATE UNIQUE INDEX orchestrator_conversations_case_id_channel_key_key ON public.orchestrator_conversations USING btree (case_id, channel_key);

CREATE INDEX orchestrator_conversations_next_wake_at_idx ON public.orchestrator_conversations USING btree (next_wake_at);

CREATE INDEX orchestrator_decisions_case_id_status_idx ON public.orchestrator_decisions USING btree (case_id, status);

CREATE UNIQUE INDEX orchestrator_messages_conversation_id_dedup_key_key ON public.orchestrator_messages USING btree (conversation_id, dedup_key);

CREATE INDEX orchestrator_messages_conversation_id_turn_id_idx ON public.orchestrator_messages USING btree (conversation_id, turn_id);

CREATE INDEX orchestrator_tasks_case_id_compute_target_id_idx ON public.orchestrator_tasks USING btree (case_id, compute_target_id);

CREATE UNIQUE INDEX orchestrator_tasks_loop_id_key ON public.orchestrator_tasks USING btree (loop_id);

CREATE INDEX orchestrator_tasks_status_idx ON public.orchestrator_tasks USING btree (status);

CREATE INDEX orchestrator_turns_conversation_id_status_idx ON public.orchestrator_turns USING btree (conversation_id, status);

CREATE UNIQUE INDEX orchestrator_turns_token_hash_key ON public.orchestrator_turns USING btree (token_hash);

CREATE INDEX orchestrator_waits_conversation_id_fired_at_idx ON public.orchestrator_waits USING btree (conversation_id, fired_at);

CREATE UNIQUE INDEX organizations_clerk_id_key ON public.organizations USING btree (clerk_id);

CREATE UNIQUE INDEX organizations_slug_key ON public.organizations USING btree (slug);

CREATE INDEX project_connection_scopes_organization_id_scope_key_idx ON public.project_connection_scopes USING btree (organization_id, scope_key);

CREATE UNIQUE INDEX project_connection_scopes_project_connection_id_scope_key_key ON public.project_connection_scopes USING btree (project_connection_id, scope_key);

CREATE INDEX project_connections_organization_id_connection_id_idx ON public.project_connections USING btree (organization_id, connection_id);

CREATE UNIQUE INDEX project_connections_project_id_connection_id_key ON public.project_connections USING btree (project_id, connection_id);

CREATE UNIQUE INDEX project_connections_project_id_key_key ON public.project_connections USING btree (project_id, key);

CREATE UNIQUE INDEX project_process_versions_project_id_version_key ON public.project_process_versions USING btree (project_id, version);

CREATE INDEX project_repositories_connection_id_idx ON public.project_repositories USING btree (connection_id);

CREATE INDEX project_repositories_organization_id_project_id_idx ON public.project_repositories USING btree (organization_id, project_id);

CREATE UNIQUE INDEX project_repositories_project_id_provider_external_id_key ON public.project_repositories USING btree (project_id, provider, external_id);

CREATE INDEX projects_assignee_id_idx ON public.projects USING btree (assignee_id);

CREATE INDEX projects_created_by_id_idx ON public.projects USING btree (created_by_id);

CREATE UNIQUE INDEX projects_organization_id_slug_key ON public.projects USING btree (organization_id, slug);

CREATE INDEX prompt_registry_organization_id_name_idx ON public.prompt_registry USING btree (organization_id, name);

CREATE UNIQUE INDEX prompt_registry_organization_id_name_version_key ON public.prompt_registry USING btree (organization_id, name, version);

CREATE INDEX public_repositories_org_lower_full_name_idx ON public.public_repositories USING btree (organization_id, lower(full_name));

CREATE UNIQUE INDEX public_repositories_organization_id_github_repo_id_key ON public.public_repositories USING btree (organization_id, github_repo_id);

CREATE UNIQUE INDEX pull_request_detail_artifact_id_key ON public.pull_request_detail USING btree (artifact_id);

CREATE INDEX pull_request_detail_branch_artifact_id_is_current_idx ON public.pull_request_detail USING btree (branch_artifact_id, is_current);

CREATE UNIQUE INDEX pull_request_detail_github_id_key ON public.pull_request_detail USING btree (github_id);

CREATE UNIQUE INDEX pull_request_detail_id_branch_artifact_id_key ON public.pull_request_detail USING btree (id, branch_artifact_id);

CREATE UNIQUE INDEX pull_request_detail_org_id_key ON public.pull_request_detail USING btree (organization_id, id);

CREATE INDEX pull_request_detail_org_lower_head_repo_full_name_idx ON public.pull_request_detail USING btree (organization_id, lower(head_repository_full_name)) WHERE (head_repository_full_name IS NOT NULL);

CREATE UNIQUE INDEX pull_request_detail_org_repo_full_name_number_key ON public.pull_request_detail USING btree (organization_id, repository_full_name, number) WHERE (repository_id IS NULL);

CREATE INDEX pull_request_detail_organization_id_idx ON public.pull_request_detail USING btree (organization_id);

CREATE INDEX pull_request_detail_organization_id_pr_state_merged_at_idx ON public.pull_request_detail USING btree (organization_id, pr_state, merged_at);

CREATE UNIQUE INDEX pull_request_detail_repository_id_number_key ON public.pull_request_detail USING btree (repository_id, number);

CREATE INDEX repo_bootstrap_configs_organization_id_idx ON public.repo_bootstrap_configs USING btree (organization_id);

CREATE UNIQUE INDEX repo_bootstrap_configs_organization_id_repo_full_name_key ON public.repo_bootstrap_configs USING btree (organization_id, repo_full_name);

CREATE UNIQUE INDEX routine_runs_organization_id_source_run_id_key ON public.routine_runs USING btree (organization_id, source_run_id);

CREATE INDEX routine_runs_organization_id_started_at_idx ON public.routine_runs USING btree (organization_id, started_at);

CREATE INDEX routine_runs_routine_id_started_at_idx ON public.routine_runs USING btree (routine_id, started_at);

CREATE UNIQUE INDEX routines_organization_id_source_id_key ON public.routines USING btree (organization_id, source_id);

CREATE INDEX routines_organization_id_status_idx ON public.routines USING btree (organization_id, status);

CREATE INDEX routines_organization_id_updated_at_idx ON public.routines USING btree (organization_id, updated_at);

CREATE INDEX search_document_org_lower_slug_idx ON public.search_document USING btree (organization_id, lower(slug)) WHERE (slug IS NOT NULL);

CREATE INDEX search_document_organization_id_entity_id_idx ON public.search_document USING btree (organization_id, entity_id);

CREATE UNIQUE INDEX search_document_organization_id_entity_type_entity_id_key ON public.search_document USING btree (organization_id, entity_type, entity_id);

CREATE INDEX search_document_organization_id_entity_type_updated_at_idx ON public.search_document USING btree (organization_id, entity_type, updated_at);

CREATE INDEX search_document_tsv_gin_idx ON public.search_document USING gin (tsv);

CREATE INDEX session_detail_artifact_id_session_started_at_idx ON public.session_detail USING btree (artifact_id, session_started_at);

CREATE INDEX session_detail_autonomy_idx ON public.session_detail USING btree (autonomy);

CREATE UNIQUE INDEX session_detail_compute_target_id_external_session_id_key ON public.session_detail USING btree (compute_target_id, external_session_id);

CREATE INDEX session_detail_compute_target_id_last_activity_at_idx ON public.session_detail USING btree (compute_target_id, last_activity_at);

CREATE INDEX session_detail_compute_target_id_session_updated_at_idx ON public.session_detail USING btree (compute_target_id, session_updated_at);

CREATE INDEX session_detail_estimated_cost_idx ON public.session_detail USING btree (estimated_cost);

CREATE INDEX session_detail_harness_session_started_at_idx ON public.session_detail USING btree (harness, session_started_at);

CREATE INDEX session_detail_last_activity_at_idx ON public.session_detail USING btree (last_activity_at);

CREATE INDEX session_detail_model_started_at_idx ON public.session_detail USING btree (model, session_started_at);

CREATE INDEX session_detail_repository_full_name_idx ON public.session_detail USING btree (repository_full_name);

CREATE INDEX session_detail_session_started_at_idx ON public.session_detail USING btree (session_started_at);

CREATE INDEX session_detail_source_loop_id_idx ON public.session_detail USING btree (source_loop_id);

CREATE INDEX session_detail_user_id_session_started_at_idx ON public.session_detail USING btree (user_id, session_started_at);

CREATE UNIQUE INDEX session_transcript_compute_target_id_external_session_id_fi_key ON public.session_transcript USING btree (compute_target_id, external_session_id, file_key);

CREATE INDEX session_transcript_organization_id_compute_target_id_extern_idx ON public.session_transcript USING btree (organization_id, compute_target_id, external_session_id, file_key);

CREATE INDEX session_transcript_session_detail_id_idx ON public.session_transcript USING btree (session_detail_id);

CREATE UNIQUE INDEX slack_integrations_organization_id_key ON public.slack_integrations USING btree (organization_id);

CREATE UNIQUE INDEX slug_counters_organization_id_type_prefix_key ON public.slug_counters USING btree (organization_id, type_prefix);

CREATE INDEX source_occurrences_compute_target_id_idx ON public.source_occurrences USING btree (compute_target_id);

CREATE INDEX source_occurrences_organization_id_definition_version_id_idx ON public.source_occurrences USING btree (organization_id, definition_version_id);

CREATE INDEX tag_artifacts_artifact_id_idx ON public.tag_artifacts USING btree (artifact_id);

CREATE UNIQUE INDEX tag_artifacts_tag_id_artifact_id_key ON public.tag_artifacts USING btree (tag_id, artifact_id);

CREATE INDEX tag_loops_loop_id_idx ON public.tag_loops USING btree (loop_id);

CREATE UNIQUE INDEX tag_loops_tag_id_loop_id_key ON public.tag_loops USING btree (tag_id, loop_id);

CREATE INDEX tag_projects_project_id_idx ON public.tag_projects USING btree (project_id);

CREATE UNIQUE INDEX tag_projects_tag_id_project_id_key ON public.tag_projects USING btree (tag_id, project_id);

CREATE INDEX tags_organization_id_idx ON public.tags USING btree (organization_id);

CREATE UNIQUE INDEX tags_organization_id_name_ci_key ON public.tags USING btree (organization_id, lower(name));

CREATE INDEX tags_organization_id_name_idx ON public.tags USING btree (organization_id, name);

CREATE INDEX user_public_keys_organization_id_idx ON public.user_public_keys USING btree (organization_id);

CREATE UNIQUE INDEX user_public_keys_user_id_fingerprint_key ON public.user_public_keys USING btree (user_id, fingerprint);

CREATE INDEX users_clerk_id_idx ON public.users USING btree (clerk_id);

CREATE UNIQUE INDEX users_clerk_id_organization_id_key ON public.users USING btree (clerk_id, organization_id);

CREATE INDEX users_github_username_idx ON public.users USING btree (github_username);

CREATE INDEX users_linear_id_idx ON public.users USING btree (linear_id);

CREATE UNIQUE INDEX users_organization_id_email_key ON public.users USING btree (organization_id, email);

CREATE INDEX users_slack_id_idx ON public.users USING btree (slack_id);

CREATE UNIQUE INDEX workflow_action_runs_run_id_action_id_event_cycle_key ON public.workflow_action_runs USING btree (run_id, action_id, event, cycle);

CREATE INDEX workflow_action_runs_status_next_attempt_at_idx ON public.workflow_action_runs USING btree (status, next_attempt_at);

CREATE INDEX workflow_actions_connection_id_idx ON public.workflow_actions USING btree (connection_id);

CREATE INDEX workflow_actions_workflow_id_idx ON public.workflow_actions USING btree (workflow_id);

CREATE UNIQUE INDEX workflow_run_loops_loop_id_key ON public.workflow_run_loops USING btree (loop_id);

CREATE INDEX workflow_run_loops_run_id_idx ON public.workflow_run_loops USING btree (run_id);

CREATE INDEX workflow_runs_organization_id_created_at_idx ON public.workflow_runs USING btree (organization_id, created_at);

CREATE INDEX workflow_runs_plan_document_id_idx ON public.workflow_runs USING btree (plan_document_id);

CREATE INDEX workflow_runs_status_updated_at_idx ON public.workflow_runs USING btree (status, updated_at);

CREATE UNIQUE INDEX workflow_runs_workflow_id_dedup_key_key ON public.workflow_runs USING btree (workflow_id, dedup_key);

CREATE INDEX workflow_runs_workflow_id_source_key_idx ON public.workflow_runs USING btree (workflow_id, source_key);

CREATE INDEX workflow_triggers_connection_id_type_idx ON public.workflow_triggers USING btree (connection_id, type);

CREATE INDEX workflow_triggers_project_connection_id_idx ON public.workflow_triggers USING btree (project_connection_id);

CREATE INDEX workflow_triggers_project_id_idx ON public.workflow_triggers USING btree (project_id);

CREATE INDEX workflow_triggers_workflow_id_idx ON public.workflow_triggers USING btree (workflow_id);

CREATE INDEX workflows_organization_id_idx ON public.workflows USING btree (organization_id);

CREATE TRIGGER artifacts_github_projection_owner_drift_check BEFORE UPDATE OF type, organization_id ON public.artifacts FOR EACH ROW EXECUTE FUNCTION public.prevent_github_comment_thread_projection_artifact_drift();

CREATE TRIGGER audit_entries_append_only BEFORE DELETE OR UPDATE ON public.audit_entries FOR EACH ROW EXECUTE FUNCTION public.audit_entries_reject_mutation();

CREATE TRIGGER audit_entries_no_truncate BEFORE TRUNCATE ON public.audit_entries FOR EACH STATEMENT EXECUTE FUNCTION public.audit_entries_reject_truncate();

CREATE TRIGGER comment_threads_github_projection_owner_drift_check BEFORE UPDATE OF source, organization_id, artifact_id ON public.comment_threads FOR EACH ROW EXECUTE FUNCTION public.prevent_github_comment_thread_projection_thread_drift();

CREATE TRIGGER comments_parent_same_thread_check BEFORE INSERT OR UPDATE OF parent_comment_id, thread_id ON public.comments FOR EACH ROW EXECUTE FUNCTION public.ensure_comments_parent_same_thread();

CREATE TRIGGER github_comment_thread_projection_base_row_cleanup AFTER DELETE ON public.github_comment_thread_projections FOR EACH ROW EXECUTE FUNCTION public.delete_github_comment_thread_projection_base_row();

CREATE TRIGGER github_comment_thread_projection_owner_check BEFORE INSERT OR UPDATE OF thread_id, branch_artifact_id, pull_request_detail_id ON public.github_comment_thread_projections FOR EACH ROW EXECUTE FUNCTION public.ensure_github_comment_thread_projection_owner();

CREATE TRIGGER pull_request_detail_head_ref_pair_guard BEFORE UPDATE OF head_ref_oid ON public.pull_request_detail FOR EACH ROW EXECUTE FUNCTION public.guard_pull_request_head_ref_pair();

ALTER TABLE ONLY public.agent_component_session_usage
    ADD CONSTRAINT agent_component_session_usage_agent_component_id_fkey FOREIGN KEY (agent_component_id) REFERENCES public.agent_components(id) ON UPDATE CASCADE ON DELETE SET NULL;

ALTER TABLE ONLY public.agent_component_session_usage
    ADD CONSTRAINT agent_component_session_usage_agent_session_id_fkey FOREIGN KEY (agent_session_id) REFERENCES public.session_detail(artifact_id) ON UPDATE CASCADE ON DELETE CASCADE;

ALTER TABLE ONLY public.agent_component_session_usage
    ADD CONSTRAINT agent_component_session_usage_definition_version_id_fkey FOREIGN KEY (definition_version_id) REFERENCES public.definition_versions(id) ON UPDATE CASCADE ON DELETE SET NULL;

ALTER TABLE ONLY public.agent_component_versions
    ADD CONSTRAINT agent_component_versions_definition_version_id_fkey FOREIGN KEY (definition_version_id) REFERENCES public.definition_versions(id) ON UPDATE CASCADE ON DELETE SET NULL;

ALTER TABLE ONLY public.agent_component_versions
    ADD CONSTRAINT agent_component_versions_organization_id_fkey FOREIGN KEY (organization_id) REFERENCES public.organizations(id) ON UPDATE CASCADE ON DELETE CASCADE;

ALTER TABLE ONLY public.agent_components
    ADD CONSTRAINT agent_components_compute_target_id_fkey FOREIGN KEY (compute_target_id) REFERENCES public.compute_targets(id) ON UPDATE CASCADE ON DELETE CASCADE;

ALTER TABLE ONLY public.agent_components
    ADD CONSTRAINT agent_components_organization_id_fkey FOREIGN KEY (organization_id) REFERENCES public.organizations(id) ON UPDATE CASCADE ON DELETE CASCADE;

ALTER TABLE ONLY public.agent_session_activity_segments
    ADD CONSTRAINT agent_session_activity_segments_agent_session_id_fkey FOREIGN KEY (agent_session_id) REFERENCES public.session_detail(artifact_id) ON UPDATE CASCADE ON DELETE CASCADE;

ALTER TABLE ONLY public.agent_session_events
    ADD CONSTRAINT agent_session_events_agent_session_id_fkey FOREIGN KEY (agent_session_id) REFERENCES public.session_detail(artifact_id) ON UPDATE CASCADE ON DELETE CASCADE;

ALTER TABLE ONLY public.agent_session_token_events
    ADD CONSTRAINT agent_session_token_events_agent_session_id_fkey FOREIGN KEY (agent_session_id) REFERENCES public.session_detail(artifact_id) ON UPDATE CASCADE ON DELETE CASCADE;

ALTER TABLE ONLY public.agent_session_token_usage
    ADD CONSTRAINT agent_session_token_usage_agent_session_id_fkey FOREIGN KEY (agent_session_id) REFERENCES public.session_detail(artifact_id) ON UPDATE CASCADE ON DELETE CASCADE;

ALTER TABLE ONLY public.agent_session_usage_rollups
    ADD CONSTRAINT agent_session_usage_rollups_artifact_id_fkey FOREIGN KEY (artifact_id) REFERENCES public.session_detail(artifact_id) ON UPDATE CASCADE ON DELETE CASCADE;

ALTER TABLE ONLY public.agent_versions
    ADD CONSTRAINT agent_versions_agent_id_fkey FOREIGN KEY (agent_id) REFERENCES public.agents(id) ON UPDATE CASCADE ON DELETE CASCADE;

ALTER TABLE ONLY public.agent_versions
    ADD CONSTRAINT agent_versions_changed_by_id_fkey FOREIGN KEY (changed_by_id) REFERENCES public.users(id) ON UPDATE CASCADE ON DELETE RESTRICT;

ALTER TABLE ONLY public.agents
    ADD CONSTRAINT agents_created_by_id_fkey FOREIGN KEY (created_by_id) REFERENCES public.users(id) ON UPDATE CASCADE ON DELETE RESTRICT;

ALTER TABLE ONLY public.agents
    ADD CONSTRAINT agents_organization_id_fkey FOREIGN KEY (organization_id) REFERENCES public.organizations(id) ON UPDATE CASCADE ON DELETE CASCADE;

ALTER TABLE ONLY public.artifact_activity_events
    ADD CONSTRAINT artifact_activity_events_artifact_id_fkey FOREIGN KEY (artifact_id) REFERENCES public.artifacts(id) ON UPDATE CASCADE ON DELETE CASCADE;

ALTER TABLE ONLY public.artifact_evaluations
    ADD CONSTRAINT artifact_evaluations_artifact_id_fkey FOREIGN KEY (artifact_id) REFERENCES public.artifacts(id) ON UPDATE CASCADE ON DELETE CASCADE;

ALTER TABLE ONLY public.artifact_evaluations
    ADD CONSTRAINT artifact_evaluations_loop_id_fkey FOREIGN KEY (loop_id) REFERENCES public.loops(id) ON UPDATE CASCADE ON DELETE SET NULL;

ALTER TABLE ONLY public.artifact_generation_status_dismissals
    ADD CONSTRAINT artifact_generation_status_dismissals_artifact_id_fkey FOREIGN KEY (artifact_id) REFERENCES public.artifacts(id) ON UPDATE CASCADE ON DELETE CASCADE;

ALTER TABLE ONLY public.artifact_generation_status_dismissals
    ADD CONSTRAINT artifact_generation_status_dismissals_dismissed_by_id_fkey FOREIGN KEY (dismissed_by_id) REFERENCES public.users(id) ON UPDATE CASCADE ON DELETE RESTRICT;

ALTER TABLE ONLY public.artifact_links
    ADD CONSTRAINT artifact_links_source_id_fkey FOREIGN KEY (source_id) REFERENCES public.artifacts(id) ON UPDATE CASCADE ON DELETE CASCADE;

ALTER TABLE ONLY public.artifact_links
    ADD CONSTRAINT artifact_links_target_id_fkey FOREIGN KEY (target_id) REFERENCES public.artifacts(id) ON UPDATE CASCADE ON DELETE CASCADE;

ALTER TABLE ONLY public.artifact_ratings
    ADD CONSTRAINT artifact_ratings_artifact_id_fkey FOREIGN KEY (artifact_id) REFERENCES public.artifacts(id) ON UPDATE CASCADE ON DELETE CASCADE;

ALTER TABLE ONLY public.artifact_ratings
    ADD CONSTRAINT artifact_ratings_organization_id_fkey FOREIGN KEY (organization_id) REFERENCES public.organizations(id) ON UPDATE CASCADE ON DELETE CASCADE;

ALTER TABLE ONLY public.artifact_ratings
    ADD CONSTRAINT artifact_ratings_user_id_fkey FOREIGN KEY (user_id) REFERENCES public.users(id) ON UPDATE CASCADE ON DELETE CASCADE;

ALTER TABLE ONLY public.artifacts
    ADD CONSTRAINT artifacts_assignee_id_fkey FOREIGN KEY (assignee_id) REFERENCES public.users(id) ON UPDATE CASCADE ON DELETE SET NULL;

ALTER TABLE ONLY public.artifacts
    ADD CONSTRAINT artifacts_created_by_id_fkey FOREIGN KEY (created_by_id) REFERENCES public.users(id) ON UPDATE CASCADE ON DELETE SET NULL;

ALTER TABLE ONLY public.artifacts
    ADD CONSTRAINT artifacts_organization_id_fkey FOREIGN KEY (organization_id) REFERENCES public.organizations(id) ON UPDATE CASCADE ON DELETE RESTRICT;

ALTER TABLE ONLY public.artifacts
    ADD CONSTRAINT artifacts_project_id_fkey FOREIGN KEY (project_id) REFERENCES public.projects(id) ON UPDATE CASCADE ON DELETE CASCADE;

ALTER TABLE ONLY public.audit_entries
    ADD CONSTRAINT audit_entries_organization_id_fkey FOREIGN KEY (organization_id) REFERENCES public.organizations(id) ON UPDATE CASCADE ON DELETE CASCADE;

ALTER TABLE ONLY public.audit_outbox
    ADD CONSTRAINT audit_outbox_organization_id_fkey FOREIGN KEY (organization_id) REFERENCES public.organizations(id) ON UPDATE CASCADE ON DELETE CASCADE;

ALTER TABLE ONLY public.auth_accounts
    ADD CONSTRAINT auth_accounts_user_id_fkey FOREIGN KEY (user_id) REFERENCES public.auth_users(id) ON UPDATE CASCADE ON DELETE CASCADE;

ALTER TABLE ONLY public.auth_invitations
    ADD CONSTRAINT auth_invitations_inviter_id_fkey FOREIGN KEY (inviter_id) REFERENCES public.auth_users(id) ON UPDATE CASCADE ON DELETE CASCADE;

ALTER TABLE ONLY public.auth_invitations
    ADD CONSTRAINT auth_invitations_organization_id_fkey FOREIGN KEY (organization_id) REFERENCES public.auth_organizations(id) ON UPDATE CASCADE ON DELETE CASCADE;

ALTER TABLE ONLY public.auth_members
    ADD CONSTRAINT auth_members_organization_id_fkey FOREIGN KEY (organization_id) REFERENCES public.auth_organizations(id) ON UPDATE CASCADE ON DELETE CASCADE;

ALTER TABLE ONLY public.auth_members
    ADD CONSTRAINT auth_members_user_id_fkey FOREIGN KEY (user_id) REFERENCES public.auth_users(id) ON UPDATE CASCADE ON DELETE CASCADE;

ALTER TABLE ONLY public.auth_sessions
    ADD CONSTRAINT auth_sessions_user_id_fkey FOREIGN KEY (user_id) REFERENCES public.auth_users(id) ON UPDATE CASCADE ON DELETE CASCADE;

ALTER TABLE ONLY public.branch_activity_atoms
    ADD CONSTRAINT branch_activity_atoms_branch_fkey FOREIGN KEY (organization_id, branch_artifact_id) REFERENCES public.branch_detail(organization_id, artifact_id) ON UPDATE CASCADE ON DELETE CASCADE;

ALTER TABLE ONLY public.branch_activity_atoms
    ADD CONSTRAINT branch_activity_atoms_organization_fkey FOREIGN KEY (organization_id) REFERENCES public.organizations(id) ON UPDATE CASCADE ON DELETE CASCADE;

ALTER TABLE ONLY public.branch_activity_atoms
    ADD CONSTRAINT branch_activity_atoms_pull_request_fkey FOREIGN KEY (organization_id, pull_request_detail_id) REFERENCES public.pull_request_detail(organization_id, id) ON UPDATE CASCADE ON DELETE CASCADE;

ALTER TABLE ONLY public.branch_detail
    ADD CONSTRAINT branch_detail_artifact_id_fkey FOREIGN KEY (artifact_id) REFERENCES public.artifacts(id) ON UPDATE CASCADE ON DELETE CASCADE;

ALTER TABLE ONLY public.branch_detail
    ADD CONSTRAINT branch_detail_current_pull_request_detail_id_fkey FOREIGN KEY (current_pull_request_detail_id) REFERENCES public.pull_request_detail(id) ON UPDATE CASCADE ON DELETE SET NULL;

ALTER TABLE ONLY public.branch_detail
    ADD CONSTRAINT branch_detail_organization_id_fkey FOREIGN KEY (organization_id) REFERENCES public.organizations(id) ON UPDATE CASCADE ON DELETE RESTRICT;

ALTER TABLE ONLY public.branch_detail
    ADD CONSTRAINT branch_detail_repository_id_fkey FOREIGN KEY (repository_id) REFERENCES public.github_installation_repositories(id) ON UPDATE CASCADE ON DELETE SET NULL;

ALTER TABLE ONLY public.branch_file_changes
    ADD CONSTRAINT branch_file_changes_branch_artifact_id_fkey FOREIGN KEY (branch_artifact_id) REFERENCES public.branch_detail(artifact_id) ON UPDATE CASCADE ON DELETE CASCADE;

ALTER TABLE ONLY public.branch_status_checks
    ADD CONSTRAINT branch_status_checks_branch_artifact_id_fkey FOREIGN KEY (branch_artifact_id) REFERENCES public.branch_detail(artifact_id) ON UPDATE CASCADE ON DELETE CASCADE;

ALTER TABLE ONLY public.catalog_item_versions
    ADD CONSTRAINT catalog_item_versions_catalog_item_id_fkey FOREIGN KEY (catalog_item_id) REFERENCES public.catalog_items(id) ON UPDATE CASCADE ON DELETE CASCADE;

ALTER TABLE ONLY public.catalog_item_versions
    ADD CONSTRAINT catalog_item_versions_changed_by_id_fkey FOREIGN KEY (changed_by_id) REFERENCES public.users(id) ON UPDATE CASCADE ON DELETE SET NULL;

ALTER TABLE ONLY public.catalog_item_versions
    ADD CONSTRAINT catalog_item_versions_definition_version_id_fkey FOREIGN KEY (definition_version_id) REFERENCES public.definition_versions(id) ON UPDATE CASCADE ON DELETE SET NULL;

ALTER TABLE ONLY public.catalog_items
    ADD CONSTRAINT catalog_items_created_by_id_fkey FOREIGN KEY (created_by_id) REFERENCES public.users(id) ON UPDATE CASCADE ON DELETE SET NULL;

ALTER TABLE ONLY public.catalog_items
    ADD CONSTRAINT catalog_items_organization_id_fkey FOREIGN KEY (organization_id) REFERENCES public.organizations(id) ON UPDATE CASCADE ON DELETE CASCADE;

ALTER TABLE ONLY public.catalog_items
    ADD CONSTRAINT catalog_items_parent_pack_id_fkey FOREIGN KEY (parent_pack_id) REFERENCES public.catalog_items(id) ON UPDATE CASCADE ON DELETE CASCADE;

ALTER TABLE ONLY public.chat_sessions
    ADD CONSTRAINT chat_sessions_organization_id_fkey FOREIGN KEY (organization_id) REFERENCES public.organizations(id) ON UPDATE CASCADE ON DELETE CASCADE;

ALTER TABLE ONLY public.chat_sessions
    ADD CONSTRAINT chat_sessions_user_id_fkey FOREIGN KEY (user_id) REFERENCES public.users(id) ON UPDATE CASCADE ON DELETE CASCADE;

ALTER TABLE ONLY public.comment_attachments
    ADD CONSTRAINT comment_attachments_comment_id_fkey FOREIGN KEY (comment_id) REFERENCES public.comments(id) ON UPDATE CASCADE ON DELETE CASCADE;

ALTER TABLE ONLY public.comment_reactions
    ADD CONSTRAINT comment_reactions_comment_id_fkey FOREIGN KEY (comment_id) REFERENCES public.comments(id) ON UPDATE CASCADE ON DELETE CASCADE;

ALTER TABLE ONLY public.comment_threads
    ADD CONSTRAINT comment_threads_artifact_id_fkey FOREIGN KEY (artifact_id) REFERENCES public.artifacts(id) ON UPDATE CASCADE ON DELETE CASCADE;

ALTER TABLE ONLY public.comment_threads
    ADD CONSTRAINT comment_threads_organization_id_fkey FOREIGN KEY (organization_id) REFERENCES public.organizations(id) ON UPDATE CASCADE ON DELETE RESTRICT;

ALTER TABLE ONLY public.comments
    ADD CONSTRAINT comments_parent_comment_id_fkey FOREIGN KEY (parent_comment_id) REFERENCES public.comments(id) ON UPDATE CASCADE ON DELETE SET NULL;

ALTER TABLE ONLY public.comments
    ADD CONSTRAINT comments_thread_id_fkey FOREIGN KEY (thread_id) REFERENCES public.comment_threads(id) ON UPDATE CASCADE ON DELETE CASCADE;

ALTER TABLE ONLY public.commit_detail
    ADD CONSTRAINT commit_detail_branch_artifact_id_fkey FOREIGN KEY (branch_artifact_id) REFERENCES public.artifacts(id) ON UPDATE CASCADE ON DELETE CASCADE;

ALTER TABLE ONLY public.commit_detail
    ADD CONSTRAINT commit_detail_organization_id_fkey FOREIGN KEY (organization_id) REFERENCES public.organizations(id) ON UPDATE CASCADE ON DELETE RESTRICT;

ALTER TABLE ONLY public.compute_target_capabilities
    ADD CONSTRAINT compute_target_capabilities_compute_target_id_fkey FOREIGN KEY (compute_target_id) REFERENCES public.compute_targets(id) ON UPDATE CASCADE ON DELETE CASCADE;

ALTER TABLE ONLY public.compute_target_capabilities
    ADD CONSTRAINT compute_target_capabilities_organization_id_fkey FOREIGN KEY (organization_id) REFERENCES public.organizations(id) ON UPDATE CASCADE ON DELETE CASCADE;

ALTER TABLE ONLY public.compute_target_capabilities
    ADD CONSTRAINT compute_target_capabilities_project_id_fkey FOREIGN KEY (project_id) REFERENCES public.projects(id) ON UPDATE CASCADE ON DELETE CASCADE;

ALTER TABLE ONLY public.compute_target_health_checks
    ADD CONSTRAINT compute_target_health_checks_compute_target_id_fkey FOREIGN KEY (compute_target_id) REFERENCES public.compute_targets(id) ON UPDATE CASCADE ON DELETE CASCADE;

ALTER TABLE ONLY public.compute_target_health_checks
    ADD CONSTRAINT compute_target_health_checks_organization_id_fkey FOREIGN KEY (organization_id) REFERENCES public.organizations(id) ON UPDATE CASCADE ON DELETE RESTRICT;

ALTER TABLE ONLY public.compute_targets
    ADD CONSTRAINT compute_targets_organization_id_fkey FOREIGN KEY (organization_id) REFERENCES public.organizations(id) ON UPDATE CASCADE ON DELETE RESTRICT;

ALTER TABLE ONLY public.compute_targets
    ADD CONSTRAINT compute_targets_user_id_fkey FOREIGN KEY (user_id) REFERENCES public.users(id) ON UPDATE CASCADE ON DELETE RESTRICT;

ALTER TABLE ONLY public.custom_field_enum_options
    ADD CONSTRAINT custom_field_enum_options_custom_field_id_fkey FOREIGN KEY (custom_field_id) REFERENCES public.custom_fields(id) ON UPDATE CASCADE ON DELETE CASCADE;

ALTER TABLE ONLY public.custom_field_settings
    ADD CONSTRAINT custom_field_settings_custom_field_id_fkey FOREIGN KEY (custom_field_id) REFERENCES public.custom_fields(id) ON UPDATE CASCADE ON DELETE CASCADE;

ALTER TABLE ONLY public.custom_field_values
    ADD CONSTRAINT custom_field_values_custom_field_id_fkey FOREIGN KEY (custom_field_id) REFERENCES public.custom_fields(id) ON UPDATE CASCADE ON DELETE CASCADE;

ALTER TABLE ONLY public.custom_field_values
    ADD CONSTRAINT custom_field_values_enum_value_id_fkey FOREIGN KEY (enum_value_id) REFERENCES public.custom_field_enum_options(id) ON UPDATE CASCADE ON DELETE SET NULL;

ALTER TABLE ONLY public.custom_field_values
    ADD CONSTRAINT custom_field_values_updated_by_id_fkey FOREIGN KEY (updated_by_id) REFERENCES public.users(id) ON UPDATE CASCADE ON DELETE SET NULL;

ALTER TABLE ONLY public.custom_fields
    ADD CONSTRAINT custom_fields_created_by_id_fkey FOREIGN KEY (created_by_id) REFERENCES public.users(id) ON UPDATE CASCADE ON DELETE SET NULL;

ALTER TABLE ONLY public.custom_fields
    ADD CONSTRAINT custom_fields_organization_id_fkey FOREIGN KEY (organization_id) REFERENCES public.organizations(id) ON UPDATE CASCADE ON DELETE RESTRICT;

ALTER TABLE ONLY public.definition_version_editors
    ADD CONSTRAINT definition_version_editors_definition_version_id_fkey FOREIGN KEY (definition_version_id) REFERENCES public.definition_versions(id) ON UPDATE CASCADE ON DELETE CASCADE;

ALTER TABLE ONLY public.definition_version_editors
    ADD CONSTRAINT definition_version_editors_user_id_fkey FOREIGN KEY (user_id) REFERENCES public.users(id) ON UPDATE CASCADE ON DELETE CASCADE;

ALTER TABLE ONLY public.definition_versions
    ADD CONSTRAINT definition_versions_organization_id_fkey FOREIGN KEY (organization_id) REFERENCES public.organizations(id) ON UPDATE CASCADE ON DELETE CASCADE;

ALTER TABLE ONLY public.deployment_detail
    ADD CONSTRAINT deployment_detail_artifact_id_fkey FOREIGN KEY (artifact_id) REFERENCES public.artifacts(id) ON UPDATE CASCADE ON DELETE CASCADE;

ALTER TABLE ONLY public.deployment_detail
    ADD CONSTRAINT deployment_detail_branch_artifact_id_fkey FOREIGN KEY (branch_artifact_id) REFERENCES public.artifacts(id) ON UPDATE CASCADE ON DELETE SET NULL;

ALTER TABLE ONLY public.deployment_events
    ADD CONSTRAINT deployment_events_organization_id_fkey FOREIGN KEY (organization_id) REFERENCES public.organizations(id) ON UPDATE CASCADE ON DELETE CASCADE;

ALTER TABLE ONLY public.desktop_command_events
    ADD CONSTRAINT desktop_command_events_command_id_fkey FOREIGN KEY (command_id) REFERENCES public.desktop_commands(id) ON UPDATE CASCADE ON DELETE CASCADE;

ALTER TABLE ONLY public.desktop_commands
    ADD CONSTRAINT desktop_commands_compute_target_id_fkey FOREIGN KEY (compute_target_id) REFERENCES public.compute_targets(id) ON UPDATE CASCADE ON DELETE CASCADE;

ALTER TABLE ONLY public.desktop_refresh_tokens
    ADD CONSTRAINT desktop_refresh_tokens_session_id_fkey FOREIGN KEY (session_id) REFERENCES public.desktop_sessions(id) ON UPDATE CASCADE ON DELETE CASCADE;

ALTER TABLE ONLY public.desktop_sessions
    ADD CONSTRAINT desktop_sessions_organization_id_fkey FOREIGN KEY (organization_id) REFERENCES public.organizations(id) ON UPDATE CASCADE ON DELETE CASCADE;

ALTER TABLE ONLY public.desktop_sessions
    ADD CONSTRAINT desktop_sessions_user_id_fkey FOREIGN KEY (user_id) REFERENCES public.users(id) ON UPDATE CASCADE ON DELETE CASCADE;

ALTER TABLE ONLY public.distribution_target_status
    ADD CONSTRAINT distribution_target_status_compute_target_id_fkey FOREIGN KEY (compute_target_id) REFERENCES public.compute_targets(id) ON UPDATE CASCADE ON DELETE CASCADE;

ALTER TABLE ONLY public.distribution_target_status
    ADD CONSTRAINT distribution_target_status_distribution_id_fkey FOREIGN KEY (distribution_id) REFERENCES public.distributions(id) ON UPDATE CASCADE ON DELETE CASCADE;

ALTER TABLE ONLY public.distribution_target_status
    ADD CONSTRAINT distribution_target_status_user_id_fkey FOREIGN KEY (user_id) REFERENCES public.users(id) ON UPDATE CASCADE ON DELETE SET NULL;

ALTER TABLE ONLY public.distribution_targeting_entries
    ADD CONSTRAINT distribution_targeting_entries_compute_target_id_fkey FOREIGN KEY (compute_target_id) REFERENCES public.compute_targets(id) ON UPDATE CASCADE ON DELETE CASCADE;

ALTER TABLE ONLY public.distribution_targeting_entries
    ADD CONSTRAINT distribution_targeting_entries_distribution_id_fkey FOREIGN KEY (distribution_id) REFERENCES public.distributions(id) ON UPDATE CASCADE ON DELETE CASCADE;

ALTER TABLE ONLY public.distributions
    ADD CONSTRAINT distributions_catalog_item_id_fkey FOREIGN KEY (catalog_item_id) REFERENCES public.catalog_items(id) ON UPDATE CASCADE ON DELETE CASCADE;

ALTER TABLE ONLY public.distributions
    ADD CONSTRAINT distributions_created_by_id_fkey FOREIGN KEY (created_by_id) REFERENCES public.users(id) ON UPDATE CASCADE ON DELETE SET NULL;

ALTER TABLE ONLY public.distributions
    ADD CONSTRAINT distributions_organization_id_fkey FOREIGN KEY (organization_id) REFERENCES public.organizations(id) ON UPDATE CASCADE ON DELETE CASCADE;

ALTER TABLE ONLY public.distributions
    ADD CONSTRAINT distributions_withdrawn_by_id_fkey FOREIGN KEY (withdrawn_by_id) REFERENCES public.users(id) ON UPDATE CASCADE ON DELETE SET NULL;

ALTER TABLE ONLY public.document_detail
    ADD CONSTRAINT document_detail_approver_id_fkey FOREIGN KEY (approver_id) REFERENCES public.users(id) ON UPDATE CASCADE ON DELETE SET NULL;

ALTER TABLE ONLY public.document_detail
    ADD CONSTRAINT document_detail_artifact_id_fkey FOREIGN KEY (artifact_id) REFERENCES public.artifacts(id) ON UPDATE CASCADE ON DELETE CASCADE;

ALTER TABLE ONLY public.document_versions
    ADD CONSTRAINT document_versions_artifact_id_fkey FOREIGN KEY (artifact_id) REFERENCES public.document_detail(artifact_id) ON UPDATE CASCADE ON DELETE CASCADE;

ALTER TABLE ONLY public.external_comment_authors
    ADD CONSTRAINT external_comment_authors_organization_id_fkey FOREIGN KEY (organization_id) REFERENCES public.organizations(id) ON UPDATE CASCADE ON DELETE CASCADE;

ALTER TABLE ONLY public.external_comment_authors
    ADD CONSTRAINT external_comment_authors_user_id_fkey FOREIGN KEY (user_id) REFERENCES public.users(id) ON UPDATE CASCADE ON DELETE CASCADE;

ALTER TABLE ONLY public.favorite_artifacts
    ADD CONSTRAINT favorite_artifacts_artifact_id_fkey FOREIGN KEY (artifact_id) REFERENCES public.artifacts(id) ON UPDATE CASCADE ON DELETE CASCADE;

ALTER TABLE ONLY public.favorite_artifacts
    ADD CONSTRAINT favorite_artifacts_user_id_fkey FOREIGN KEY (user_id) REFERENCES public.users(id) ON UPDATE CASCADE ON DELETE CASCADE;

ALTER TABLE ONLY public.favorite_projects
    ADD CONSTRAINT favorite_projects_project_id_fkey FOREIGN KEY (project_id) REFERENCES public.projects(id) ON UPDATE CASCADE ON DELETE CASCADE;

ALTER TABLE ONLY public.favorite_projects
    ADD CONSTRAINT favorite_projects_user_id_fkey FOREIGN KEY (user_id) REFERENCES public.users(id) ON UPDATE CASCADE ON DELETE CASCADE;

ALTER TABLE ONLY public.file_attachments
    ADD CONSTRAINT file_attachments_artifact_id_fkey FOREIGN KEY (artifact_id) REFERENCES public.artifacts(id) ON UPDATE CASCADE ON DELETE CASCADE;

ALTER TABLE ONLY public.agent_component_invocations
    ADD CONSTRAINT fk_aci_component FOREIGN KEY (agent_component_id) REFERENCES public.agent_components(id) ON UPDATE CASCADE ON DELETE SET NULL;

ALTER TABLE ONLY public.agent_component_invocations
    ADD CONSTRAINT fk_aci_definition_version FOREIGN KEY (definition_version_id) REFERENCES public.definition_versions(id) ON UPDATE CASCADE ON DELETE SET NULL;

ALTER TABLE ONLY public.agent_component_invocations
    ADD CONSTRAINT fk_aci_generation FOREIGN KEY (generation_id) REFERENCES public.agent_component_invocation_generations(id) ON UPDATE CASCADE ON DELETE CASCADE;

ALTER TABLE ONLY public.agent_component_invocations
    ADD CONSTRAINT fk_aci_part FOREIGN KEY (part_id) REFERENCES public.agent_component_invocation_parts(id) ON UPDATE CASCADE ON DELETE CASCADE;

ALTER TABLE ONLY public.agent_component_invocations
    ADD CONSTRAINT fk_aci_source_occurrence FOREIGN KEY (source_occurrence_id) REFERENCES public.source_occurrences(id) ON UPDATE CASCADE ON DELETE SET NULL;

ALTER TABLE ONLY public.agent_component_invocation_generations
    ADD CONSTRAINT fk_acig_session FOREIGN KEY (agent_session_id) REFERENCES public.session_detail(artifact_id) ON UPDATE CASCADE ON DELETE CASCADE;

ALTER TABLE ONLY public.agent_component_invocation_parts
    ADD CONSTRAINT fk_acip_generation FOREIGN KEY (generation_id) REFERENCES public.agent_component_invocation_generations(id) ON UPDATE CASCADE ON DELETE CASCADE;

ALTER TABLE ONLY public.github_access_capabilities
    ADD CONSTRAINT github_access_capabilities_github_user_connection_id_fkey FOREIGN KEY (github_user_connection_id) REFERENCES public.github_user_connections(id) ON UPDATE CASCADE ON DELETE CASCADE;

ALTER TABLE ONLY public.github_access_capabilities
    ADD CONSTRAINT github_access_capabilities_organization_id_fkey FOREIGN KEY (organization_id) REFERENCES public.organizations(id) ON UPDATE CASCADE ON DELETE CASCADE;

ALTER TABLE ONLY public.github_comment_projections
    ADD CONSTRAINT github_comment_projections_comment_id_thread_id_fkey FOREIGN KEY (comment_id, thread_id) REFERENCES public.comments(id, thread_id) ON UPDATE CASCADE ON DELETE CASCADE;

ALTER TABLE ONLY public.github_comment_projections
    ADD CONSTRAINT github_comment_projections_external_author_id_fkey FOREIGN KEY (external_author_id) REFERENCES public.external_comment_authors(id) ON UPDATE CASCADE ON DELETE SET NULL;

ALTER TABLE ONLY public.github_comment_projections
    ADD CONSTRAINT github_comment_projections_thread_id_fkey FOREIGN KEY (thread_id) REFERENCES public.github_comment_thread_projections(thread_id) ON UPDATE CASCADE ON DELETE CASCADE;

ALTER TABLE ONLY public.github_comment_thread_projections
    ADD CONSTRAINT github_comment_thread_projections_branch_artifact_id_fkey FOREIGN KEY (branch_artifact_id) REFERENCES public.branch_detail(artifact_id) ON UPDATE CASCADE ON DELETE CASCADE;

ALTER TABLE ONLY public.github_comment_thread_projections
    ADD CONSTRAINT github_comment_thread_projections_pull_request_detail_id_b_fkey FOREIGN KEY (pull_request_detail_id, branch_artifact_id) REFERENCES public.pull_request_detail(id, branch_artifact_id) ON UPDATE CASCADE ON DELETE CASCADE;

ALTER TABLE ONLY public.github_comment_thread_projections
    ADD CONSTRAINT github_comment_thread_projections_thread_id_branch_artifac_fkey FOREIGN KEY (thread_id, branch_artifact_id) REFERENCES public.comment_threads(id, artifact_id) ON UPDATE CASCADE ON DELETE CASCADE;

ALTER TABLE ONLY public.github_dirty_scope_nudges
    ADD CONSTRAINT github_dirty_scope_nudges_compute_target_id_fkey FOREIGN KEY (compute_target_id) REFERENCES public.compute_targets(id) ON UPDATE CASCADE ON DELETE CASCADE;

ALTER TABLE ONLY public.github_dirty_scope_nudges
    ADD CONSTRAINT github_dirty_scope_nudges_github_installation_repository_i_fkey FOREIGN KEY (github_installation_repository_id) REFERENCES public.github_installation_repositories(id) ON UPDATE CASCADE ON DELETE CASCADE;

ALTER TABLE ONLY public.github_dirty_scope_nudges
    ADD CONSTRAINT github_dirty_scope_nudges_organization_id_fkey FOREIGN KEY (organization_id) REFERENCES public.organizations(id) ON UPDATE CASCADE ON DELETE CASCADE;

ALTER TABLE ONLY public.github_installation_repositories
    ADD CONSTRAINT github_installation_repositories_installation_id_fkey FOREIGN KEY (installation_id) REFERENCES public.github_installations(id) ON UPDATE CASCADE ON DELETE CASCADE;

ALTER TABLE ONLY public.github_installations
    ADD CONSTRAINT github_installations_organization_id_fkey FOREIGN KEY (organization_id) REFERENCES public.organizations(id) ON UPDATE CASCADE ON DELETE SET NULL;

ALTER TABLE ONLY public.github_pr_reviews
    ADD CONSTRAINT github_pr_reviews_pull_request_id_fkey FOREIGN KEY (pull_request_id) REFERENCES public.pull_request_detail(id) ON UPDATE CASCADE ON DELETE CASCADE;

ALTER TABLE ONLY public.github_repo_sync_state
    ADD CONSTRAINT github_repo_sync_state_organization_id_fkey FOREIGN KEY (organization_id) REFERENCES public.organizations(id) ON UPDATE CASCADE ON DELETE CASCADE;

ALTER TABLE ONLY public.github_user_connections
    ADD CONSTRAINT github_user_connections_organization_id_fkey FOREIGN KEY (organization_id) REFERENCES public.organizations(id) ON UPDATE CASCADE ON DELETE CASCADE;

ALTER TABLE ONLY public.github_user_connections
    ADD CONSTRAINT github_user_connections_user_id_fkey FOREIGN KEY (user_id) REFERENCES public.users(id) ON UPDATE CASCADE ON DELETE CASCADE;

ALTER TABLE ONLY public.integration_connections
    ADD CONSTRAINT integration_connections_created_by_id_fkey FOREIGN KEY (created_by_id) REFERENCES public.users(id) ON UPDATE CASCADE ON DELETE SET NULL;

ALTER TABLE ONLY public.integration_connections
    ADD CONSTRAINT integration_connections_managed_by_workflow_id_fkey FOREIGN KEY (managed_by_workflow_id) REFERENCES public.workflows(id) ON UPDATE CASCADE ON DELETE CASCADE;

ALTER TABLE ONLY public.integration_connections
    ADD CONSTRAINT integration_connections_organization_id_fkey FOREIGN KEY (organization_id) REFERENCES public.organizations(id) ON UPDATE CASCADE ON DELETE CASCADE;

ALTER TABLE ONLY public.integration_deliveries
    ADD CONSTRAINT integration_deliveries_connection_id_fkey FOREIGN KEY (connection_id) REFERENCES public.integration_connections(id) ON UPDATE CASCADE ON DELETE CASCADE;

ALTER TABLE ONLY public.integration_deliveries
    ADD CONSTRAINT integration_deliveries_organization_id_fkey FOREIGN KEY (organization_id) REFERENCES public.organizations(id) ON UPDATE CASCADE ON DELETE CASCADE;

ALTER TABLE ONLY public.integration_tool_calls
    ADD CONSTRAINT integration_tool_calls_action_run_id_fkey FOREIGN KEY (action_run_id) REFERENCES public.workflow_action_runs(id) ON UPDATE CASCADE ON DELETE CASCADE;

ALTER TABLE ONLY public.integration_tool_calls
    ADD CONSTRAINT integration_tool_calls_loop_id_fkey FOREIGN KEY (loop_id) REFERENCES public.loops(id) ON UPDATE CASCADE ON DELETE CASCADE;

ALTER TABLE ONLY public.integration_tool_calls
    ADD CONSTRAINT integration_tool_calls_run_id_fkey FOREIGN KEY (run_id) REFERENCES public.workflow_runs(id) ON UPDATE CASCADE ON DELETE CASCADE;

ALTER TABLE ONLY public.integration_tool_calls
    ADD CONSTRAINT integration_tool_calls_session_id_fkey FOREIGN KEY (session_id) REFERENCES public.integration_tool_sessions(id) ON UPDATE CASCADE ON DELETE CASCADE;

ALTER TABLE ONLY public.integration_tool_sessions
    ADD CONSTRAINT integration_tool_sessions_action_run_id_fkey FOREIGN KEY (action_run_id) REFERENCES public.workflow_action_runs(id) ON UPDATE CASCADE ON DELETE CASCADE;

ALTER TABLE ONLY public.integration_tool_sessions
    ADD CONSTRAINT integration_tool_sessions_loop_id_fkey FOREIGN KEY (loop_id) REFERENCES public.loops(id) ON UPDATE CASCADE ON DELETE CASCADE;

ALTER TABLE ONLY public.integration_tool_sessions
    ADD CONSTRAINT integration_tool_sessions_run_id_fkey FOREIGN KEY (run_id) REFERENCES public.workflow_runs(id) ON UPDATE CASCADE ON DELETE CASCADE;

ALTER TABLE ONLY public.judge_human_scores
    ADD CONSTRAINT judge_human_scores_evaluation_id_fkey FOREIGN KEY (evaluation_id) REFERENCES public.artifact_evaluations(id) ON UPDATE CASCADE ON DELETE CASCADE;

ALTER TABLE ONLY public.judge_human_scores
    ADD CONSTRAINT judge_human_scores_judge_score_id_fkey FOREIGN KEY (judge_score_id) REFERENCES public.judge_scores(id) ON UPDATE CASCADE ON DELETE CASCADE;

ALTER TABLE ONLY public.judge_human_scores
    ADD CONSTRAINT judge_human_scores_organization_id_fkey FOREIGN KEY (organization_id) REFERENCES public.organizations(id) ON UPDATE CASCADE ON DELETE CASCADE;

ALTER TABLE ONLY public.judge_human_scores
    ADD CONSTRAINT judge_human_scores_user_id_fkey FOREIGN KEY (user_id) REFERENCES public.users(id) ON UPDATE CASCADE ON DELETE CASCADE;

ALTER TABLE ONLY public.judge_scores
    ADD CONSTRAINT judge_scores_evaluation_id_fkey FOREIGN KEY (evaluation_id) REFERENCES public.artifact_evaluations(id) ON UPDATE CASCADE ON DELETE CASCADE;

ALTER TABLE ONLY public.judge_scores
    ADD CONSTRAINT judge_scores_prompt_id_fkey FOREIGN KEY (prompt_id) REFERENCES public.prompt_registry(id) ON UPDATE CASCADE ON DELETE SET NULL;

ALTER TABLE ONLY public.linear_subtasks
    ADD CONSTRAINT linear_subtasks_document_id_fkey FOREIGN KEY (document_id) REFERENCES public.artifacts(id) ON UPDATE CASCADE ON DELETE CASCADE;

ALTER TABLE ONLY public.linear_subtasks
    ADD CONSTRAINT linear_subtasks_organization_id_fkey FOREIGN KEY (organization_id) REFERENCES public.organizations(id) ON UPDATE CASCADE ON DELETE CASCADE;

ALTER TABLE ONLY public.loop_events
    ADD CONSTRAINT loop_events_loop_id_fkey FOREIGN KEY (loop_id) REFERENCES public.loops(id) ON UPDATE CASCADE ON DELETE CASCADE;

ALTER TABLE ONLY public.loop_execution_credential_consumptions
    ADD CONSTRAINT loop_execution_credential_consumptions_command_id_fkey FOREIGN KEY (command_id) REFERENCES public.desktop_commands(id) ON UPDATE CASCADE ON DELETE CASCADE;

ALTER TABLE ONLY public.loop_execution_credential_consumptions
    ADD CONSTRAINT loop_execution_credential_consumptions_compute_target_id_fkey FOREIGN KEY (compute_target_id) REFERENCES public.compute_targets(id) ON UPDATE CASCADE ON DELETE CASCADE;

ALTER TABLE ONLY public.loop_execution_credential_consumptions
    ADD CONSTRAINT loop_execution_credential_consumptions_loop_id_fkey FOREIGN KEY (loop_id) REFERENCES public.loops(id) ON UPDATE CASCADE ON DELETE CASCADE;

ALTER TABLE ONLY public.loop_token_refresh
    ADD CONSTRAINT loop_token_refresh_loop_id_fkey FOREIGN KEY (loop_id) REFERENCES public.loops(id) ON UPDATE CASCADE ON DELETE CASCADE;

ALTER TABLE ONLY public.loops
    ADD CONSTRAINT loops_artifact_id_fkey FOREIGN KEY (artifact_id) REFERENCES public.artifacts(id) ON UPDATE CASCADE ON DELETE SET NULL;

ALTER TABLE ONLY public.loops
    ADD CONSTRAINT loops_compute_target_id_fkey FOREIGN KEY (compute_target_id) REFERENCES public.compute_targets(id) ON UPDATE CASCADE ON DELETE SET NULL;

ALTER TABLE ONLY public.loops
    ADD CONSTRAINT loops_organization_id_fkey FOREIGN KEY (organization_id) REFERENCES public.organizations(id) ON UPDATE CASCADE ON DELETE RESTRICT;

ALTER TABLE ONLY public.loops
    ADD CONSTRAINT loops_parent_loop_id_fkey FOREIGN KEY (parent_loop_id) REFERENCES public.loops(id) ON UPDATE RESTRICT ON DELETE RESTRICT;

ALTER TABLE ONLY public.loops
    ADD CONSTRAINT loops_session_artifact_id_fkey FOREIGN KEY (session_artifact_id) REFERENCES public.artifacts(id) ON UPDATE CASCADE ON DELETE SET NULL;

ALTER TABLE ONLY public.loops
    ADD CONSTRAINT loops_user_id_fkey FOREIGN KEY (user_id) REFERENCES public.users(id) ON UPDATE CASCADE ON DELETE RESTRICT;

ALTER TABLE ONLY public.orchestrator_anchors
    ADD CONSTRAINT orchestrator_anchors_conversation_id_fkey FOREIGN KEY (conversation_id) REFERENCES public.orchestrator_conversations(id) ON UPDATE CASCADE ON DELETE CASCADE;

ALTER TABLE ONLY public.orchestrator_anchors
    ADD CONSTRAINT orchestrator_anchors_organization_id_fkey FOREIGN KEY (organization_id) REFERENCES public.organizations(id) ON UPDATE CASCADE ON DELETE CASCADE;

ALTER TABLE ONLY public.orchestrator_cases
    ADD CONSTRAINT orchestrator_cases_organization_id_fkey FOREIGN KEY (organization_id) REFERENCES public.organizations(id) ON UPDATE CASCADE ON DELETE CASCADE;

ALTER TABLE ONLY public.orchestrator_cases
    ADD CONSTRAINT orchestrator_cases_project_id_fkey FOREIGN KEY (project_id) REFERENCES public.projects(id) ON UPDATE CASCADE ON DELETE CASCADE;

ALTER TABLE ONLY public.orchestrator_cases
    ADD CONSTRAINT orchestrator_cases_workflow_id_fkey FOREIGN KEY (workflow_id) REFERENCES public.workflows(id) ON UPDATE CASCADE ON DELETE CASCADE;

ALTER TABLE ONLY public.orchestrator_conversations
    ADD CONSTRAINT orchestrator_conversations_case_id_fkey FOREIGN KEY (case_id) REFERENCES public.orchestrator_cases(id) ON UPDATE CASCADE ON DELETE CASCADE;

ALTER TABLE ONLY public.orchestrator_conversations
    ADD CONSTRAINT orchestrator_conversations_organization_id_fkey FOREIGN KEY (organization_id) REFERENCES public.organizations(id) ON UPDATE CASCADE ON DELETE CASCADE;

ALTER TABLE ONLY public.orchestrator_conversations
    ADD CONSTRAINT orchestrator_conversations_project_connection_id_fkey FOREIGN KEY (project_connection_id) REFERENCES public.project_connections(id) ON UPDATE CASCADE ON DELETE SET NULL;

ALTER TABLE ONLY public.orchestrator_decisions
    ADD CONSTRAINT orchestrator_decisions_case_id_fkey FOREIGN KEY (case_id) REFERENCES public.orchestrator_cases(id) ON UPDATE CASCADE ON DELETE CASCADE;

ALTER TABLE ONLY public.orchestrator_decisions
    ADD CONSTRAINT orchestrator_decisions_conversation_id_fkey FOREIGN KEY (conversation_id) REFERENCES public.orchestrator_conversations(id) ON UPDATE CASCADE ON DELETE CASCADE;

ALTER TABLE ONLY public.orchestrator_decisions
    ADD CONSTRAINT orchestrator_decisions_organization_id_fkey FOREIGN KEY (organization_id) REFERENCES public.organizations(id) ON UPDATE CASCADE ON DELETE CASCADE;

ALTER TABLE ONLY public.orchestrator_messages
    ADD CONSTRAINT orchestrator_messages_conversation_id_fkey FOREIGN KEY (conversation_id) REFERENCES public.orchestrator_conversations(id) ON UPDATE CASCADE ON DELETE CASCADE;

ALTER TABLE ONLY public.orchestrator_messages
    ADD CONSTRAINT orchestrator_messages_organization_id_fkey FOREIGN KEY (organization_id) REFERENCES public.organizations(id) ON UPDATE CASCADE ON DELETE CASCADE;

ALTER TABLE ONLY public.orchestrator_messages
    ADD CONSTRAINT orchestrator_messages_turn_id_fkey FOREIGN KEY (turn_id) REFERENCES public.orchestrator_turns(id) ON UPDATE CASCADE ON DELETE SET NULL;

ALTER TABLE ONLY public.orchestrator_tasks
    ADD CONSTRAINT orchestrator_tasks_case_id_fkey FOREIGN KEY (case_id) REFERENCES public.orchestrator_cases(id) ON UPDATE CASCADE ON DELETE CASCADE;

ALTER TABLE ONLY public.orchestrator_tasks
    ADD CONSTRAINT orchestrator_tasks_compute_target_id_fkey FOREIGN KEY (compute_target_id) REFERENCES public.compute_targets(id) ON UPDATE CASCADE ON DELETE SET NULL;

ALTER TABLE ONLY public.orchestrator_tasks
    ADD CONSTRAINT orchestrator_tasks_conversation_id_fkey FOREIGN KEY (conversation_id) REFERENCES public.orchestrator_conversations(id) ON UPDATE CASCADE ON DELETE CASCADE;

ALTER TABLE ONLY public.orchestrator_tasks
    ADD CONSTRAINT orchestrator_tasks_document_id_fkey FOREIGN KEY (document_id) REFERENCES public.artifacts(id) ON UPDATE CASCADE ON DELETE SET NULL;

ALTER TABLE ONLY public.orchestrator_tasks
    ADD CONSTRAINT orchestrator_tasks_organization_id_fkey FOREIGN KEY (organization_id) REFERENCES public.organizations(id) ON UPDATE CASCADE ON DELETE CASCADE;

ALTER TABLE ONLY public.orchestrator_tasks
    ADD CONSTRAINT orchestrator_tasks_turn_id_fkey FOREIGN KEY (turn_id) REFERENCES public.orchestrator_turns(id) ON UPDATE CASCADE ON DELETE SET NULL;

ALTER TABLE ONLY public.orchestrator_turns
    ADD CONSTRAINT orchestrator_turns_compute_target_id_fkey FOREIGN KEY (compute_target_id) REFERENCES public.compute_targets(id) ON UPDATE CASCADE ON DELETE SET NULL;

ALTER TABLE ONLY public.orchestrator_turns
    ADD CONSTRAINT orchestrator_turns_conversation_id_fkey FOREIGN KEY (conversation_id) REFERENCES public.orchestrator_conversations(id) ON UPDATE CASCADE ON DELETE CASCADE;

ALTER TABLE ONLY public.orchestrator_turns
    ADD CONSTRAINT orchestrator_turns_organization_id_fkey FOREIGN KEY (organization_id) REFERENCES public.organizations(id) ON UPDATE CASCADE ON DELETE CASCADE;

ALTER TABLE ONLY public.orchestrator_waits
    ADD CONSTRAINT orchestrator_waits_conversation_id_fkey FOREIGN KEY (conversation_id) REFERENCES public.orchestrator_conversations(id) ON UPDATE CASCADE ON DELETE CASCADE;

ALTER TABLE ONLY public.orchestrator_waits
    ADD CONSTRAINT orchestrator_waits_organization_id_fkey FOREIGN KEY (organization_id) REFERENCES public.organizations(id) ON UPDATE CASCADE ON DELETE CASCADE;

ALTER TABLE ONLY public.project_connection_scopes
    ADD CONSTRAINT project_connection_scopes_organization_id_fkey FOREIGN KEY (organization_id) REFERENCES public.organizations(id) ON UPDATE CASCADE ON DELETE CASCADE;

ALTER TABLE ONLY public.project_connection_scopes
    ADD CONSTRAINT project_connection_scopes_project_connection_id_fkey FOREIGN KEY (project_connection_id) REFERENCES public.project_connections(id) ON UPDATE CASCADE ON DELETE CASCADE;

ALTER TABLE ONLY public.project_connections
    ADD CONSTRAINT project_connections_connection_id_fkey FOREIGN KEY (connection_id) REFERENCES public.integration_connections(id) ON UPDATE CASCADE ON DELETE CASCADE;

ALTER TABLE ONLY public.project_connections
    ADD CONSTRAINT project_connections_created_by_id_fkey FOREIGN KEY (created_by_id) REFERENCES public.users(id) ON UPDATE CASCADE ON DELETE SET NULL;

ALTER TABLE ONLY public.project_connections
    ADD CONSTRAINT project_connections_organization_id_fkey FOREIGN KEY (organization_id) REFERENCES public.organizations(id) ON UPDATE CASCADE ON DELETE CASCADE;

ALTER TABLE ONLY public.project_connections
    ADD CONSTRAINT project_connections_project_id_fkey FOREIGN KEY (project_id) REFERENCES public.projects(id) ON UPDATE CASCADE ON DELETE CASCADE;

ALTER TABLE ONLY public.project_process_versions
    ADD CONSTRAINT project_process_versions_created_by_id_fkey FOREIGN KEY (created_by_id) REFERENCES public.users(id) ON UPDATE CASCADE ON DELETE SET NULL;

ALTER TABLE ONLY public.project_process_versions
    ADD CONSTRAINT project_process_versions_organization_id_fkey FOREIGN KEY (organization_id) REFERENCES public.organizations(id) ON UPDATE CASCADE ON DELETE CASCADE;

ALTER TABLE ONLY public.project_process_versions
    ADD CONSTRAINT project_process_versions_project_id_fkey FOREIGN KEY (project_id) REFERENCES public.projects(id) ON UPDATE CASCADE ON DELETE CASCADE;

ALTER TABLE ONLY public.project_repositories
    ADD CONSTRAINT project_repositories_connection_id_fkey FOREIGN KEY (connection_id) REFERENCES public.integration_connections(id) ON UPDATE CASCADE ON DELETE SET NULL;

ALTER TABLE ONLY public.project_repositories
    ADD CONSTRAINT project_repositories_created_by_id_fkey FOREIGN KEY (created_by_id) REFERENCES public.users(id) ON UPDATE CASCADE ON DELETE SET NULL;

ALTER TABLE ONLY public.project_repositories
    ADD CONSTRAINT project_repositories_organization_id_fkey FOREIGN KEY (organization_id) REFERENCES public.organizations(id) ON UPDATE CASCADE ON DELETE CASCADE;

ALTER TABLE ONLY public.project_repositories
    ADD CONSTRAINT project_repositories_project_id_fkey FOREIGN KEY (project_id) REFERENCES public.projects(id) ON UPDATE CASCADE ON DELETE CASCADE;

ALTER TABLE ONLY public.projects
    ADD CONSTRAINT projects_assignee_id_fkey FOREIGN KEY (assignee_id) REFERENCES public.users(id) ON UPDATE CASCADE ON DELETE SET NULL;

ALTER TABLE ONLY public.projects
    ADD CONSTRAINT projects_created_by_id_fkey FOREIGN KEY (created_by_id) REFERENCES public.users(id) ON UPDATE CASCADE ON DELETE RESTRICT;

ALTER TABLE ONLY public.projects
    ADD CONSTRAINT projects_organization_id_fkey FOREIGN KEY (organization_id) REFERENCES public.organizations(id) ON UPDATE CASCADE ON DELETE RESTRICT;

ALTER TABLE ONLY public.prompt_registry
    ADD CONSTRAINT prompt_registry_organization_id_fkey FOREIGN KEY (organization_id) REFERENCES public.organizations(id) ON UPDATE CASCADE ON DELETE CASCADE;

ALTER TABLE ONLY public.public_repositories
    ADD CONSTRAINT public_repositories_organization_id_fkey FOREIGN KEY (organization_id) REFERENCES public.organizations(id) ON UPDATE CASCADE ON DELETE CASCADE;

ALTER TABLE ONLY public.pull_request_detail
    ADD CONSTRAINT pull_request_detail_artifact_id_fkey FOREIGN KEY (artifact_id) REFERENCES public.artifacts(id) ON UPDATE CASCADE ON DELETE SET NULL;

ALTER TABLE ONLY public.pull_request_detail
    ADD CONSTRAINT pull_request_detail_branch_artifact_id_fkey FOREIGN KEY (branch_artifact_id) REFERENCES public.artifacts(id) ON UPDATE CASCADE ON DELETE CASCADE;

ALTER TABLE ONLY public.pull_request_detail
    ADD CONSTRAINT pull_request_detail_organization_id_fkey FOREIGN KEY (organization_id) REFERENCES public.organizations(id) ON UPDATE CASCADE ON DELETE RESTRICT;

ALTER TABLE ONLY public.pull_request_detail
    ADD CONSTRAINT pull_request_detail_repository_id_fkey FOREIGN KEY (repository_id) REFERENCES public.github_installation_repositories(id) ON UPDATE CASCADE ON DELETE SET NULL;

ALTER TABLE ONLY public.repo_bootstrap_configs
    ADD CONSTRAINT repo_bootstrap_configs_organization_id_fkey FOREIGN KEY (organization_id) REFERENCES public.organizations(id) ON UPDATE CASCADE ON DELETE CASCADE;

ALTER TABLE ONLY public.repository_default_observation_receipts
    ADD CONSTRAINT repo_default_observation_receipt_org_fkey FOREIGN KEY (organization_id) REFERENCES public.organizations(id) ON UPDATE CASCADE ON DELETE CASCADE;

ALTER TABLE ONLY public.routine_runs
    ADD CONSTRAINT routine_runs_organization_id_fkey FOREIGN KEY (organization_id) REFERENCES public.organizations(id) ON UPDATE CASCADE ON DELETE CASCADE;

ALTER TABLE ONLY public.routine_runs
    ADD CONSTRAINT routine_runs_routine_id_fkey FOREIGN KEY (routine_id) REFERENCES public.routines(id) ON UPDATE CASCADE ON DELETE CASCADE;

ALTER TABLE ONLY public.routines
    ADD CONSTRAINT routines_organization_id_fkey FOREIGN KEY (organization_id) REFERENCES public.organizations(id) ON UPDATE CASCADE ON DELETE CASCADE;

ALTER TABLE ONLY public.routines
    ADD CONSTRAINT routines_owner_id_fkey FOREIGN KEY (owner_id) REFERENCES public.users(id) ON UPDATE CASCADE ON DELETE SET NULL;

ALTER TABLE ONLY public.session_detail
    ADD CONSTRAINT session_detail_artifact_id_fkey FOREIGN KEY (artifact_id) REFERENCES public.artifacts(id) ON UPDATE CASCADE ON DELETE CASCADE;

ALTER TABLE ONLY public.session_detail
    ADD CONSTRAINT session_detail_compute_target_id_fkey FOREIGN KEY (compute_target_id) REFERENCES public.compute_targets(id) ON UPDATE CASCADE ON DELETE RESTRICT;

ALTER TABLE ONLY public.session_detail
    ADD CONSTRAINT session_detail_user_id_fkey FOREIGN KEY (user_id) REFERENCES public.users(id) ON UPDATE CASCADE ON DELETE SET NULL;

ALTER TABLE ONLY public.session_transcript
    ADD CONSTRAINT session_transcript_compute_target_id_fkey FOREIGN KEY (compute_target_id) REFERENCES public.compute_targets(id) ON UPDATE CASCADE ON DELETE RESTRICT;

ALTER TABLE ONLY public.session_transcript
    ADD CONSTRAINT session_transcript_organization_id_fkey FOREIGN KEY (organization_id) REFERENCES public.organizations(id) ON UPDATE CASCADE ON DELETE RESTRICT;

ALTER TABLE ONLY public.session_transcript
    ADD CONSTRAINT session_transcript_session_detail_id_fkey FOREIGN KEY (session_detail_id) REFERENCES public.session_detail(artifact_id) ON UPDATE CASCADE ON DELETE SET NULL;

ALTER TABLE ONLY public.source_occurrences
    ADD CONSTRAINT source_occurrences_compute_target_id_fkey FOREIGN KEY (compute_target_id) REFERENCES public.compute_targets(id) ON UPDATE CASCADE ON DELETE SET NULL;

ALTER TABLE ONLY public.source_occurrences
    ADD CONSTRAINT source_occurrences_definition_version_id_fkey FOREIGN KEY (definition_version_id) REFERENCES public.definition_versions(id) ON UPDATE CASCADE ON DELETE CASCADE;

ALTER TABLE ONLY public.source_occurrences
    ADD CONSTRAINT source_occurrences_organization_id_fkey FOREIGN KEY (organization_id) REFERENCES public.organizations(id) ON UPDATE CASCADE ON DELETE CASCADE;

ALTER TABLE ONLY public.tag_artifacts
    ADD CONSTRAINT tag_artifacts_artifact_id_fkey FOREIGN KEY (artifact_id) REFERENCES public.artifacts(id) ON UPDATE CASCADE ON DELETE CASCADE;

ALTER TABLE ONLY public.tag_artifacts
    ADD CONSTRAINT tag_artifacts_tag_id_fkey FOREIGN KEY (tag_id) REFERENCES public.tags(id) ON UPDATE CASCADE ON DELETE CASCADE;

ALTER TABLE ONLY public.tag_loops
    ADD CONSTRAINT tag_loops_loop_id_fkey FOREIGN KEY (loop_id) REFERENCES public.loops(id) ON UPDATE CASCADE ON DELETE CASCADE;

ALTER TABLE ONLY public.tag_loops
    ADD CONSTRAINT tag_loops_tag_id_fkey FOREIGN KEY (tag_id) REFERENCES public.tags(id) ON UPDATE CASCADE ON DELETE CASCADE;

ALTER TABLE ONLY public.tag_projects
    ADD CONSTRAINT tag_projects_project_id_fkey FOREIGN KEY (project_id) REFERENCES public.projects(id) ON UPDATE CASCADE ON DELETE CASCADE;

ALTER TABLE ONLY public.tag_projects
    ADD CONSTRAINT tag_projects_tag_id_fkey FOREIGN KEY (tag_id) REFERENCES public.tags(id) ON UPDATE CASCADE ON DELETE CASCADE;

ALTER TABLE ONLY public.tags
    ADD CONSTRAINT tags_created_by_id_fkey FOREIGN KEY (created_by_id) REFERENCES public.users(id) ON UPDATE CASCADE ON DELETE RESTRICT;

ALTER TABLE ONLY public.tags
    ADD CONSTRAINT tags_organization_id_fkey FOREIGN KEY (organization_id) REFERENCES public.organizations(id) ON UPDATE CASCADE ON DELETE RESTRICT;

ALTER TABLE ONLY public.user_public_keys
    ADD CONSTRAINT user_public_keys_organization_id_fkey FOREIGN KEY (organization_id) REFERENCES public.organizations(id) ON UPDATE CASCADE ON DELETE CASCADE;

ALTER TABLE ONLY public.user_public_keys
    ADD CONSTRAINT user_public_keys_user_id_fkey FOREIGN KEY (user_id) REFERENCES public.users(id) ON UPDATE CASCADE ON DELETE CASCADE;

ALTER TABLE ONLY public.users
    ADD CONSTRAINT users_organization_id_fkey FOREIGN KEY (organization_id) REFERENCES public.organizations(id) ON UPDATE CASCADE ON DELETE RESTRICT;

ALTER TABLE ONLY public.users
    ADD CONSTRAINT users_preferred_compute_target_id_fkey FOREIGN KEY (preferred_compute_target_id) REFERENCES public.compute_targets(id) ON UPDATE CASCADE ON DELETE SET NULL;

ALTER TABLE ONLY public.workflow_action_runs
    ADD CONSTRAINT workflow_action_runs_action_id_fkey FOREIGN KEY (action_id) REFERENCES public.workflow_actions(id) ON UPDATE CASCADE ON DELETE SET NULL;

ALTER TABLE ONLY public.workflow_action_runs
    ADD CONSTRAINT workflow_action_runs_run_id_fkey FOREIGN KEY (run_id) REFERENCES public.workflow_runs(id) ON UPDATE CASCADE ON DELETE CASCADE;

ALTER TABLE ONLY public.workflow_actions
    ADD CONSTRAINT workflow_actions_connection_id_fkey FOREIGN KEY (connection_id) REFERENCES public.integration_connections(id) ON UPDATE CASCADE ON DELETE CASCADE;

ALTER TABLE ONLY public.workflow_actions
    ADD CONSTRAINT workflow_actions_workflow_id_fkey FOREIGN KEY (workflow_id) REFERENCES public.workflows(id) ON UPDATE CASCADE ON DELETE CASCADE;

ALTER TABLE ONLY public.workflow_run_loops
    ADD CONSTRAINT workflow_run_loops_loop_id_fkey FOREIGN KEY (loop_id) REFERENCES public.loops(id) ON UPDATE CASCADE ON DELETE CASCADE;

ALTER TABLE ONLY public.workflow_run_loops
    ADD CONSTRAINT workflow_run_loops_run_id_fkey FOREIGN KEY (run_id) REFERENCES public.workflow_runs(id) ON UPDATE CASCADE ON DELETE CASCADE;

ALTER TABLE ONLY public.workflow_runs
    ADD CONSTRAINT workflow_runs_connection_id_fkey FOREIGN KEY (connection_id) REFERENCES public.integration_connections(id) ON UPDATE CASCADE ON DELETE SET NULL;

ALTER TABLE ONLY public.workflow_runs
    ADD CONSTRAINT workflow_runs_delivery_id_fkey FOREIGN KEY (delivery_id) REFERENCES public.integration_deliveries(id) ON UPDATE CASCADE ON DELETE SET NULL;

ALTER TABLE ONLY public.workflow_runs
    ADD CONSTRAINT workflow_runs_feature_document_id_fkey FOREIGN KEY (feature_document_id) REFERENCES public.artifacts(id) ON UPDATE CASCADE ON DELETE SET NULL;

ALTER TABLE ONLY public.workflow_runs
    ADD CONSTRAINT workflow_runs_organization_id_fkey FOREIGN KEY (organization_id) REFERENCES public.organizations(id) ON UPDATE CASCADE ON DELETE CASCADE;

ALTER TABLE ONLY public.workflow_runs
    ADD CONSTRAINT workflow_runs_plan_document_id_fkey FOREIGN KEY (plan_document_id) REFERENCES public.artifacts(id) ON UPDATE CASCADE ON DELETE SET NULL;

ALTER TABLE ONLY public.workflow_runs
    ADD CONSTRAINT workflow_runs_project_connection_id_fkey FOREIGN KEY (project_connection_id) REFERENCES public.project_connections(id) ON UPDATE CASCADE ON DELETE SET NULL;

ALTER TABLE ONLY public.workflow_runs
    ADD CONSTRAINT workflow_runs_project_id_fkey FOREIGN KEY (project_id) REFERENCES public.projects(id) ON UPDATE CASCADE ON DELETE CASCADE;

ALTER TABLE ONLY public.workflow_runs
    ADD CONSTRAINT workflow_runs_run_as_user_id_fkey FOREIGN KEY (run_as_user_id) REFERENCES public.users(id) ON UPDATE CASCADE ON DELETE SET NULL;

ALTER TABLE ONLY public.workflow_runs
    ADD CONSTRAINT workflow_runs_trigger_id_fkey FOREIGN KEY (trigger_id) REFERENCES public.workflow_triggers(id) ON UPDATE CASCADE ON DELETE SET NULL;

ALTER TABLE ONLY public.workflow_runs
    ADD CONSTRAINT workflow_runs_workflow_id_fkey FOREIGN KEY (workflow_id) REFERENCES public.workflows(id) ON UPDATE CASCADE ON DELETE CASCADE;

ALTER TABLE ONLY public.workflow_triggers
    ADD CONSTRAINT workflow_triggers_connection_id_fkey FOREIGN KEY (connection_id) REFERENCES public.integration_connections(id) ON UPDATE CASCADE ON DELETE CASCADE;

ALTER TABLE ONLY public.workflow_triggers
    ADD CONSTRAINT workflow_triggers_project_connection_id_fkey FOREIGN KEY (project_connection_id) REFERENCES public.project_connections(id) ON UPDATE CASCADE ON DELETE RESTRICT;

ALTER TABLE ONLY public.workflow_triggers
    ADD CONSTRAINT workflow_triggers_project_id_fkey FOREIGN KEY (project_id) REFERENCES public.projects(id) ON UPDATE CASCADE ON DELETE CASCADE;

ALTER TABLE ONLY public.workflow_triggers
    ADD CONSTRAINT workflow_triggers_workflow_id_fkey FOREIGN KEY (workflow_id) REFERENCES public.workflows(id) ON UPDATE CASCADE ON DELETE CASCADE;

ALTER TABLE ONLY public.workflows
    ADD CONSTRAINT workflows_created_by_id_fkey FOREIGN KEY (created_by_id) REFERENCES public.users(id) ON UPDATE CASCADE ON DELETE SET NULL;

ALTER TABLE ONLY public.workflows
    ADD CONSTRAINT workflows_organization_id_fkey FOREIGN KEY (organization_id) REFERENCES public.organizations(id) ON UPDATE CASCADE ON DELETE CASCADE;

ALTER TABLE ONLY public.workflows
    ADD CONSTRAINT workflows_project_id_fkey FOREIGN KEY (project_id) REFERENCES public.projects(id) ON UPDATE CASCADE ON DELETE SET NULL;

ALTER TABLE ONLY public.workflows
    ADD CONSTRAINT workflows_run_as_user_id_fkey FOREIGN KEY (run_as_user_id) REFERENCES public.users(id) ON UPDATE CASCADE ON DELETE SET NULL;
