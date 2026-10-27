-- Dashboard access control: GitHub logins allowed to view a private project.
-- IF NOT EXISTS: dev databases seeded by the dashboard before this migration already have the table.
-- Logins are stored lowercase; the dashboard lowercases before matching.
CREATE TABLE IF NOT EXISTS project_members (
    project_id   uuid        NOT NULL REFERENCES projects (id) ON DELETE CASCADE,
    github_login text        NOT NULL CHECK (github_login = lower(github_login)),
    created_at   timestamptz NOT NULL DEFAULT now(),
    PRIMARY KEY (project_id, github_login)
);

CREATE INDEX IF NOT EXISTS project_members_login_idx ON project_members (github_login);
