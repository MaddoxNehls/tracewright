package config

import (
	"strings"
	"testing"
	"time"
)

func env(m map[string]string) func(string) string {
	return func(k string) string { return m[k] }
}

func TestLoadDefaults(t *testing.T) {
	c, err := Load(env(map[string]string{"DATABASE_URL": "postgres://x"}))
	if err != nil {
		t.Fatal(err)
	}
	want := Config{
		DatabaseURL:   "postgres://x",
		Port:          4318,
		QueueCapacity: 50_000,
		QueueMaxBytes: 256 << 20,
		Writers:       4,
		BatchMaxSpans: 1_000,
		BatchMaxWait:  200 * time.Millisecond,
	}
	if c != want {
		t.Errorf("got %+v, want %+v", c, want)
	}
}

func TestLoadOverrides(t *testing.T) {
	c, err := Load(env(map[string]string{
		"DATABASE_URL":    "postgres://x",
		"PORT":            "9000",
		"QUEUE_CAPACITY":  "5000",
		"QUEUE_MAX_BYTES": "10485760",
		"WRITERS":         "8",
		"BATCH_MAX_SPANS": "500",
		"BATCH_MAX_WAIT":  "1s",
	}))
	if err != nil {
		t.Fatal(err)
	}
	if c.Port != 9000 || c.QueueCapacity != 5000 || c.QueueMaxBytes != 10<<20 || c.Writers != 8 || c.BatchMaxSpans != 500 || c.BatchMaxWait != time.Second {
		t.Errorf("overrides not applied: %+v", c)
	}
}

func TestLoadReportsAllErrors(t *testing.T) {
	_, err := Load(env(map[string]string{
		"PORT":            "99999",
		"QUEUE_CAPACITY":  "10", // smaller than one full request
		"QUEUE_MAX_BYTES": "1024",
		"WRITERS":         "zero",
		"BATCH_MAX_WAIT":  "-1s",
	}))
	if err == nil {
		t.Fatal("expected error")
	}
	for _, name := range []string{"DATABASE_URL", "PORT", "QUEUE_CAPACITY", "QUEUE_MAX_BYTES", "WRITERS", "BATCH_MAX_WAIT"} {
		if !strings.Contains(err.Error(), name) {
			t.Errorf("error does not mention %s: %v", name, err)
		}
	}
}
