package store

import (
	"context"
	"errors"
	"fmt"

	"github.com/jackc/pgx/v5"
	"github.com/jackc/pgx/v5/pgconn"

	"github.com/MaddoxNehls/tracewright/ingest/internal/apikey"
)

var (
	ErrNotFound = errors.New("not found")
	ErrConflict = errors.New("already exists")
)

// Project is a row of the projects table.
type Project struct {
	ID       string
	Slug     string
	Name     string
	IsPublic bool
}

// CreateProject inserts a project. It returns ErrConflict if the slug is taken.
func (s *Store) CreateProject(ctx context.Context, slug, name string, public bool) (Project, error) {
	p := Project{Slug: slug, Name: name, IsPublic: public}
	err := s.pool.QueryRow(ctx,
		`INSERT INTO projects (slug, name, is_public) VALUES ($1, $2, $3) RETURNING id`,
		slug, name, public).Scan(&p.ID)
	if err != nil {
		var pgErr *pgconn.PgError
		if errors.As(err, &pgErr) && pgErr.Code == "23505" {
			return Project{}, fmt.Errorf("project %q: %w", slug, ErrConflict)
		}
		return Project{}, fmt.Errorf("insert project: %w", err)
	}
	return p, nil
}

// CreateAPIKey issues a new key for the project with the given slug. The
// plaintext key is returned exactly once; only its hash is persisted.
func (s *Store) CreateAPIKey(ctx context.Context, projectSlug string) (key string, err error) {
	var projectID string
	err = s.pool.QueryRow(ctx, `SELECT id FROM projects WHERE slug = $1`, projectSlug).Scan(&projectID)
	if errors.Is(err, pgx.ErrNoRows) {
		return "", fmt.Errorf("project %q: %w", projectSlug, ErrNotFound)
	}
	if err != nil {
		return "", fmt.Errorf("look up project: %w", err)
	}

	key = apikey.Generate()
	hash := apikey.Hash(key)
	if _, err := s.pool.Exec(ctx,
		`INSERT INTO api_keys (project_id, prefix, key_hash) VALUES ($1, $2, $3)`,
		projectID, apikey.DisplayPrefix(key), hash[:]); err != nil {
		return "", fmt.Errorf("insert api key: %w", err)
	}
	return key, nil
}

// RevokeAPIKey revokes the active key in the project whose display prefix
// matches. Prefixes carry only 32 bits, so an ambiguous match is refused
// rather than revoking more than the caller meant to.
func (s *Store) RevokeAPIKey(ctx context.Context, projectSlug, prefix string) error {
	return pgx.BeginFunc(ctx, s.pool, func(tx pgx.Tx) error {
		rows, err := tx.Query(ctx,
			`SELECT k.id FROM api_keys k JOIN projects p ON p.id = k.project_id
			 WHERE p.slug = $1 AND k.prefix = $2 AND k.revoked_at IS NULL
			 FOR UPDATE OF k`,
			projectSlug, prefix)
		if err != nil {
			return fmt.Errorf("look up api key: %w", err)
		}
		ids, err := pgx.CollectRows(rows, pgx.RowTo[string])
		if err != nil {
			return fmt.Errorf("look up api key: %w", err)
		}
		switch len(ids) {
		case 0:
			return fmt.Errorf("active key %q in project %q: %w", prefix, projectSlug, ErrNotFound)
		case 1:
		default:
			return fmt.Errorf("prefix %q matches %d active keys; refusing to revoke", prefix, len(ids))
		}
		if _, err := tx.Exec(ctx, `UPDATE api_keys SET revoked_at = now() WHERE id = $1`, ids[0]); err != nil {
			return fmt.Errorf("revoke api key: %w", err)
		}
		return nil
	})
}

// ProjectIDForKeyHash resolves a key hash to its project. ok is false when no
// active (non-revoked) key matches.
func (s *Store) ProjectIDForKeyHash(ctx context.Context, hash [32]byte) (projectID string, ok bool, err error) {
	err = s.pool.QueryRow(ctx,
		`SELECT project_id FROM api_keys WHERE key_hash = $1 AND revoked_at IS NULL`,
		hash[:]).Scan(&projectID)
	if errors.Is(err, pgx.ErrNoRows) {
		return "", false, nil
	}
	if err != nil {
		return "", false, fmt.Errorf("look up api key: %w", err)
	}
	return projectID, true, nil
}
