package api

import (
	"encoding/json"
	"strings"
	"testing"

	"github.com/MaddoxNehls/tracewright/ingest/internal/pricing"
)

const testProject = "00000000-0000-0000-0000-000000000001"

// validSpan returns a span that passes validation; tests mutate copies of it.
func validSpan() map[string]any {
	return map[string]any{
		"trace_id":       "4bf92f3577b34da6a3ce929d0e0e4736",
		"span_id":        "00f067aa0ba902b7",
		"parent_span_id": nil,
		"name":           "research-agent",
		"kind":           "agent",
		"start_time":     "2026-10-27T12:00:00.123456789Z",
		"end_time":       "2026-10-27T12:00:01Z",
		"status":         "ok",
		"error":          nil,
		"attributes":     map[string]any{},
		"input":          map[string]any{"q": "hi"},
		"output":         nil,
	}
}

func mustPrices(t *testing.T) *pricing.Table {
	t.Helper()
	p, err := pricing.Default()
	if err != nil {
		t.Fatal(err)
	}
	return p
}

func rawSpans(t *testing.T, spans ...map[string]any) []json.RawMessage {
	t.Helper()
	out := make([]json.RawMessage, len(spans))
	for i, s := range spans {
		b, err := json.Marshal(s)
		if err != nil {
			t.Fatal(err)
		}
		out[i] = b
	}
	return out
}

func TestParseSpansRejectsInvalidFields(t *testing.T) {
	tests := []struct {
		name      string
		mutate    func(s map[string]any)
		wantField string
		wantMsg   string
	}{
		{"missing trace_id", func(s map[string]any) { delete(s, "trace_id") }, "trace_id", "is required"},
		{"trace_id wrong type", func(s map[string]any) { s["trace_id"] = 42 }, "trace_id", "must be a string"},
		{"trace_id too short", func(s map[string]any) { s["trace_id"] = "abc" }, "trace_id", "32 lowercase hex"},
		{"trace_id uppercase", func(s map[string]any) { s["trace_id"] = strings.ToUpper("4bf92f3577b34da6a3ce929d0e0e4736") }, "trace_id", "lowercase hex"},
		{"span_id not hex", func(s map[string]any) { s["span_id"] = "zzzzzzzzzzzzzzzz" }, "span_id", "16 lowercase hex"},
		{"parent_span_id bad", func(s map[string]any) { s["parent_span_id"] = "123" }, "parent_span_id", "16 lowercase hex"},
		{"empty name", func(s map[string]any) { s["name"] = "" }, "name", "1-256"},
		{"name too long", func(s map[string]any) { s["name"] = strings.Repeat("x", 257) }, "name", "1-256"},
		{"bad kind", func(s map[string]any) { s["kind"] = "chain" }, "kind", "must be one of"},
		{"bad status", func(s map[string]any) { s["status"] = "failed" }, "status", "must be one of"},
		{"start_time not RFC3339", func(s map[string]any) { s["start_time"] = "yesterday" }, "start_time", "RFC 3339"},
		{"start_time not UTC", func(s map[string]any) { s["start_time"] = "2026-10-27T12:00:00+02:00" }, "start_time", "UTC"},
		{"end before start", func(s map[string]any) { s["end_time"] = "2026-10-27T11:59:59Z" }, "end_time", "before start_time"},
		{"error required on status=error", func(s map[string]any) { s["status"] = "error" }, "error", "required"},
		{"error not an object", func(s map[string]any) { s["error"] = "boom" }, "error", "must be an object"},
		{"error.message missing", func(s map[string]any) {
			s["status"] = "error"
			s["error"] = map[string]any{"type": "ValueError"}
		}, "error.message", "is required"},
		{"attributes not an object", func(s map[string]any) { s["attributes"] = []int{1} }, "attributes", "must be an object"},
		{"negative tokens", func(s map[string]any) {
			s["attributes"] = map[string]any{"gen_ai.usage.input_tokens": -1}
		}, "attributes.gen_ai.usage.input_tokens", "non-negative integer"},
		{"fractional tokens", func(s map[string]any) {
			s["attributes"] = map[string]any{"gen_ai.usage.output_tokens": 1.5}
		}, "attributes.gen_ai.usage.output_tokens", "non-negative integer"},
		{"tokens as string", func(s map[string]any) {
			s["attributes"] = map[string]any{"gen_ai.usage.output_tokens": "12"}
		}, "attributes.gen_ai.usage.output_tokens", "non-negative integer"},
		{"tags not strings", func(s map[string]any) {
			s["attributes"] = map[string]any{"tracewright.tags": []any{"a", 1}}
		}, "attributes.tracewright.tags", "array of strings"},
		{"cost negative", func(s map[string]any) {
			s["attributes"] = map[string]any{"tracewright.cost_usd": -0.5}
		}, "attributes.tracewright.cost_usd", "between 0"},
		{"cost overflows column", func(s map[string]any) {
			s["attributes"] = map[string]any{"tracewright.cost_usd": 1e7}
		}, "attributes.tracewright.cost_usd", "between 0"},
		{"model not a string", func(s map[string]any) {
			s["attributes"] = map[string]any{"gen_ai.request.model": 5}
		}, "attributes.gen_ai.request.model", "must be a string"},
		{"truncated not bool", func(s map[string]any) {
			s["attributes"] = map[string]any{"tracewright.truncated": "yes"}
		}, "attributes.tracewright.truncated", "boolean"},
	}

	prices := mustPrices(t)
	for _, tt := range tests {
		t.Run(tt.name, func(t *testing.T) {
			bad := validSpan()
			tt.mutate(bad)
			// The bad span sits at index 1 to prove errors carry the right index.
			spans, errs := parseSpans(rawSpans(t, validSpan(), bad), testProject, prices)
			if spans != nil {
				t.Errorf("expected no spans when the batch is invalid, got %d", len(spans))
			}
			if len(errs) != 1 {
				t.Fatalf("got %d errors, want 1: %+v", len(errs), errs)
			}
			e := errs[0]
			if e.Index != 1 || e.Field != tt.wantField || !strings.Contains(e.Message, tt.wantMsg) {
				t.Errorf("got %+v, want index 1, field %q, message containing %q", e, tt.wantField, tt.wantMsg)
			}
		})
	}
}

