package api

import (
	"context"
	"encoding/json"
	"errors"
	"net/http"
	"net/http/httptest"
	"testing"
	"time"

	"github.com/MaddoxNehls/tracewright/ingest/internal/store"
)

const readTrace = "4bf92f3577b34da6a3ce929d0e0e4736"

// fakeRuns serves one stored run, owned by testProject.
type fakeRuns struct {
	err        error
	gotProject string
}

func (f *fakeRuns) GetRun(_ context.Context, projectID, traceID string) (store.Run, []store.Span, error) {
	f.gotProject = projectID
	if f.err != nil {
		return store.Run{}, nil, f.err
	}
	if projectID != testProject || traceID != readTrace {
		return store.Run{}, nil, store.ErrNotFound
	}
	// A non-UTC location proves the handler normalizes timestamps.
	start := time.Date(2026, 10, 27, 14, 0, 0, 123_456_000, time.FixedZone("CET", 2*3600))
	root := "aaaaaaaaaaaaaaaa"
	return store.Run{
		TraceID: readTrace, Name: "research-agent", Status: "ok",
		StartTime: start, EndTime: start.Add(time.Second), DurationMs: 1000,
		SpanCount: 2, LLMCallCount: 1, TotalInputTokens: 10, TotalOutputTokens: 5,
		Tags: []string{"demo"},
	}, []store.Span{
		{
			TraceID: readTrace, SpanID: root, Name: "research-agent", Kind: "agent",
			StartTime: start, EndTime: start.Add(time.Second), Status: "ok",
			Attributes: []byte(`{"tracewright.tags":["demo"]}`), Input: []byte(`{"question":"why?"}`),
		},
		{
			TraceID: readTrace, SpanID: "bbbbbbbbbbbbbbbb", ParentSpanID: &root, Name: "chat x", Kind: "llm",
			StartTime: start.Add(time.Millisecond), EndTime: start.Add(500 * time.Millisecond),
			Status: "error", Error: []byte(`{"type":"Timeout","message":"slow"}`), Attributes: []byte(`{}`),
		},
	}, nil
}

func (s *testServer) get(t *testing.T, path, key string) *httptest.ResponseRecorder {
	t.Helper()
	req := httptest.NewRequest(http.MethodGet, path, nil)
	if key != "" {
		req.Header.Set("Authorization", "Bearer "+key)
	}
	rec := httptest.NewRecorder()
	s.handler.ServeHTTP(rec, req)
	return rec
}

func TestGetRun(t *testing.T) {
	s := newTestServer(t, 10)
	rec := s.get(t, "/v1/runs/"+readTrace, testKey)
	if rec.Code != http.StatusOK {
		t.Fatalf("status = %d, body = %s", rec.Code, rec.Body)
	}
	if s.runs.gotProject != testProject {
		t.Errorf("queried project %q, want the key's project", s.runs.gotProject)
	}

	var body struct {
		Run   map[string]any   `json:"run"`
		Spans []map[string]any `json:"spans"`
	}
	if err := json.Unmarshal(rec.Body.Bytes(), &body); err != nil {
		t.Fatal(err)
	}
	if body.Run["trace_id"] != readTrace || body.Run["span_count"] != 2.0 || body.Run["total_cost_usd"] != nil {
		t.Errorf("run = %v", body.Run)
	}
	if body.Run["start_time"] != "2026-10-27T12:00:00.123456Z" {
		t.Errorf("run start_time = %v, want UTC RFC3339Nano", body.Run["start_time"])
	}
	if models, ok := body.Run["models"].([]any); !ok || len(models) != 0 {
		t.Errorf("models = %#v, want []", body.Run["models"])
	}
	if len(body.Spans) != 2 {
		t.Fatalf("got %d spans", len(body.Spans))
	}

	root, child := body.Spans[0], body.Spans[1]
	wantKeys := []string{"trace_id", "span_id", "parent_span_id", "name", "kind", "start_time",
		"end_time", "status", "error", "attributes", "input", "output"}
	for _, k := range wantKeys {
		if _, ok := root[k]; !ok {
			t.Errorf("span is missing %q", k)
		}
	}
	if len(root) != len(wantKeys) {
		t.Errorf("span has %d fields, want exactly the contract's %d", len(root), len(wantKeys))
	}
	if root["parent_span_id"] != nil || root["error"] != nil || root["output"] != nil {
		t.Errorf("null fields not null: %v", root)
	}
	if q := root["input"].(map[string]any)["question"]; q != "why?" {
		t.Errorf("input = %v", root["input"])
	}
	if child["parent_span_id"] != "aaaaaaaaaaaaaaaa" || child["error"].(map[string]any)["type"] != "Timeout" {
		t.Errorf("child = %v", child)
	}
}

func TestGetRunErrors(t *testing.T) {
	tests := []struct {
		name, path, key string
		storeErr        error
		want            int
	}{
		{"no key", "/v1/runs/" + readTrace, "", nil, http.StatusUnauthorized},
		{"unknown key", "/v1/runs/" + readTrace, "tw_ffffffffffffffffffffffffffffffff", nil, http.StatusUnauthorized},
		{"unknown trace", "/v1/runs/ffffffffffffffffffffffffffffffff", testKey, nil, http.StatusNotFound},
		{"malformed trace id", "/v1/runs/not-a-trace", testKey, nil, http.StatusBadRequest},
		{"uppercase trace id", "/v1/runs/4BF92F3577B34DA6A3CE929D0E0E4736", testKey, nil, http.StatusBadRequest},
		{"store failure", "/v1/runs/" + readTrace, testKey, errors.New("connection reset"), http.StatusInternalServerError},
	}
	for _, tt := range tests {
		t.Run(tt.name, func(t *testing.T) {
			s := newTestServer(t, 10)
			s.runs.err = tt.storeErr
			if rec := s.get(t, tt.path, tt.key); rec.Code != tt.want {
				t.Errorf("status = %d, want %d (body %s)", rec.Code, tt.want, rec.Body)
			}
		})
	}
}

func TestGetRunRejectsOtherMethods(t *testing.T) {
	s := newTestServer(t, 10)
	req := httptest.NewRequest(http.MethodDelete, "/v1/runs/"+readTrace, nil)
	req.Header.Set("Authorization", "Bearer "+testKey)
	rec := httptest.NewRecorder()
	s.handler.ServeHTTP(rec, req)
	if rec.Code != http.StatusMethodNotAllowed {
		t.Errorf("status = %d, want 405", rec.Code)
	}
}
