// Package config loads service settings from environment variables.
package config

import (
	"errors"
	"fmt"
	"strconv"
	"time"
)

// Contract limits for a single POST /v1/spans request. The queue must be able
// to hold at least one maximal request or such requests could never fit.
const (
	MaxSpansPerRequest = 1000
	MaxBodyBytes       = 5 << 20
)

// Config holds the ingest service settings.
type Config struct {
	DatabaseURL   string
	Port          int
	QueueCapacity int           // max spans buffered between handlers and writers
	QueueMaxBytes int           // max payload bytes buffered; spans alone don't bound memory
	Writers       int           // concurrent batch writer goroutines
	BatchMaxSpans int           // flush once a batch holds this many spans...
	BatchMaxWait  time.Duration // ...or once its oldest span has waited this long
}

// Load reads configuration using getenv (os.Getenv in production) and
// reports every invalid variable at once.
func Load(getenv func(string) string) (Config, error) {
	c := Config{DatabaseURL: getenv("DATABASE_URL")}
	var errs []error
	if c.DatabaseURL == "" {
		errs = append(errs, errors.New("DATABASE_URL is required"))
	}

	intVar := func(name string, def, lo int) int {
		raw := getenv(name)
		if raw == "" {
			return def
		}
		v, err := strconv.Atoi(raw)
		if err != nil || v < lo {
			errs = append(errs, fmt.Errorf("%s must be an integer >= %d, got %q", name, lo, raw))
			return def
		}
		return v
	}
	c.Port = intVar("PORT", 4318, 1)
	c.QueueCapacity = intVar("QUEUE_CAPACITY", 50_000, MaxSpansPerRequest)
	c.QueueMaxBytes = intVar("QUEUE_MAX_BYTES", 256<<20, MaxBodyBytes)
	c.Writers = intVar("WRITERS", 4, 1)
	c.BatchMaxSpans = intVar("BATCH_MAX_SPANS", 1_000, 1)

	c.BatchMaxWait = 200 * time.Millisecond
	if raw := getenv("BATCH_MAX_WAIT"); raw != "" {
		d, err := time.ParseDuration(raw)
		if err != nil || d <= 0 {
			errs = append(errs, fmt.Errorf("BATCH_MAX_WAIT must be a positive duration like 200ms, got %q", raw))
		} else {
			c.BatchMaxWait = d
		}
	}

	if c.Port > 65535 {
		errs = append(errs, fmt.Errorf("PORT must be <= 65535, got %d", c.Port))
	}
	return c, errors.Join(errs...)
}
