CREATE TABLE workspaces (
    id text PRIMARY KEY DEFAULT ('ws_' || gen_random_uuid()::text),
    name text NOT NULL,
    slug text NOT NULL UNIQUE,
    created_at timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE users (
    id text PRIMARY KEY DEFAULT ('usr_' || gen_random_uuid()::text),
    email text NOT NULL UNIQUE,
    password_hash text NOT NULL,
    display_name text NOT NULL,
    created_at timestamptz NOT NULL DEFAULT now(),
    updated_at timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE sessions (
    id text PRIMARY KEY,
    user_id text NOT NULL REFERENCES users(id),
    expires_at timestamptz NOT NULL,
    created_at timestamptz NOT NULL DEFAULT now(),
    CHECK (expires_at > created_at)
);
CREATE INDEX sessions_user_id_idx ON sessions(user_id);
CREATE INDEX sessions_expires_at_idx ON sessions(expires_at);

CREATE TABLE workspace_members (
    workspace_id text NOT NULL REFERENCES workspaces(id),
    user_id text NOT NULL REFERENCES users(id),
    role text NOT NULL CHECK (role IN ('admin', 'member')),
    created_at timestamptz NOT NULL DEFAULT now(),
    updated_at timestamptz NOT NULL DEFAULT now(),
    PRIMARY KEY (workspace_id, user_id)
);

CREATE TABLE repositories (
    id text PRIMARY KEY DEFAULT ('repo_' || gen_random_uuid()::text),
    workspace_id text NOT NULL REFERENCES workspaces(id),
    name text NOT NULL,
    remote_url text,
    default_ref text NOT NULL DEFAULT 'main',
    status text NOT NULL DEFAULT 'active' CHECK (status IN ('active', 'archived')),
    created_at timestamptz NOT NULL DEFAULT now(),
    updated_at timestamptz NOT NULL DEFAULT now(),
    UNIQUE (workspace_id, id)
);
CREATE UNIQUE INDEX repositories_workspace_remote_url_key
    ON repositories(workspace_id, remote_url) WHERE remote_url IS NOT NULL;

CREATE TABLE runners (
    id text PRIMARY KEY DEFAULT ('rnr_' || gen_random_uuid()::text),
    workspace_id text NOT NULL REFERENCES workspaces(id),
    name text NOT NULL,
    kind text NOT NULL DEFAULT 'local' CHECK (kind IN ('local', 'vps')),
    status text NOT NULL DEFAULT 'offline' CHECK (status IN ('offline', 'online', 'draining', 'revoked')),
    daemon_version text,
    os text,
    arch text,
    max_concurrency integer NOT NULL DEFAULT 2 CHECK (max_concurrency > 0),
    token_hash text UNIQUE CHECK (token_hash ~ '^[0-9a-f]{64}$'),
    token_rotated_at timestamptz,
    previous_token_hash text CHECK (previous_token_hash ~ '^[0-9a-f]{64}$'),
    previous_token_expires_at timestamptz,
    last_seen_at timestamptz,
    created_by text NOT NULL,
    created_at timestamptz NOT NULL DEFAULT now(),
    updated_at timestamptz NOT NULL DEFAULT now(),
    revoked_at timestamptz,
    UNIQUE (workspace_id, id),
    FOREIGN KEY (workspace_id, created_by) REFERENCES workspace_members(workspace_id, user_id),
    CHECK ((previous_token_hash IS NULL) = (previous_token_expires_at IS NULL))
);

CREATE TABLE runner_pairing_codes (
    id text PRIMARY KEY DEFAULT ('pair_' || gen_random_uuid()::text),
    workspace_id text NOT NULL REFERENCES workspaces(id),
    runner_id text NOT NULL,
    code_hash text NOT NULL UNIQUE CHECK (code_hash ~ '^[0-9a-f]{64}$'),
    expires_at timestamptz NOT NULL DEFAULT (now() + interval '10 minutes'),
    used_at timestamptz,
    created_by text NOT NULL,
    created_at timestamptz NOT NULL DEFAULT now(),
    updated_at timestamptz NOT NULL DEFAULT now(),
    FOREIGN KEY (workspace_id, runner_id) REFERENCES runners(workspace_id, id),
    FOREIGN KEY (workspace_id, created_by) REFERENCES workspace_members(workspace_id, user_id),
    CHECK (expires_at > created_at)
);
CREATE INDEX runner_pairing_codes_expires_at_idx ON runner_pairing_codes(expires_at);

-- The explicit tenant key closes the otherwise indirect Runner/Repository join.
CREATE TABLE runner_repositories (
    workspace_id text NOT NULL REFERENCES workspaces(id),
    runner_id text NOT NULL,
    repository_id text NOT NULL,
    access text NOT NULL CHECK (access IN ('read', 'write')),
    reported_at timestamptz NOT NULL DEFAULT now(),
    created_at timestamptz NOT NULL DEFAULT now(),
    updated_at timestamptz NOT NULL DEFAULT now(),
    PRIMARY KEY (runner_id, repository_id),
    FOREIGN KEY (workspace_id, runner_id) REFERENCES runners(workspace_id, id),
    FOREIGN KEY (workspace_id, repository_id) REFERENCES repositories(workspace_id, id)
);

CREATE TABLE agent_profiles (
    id text PRIMARY KEY DEFAULT ('agp_' || gen_random_uuid()::text),
    workspace_id text NOT NULL REFERENCES workspaces(id),
    runner_id text NOT NULL,
    engine text NOT NULL CHECK (engine IN ('claude-code', 'codex', 'pi', 'custom')),
    display_name text NOT NULL,
    launch jsonb NOT NULL DEFAULT '{"kind":"managed"}'::jsonb CHECK (jsonb_typeof(launch) = 'object'),
    default_model text,
    capability_snapshot jsonb CHECK (jsonb_typeof(capability_snapshot) = 'object'),
    capability_reported_at timestamptz,
    created_at timestamptz NOT NULL DEFAULT now(),
    updated_at timestamptz NOT NULL DEFAULT now(),
    UNIQUE (workspace_id, id),
    UNIQUE (workspace_id, runner_id, id),
    FOREIGN KEY (workspace_id, runner_id) REFERENCES runners(workspace_id, id)
);

CREATE TABLE tasks (
    id text PRIMARY KEY DEFAULT ('task_' || gen_random_uuid()::text),
    workspace_id text NOT NULL REFERENCES workspaces(id),
    title text NOT NULL,
    description text NOT NULL DEFAULT '',
    status text NOT NULL DEFAULT 'backlog' CHECK (status IN ('backlog', 'todo', 'in_progress', 'needs_review', 'done', 'canceled')),
    priority text CHECK (priority IN ('urgent', 'high', 'medium', 'low')),
    repository_id text,
    last_run_config jsonb CHECK (jsonb_typeof(last_run_config) = 'object'),
    revision integer NOT NULL DEFAULT 1 CHECK (revision > 0),
    created_by text NOT NULL,
    created_at timestamptz NOT NULL DEFAULT now(),
    updated_at timestamptz NOT NULL DEFAULT now(),
    UNIQUE (workspace_id, id),
    FOREIGN KEY (workspace_id, repository_id) REFERENCES repositories(workspace_id, id),
    FOREIGN KEY (workspace_id, created_by) REFERENCES workspace_members(workspace_id, user_id)
);
CREATE INDEX tasks_workspace_status_updated_at_idx ON tasks(workspace_id, status, updated_at DESC);

CREATE TABLE runs (
    id text PRIMARY KEY DEFAULT ('run_' || gen_random_uuid()::text),
    workspace_id text NOT NULL REFERENCES workspaces(id),
    task_id text NOT NULL,
    requested_by text NOT NULL,
    status text NOT NULL DEFAULT 'pending' CHECK (status IN ('pending', 'active', 'idle', 'waiting_approval', 'completed', 'failed', 'canceled', 'lost')),
    runner_id text NOT NULL,
    agent_profile_id text NOT NULL,
    repository_id text NOT NULL,
    base_commit_sha text NOT NULL,
    frozen_spec jsonb NOT NULL CHECK (jsonb_typeof(frozen_spec) = 'object'),
    current_attempt_id text,
    -- Pre-start retries only (ADR-015, scheduling-reliability.md §6.1); never incremented after the Agent starts.
    auto_retry_count integer NOT NULL DEFAULT 0 CHECK (auto_retry_count BETWEEN 0 AND 3),
    created_at timestamptz NOT NULL DEFAULT now(),
    updated_at timestamptz NOT NULL DEFAULT now(),
    started_at timestamptz,
    finished_at timestamptz,
    UNIQUE (workspace_id, id),
    UNIQUE (workspace_id, id, runner_id, agent_profile_id),
    FOREIGN KEY (workspace_id, task_id) REFERENCES tasks(workspace_id, id),
    FOREIGN KEY (workspace_id, requested_by) REFERENCES workspace_members(workspace_id, user_id),
    FOREIGN KEY (workspace_id, runner_id, agent_profile_id) REFERENCES agent_profiles(workspace_id, runner_id, id),
    FOREIGN KEY (workspace_id, repository_id) REFERENCES repositories(workspace_id, id),
    CONSTRAINT runs_frozen_spec_projection_check CHECK ((
        frozen_spec->>'taskId' = task_id
        AND frozen_spec->>'runnerId' = runner_id
        AND frozen_spec->>'agentProfileId' = agent_profile_id
        AND frozen_spec->>'repositoryId' = repository_id
        AND frozen_spec->>'baseCommitSha' = base_commit_sha
        AND frozen_spec->'runConfig'->>'agentProfileId' = agent_profile_id
    ) IS TRUE)
);
CREATE INDEX runs_workspace_task_created_at_idx ON runs(workspace_id, task_id, created_at DESC);

CREATE TABLE attempts (
    id text PRIMARY KEY DEFAULT ('att_' || gen_random_uuid()::text),
    workspace_id text NOT NULL REFERENCES workspaces(id),
    run_id text NOT NULL,
    number integer NOT NULL CHECK (number > 0),
    runner_id text NOT NULL,
    agent_profile_id text NOT NULL,
    status text NOT NULL DEFAULT 'queued' CHECK (status IN ('queued', 'claimed', 'preparing', 'running', 'idle', 'waiting_approval', 'completed', 'failed', 'canceled', 'lost')),
    resume_from jsonb NOT NULL DEFAULT '{"kind":"base"}'::jsonb CHECK (jsonb_typeof(resume_from) = 'object'),
    branch_name text NOT NULL,
    base_commit_sha text NOT NULL,
    head_commit_sha text,
    not_before timestamptz,
    claimed_at timestamptz,
    started_at timestamptz,
    finished_at timestamptz,
    lease_expires_at timestamptz,
    last_heartbeat_at timestamptz,
    last_sequence bigint NOT NULL DEFAULT 0 CHECK (last_sequence >= 0),
    last_client_seq bigint NOT NULL DEFAULT 0 CHECK (last_client_seq >= 0),
    last_chunk_seq bigint NOT NULL DEFAULT 0 CHECK (last_chunk_seq >= 0),
    enforcement jsonb CHECK (jsonb_typeof(enforcement) = 'object'),
    cancel_requested_at timestamptz,
    error jsonb CHECK (jsonb_typeof(error) = 'object'),
    created_at timestamptz NOT NULL DEFAULT now(),
    updated_at timestamptz NOT NULL DEFAULT now(),
    UNIQUE (run_id, number),
    UNIQUE (workspace_id, id),
    UNIQUE (workspace_id, run_id, id),
    FOREIGN KEY (workspace_id, run_id, runner_id, agent_profile_id) REFERENCES runs(workspace_id, id, runner_id, agent_profile_id),
    CONSTRAINT attempts_active_lease_check CHECK (
        status NOT IN ('claimed', 'preparing', 'running', 'idle', 'waiting_approval')
        OR (claimed_at IS NOT NULL AND last_heartbeat_at IS NOT NULL
            AND lease_expires_at IS NOT NULL AND lease_expires_at > last_heartbeat_at)
    ),
    CONSTRAINT attempts_queued_lease_check CHECK (
        status <> 'queued' OR (claimed_at IS NULL AND lease_expires_at IS NULL AND last_heartbeat_at IS NULL)
    )
);
CREATE INDEX attempts_runner_status_idx ON attempts(runner_id, status);
CREATE INDEX attempts_active_lease_idx ON attempts(status, lease_expires_at)
    WHERE status IN ('claimed', 'preparing', 'running', 'idle', 'waiting_approval');
CREATE INDEX attempts_queued_claim_idx ON attempts(runner_id, status, not_before) WHERE status = 'queued';
-- A Run has one current nonterminal Attempt, including its queued reservation.
CREATE UNIQUE INDEX attempts_one_active_run_idx ON attempts(run_id)
    WHERE status IN ('queued', 'claimed', 'preparing', 'running', 'idle', 'waiting_approval');
-- Queued Attempts do not reserve a profile; claiming reserves it.
CREATE UNIQUE INDEX attempts_one_active_profile_idx ON attempts(agent_profile_id)
    WHERE status IN ('claimed', 'preparing', 'running', 'idle', 'waiting_approval');

-- Deferred to permit Run -> Attempt -> current pointer insertion in one transaction.
ALTER TABLE runs ADD CONSTRAINT runs_current_attempt_fk
    FOREIGN KEY (workspace_id, id, current_attempt_id)
    REFERENCES attempts(workspace_id, run_id, id) DEFERRABLE INITIALLY DEFERRED;

CREATE TABLE turns (
    id text PRIMARY KEY DEFAULT ('trn_' || gen_random_uuid()::text),
    workspace_id text NOT NULL REFERENCES workspaces(id),
    attempt_id text NOT NULL,
    number integer NOT NULL CHECK (number > 0),
    prompt text NOT NULL,
    status text NOT NULL DEFAULT 'running' CHECK (status IN ('running', 'waiting_approval', 'completed', 'failed', 'canceled')),
    usage jsonb CHECK (jsonb_typeof(usage) = 'object'),
    diff_stats jsonb CHECK (jsonb_typeof(diff_stats) = 'object'),
    commit_sha text,
    patch_artifact_id text,
    started_at timestamptz NOT NULL DEFAULT now(),
    finished_at timestamptz,
    created_at timestamptz NOT NULL DEFAULT now(),
    updated_at timestamptz NOT NULL DEFAULT now(),
    UNIQUE (attempt_id, number),
    UNIQUE (workspace_id, attempt_id, id),
    FOREIGN KEY (workspace_id, attempt_id) REFERENCES attempts(workspace_id, id)
);

CREATE TABLE run_events (
    id bigserial PRIMARY KEY,
    workspace_id text NOT NULL REFERENCES workspaces(id),
    run_id text NOT NULL,
    attempt_id text NOT NULL,
    turn_id text,
    sequence bigint NOT NULL CHECK (sequence > 0),
    client_seq bigint CHECK (client_seq > 0),
    type text NOT NULL,
    payload jsonb NOT NULL,
    occurred_at timestamptz NOT NULL,
    created_at timestamptz NOT NULL DEFAULT now(),
    UNIQUE (attempt_id, sequence),
    FOREIGN KEY (workspace_id, run_id, attempt_id) REFERENCES attempts(workspace_id, run_id, id),
    FOREIGN KEY (workspace_id, attempt_id, turn_id) REFERENCES turns(workspace_id, attempt_id, id)
);
CREATE UNIQUE INDEX run_events_attempt_client_seq_key ON run_events(attempt_id, client_seq) WHERE client_seq IS NOT NULL;
CREATE INDEX run_events_run_created_at_idx ON run_events(run_id, created_at);

CREATE TABLE transcript_chunks (
    workspace_id text NOT NULL REFERENCES workspaces(id),
    attempt_id text NOT NULL,
    chunk_seq bigint NOT NULL CHECK (chunk_seq > 0),
    turn_id text NOT NULL,
    frames jsonb NOT NULL CHECK (jsonb_typeof(frames) = 'array'),
    frame_count integer NOT NULL CHECK (frame_count > 0),
    byte_size integer NOT NULL CHECK (byte_size > 0 AND byte_size <= 65536),
    created_at timestamptz NOT NULL DEFAULT now(),
    PRIMARY KEY (attempt_id, chunk_seq),
    FOREIGN KEY (workspace_id, attempt_id) REFERENCES attempts(workspace_id, id),
    FOREIGN KEY (workspace_id, attempt_id, turn_id) REFERENCES turns(workspace_id, attempt_id, id),
    CHECK (frame_count = jsonb_array_length(frames))
);

CREATE TABLE approval_requests (
    id text PRIMARY KEY DEFAULT ('apr_' || gen_random_uuid()::text),
    workspace_id text NOT NULL REFERENCES workspaces(id),
    run_id text NOT NULL,
    attempt_id text NOT NULL,
    turn_id text NOT NULL,
    request_id text NOT NULL,
    kind text NOT NULL CHECK (kind IN ('tool', 'file_write', 'shell', 'network', 'other')),
    title text NOT NULL,
    payload jsonb NOT NULL,
    status text NOT NULL DEFAULT 'pending' CHECK (status IN ('pending', 'approved', 'denied', 'expired')),
    decided_by text,
    decided_at timestamptz,
    expires_at timestamptz NOT NULL DEFAULT (now() + interval '24 hours'),
    created_at timestamptz NOT NULL DEFAULT now(),
    updated_at timestamptz NOT NULL DEFAULT now(),
    UNIQUE (attempt_id, request_id),
    FOREIGN KEY (workspace_id, run_id, attempt_id) REFERENCES attempts(workspace_id, run_id, id),
    FOREIGN KEY (workspace_id, attempt_id, turn_id) REFERENCES turns(workspace_id, attempt_id, id),
    FOREIGN KEY (workspace_id, decided_by) REFERENCES workspace_members(workspace_id, user_id),
    CHECK (status NOT IN ('approved', 'denied') OR (decided_by IS NOT NULL AND decided_at IS NOT NULL)),
    CHECK (status <> 'pending' OR (decided_by IS NULL AND decided_at IS NULL))
);
CREATE INDEX approval_requests_workspace_status_created_at_idx ON approval_requests(workspace_id, status, created_at);

CREATE TABLE artifacts (
    id text PRIMARY KEY DEFAULT ('art_' || gen_random_uuid()::text),
    workspace_id text NOT NULL REFERENCES workspaces(id),
    run_id text NOT NULL,
    attempt_id text NOT NULL,
    turn_id text,
    kind text NOT NULL CHECK (kind IN ('patch', 'file', 'log')),
    blob_ref text NOT NULL UNIQUE,
    size_bytes bigint NOT NULL CHECK (size_bytes >= 0),
    sha256 text NOT NULL CHECK (sha256 ~ '^[0-9a-f]{64}$'),
    mime_type text NOT NULL,
    created_at timestamptz NOT NULL DEFAULT now(),
    UNIQUE (workspace_id, attempt_id, turn_id, id),
    FOREIGN KEY (workspace_id, run_id, attempt_id) REFERENCES attempts(workspace_id, run_id, id),
    FOREIGN KEY (workspace_id, attempt_id, turn_id) REFERENCES turns(workspace_id, attempt_id, id),
    CHECK (kind <> 'patch' OR size_bytes <= 20971520),
    CHECK (kind <> 'log' OR size_bytes <= 52428800)
);
ALTER TABLE turns ADD CONSTRAINT turns_patch_artifact_fk
    FOREIGN KEY (workspace_id, attempt_id, id, patch_artifact_id)
    REFERENCES artifacts(workspace_id, attempt_id, turn_id, id) DEFERRABLE INITIALLY DEFERRED;

CREATE TABLE audit_events (
    id bigserial PRIMARY KEY,
    workspace_id text NOT NULL REFERENCES workspaces(id),
    actor_type text NOT NULL CHECK (actor_type IN ('human', 'runner', 'system')),
    actor_id text NOT NULL,
    entity_type text NOT NULL CHECK (entity_type IN ('task', 'run', 'attempt', 'runner', 'repository', 'agent_profile', 'approval')),
    entity_id text NOT NULL,
    kind text NOT NULL,
    data jsonb NOT NULL DEFAULT '{}'::jsonb CHECK (jsonb_typeof(data) = 'object'),
    created_at timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX audit_events_workspace_entity_created_at_idx ON audit_events(workspace_id, entity_type, entity_id, created_at);

CREATE FUNCTION reject_audit_mutation() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
    RAISE EXCEPTION 'audit_events is append-only' USING ERRCODE = '23514';
END;
$$;
CREATE TRIGGER audit_events_append_only BEFORE UPDATE OR DELETE OR TRUNCATE ON audit_events
    FOR EACH STATEMENT EXECUTE FUNCTION reject_audit_mutation();

CREATE FUNCTION preserve_run_spec() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
    IF ROW(NEW.id, NEW.workspace_id, NEW.task_id, NEW.requested_by, NEW.runner_id,
           NEW.agent_profile_id, NEW.repository_id, NEW.base_commit_sha, NEW.frozen_spec)
       IS DISTINCT FROM
       ROW(OLD.id, OLD.workspace_id, OLD.task_id, OLD.requested_by, OLD.runner_id,
           OLD.agent_profile_id, OLD.repository_id, OLD.base_commit_sha, OLD.frozen_spec) THEN
        RAISE EXCEPTION 'Run identity and frozen spec are immutable' USING ERRCODE = '23514';
    END IF;
    RETURN NEW;
END;
$$;
CREATE TRIGGER runs_preserve_frozen_spec BEFORE UPDATE ON runs
    FOR EACH ROW EXECUTE FUNCTION preserve_run_spec();

CREATE FUNCTION preserve_terminal_attempt() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
    IF OLD.status IN ('completed', 'failed', 'canceled', 'lost') AND NEW.status <> OLD.status THEN
        RAISE EXCEPTION 'Terminal attempts cannot be reused' USING ERRCODE = '23514';
    END IF;
    RETURN NEW;
END;
$$;
CREATE TRIGGER attempts_preserve_terminal_status BEFORE UPDATE OF status ON attempts
    FOR EACH ROW EXECUTE FUNCTION preserve_terminal_attempt();

CREATE FUNCTION touch_updated_at() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
    NEW.updated_at := now();
    RETURN NEW;
END;
$$;
DO $$
DECLARE
    table_name text;
BEGIN
    FOREACH table_name IN ARRAY ARRAY['users', 'workspace_members', 'repositories', 'runners',
        'runner_pairing_codes', 'runner_repositories', 'agent_profiles', 'tasks', 'runs',
        'attempts', 'turns', 'approval_requests']
    LOOP
        EXECUTE format('CREATE TRIGGER %I BEFORE UPDATE ON %I FOR EACH ROW EXECUTE FUNCTION touch_updated_at()',
            table_name || '_touch_updated_at', table_name);
    END LOOP;
END;
$$;
