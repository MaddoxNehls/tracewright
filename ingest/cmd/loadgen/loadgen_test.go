package main

import (
	"bufio"
	"context"
	"encoding/json"
	"io"
	"log/slog"
	"net/http/httptest"
	"strings"
	"sync/atomic"
	"testing"
	"time"

	"github.com/prometheus/client_golang/prometheus"

	"github.com/MaddoxNehls/tracewright/ingest/internal/api"
	"github.com/MaddoxNehls/tracewright/ingest/internal/apikey"
	"github.com/MaddoxNehls/tracewright/ingest/internal/metrics"
	"github.com/MaddoxNehls/tracewright/ingest/internal/pipeline"
	"github.com/MaddoxNehls/tracewright/ingest/internal/pricing"
	"github.com/MaddoxNehls/tracewright/ingest/internal/store"
)

const testKey = "tw_0123456789abcdef0123456789abcdef"

type oneKey struct{}

func (oneKey) ProjectIDForKeyHash(_ context.Context, hash [32]byte) (string, bool, error) {
	return "00000000-0000-0000-0000-000000000001", hash == apikey.Hash(testKey), nil
}

// countingStore stands in for Postgres.
type countingStore struct{ spans atomic.Int64 }

func (c *countingStore) WriteSpans(_ context.Context, spans []store.Span) (int64, error) {
	c.spans.Add(int64(len(spans)))
	return int64(len(spans)), nil
}

// The generated workload must pass ingest's real validation, and the whole stage loop
// (send, drain, metrics diff) must account for every span.
func TestStageAgainstRealHandler(t *testing.T) {
	reg := prometheus.NewRegistry()
	m := metrics.New(reg)
	q := pipeline.NewQueue(50_000, 256<<20)
	metrics.RegisterQueueDepth(reg, func() float64 { return float64(q.Depth()) })
	db := &countingStore{}
	writers := pipeline.StartWriters(q, db, pipeline.WriterConfig{Writers: 2, MaxSpans: 500, MaxWait: 10 * time.Millisecond},
		slog.New(slog.DiscardHandler), m)
	t.Cleanup(func() { writers.Shutdown(context.Background()) })
	prices, err := pricing.Default()
	if err != nil {
		t.Fatal(err)
	}
	h := &api.Handler{Auth: api.NewAuthenticator(oneKey{}, api.AuthConfig{}), Queue: q, Prices: prices,
		Metrics: m, Gatherer: reg, Log: slog.New(slog.DiscardHandler)}
	srv := httptest.NewServer(h.Routes())
	t.Cleanup(srv.Close)

	cfg, err := parseFlags([]string{"-url", srv.URL, "-key", testKey, "-concurrency", "2", "-duration", "300ms", "-batch", "50"})
	if err != nil {
		t.Fatal(err)
	}
	results, err := run(t.Context(), cfg, io.Discard)
	if err != nil {
		t.Fatal(err)
	}

	r := results[0]
	if r.Requests == 0 || r.Failed != 0 || r.ThrottledPct != 0 {
		t.Fatalf("result = %+v", r)
	}
	if got, want := float64(db.spans.Load()), r.WrittenSpansPS*(r.DurationS+r.DrainS); abs(got-want) > 1 {
		t.Errorf("store got %v spans, written/s accounts for %v", got, want)
	}
	if r.P50Ms <= 0 || r.P99Ms < r.P50Ms || r.MeanFlushSpans <= 0 {
		t.Errorf("latency/flush stats look wrong: %+v", r)
	}
}

func TestWorkloadShape(t *testing.T) {
	w := newWorkload(1, 31, 4096, 8192, "s")
	spans := w.batch(62) // exactly two traces
	traces := map[string]int{}
	kinds := map[string]int{}
	for _, s := range spans {
		traces[s.TraceID]++
		kinds[s.Kind]++
		if s.Attributes["loadgen.stage"] != "s" {
			t.Fatalf("span without stage attribute: %+v", s)
		}
		if s.Kind == "llm" {
			prompt, _ := json.Marshal(s.Input)
			if n := len(prompt); n < 4096 || n > 8192+200 {
				t.Errorf("llm prompt is %d bytes", n)
			}
		}
	}
	if len(traces) != 2 || kinds["agent"] != 2 || kinds["llm"] != 20 || kinds["tool"] != 20 {
		t.Errorf("traces=%v kinds=%v", traces, kinds)
	}
}

func TestParseMetrics(t *testing.T) {
	text := `# HELP x
tracewright_spans_rejected_total{reason="invalid"} 3
tracewright_spans_rejected_total{reason="queue full"} 4
tracewright_queue_depth 7
tracewright_batch_write_duration_seconds_sum 1.5e-01
`
	m, err := parseMetrics(bufio.NewScanner(strings.NewReader(text)))
	if err != nil {
		t.Fatal(err)
	}
	if m["tracewright_spans_rejected_total"] != 7 || m["tracewright_queue_depth"] != 7 ||
		m["tracewright_batch_write_duration_seconds_sum"] != 0.15 {
		t.Errorf("parsed %v", m)
	}
}

func abs(f float64) float64 {
	if f < 0 {
		return -f
	}
	return f
}
