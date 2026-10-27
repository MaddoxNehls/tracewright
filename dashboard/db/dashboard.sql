-- Dashboard-owned tables. To be moved into the ingest migrations
-- (ingest/internal/store/migrations), which are the canonical schema.

-- Who may view a private project. A project is visible to a signed-in GitHub
-- user when projects.is_public is true OR a row here matches their login.
-- github_login is stored lowercase; GitHub logins are case-insensitive.
CREATE TABLE IF NOT EXISTS project_members (
    project_id   uuid        NOT NULL REFERENCES projects (id) ON DELETE CASCADE,
    github_login text        NOT NULL CHECK (github_login = lower(github_login)),
    created_at   timestamptz NOT NULL DEFAULT now(),
    PRIMARY KEY (project_id, github_login)
);

-- "Which projects can this login see?" scans by login, not by project.
CREATE INDEX IF NOT EXISTS project_members_login_idx ON project_members (github_login);