func TestParseSpansReportsEveryError(t *testing.T) {
	a := validSpan()
	a["kind"] = "nope"
	a["status"] = "nope"
	b := validSpan()
	b["span_id"] = "short"

	_, errs := parseSpans(rawSpans(t, a, validSpan(), b), testProject, mustPrices(t))
	want := []FieldError{
		{Index: 0, Field: "kind"},
		{Index: 0, Field: "status"},
		{Index: 2, Field: "span_id"},
	}
	if len(errs) != len(want) {
		t.Fatalf("got %+v, want %d errors", errs, len(want))
	}
	for i := range want {
		if errs[i].Index != want[i].Index || errs[i].Field != want[i].Field {
			t.Errorf("error %d = %+v, want index %d field %q", i, errs[i], want[i].Index, want[i].Field)
		}
	}
}

func TestParseSpansRejectsNonObjects(t *testing.T) {
	_, errs := parseSpans([]json.RawMessage{json.RawMessage(`"span"`)}, testProject, mustPrices(t))
	if len(errs) != 1 || errs[0].Index != 0 || !strings.Contains(errs[0].Message, "JSON object") {
		t.Errorf("got %+v", errs)
	}
}

func TestParseSpansAcceptsValid(t *testing.T) {
	root := validSpan()
	root["start_time"] = "2026-10-27T12:00:00+00:00" // Python isoformat style
	child := validSpan()
	child["span_id"] = "1111111111111111"
	child["parent_span_id"] = "00f067aa0ba902b7"
	child["kind"] = "tool"
	child["status"] = "error"
	child["error"] = map[string]any{"type": "TimeoutError", "message": "took too long", "extra": 1}
	delete(child, "attributes") // attributes default to {}
	delete(child, "input")

	spans, errs := parseSpans(rawSpans(t, root, child), testProject, mustPrices(t))
	if errs != nil {
		t.Fatalf("unexpected errors: %+v", errs)
	}
	if len(spans) != 2 {
		t.Fatalf("got %d spans", len(spans))
	}
	if spans[0].ParentSpanID != nil || spans[0].ProjectID != testProject {
		t.Errorf("root span parsed wrong: %+v", spans[0])
	}
	if spans[0].StartTime.Nanosecond() != 0 || spans[0].EndTime.Location().String() != "UTC" {
		t.Errorf("times not normalized: %v %v", spans[0].StartTime, spans[0].EndTime)
	}
	c := spans[1]
	if c.ParentSpanID == nil || *c.ParentSpanID != "00f067aa0ba902b7" {
		t.Errorf("parent_span_id = %v", c.ParentSpanID)
	}
	if string(c.Attributes) != "{}" || c.Input != nil || c.Error == nil {
		t.Errorf("attributes=%s input=%s error=%s", c.Attributes, c.Input, c.Error)
	}
}

