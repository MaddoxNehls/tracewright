// Package pgtest provides a disposable, migrated Postgres for integration
// tests. One container is shared per test binary; tests isolate their data by
// creating their own project.
package pgtest

import (
	"context"
	"crypto/rand"
	"encoding/hex"
	"fmt"
	"sync"
	"testing"

	"github.com/jackc/pgx/v5/pgxpool"
	"github.com/testcontainers/testcontainers-go"
	"github.com/testcontainers/testcontainers-go/modules/postgres"

	"github.com/MaddoxNehls/tracewright/ingest/internal/store"
)

var (
	once      sync.Once
	container *postgres.PostgresContainer
	dsn       string
	startErr  error
)

func start() {
	ctx := context.Background()
	container, startErr = postgres.Run(ctx, "postgres:17-alpine",
		postgres.WithDatabase("tracewright"),
		postgres.WithUsername("tracewright"),
		postgres.WithPassword("tracewright"),
		postgres.BasicWaitStrategies(),
	)
	if startErr != nil {
		return
	}
	if dsn, startErr = container.ConnectionString(ctx, "sslmode=disable"); startErr != nil {
		return
	}
	st, err := store.Open(ctx, dsn, 1)
	if err != nil {
		startErr = err
		return
	}
	defer st.Close()
	_, startErr = st.Migrate(ctx)
}

// Store returns a store connected to the shared container. The test is
// skipped when no Docker provider is available.
func Store(t *testing.T) *store.Store {
	t.Helper()
	testcontainers.SkipIfProviderIsNotHealthy(t)
	once.Do(start)
	if startErr != nil {
		t.Fatalf("start postgres container: %v", startErr)
	}
	pool, err := pgxpool.New(t.Context(), dsn)
	if err != nil {
		t.Fatal(err)
	}
	t.Cleanup(pool.Close)
	return store.New(pool)
}

// Project creates a uniquely named project and returns its ID.
func Project(t *testing.T, st *store.Store) string {
	t.Helper()
	b := make([]byte, 6)
	rand.Read(b)
	p, err := st.CreateProject(t.Context(), "test-"+hex.EncodeToString(b), t.Name(), false)
	if err != nil {
		t.Fatal(err)
	}
	return p.ID
}

// Terminate stops the shared container; call it from TestMain after m.Run.
func Terminate() {
	if container != nil {
		if err := container.Terminate(context.Background()); err != nil {
			fmt.Println("pgtest: terminate container:", err)
		}
	}
}
