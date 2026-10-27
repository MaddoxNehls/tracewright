// Package e2e exercises the whole ingest path: HTTP -> validation -> queue ->
// batch writers -> Postgres, against a real database.
package e2e

import (
	"bytes"
	"encoding/json"
	"fmt"
	"log/slog"
	"net/http"
	"net/http/httptest"
	"os"
	"testing"
	"time"

	"github.com/prometheus/client_golang/prometheus"

	"github.com/MaddoxNehls/tracewright/ingest/internal/api"
	"github.com/MaddoxNehls/tracewright/ingest/internal/metrics"
	"github.com/MaddoxNehls/tracewright/ingest/internal/pgtest"
	"github.com/MaddoxNehls/tracewright/ingest/internal/pipeline"
	"github.com/MaddoxNehls/tracewright/ingest/internal/pricing"
	"github.com/MaddoxNehls/tracewright/ingest/internal/store"
)

func TestMain(m *testing.M) {
	code := m.Run()
	pgtest.Terminate()
	os.Exit(code)
}

type stack struct {
	srv     *httptest.Server
	st      *store.Store
	writers *pipeline.Writers
	key     string
	project string
}

func newStack(t *testing.T) *stack {
	t.Helper()
	st := pgtest.Store(t)
	project := pgtest.Project(t, st)
	var slug string
	if err := st.Pool().QueryRow(t.Context(), `SELECT slug FROM projects WHERE id = $1`, project).Scan(&slug); err != nil {
		t.Fatal(err)
	}
	key, err := st.CreateAPIKey(t.Context(), slug)
	if err != nil {
		t.Fatal(err)
	}
	prices, err := pricing.Default()
	if err != nil {
		t.Fatal(err)
	}

	reg := prometheus.NewRegistry()
	m := metrics.New(reg)
	log := slog.New(slog.DiscardHandler)
	q := pipeline.NewQueue(10_000, 64<<20)
	writers := pipeline.StartWriters(q, st, pipeline.WriterConfig{
		Writers: 2, MaxSpans: 500, MaxWait: 10 * time.Millisecond,
	}, log, m)
	h := &api.Handler{
		Auth: api.NewAuthenticator(st, api.AuthConfig{}), Queue: q, Runs: st, Prices: prices,
		Metrics: m, Gatherer: reg, Log: log,
	}
	srv := httptest.NewServer(h.Routes())
	t.Cleanup(srv.Close)
	return &stack{srv: srv, st: st, writers: writers, key: key, project: project}
}

// drain flushes everything accepted so far, as graceful shutdown would.
func (s *stack) drain(t *testing.T) {
	t.Helper()
	if err := s.writers.Shutdown(t.Context()); err != nil {
		t.Fatal(err)
	}
}

func (s *stack) post(t *testing.T, spans ...map[string]any) {
	t.Helper()
	body, _ := json.Marshal(map[string]any{"spans": spans})
	req, _ := http.NewRequestWithContext(t.Context(), http.MethodPost, s.srv.URL+"/v1/spans", bytes.NewReader(body))
	req.Header.Set("Authorization", "Bearer "+s.key)
	req.Header.Set("Content-Type", "application/json")
	resp, err := http.DefaultClient.Do(req)
	if err != nil {
		t.Fatal(err)
	}
	defer resp.Body.Close()
	if resp.StatusCode != http.StatusAccepted {
		var b bytes.Buffer
		b.ReadFrom(resp.Body)
		t.Fatalf("POST /v1/spans: %d %s", resp.StatusCode, b.String())
	}
}

const trace = "0af7651916cd43dd8448eb211c80319c"

func wireSpan(spanID, parent, name, kind string, startMs int, attrs map[string]any) map[string]any {
	start := time.Date(2026, 10, 27, 9, 0, 0, 0, time.UTC).Add(time.Duration(startMs) * time.Millisecond)
	s := map[string]any{
		"trace_id": trace, "span_id": spanID, "name": name, "kind": kind,
		"start_time": start.Format(time.RFC3339Nano),
		"end_time":   start.Add(500 * time.Millisecond).Format(time.RFC3339Nano),
		"status":     "ok", "attributes": attrs, "input": map[string]any{"prompt": "hi"}, "output": "done",
	}
	if parent != "" {
		s["parent_span_id"] = parent
	}
	return s
}