func TestParseSpansDerivesModelTokensAndCost(t *testing.T) {
	tests := []struct {
		name      string
		attrs     map[string]any
		wantModel string // "" means nil
		wantIn    int64  // -1 means nil
		wantOut   int64
		wantCost  float64 // -1 means nil
	}{
		{
			name: "cost computed from response model",
			attrs: map[string]any{
				"gen_ai.request.model": "claude-opus-5-5", "gen_ai.response.model": "claude-sonnet-5-5",
				"gen_ai.usage.input_tokens": 1_000_000, "gen_ai.usage.output_tokens": 100_000,
			},
			wantModel: "claude-sonnet-5-5", wantIn: 1_000_000, wantOut: 100_000, wantCost: 2.0 + 1.0,
		},
		{
			name:      "falls back to request model",
			attrs:     map[string]any{"gen_ai.request.model": "claude-opus-5-5", "gen_ai.usage.input_tokens": 1000},
			wantModel: "claude-opus-5-5", wantIn: 1000, wantOut: -1, wantCost: 0.004,
		},
		{
			name: "explicit cost wins over pricing",
			attrs: map[string]any{
				"gen_ai.request.model": "claude-opus-5-5", "gen_ai.usage.input_tokens": 1000,
				"tracewright.cost_usd": 0.5,
			},
			wantModel: "claude-opus-5-5", wantIn: 1000, wantOut: -1, wantCost: 0.5,
		},
		{
			name:      "unknown model has null cost",
			attrs:     map[string]any{"gen_ai.request.model": "gpt-5", "gen_ai.usage.input_tokens": 10, "gen_ai.usage.output_tokens": 10},
			wantModel: "gpt-5", wantIn: 10, wantOut: 10, wantCost: -1,
		},
		{
			name:      "model without usage has null cost",
			attrs:     map[string]any{"gen_ai.request.model": "claude-opus-5-5"},
			wantModel: "claude-opus-5-5", wantIn: -1, wantOut: -1, wantCost: -1,
		},
		{
			name:   "no model, no cost",
			attrs:  map[string]any{"gen_ai.tool.name": "search"},
			wantIn: -1, wantOut: -1, wantCost: -1,
		},
	}
	for _, tt := range tests {
		t.Run(tt.name, func(t *testing.T) {
			s := validSpan()
			s["kind"] = "llm"
			s["attributes"] = tt.attrs
			spans, errs := parseSpans(rawSpans(t, s), testProject, mustPrices(t))
			if errs != nil {
				t.Fatalf("unexpected errors: %+v", errs)
			}
			got := spans[0]
			if (got.Model == nil) != (tt.wantModel == "") || (got.Model != nil && *got.Model != tt.wantModel) {
				t.Errorf("model = %v, want %q", strOrNil(got.Model), tt.wantModel)
			}
			checkInt(t, "input_tokens", got.InputTokens, tt.wantIn)
			checkInt(t, "output_tokens", got.OutputTokens, tt.wantOut)
			switch {
			case tt.wantCost < 0 && got.CostUSD != nil:
				t.Errorf("cost = %v, want nil", *got.CostUSD)
			case tt.wantCost >= 0 && (got.CostUSD == nil || *got.CostUSD != tt.wantCost):
				t.Errorf("cost = %v, want %v", got.CostUSD, tt.wantCost)
			}
		})
	}
}

func TestSanitizeNUL(t *testing.T) {
	tests := map[string]struct{ in, want string }{
		"no escapes": {`{"a":"b"}`, `{"a":"b"}`},
		// The replacement escape is split across literals so editors don't render it as U+FFFD.
		"nul escape":         {`{"a":"x\u0000y"}`, `{"a":"x\u` + `fffdy"}`},
		"escaped backslash":  {`{"a":"\\u0000"}`, `{"a":"\\u0000"}`},
		"backslash then nul": {`{"a":"\\\u0000"}`, `{"a":"\\\u` + `fffd"}`},
		"other escape":       {`{"a":"\u0001"}`, `{"a":"\u0001"}`},
	}
	for name, tt := range tests {
		t.Run(name, func(t *testing.T) {
			b := []byte(tt.in)
			sanitizeNUL(b)
			if string(b) != tt.want {
				t.Errorf("got %s, want %s", b, tt.want)
			}
			if !json.Valid(b) {
				t.Errorf("result is not valid JSON: %s", b)
			}
		})
	}
}

func checkInt(t *testing.T, field string, got *int64, want int64) {
	t.Helper()
	switch {
	case want < 0 && got != nil:
		t.Errorf("%s = %d, want nil", field, *got)
	case want >= 0 && (got == nil || *got != want):
		t.Errorf("%s = %v, want %d", field, got, want)
	}
}

func strOrNil(s *string) any {
	if s == nil {
		return nil
	}
	return *s
}
