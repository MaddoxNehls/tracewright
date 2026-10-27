package main

import (
	"context"
	"errors"
	"flag"
	"fmt"
	"io"
	"os"
	"regexp"

	"github.com/MaddoxNehls/tracewright/ingest/internal/store"
)

var slugPattern = regexp.MustCompile(`^[a-z0-9][a-z0-9-]{0,62}$`)

func runAdmin(ctx context.Context, args []string) error {
	if len(args) == 0 {
		return errors.New(usage)
	}
	cmd, args := args[0], args[1:]

	fs := flag.NewFlagSet("admin "+cmd, flag.ContinueOnError)
	fs.SetOutput(io.Discard) // errors are returned and printed once by main
	var slug, name, project, prefix string
	var public bool
	switch cmd {
	case "create-project":
		fs.StringVar(&slug, "slug", "", "URL-safe project identifier")
		fs.StringVar(&name, "name", "", "display name")
		fs.BoolVar(&public, "public", false, "make the project readable without signing in")
	case "create-key":
		fs.StringVar(&project, "project", "", "slug of the project the key belongs to")
	case "revoke-key":
		fs.StringVar(&project, "project", "", "slug of the project the key belongs to")
		fs.StringVar(&prefix, "prefix", "", "display prefix of the key, e.g. tw_1a2b3c4d")
	default:
		return fmt.Errorf("unknown admin command %q\n\n%s", cmd, usage)
	}
	if err := fs.Parse(args); err != nil {
		return fmt.Errorf("%w\n\n%s", err, usage)
	}

	databaseURL := os.Getenv("DATABASE_URL")
	if databaseURL == "" {
		return errors.New("DATABASE_URL is required")
	}
	st, err := store.Open(ctx, databaseURL, 1)
	if err != nil {
		return err
	}
	defer st.Close()
	// Migrating first lets the admin commands bootstrap a brand-new database.
	if _, err := st.Migrate(ctx); err != nil {
		return err
	}

	switch cmd {
	case "create-project":
		if !slugPattern.MatchString(slug) {
			return errors.New("--slug must be lowercase letters, digits, and dashes (max 63)")
		}
		if name == "" {
			return errors.New("--name is required")
		}
		p, err := st.CreateProject(ctx, slug, name, public)
		if err != nil {
			return err
		}
		fmt.Printf("created project %q (id %s, public=%t)\n", p.Slug, p.ID, p.IsPublic)

	case "create-key":
		if project == "" {
			return errors.New("--project is required")
		}
		key, err := st.CreateAPIKey(ctx, project)
		if err != nil {
			return err
		}
		// The key alone goes to stdout so scripts can capture it: KEY=$(... create-key ...).
		fmt.Fprintln(os.Stderr, "API key created. Store it now: it cannot be shown again.")
		fmt.Println(key)

	case "revoke-key":
		if project == "" || prefix == "" {
			return errors.New("--project and --prefix are required")
		}
		if err := st.RevokeAPIKey(ctx, project, prefix); err != nil {
			return err
		}
		// Running ingest instances cache auth results, so say how long the key stays usable.
		fmt.Println("key revoked; running ingest instances stop accepting it within the auth cache TTL (60s)")
	}
	return nil
}
