package api

import (
	"bytes"
	"compress/gzip"
	"context"
	"encoding/json"
	"errors"
	"io"
	"log/slog"
	"net/http"
	"net/http/httptest"
	"strings"
	"sync/atomic"
	"testing"
	"time"

	"github.com/prometheus/client_golang/prometheus"
	"github.com/prometheus/client_golang/prometheus/testutil"

	"github.com/MaddoxNehls/tracewright/ingest/internal/apikey"
	"github.com/MaddoxNehls/tracewright/ingest/internal/config"
	"github.com/MaddoxNehls/tracewright/ingest/internal/metrics"
	"github.com/MaddoxNehls/tracewright/ingest/internal/pipeline"
)

const testKey = "tw_0123456789abcdef0123456789abcdef"

// fakeKeys resolves testKey to testProject and counts lookups.
type fakeKeys struct {
	calls atomic.Int32
	err   error
}

func (f *fakeKeys) ProjectIDForKeyHash(_ context.Context, hash [32]byte) (string, bool, error) {
	f.calls.Add(1)
	if f.err != nil {
		return "", false, f.err
	}
	if hash == apikey.Hash(testKey) {
		return testProject, true, nil
	}
	return "", false, nil
}

type testServer struct {
	handler http.Handler
	queue   *pipeline.Queue
	metrics *metrics.Metrics
	keys    *fakeKeys
}

func newTestServer(t *testing.T, queueSpans int) *testServer {
	t.Helper()
	reg := prometheus.NewRegistry()
	m := metrics.New(reg)
	q := pipeline.NewQueue(queueSpans, 64<<20)
	keys := &fakeKeys{}
	h := &Handler{
		Auth:     NewAuthenticator(keys, AuthConfig{}),
		Queue:    q,
		Prices:   mustPrices(t),
		Metrics:  m,
		Gatherer: reg,
		Log:      slog.New(slog.DiscardHandler),
	}
	return &testServer{handler: h.Routes(), queue: q, metrics: m, keys: keys}
}

func (s *testServer) post(t *testing.T, body []byte, header map[string]string) *httptest.ResponseRecorder {
	t.Helper()
	req := httptest.NewRequest(http.MethodPost, "/v1/spans", bytes.NewReader(body))
	req.Header.Set("Content-Type", "application/json")
	req.Header.Set("Authorization", "Bearer "+testKey)
	for k, v := range header {
		if v == "" {
			req.Header.Del(k)
		} else {
			req.Header.Set(k, v)
		}
	}
	rec := httptest.NewRecorder()
	s.handler.ServeHTTP(rec, req)
	return rec
}

func spansBody(t *testing.T, spans ...map[string]any) []byte {
	t.Helper()
	b, err := json.Marshal(map[string]any{"spans": spans})
	if err != nil {
		t.Fatal(err)
	}
	return b
}

func gzipped(t *testing.T, b []byte) []byte {
	t.Helper()
	var buf bytes.Buffer
	zw := gzip.NewWriter(&buf)
	zw.Write(b)
	if err := zw.Close(); err != nil {
		t.Fatal(err)
	}
	return buf.Bytes()
}

func TestPostSpansAccepted(t *testing.T) {
	s := newTestServer(t, 10_000)
	rec := s.post(t, spansBody(t, validSpan()), nil)

	if rec.Code != http.StatusAccepted {
		t.Fatalf("status = %d, body = %s", rec.Code, rec.Body)
	}
	if got := strings.TrimSpace(rec.Body.String()); got != `{"accepted":1}` {
		t.Errorf("body = %s", got)
	}
	if s.queue.Depth() != 1 {
		t.Errorf("queue depth = %d, want 1", s.queue.Depth())
	}
	if got := testutil.ToFloat64(s.metrics.SpansReceived); got != 1 {
		t.Errorf("spans_received_total = %v", got)
	}
}

func TestPostSpansGzip(t *testing.T) {
	s := newTestServer(t, 10_000)
	rec := s.post(t, gzipped(t, spansBody(t, validSpan(), validSpan())), map[string]string{"Content-Encoding": "gzip"})
	if rec.Code != http.StatusAccepted {
		t.Fatalf("status = %d, body = %s", rec.Code, rec.Body)
	}
}

