package store_test

import (
	"context"
	"errors"
	"fmt"
	"os"
	"slices"
	"sync"
	"testing"
	"time"

	"github.com/MaddoxNehls/tracewright/ingest/internal/apikey"
	"github.com/MaddoxNehls/tracewright/ingest/internal/pgtest"
	"github.com/MaddoxNehls/tracewright/ingest/internal/store"
)

func TestMain(m *testing.M) {
	code := m.Run()
	pgtest.Terminate()
	os.Exit(code)
}

const traceID = "4bf92f3577b34da6a3ce929d0e0e4736"

var t0 = time.Date(2026, 10, 27, 12, 0, 0, 0, time.UTC)

func ptr[T any](v T) *T { return &v }

// span builds a span starting startMs after t0 and lasting durMs.
func span(projectID, spanID string, parent *string, name, kind string, startMs, durMs int) store.Span {
	start := t0.Add(time.Duration(startMs) * time.Millisecond)
	return store.Span{
		ProjectID:    projectID,
		TraceID:      traceID,
		SpanID:       spanID,
		ParentSpanID: parent,
		Name:         name,
		Kind:         kind,
		StartTime:    start,
		EndTime:      start.Add(time.Duration(durMs) * time.Millisecond),
		Status:       "ok",
		Attributes:   []byte(`{}`),
	}
}

type run struct {
	Name                      string
	Status                    string
	StartTime, EndTime        time.Time
	DurationMs                float64
	SpanCount, LLMs, Tools    int
	InputTokens, OutputTokens int64
	CostUSD                   *float64
	Tags, Models              []string
}

func getRun(t *testing.T, st *store.Store, projectID string) run {
	t.Helper()
	var r run
	err := st.Pool().QueryRow(t.Context(), `
		SELECT name, status, start_time, end_time, duration_ms, span_count, llm_call_count,
		       tool_call_count, total_input_tokens, total_output_tokens, total_cost_usd::float8, tags, models
		FROM runs WHERE project_id = $1 AND trace_id = $2`, projectID, traceID).
		Scan(&r.Name, &r.Status, &r.StartTime, &r.EndTime, &r.DurationMs, &r.SpanCount, &r.LLMs,
			&r.Tools, &r.InputTokens, &r.OutputTokens, &r.CostUSD, &r.Tags, &r.Models)
	if err != nil {
		t.Fatalf("read run: %v", err)
	}
	return r
}

func countSpans(t *testing.T, st *store.Store, projectID string) int {
	t.Helper()
	var n int
	if err := st.Pool().QueryRow(t.Context(),
		`SELECT count(*) FROM spans WHERE project_id = $1`, projectID).Scan(&n); err != nil {
		t.Fatal(err)
	}
	return n
}

func write(t *testing.T, st *store.Store, spans ...store.Span) int64 {
	t.Helper()
	n, err := st.WriteSpans(t.Context(), spans)
	if err != nil {
		t.Fatalf("WriteSpans: %v", err)
	}
	return n
}

func TestWriteSpansAggregatesRun(t *testing.T) {
	st := pgtest.Store(t)
	project := pgtest.Project(t, st)

	root := span(project, "aaaaaaaaaaaaaaaa", nil, "research-agent", "agent", 0, 5000)
	root.Attributes = []byte(`{"tracewright.tags": ["nightly", "v2"]}`)
	root.Input = []byte(`{"question": "why?"}`)

	llm1 := span(project, "bbbbbbbbbbbbbbbb", ptr(root.SpanID), "plan", "llm", 100, 1500)
	llm1.Model, llm1.InputTokens, llm1.OutputTokens, llm1.CostUSD = ptr("claude-opus-5-5"), ptr[int64](1000), ptr[int64](200), ptr(0.008)

	llm2 := span(project, "cccccccccccccccc", ptr(root.SpanID), "answer", "llm", 3000, 1000)
	llm2.Model, llm2.InputTokens, llm2.OutputTokens = ptr("claude-haiku-5-5"), ptr[int64](500), ptr[int64](50)
	// No cost: an unpriced call must not turn the run total into null.

	tool := span(project, "dddddddddddddddd", ptr(root.SpanID), "web_search", "tool", 1700, 1200)
	tool.Status = "error"
	tool.Error = []byte(`{"type": "Timeout", "message": "slow"}`)

	if n := write(t, st, root, llm1, llm2, tool); n != 4 {
		t.Fatalf("inserted %d, want 4", n)
	}

	r := getRun(t, st, project)
	want := run{
		Name: "research-agent", Status: "ok", // a failed tool call doesn't fail the run
		StartTime: t0, EndTime: t0.Add(5 * time.Second), DurationMs: 5000,
		SpanCount: 4, LLMs: 2, Tools: 1, InputTokens: 1500, OutputTokens: 250,
		Tags: []string{"nightly", "v2"}, Models: []string{"claude-haiku-5-5", "claude-opus-5-5"},
	}
	if r.CostUSD == nil || *r.CostUSD != 0.008 {
		t.Errorf("total_cost_usd = %v, want 0.008", r.CostUSD)
	}
	r.CostUSD = nil
	if !r.StartTime.Equal(want.StartTime) || !r.EndTime.Equal(want.EndTime) {
		t.Errorf("timing = %v..%v", r.StartTime, r.EndTime)
	}
	r.StartTime, r.EndTime = want.StartTime, want.EndTime
	if fmt.Sprint(r) != fmt.Sprint(want) {
		t.Errorf("run =\n %+v\nwant\n %+v", r, want)
	}

	var durationMs float64
	var input, output *string
	if err := st.Pool().QueryRow(t.Context(),
		`SELECT duration_ms, input::text, output::text FROM spans WHERE project_id = $1 AND span_id = $2`,
		project, root.SpanID).Scan(&durationMs, &input, &output); err != nil {
		t.Fatal(err)
	}
	if durationMs != 5000 || input == nil || *input != `{"question": "why?"}` || output != nil {
		t.Errorf("root span: duration_ms=%v input=%v output=%v", durationMs, input, output)
	}
}