func TestIngestEndToEnd(t *testing.T) {
	s := newStack(t)
	const root = "1000000000000001"

	priced := wireSpan("2000000000000002", root, "plan", "llm", 10, map[string]any{
		"gen_ai.provider.name": "anthropic", "gen_ai.request.model": "claude-opus-5-5",
		"gen_ai.usage.input_tokens": 12_000, "gen_ai.usage.output_tokens": 800,
	})
	explicit := wireSpan("3000000000000003", root, "summarize", "llm", 20, map[string]any{
		"gen_ai.request.model": "claude-opus-5-5", "gen_ai.usage.input_tokens": 10,
		"gen_ai.usage.output_tokens": 10, "tracewright.cost_usd": 0.25,
	})
	unknown := wireSpan("4000000000000004", root, "other", "llm", 30, map[string]any{
		"gen_ai.provider.name": "openrouter", "gen_ai.request.model": "some/other-model",
		"gen_ai.usage.input_tokens": 100, "gen_ai.usage.output_tokens": 100,
	})
	rootSpan := wireSpan(root, "", "research-agent", "agent", 0, map[string]any{"tracewright.tags": []string{"demo"}})

	// Children first, root in a later request: the out-of-order case.
	s.post(t, priced, explicit, unknown)
	s.post(t, rootSpan)
	// Re-sending an already accepted request must be a no-op.
	s.post(t, priced, explicit, unknown)
	s.drain(t)

	costs := map[string]*float64{}
	rows, err := s.st.Pool().Query(t.Context(),
		`SELECT span_id, cost_usd::float8 FROM spans WHERE project_id = $1`, s.project)
	if err != nil {
		t.Fatal(err)
	}
	for rows.Next() {
		var id string
		var cost *float64
		if err := rows.Scan(&id, &cost); err != nil {
			t.Fatal(err)
		}
		costs[id] = cost
	}
	if err := rows.Err(); err != nil {
		t.Fatal(err)
	}
	if len(costs) != 4 {
		t.Fatalf("stored %d spans, want 4 (re-send must be idempotent)", len(costs))
	}

	// claude-opus-5-5: $4/M input, $20/M output.
	wantPriced := 12_000*4.0/1e6 + 800*20.0/1e6 // 0.064
	checkCost(t, "computed from pricing.json", costs["2000000000000002"], &wantPriced)
	checkCost(t, "explicit tracewright.cost_usd", costs["3000000000000003"], ptr(0.25))
	checkCost(t, "unknown model", costs["4000000000000004"], nil)
	checkCost(t, "root without usage", costs[root], nil)

	var name, status string
	var spanCount int
	var total float64
	var tags []string
	if err := s.st.Pool().QueryRow(t.Context(), `
		SELECT name, status, span_count, total_cost_usd::float8, tags
		FROM runs WHERE project_id = $1 AND trace_id = $2`, s.project, trace).
		Scan(&name, &status, &spanCount, &total, &tags); err != nil {
		t.Fatal(err)
	}
	if name != "research-agent" || status != "ok" || spanCount != 4 || fmt.Sprint(tags) != "[demo]" {
		t.Errorf("run = %q %q spans=%d tags=%v", name, status, spanCount, tags)
	}
	if want := wantPriced + 0.25; !near(total, want) {
		t.Errorf("total_cost_usd = %v, want %v", total, want)
	}
}

func checkCost(t *testing.T, label string, got, want *float64) {
	t.Helper()
	switch {
	case want == nil && got != nil:
		t.Errorf("%s: cost = %v, want null", label, *got)
	case want != nil && (got == nil || !near(*got, *want)):
		t.Errorf("%s: cost = %v, want %v", label, got, *want)
	}
}

func near(a, b float64) bool { return a-b < 1e-9 && b-a < 1e-9 }

func ptr[T any](v T) *T { return &v }

// get fetches path with the given key and decodes a JSON body into out (if non-nil).
func (s *stack) get(t *testing.T, path, key string, out any) int {
	t.Helper()
	req, _ := http.NewRequestWithContext(t.Context(), http.MethodGet, s.srv.URL+path, nil)
	req.Header.Set("Authorization", "Bearer "+key)
	resp, err := http.DefaultClient.Do(req)
	if err != nil {
		t.Fatal(err)
	}
	defer resp.Body.Close()
	if out != nil && resp.StatusCode == http.StatusOK {
		if err := json.NewDecoder(resp.Body).Decode(out); err != nil {
			t.Fatal(err)
		}
	}
	return resp.StatusCode
}

func TestReadRunEndToEnd(t *testing.T) {
	s := newStack(t)
	const root = "1000000000000001"
	child := wireSpan("2000000000000002", root, "plan", "llm", 10, map[string]any{
		"gen_ai.provider.name": "anthropic", "gen_ai.request.model": "claude-opus-5-5",
		"gen_ai.usage.input_tokens": 1000, "gen_ai.usage.output_tokens": 100,
	})
	s.post(t, child, wireSpan(root, "", "research-agent", "agent", 0, map[string]any{}))
	s.drain(t)

	var body struct {
		Run struct {
			TraceID   string   `json:"trace_id"`
			SpanCount int      `json:"span_count"`
			CostUSD   *float64 `json:"total_cost_usd"`
		} `json:"run"`
		Spans []map[string]any `json:"spans"`
	}
	if code := s.get(t, "/v1/runs/"+trace, s.key, &body); code != http.StatusOK {
		t.Fatalf("GET own run: status %d", code)
	}
	if body.Run.TraceID != trace || body.Run.SpanCount != 2 || body.Run.CostUSD == nil {
		t.Errorf("run = %+v", body.Run)
	}
	if len(body.Spans) != 2 || body.Spans[0]["span_id"] != root || body.Spans[1]["name"] != "plan" {
		t.Fatalf("spans = %v", body.Spans)
	}
	// What comes back is what was sent: the read API returns the write API's shape.
	if body.Spans[1]["output"] != "done" || body.Spans[1]["start_time"] != child["start_time"] {
		t.Errorf("span round trip changed fields: %v", body.Spans[1])
	}

	// A valid key for a different project must not be able to tell the run exists.
	otherSlug := "other-" + s.project[:8]
	if _, err := s.st.CreateProject(t.Context(), otherSlug, "Other", false); err != nil {
		t.Fatal(err)
	}
	otherKey, err := s.st.CreateAPIKey(t.Context(), otherSlug)
	if err != nil {
		t.Fatal(err)
	}
	if code := s.get(t, "/v1/runs/"+trace, otherKey, nil); code != http.StatusNotFound {
		t.Errorf("GET with another project's key: status %d, want 404", code)
	}
}