func TestPostSpansAuth(t *testing.T) {
	tests := map[string]string{
		"missing header":    "",
		"wrong scheme":      "Basic " + testKey,
		"malformed key":     "Bearer not-a-key",
		"unknown key":       "Bearer tw_ffffffffffffffffffffffffffffffff",
		"uppercase hex key": "Bearer tw_0123456789ABCDEF0123456789ABCDEF",
	}
	for name, header := range tests {
		t.Run(name, func(t *testing.T) {
			s := newTestServer(t, 10_000)
			rec := s.post(t, spansBody(t, validSpan()), map[string]string{"Authorization": header})
			if rec.Code != http.StatusUnauthorized {
				t.Errorf("status = %d, want 401", rec.Code)
			}
			if s.queue.Depth() != 0 {
				t.Error("unauthenticated spans were queued")
			}
		})
	}
}

func TestPostSpansAuthBackendDown(t *testing.T) {
	s := newTestServer(t, 10_000)
	s.keys.err = errors.New("connection refused")
	rec := s.post(t, spansBody(t, validSpan()), nil)
	if rec.Code != http.StatusServiceUnavailable || rec.Header().Get("Retry-After") == "" {
		t.Errorf("status = %d, Retry-After = %q; want 503 with Retry-After", rec.Code, rec.Header().Get("Retry-After"))
	}
}

func TestPostSpansValidationDetails(t *testing.T) {
	s := newTestServer(t, 10_000)
	bad := validSpan()
	bad["kind"] = "chain"
	rec := s.post(t, spansBody(t, validSpan(), bad), nil)

	if rec.Code != http.StatusBadRequest {
		t.Fatalf("status = %d", rec.Code)
	}
	var resp struct {
		Error   string       `json:"error"`
		Details []FieldError `json:"details"`
	}
	if err := json.Unmarshal(rec.Body.Bytes(), &resp); err != nil {
		t.Fatal(err)
	}
	if len(resp.Details) != 1 || resp.Details[0].Index != 1 || resp.Details[0].Field != "kind" {
		t.Errorf("details = %+v", resp.Details)
	}
	if s.queue.Depth() != 0 {
		t.Error("a partially invalid batch must be rejected whole")
	}
	if got := testutil.ToFloat64(s.metrics.SpansRejected.WithLabelValues(metrics.ReasonInvalid)); got != 2 {
		t.Errorf("spans_rejected_total{reason=invalid} = %v, want 2", got)
	}
}

func TestPostSpansBadRequests(t *testing.T) {
	tooMany := make([]map[string]any, config.MaxSpansPerRequest+1)
	for i := range tooMany {
		tooMany[i] = validSpan()
	}
	tests := []struct {
		name   string
		body   []byte
		header map[string]string
		want   int
	}{
		{"not json", []byte("{"), nil, http.StatusBadRequest},
		{"not an object", []byte(`[1,2]`), nil, http.StatusBadRequest},
		{"no spans", []byte(`{"spans": []}`), nil, http.StatusBadRequest},
		{"spans missing", []byte(`{}`), nil, http.StatusBadRequest},
		{"too many spans", spansBody(t, tooMany...), nil, http.StatusBadRequest},
		{"invalid utf-8", []byte("{\"spans\": [\"\xff\"]}"), nil, http.StatusBadRequest},
		{"corrupt gzip", []byte("not gzip"), map[string]string{"Content-Encoding": "gzip"}, http.StatusBadRequest},
		{"unknown encoding", spansBody(t, validSpan()), map[string]string{"Content-Encoding": "br"}, http.StatusUnsupportedMediaType},
	}
	for _, tt := range tests {
		t.Run(tt.name, func(t *testing.T) {
			s := newTestServer(t, 10_000)
			rec := s.post(t, tt.body, tt.header)
			if rec.Code != tt.want {
				t.Errorf("status = %d, want %d (body %s)", rec.Code, tt.want, rec.Body)
			}
		})
	}
}

func TestPostSpansTooLarge(t *testing.T) {
	big := validSpan()
	big["input"] = strings.Repeat("a", config.MaxBodyBytes)
	body := spansBody(t, big)

	t.Run("plain", func(t *testing.T) {
		rec := newTestServer(t, 10_000).post(t, body, nil)
		if rec.Code != http.StatusRequestEntityTooLarge {
			t.Errorf("status = %d, want 413", rec.Code)
		}
	})
	t.Run("gzip bomb", func(t *testing.T) {
		compressed := gzipped(t, body) // compresses to a few KB, inflates past the limit
		if len(compressed) >= config.MaxBodyBytes {
			t.Fatal("test body should compress below the limit")
		}
		rec := newTestServer(t, 10_000).post(t, compressed, map[string]string{"Content-Encoding": "gzip"})
		if rec.Code != http.StatusRequestEntityTooLarge {
			t.Errorf("status = %d, want 413", rec.Code)
		}
	})
}

