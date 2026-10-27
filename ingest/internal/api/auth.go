package api

import (
	"context"
	"errors"
	"strings"
	"sync"
	"time"

	"github.com/MaddoxNehls/tracewright/ingest/internal/apikey"
)

// KeyResolver maps an API key hash to its project; *store.Store implements it.
type KeyResolver interface {
	ProjectIDForKeyHash(ctx context.Context, hash [32]byte) (projectID string, ok bool, err error)
}

var errUnauthorized = errors.New("missing or invalid API key")

// AuthConfig tunes the key cache. Revoking a key takes effect within TTL.
type AuthConfig struct {
	TTL         time.Duration // how long a valid key is trusted without a DB check
	NegativeTTL time.Duration // how long an unknown key is remembered; short so new keys work quickly
	MaxEntries  int           // bounds memory if a client sprays random keys
}

// Authenticator resolves bearer tokens to project IDs, caching results so the
// hot path doesn't hit Postgres on every request.
type Authenticator struct {
	resolver KeyResolver
	cfg      AuthConfig
	now      func() time.Time

	mu    sync.Mutex
	cache map[[32]byte]cacheEntry
}

type cacheEntry struct {
	projectID string // empty for a cached "no such key"
	expires   time.Time
}

// NewAuthenticator returns an Authenticator; zero config fields get defaults.
func NewAuthenticator(resolver KeyResolver, cfg AuthConfig) *Authenticator {
	if cfg.TTL <= 0 {
		cfg.TTL = time.Minute
	}
	if cfg.NegativeTTL <= 0 {
		cfg.NegativeTTL = 5 * time.Second
	}
	if cfg.MaxEntries <= 0 {
		cfg.MaxEntries = 10_000
	}
	return &Authenticator{resolver: resolver, cfg: cfg, now: time.Now, cache: map[[32]byte]cacheEntry{}}
}

// Authenticate returns the project for an Authorization header value. It
// returns errUnauthorized for bad keys and other errors for lookup failures.
func (a *Authenticator) Authenticate(ctx context.Context, header string) (string, error) {
	scheme, key, ok := strings.Cut(header, " ")
	if !ok || !strings.EqualFold(scheme, "Bearer") || !apikey.Valid(key) {
		return "", errUnauthorized
	}
	hash := apikey.Hash(key)

	if projectID, hit := a.lookup(hash); hit {
		if projectID == "" {
			return "", errUnauthorized
		}
		return projectID, nil
	}

	projectID, found, err := a.resolver.ProjectIDForKeyHash(ctx, hash)
	if err != nil {
		return "", err // not cached: a DB blip must not lock out valid keys
	}
	a.store(hash, projectID, found)
	if !found {
		return "", errUnauthorized
	}
	return projectID, nil
}

func (a *Authenticator) lookup(hash [32]byte) (projectID string, hit bool) {
	a.mu.Lock()
	defer a.mu.Unlock()
	e, ok := a.cache[hash]
	if !ok || a.now().After(e.expires) {
		return "", false
	}
	return e.projectID, true
}

func (a *Authenticator) store(hash [32]byte, projectID string, found bool) {
	ttl := a.cfg.TTL
	if !found {
		ttl = a.cfg.NegativeTTL
	}
	now := a.now()

	a.mu.Lock()
	defer a.mu.Unlock()
	if len(a.cache) >= a.cfg.MaxEntries {
		for h, e := range a.cache {
			if now.After(e.expires) {
				delete(a.cache, h)
			}
		}
		if len(a.cache) >= a.cfg.MaxEntries {
			clear(a.cache) // still full of live entries: start over rather than grow
		}
	}
	a.cache[hash] = cacheEntry{projectID: projectID, expires: now.Add(ttl)}
}

type projectKey struct{}

// projectID returns the project that requireAuth attached to the context.
func projectID(ctx context.Context) string {
	id, _ := ctx.Value(projectKey{}).(string)
	return id
}
