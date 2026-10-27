CREATE TABLE projects (
    id         uuid        PRIMARY KEY DEFAULT gen_random_uuid(),
    slug       text        NOT NULL UNIQUE,
    name       text        NOT NULL,
    is_public  boolean     NOT NULL DEFAULT false,
    created_at timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE api_keys (
    id         uuid        PRIMARY KEY DEFAULT gen_random_uuid(),
    project_id uuid        NOT NULL REFERENCES projects (id) ON DELETE CASCADE,
    prefix     text        NOT NULL,
    key_hash   bytea       NOT NULL UNIQUE,
    created_at timestamptz NOT NULL DEFAULT now(),
    revoked_at timestamptz
);

CREATE TABLE spans (
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
    -- The primary key's (project_id, trace_id) prefix doubles as the
    -- per-trace lookup index the contract asks for; a second index would be redundant.
    PRIMARY KEY (project_id, trace_id, span_id)
);

CREATE TABLE runs (
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

CREATE INDEX runs_project_start_idx ON runs (project_id, start_time DESC);