func TestWriteSpansIsIdempotent(t *testing.T) {
	st := pgtest.Store(t)
	project := pgtest.Project(t, st)

	root := span(project, "aaaaaaaaaaaaaaaa", nil, "agent", "agent", 0, 1000)
	child := span(project, "bbbbbbbbbbbbbbbb", ptr(root.SpanID), "step", "custom", 10, 100)
	write(t, st, root, child)
	before := getRun(t, st, project)

	if n := write(t, st, root, child); n != 0 {
		t.Errorf("re-send inserted %d spans, want 0", n)
	}
	// A retry that overlaps old spans and carries a new one inserts only the new one.
	extra := span(project, "cccccccccccccccc", ptr(root.SpanID), "step2", "custom", 200, 100)
	if n := write(t, st, child, extra, extra); n != 1 {
		t.Errorf("overlapping batch inserted %d spans, want 1", n)
	}

	if got := countSpans(t, st, project); got != 3 {
		t.Errorf("stored %d spans, want 3", got)
	}
	after := getRun(t, st, project)
	if after.SpanCount != before.SpanCount+1 {
		t.Errorf("span_count = %d, want %d", after.SpanCount, before.SpanCount+1)
	}
}

func TestRunsWhenRootArrivesLast(t *testing.T) {
	st := pgtest.Store(t)
	project := pgtest.Project(t, st)
	rootID := "aaaaaaaaaaaaaaaa"

	// Batch 1: only children. Before the root arrives the run is named after
	// the earliest span and cannot be in error.
	first := span(project, "bbbbbbbbbbbbbbbb", &rootID, "llm-call", "llm", 100, 200)
	second := span(project, "cccccccccccccccc", &rootID, "tool-call", "tool", 400, 300)
	second.Status, second.Error = "error", []byte(`{"type": "E", "message": "m"}`)
	write(t, st, second, first)

	r := getRun(t, st, project)
	if r.Name != "llm-call" || r.Status != "ok" || r.SpanCount != 2 || len(r.Tags) != 0 {
		t.Errorf("before root: %+v", r)
	}
	if !r.StartTime.Equal(t0.Add(100 * time.Millisecond)) {
		t.Errorf("before root: start_time = %v", r.StartTime)
	}

	// Batch 2: the root, which errored and wraps everything.
	root := span(project, rootID, nil, "research-agent", "agent", 0, 1000)
	root.Status, root.Error = "error", []byte(`{"type": "AgentError", "message": "gave up"}`)
	root.Attributes = []byte(`{"tracewright.tags": ["prod"]}`)
	write(t, st, root)

	r = getRun(t, st, project)
	if r.Name != "research-agent" || r.Status != "error" || r.SpanCount != 3 ||
		r.LLMs != 1 || r.Tools != 1 || !slices.Equal(r.Tags, []string{"prod"}) {
		t.Errorf("after root: %+v", r)
	}
	if !r.StartTime.Equal(t0) || !r.EndTime.Equal(t0.Add(time.Second)) || r.DurationMs != 1000 {
		t.Errorf("after root: timing %v..%v (%vms)", r.StartTime, r.EndTime, r.DurationMs)
	}
}

