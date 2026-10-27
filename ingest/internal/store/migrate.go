package store

import (
	"context"
	"embed"
	"fmt"
	"io/fs"
	"path"
	"slices"
	"strconv"
	"strings"

	"github.com/jackc/pgx/v5"
)

//go:embed migrations/*.sql
var migrationFS embed.FS

// migrationLockKey is an arbitrary constant; it keeps concurrently starting
// instances from applying the same migration twice.
const migrationLockKey = 0x7472616365 // "trace"

type migration struct {
	version int
	name    string
	sql     string
}

// Migrate applies every embedded migration that has not run yet. All pending
// migrations run in one transaction, so a failure leaves the schema untouched.
func (s *Store) Migrate(ctx context.Context) (applied []string, err error) {
	migrations, err := loadMigrations()
	if err != nil {
		return nil, err
	}

	err = pgx.BeginFunc(ctx, s.pool, func(tx pgx.Tx) error {
		if _, err := tx.Exec(ctx, `SELECT pg_advisory_xact_lock($1)`, migrationLockKey); err != nil {
			return fmt.Errorf("acquire migration lock: %w", err)
		}
		if _, err := tx.Exec(ctx, `
			CREATE TABLE IF NOT EXISTS schema_migrations (
				version    integer     PRIMARY KEY,
				name       text        NOT NULL,
				applied_at timestamptz NOT NULL DEFAULT now()
			)`); err != nil {
			return fmt.Errorf("create schema_migrations: %w", err)
		}

		rows, _ := tx.Query(ctx, `SELECT version FROM schema_migrations`)
		done, err := pgx.CollectRows(rows, pgx.RowTo[int])
		if err != nil {
			return fmt.Errorf("read schema_migrations: %w", err)
		}

		for _, m := range migrations {
			if slices.Contains(done, m.version) {
				continue
			}
			if _, err := tx.Exec(ctx, m.sql); err != nil {
				return fmt.Errorf("apply migration %s: %w", m.name, err)
			}
			if _, err := tx.Exec(ctx,
				`INSERT INTO schema_migrations (version, name) VALUES ($1, $2)`, m.version, m.name); err != nil {
				return fmt.Errorf("record migration %s: %w", m.name, err)
			}
			applied = append(applied, m.name)
		}
		return nil
	})
	if err != nil {
		return nil, err
	}
	return applied, nil
}

// loadMigrations reads migrations/NNNN_description.sql files sorted by version.
func loadMigrations() ([]migration, error) {
	entries, err := fs.ReadDir(migrationFS, "migrations")
	if err != nil {
		return nil, fmt.Errorf("read embedded migrations: %w", err)
	}

	var out []migration
	for _, e := range entries {
		prefix, _, ok := strings.Cut(e.Name(), "_")
		if !ok {
			return nil, fmt.Errorf("migration %q: name must look like 0001_description.sql", e.Name())
		}
		version, err := strconv.Atoi(prefix)
		if err != nil {
			return nil, fmt.Errorf("migration %q: bad version prefix: %w", e.Name(), err)
		}
		body, err := fs.ReadFile(migrationFS, path.Join("migrations", e.Name()))
		if err != nil {
			return nil, err
		}
		out = append(out, migration{version: version, name: e.Name(), sql: string(body)})
	}

	slices.SortFunc(out, func(a, b migration) int { return a.version - b.version })
	for i := 1; i < len(out); i++ {
		if out[i].version == out[i-1].version {
			return nil, fmt.Errorf("duplicate migration version %d", out[i].version)
		}
	}
	return out, nil
}
