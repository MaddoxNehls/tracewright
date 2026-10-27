-- ============================================================================
-- STANDALONE DEV ONLY. NOT CANONICAL.
--
-- The canonical schema is owned by the Go ingest service:
--   ingest/internal/store/migrations/*.sql (0001_init, 0002_project_members)
--
-- This file mirrors those migrations with IF NOT EXISTS guards so the dashboard
-- can be developed and seeded against an empty Postgres without running ingest.
-- If it ever disagrees with the ingest migrations, the migrations win.
-- ============================================================================

CREATE TABLE IF NOT EXISTS projects (
    id         uuid        PRIMARY KEY DEFAULT gen_random_uuid(),
    slug       text        NOT NULL UNIQUE,
    name       text        NOT NULL,
    is_public  boolean     NOT NULL DEFAULT false,
    created_at timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE IF NOT EXISTS api_keys (
    id         uuid        PRIMARY KEY DEFAULT gen_random_uuid(),
    project_id uuid        NOT NULL REFERENCES projects (id) ON DELETE CASCADE,
    prefix     text        NOT NULL,
    key_hash   bytea       NOT NULL UNIQUE,
    created_at timestamptz NOT NULL DEFAULT now(),
    revoked_at timestamptz
);

CREATE TABLE IF NOT EXISTS spans (
    project_id     uuid        NOT NULL REFERENCES projects (id) ON DELETE CASCADE,
    trace_id       text        NOT NULL,
    span_id        text        NOT NULL,
    parent_span_id text,
    name           text        NOT NULL,
    kind           text        NOT NULL CHECK (kind IN ('agent', 'llm', 'tool', 'custom')),
    start_time     timestamptz NOT NULL,
    end_time       timestamptz NOT NULL,
    status         text        NOT NULL CHECK (status IN ('ok', 'error')),
    error          jsonb,
    attributes     jsonb       NOT NULL DEFAULT '{}',
    input          jsonb,
    output         jsonb,
    model          text,
    input_tokens   bigint,
    output_tokens  bigint,
    cost_usd       numeric(12, 6),
    duration_ms    double precision GENERATED ALWAYS AS (EXTRACT(EPOCH FROM (end_time - start_time)) * 1000) STORED,
    received_at    timestamptz NOT NULL DEFAULT now(),
    PRIMARY KEY (project_id, trace_id, span_id)
);

CREATE TABLE IF NOT EXISTS runs (
    project_id          uuid        NOT NULL REFERENCES projects (id) ON DELETE CASCADE,
    trace_id            text        NOT NULL,
    name                text        NOT NULL,
    status              text        NOT NULL CHECK (status IN ('ok', 'error')),
    start_time          timestamptz NOT NULL,
    end_time            timestamptz NOT NULL,
    duration_ms         double precision NOT NULL,
    span_count          integer     NOT NULL,
    llm_call_count      integer     NOT NULL,
    tool_call_count     integer     NOT NULL,
    total_input_tokens  bigint      NOT NULL,
    total_output_tokens bigint      NOT NULL,
    total_cost_usd      numeric(12, 6),
    tags                text[]      NOT NULL DEFAULT '{}',
    models              text[]      NOT NULL DEFAULT '{}',
    updated_at          timestamptz NOT NULL DEFAULT now(),
    PRIMARY KEY (project_id, trace_id)
);

CREATE INDEX IF NOT EXISTS runs_project_start_idx ON runs (project_id, start_time DESC);

-- Mirrors 0002_project_members.sql: GitHub logins (lowercase) allowed to view a private project.
CREATE TABLE IF NOT EXISTS project_members (
    project_id   uuid        NOT NULL REFERENCES projects (id) ON DELETE CASCADE,
    github_login text        NOT NULL CHECK (github_login = lower(github_login)),
    created_at   timestamptz NOT NULL DEFAULT now(),
    PRIMARY KEY (project_id, github_login)
);

CREATE INDEX IF NOT EXISTS project_members_login_idx ON project_members (github_login);