// Writers flushing spans of one trace in parallel must not lose updates to
// the runs row; the per-trace advisory lock serializes them.
func TestConcurrentWritesToOneTrace(t *testing.T) {
	st := pgtest.Store(t)
	project := pgtest.Project(t, st)
	const n = 24

	var wg sync.WaitGroup
	errs := make(chan error, n)
	for i := range n {
		wg.Go(func() {
			s := span(project, fmt.Sprintf("%016x", i+1), ptr("ffffffffffffffff"), "step", "llm", i*10, 5)
			s.InputTokens = ptr[int64](10)
			if _, err := st.WriteSpans(context.Background(), []store.Span{s}); err != nil {
				errs <- err
			}
		})
	}
	wg.Wait()
	close(errs)
	for err := range errs {
		t.Fatal(err)
	}

	r := getRun(t, st, project)
	if r.SpanCount != n || r.InputTokens != 10*n {
		t.Errorf("span_count = %d, input_tokens = %d; want %d, %d", r.SpanCount, r.InputTokens, n, 10*n)
	}
}

func TestWriteSpansPermanentErrorRollsBack(t *testing.T) {
	st := pgtest.Store(t)
	project := pgtest.Project(t, st)

	good := span(project, "aaaaaaaaaaaaaaaa", nil, "ok", "agent", 0, 10)
	bad := span(project, "bbbbbbbbbbbbbbbb", nil, "bad", "not-a-kind", 0, 10)
	_, err := st.WriteSpans(t.Context(), []store.Span{good, bad})
	if err == nil || !store.IsPermanent(err) {
		t.Fatalf("err = %v, want a permanent error", err)
	}
	if got := countSpans(t, st, project); got != 0 {
		t.Errorf("%d spans persisted from a failed batch, want 0", got)
	}
	// The connection's staging table must be usable again after the rollback.
	if n := write(t, st, good); n != 1 {
		t.Errorf("inserted %d after rollback, want 1", n)
	}
}

func TestMigrateIsIdempotent(t *testing.T) {
	st := pgtest.Store(t)
	applied, err := st.Migrate(t.Context())
	if err != nil {
		t.Fatal(err)
	}
	if len(applied) != 0 {
		t.Errorf("re-running migrations applied %v", applied)
	}
}

func TestProjectsAndKeys(t *testing.T) {
	st := pgtest.Store(t)
	ctx := t.Context()

	p, err := st.CreateProject(ctx, "keys-"+apikey.Generate()[3:11], "Keys", true)
	if err != nil {
		t.Fatal(err)
	}
	if _, err := st.CreateProject(ctx, p.Slug, "Dup", false); !errors.Is(err, store.ErrConflict) {
		t.Errorf("duplicate slug: err = %v, want ErrConflict", err)
	}
	if _, err := st.CreateAPIKey(ctx, "no-such-project"); !errors.Is(err, store.ErrNotFound) {
		t.Errorf("unknown project: err = %v, want ErrNotFound", err)
	}

	key, err := st.CreateAPIKey(ctx, p.Slug)
	if err != nil {
		t.Fatal(err)
	}
	if !apikey.Valid(key) {
		t.Fatalf("generated key %q has the wrong shape", key)
	}
	var prefix string
	var hash []byte
	if err := st.Pool().QueryRow(ctx, `SELECT prefix, key_hash FROM api_keys WHERE project_id = $1`, p.ID).
		Scan(&prefix, &hash); err != nil {
		t.Fatal(err)
	}
	if want := apikey.Hash(key); prefix != key[:11] || !slices.Equal(hash, want[:]) {
		t.Errorf("stored prefix %q / hash mismatch", prefix)
	}

	id, ok, err := st.ProjectIDForKeyHash(ctx, apikey.Hash(key))
	if err != nil || !ok || id != p.ID {
		t.Errorf("lookup = %q, %v, %v", id, ok, err)
	}
	if err := st.RevokeAPIKey(ctx, p.Slug, "tw_00000000"); !errors.Is(err, store.ErrNotFound) {
		t.Errorf("unknown prefix: err = %v, want ErrNotFound", err)
	}
	if err := st.RevokeAPIKey(ctx, p.Slug, apikey.DisplayPrefix(key)); err != nil {
		t.Fatal(err)
	}
	if err := st.RevokeAPIKey(ctx, p.Slug, apikey.DisplayPrefix(key)); !errors.Is(err, store.ErrNotFound) {
		t.Errorf("already revoked: err = %v, want ErrNotFound", err)
	}
	if _, ok, err := st.ProjectIDForKeyHash(ctx, apikey.Hash(key)); ok || err != nil {
		t.Errorf("revoked key: ok = %v, err = %v", ok, err)
	}
}