func TestPostSpansQueueFull(t *testing.T) {
	s := newTestServer(t, config.MaxSpansPerRequest)
	full := make([]map[string]any, config.MaxSpansPerRequest)
	for i := range full {
		full[i] = validSpan()
	}
	if rec := s.post(t, spansBody(t, full...), nil); rec.Code != http.StatusAccepted {
		t.Fatalf("first request: status = %d", rec.Code)
	}

	rec := s.post(t, spansBody(t, validSpan()), nil)
	if rec.Code != http.StatusTooManyRequests {
		t.Fatalf("status = %d, want 429", rec.Code)
	}
	if rec.Header().Get("Retry-After") != "1" {
		t.Errorf("Retry-After = %q", rec.Header().Get("Retry-After"))
	}
	if got := testutil.ToFloat64(s.metrics.SpansRejected.WithLabelValues(metrics.ReasonQueueFull)); got != 1 {
		t.Errorf("spans_rejected_total{reason=queue_full} = %v", got)
	}
}

func TestPostSpansAfterShutdown(t *testing.T) {
	s := newTestServer(t, 10_000)
	s.queue.Close()
	if rec := s.post(t, spansBody(t, validSpan()), nil); rec.Code != http.StatusServiceUnavailable {
		t.Errorf("status = %d, want 503", rec.Code)
	}
}

func TestHealthAndMetrics(t *testing.T) {
	s := newTestServer(t, 10_000)
	s.post(t, spansBody(t, validSpan()), nil)

	for path, want := range map[string]string{
		"/healthz": "ok",
		"/metrics": "tracewright_spans_received_total 1",
	} {
		rec := httptest.NewRecorder()
		s.handler.ServeHTTP(rec, httptest.NewRequest(http.MethodGet, path, nil))
		body, _ := io.ReadAll(rec.Body)
		if rec.Code != http.StatusOK || !strings.Contains(string(body), want) {
			t.Errorf("GET %s: status %d, body missing %q", path, rec.Code, want)
		}
	}
}

func TestAuthenticatorCaches(t *testing.T) {
	keys := &fakeKeys{}
	a := NewAuthenticator(keys, AuthConfig{TTL: time.Minute, NegativeTTL: time.Second})
	now := time.Now()
	a.now = func() time.Time { return now }
	ctx := context.Background()

	for range 3 {
		if id, err := a.Authenticate(ctx, "Bearer "+testKey); err != nil || id != testProject {
			t.Fatalf("Authenticate = %q, %v", id, err)
		}
	}
	if got := keys.calls.Load(); got != 1 {
		t.Errorf("valid key: %d lookups, want 1 (cached)", got)
	}

	unknown := "Bearer tw_ffffffffffffffffffffffffffffffff"
	a.Authenticate(ctx, unknown)
	a.Authenticate(ctx, unknown)
	if got := keys.calls.Load(); got != 2 {
		t.Errorf("unknown key: %d total lookups, want 2 (negative cached)", got)
	}

	now = now.Add(2 * time.Second) // negative entry expired, positive still live
	a.Authenticate(ctx, unknown)
	a.Authenticate(ctx, "Bearer "+testKey)
	if got := keys.calls.Load(); got != 3 {
		t.Errorf("after negative TTL: %d total lookups, want 3", got)
	}

	now = now.Add(time.Minute) // positive entry expired
	a.Authenticate(ctx, "Bearer "+testKey)
	if got := keys.calls.Load(); got != 4 {
		t.Errorf("after TTL: %d total lookups, want 4", got)
	}
}

func TestAuthenticatorDoesNotCacheErrors(t *testing.T) {
	keys := &fakeKeys{err: errors.New("db down")}
	a := NewAuthenticator(keys, AuthConfig{})
	if _, err := a.Authenticate(context.Background(), "Bearer "+testKey); err == nil || errors.Is(err, errUnauthorized) {
		t.Fatalf("want lookup error, got %v", err)
	}
	keys.err = nil
	if id, err := a.Authenticate(context.Background(), "Bearer "+testKey); err != nil || id != testProject {
		t.Errorf("after recovery: %q, %v", id, err)
	}
}

func TestAuthenticatorBoundsCache(t *testing.T) {
	a := NewAuthenticator(&fakeKeys{}, AuthConfig{MaxEntries: 10})
	for range 50 {
		a.Authenticate(context.Background(), "Bearer "+apikey.Generate())
	}
	if n := len(a.cache); n > 10 {
		t.Errorf("cache grew to %d entries, max 10", n)
	}
}
