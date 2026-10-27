package api

import (
	"context"
	"encoding/json"
	"errors"
	"net/http"
	"time"

	"github.com/MaddoxNehls/tracewright/ingest/internal/store"
)

// RunReader loads a stored run; *store.Store implements it.
type RunReader interface {
	GetRun(ctx context.Context, projectID, traceID string) (store.Run, []store.Span, error)
}

type runJSON struct {
	TraceID           string   `json:"trace_id"`
	Name              string   `json:"name"`
	Status            string   `json:"status"`
	StartTime         string   `json:"start_time"`
	EndTime           string   `json:"end_time"`
	DurationMs        float64  `json:"duration_ms"`
	SpanCount         int      `json:"span_count"`
	LLMCallCount      int      `json:"llm_call_count"`
	ToolCallCount     int      `json:"tool_call_count"`
	TotalInputTokens  int64    `json:"total_input_tokens"`
	TotalOutputTokens int64    `json:"total_output_tokens"`
	TotalCostUSD      *float64 `json:"total_cost_usd"`
	Tags              []string `json:"tags"`
	Models            []string `json:"models"`
}

// spanJSON is the contract's Span shape, the same one clients POST.
type spanJSON struct {
	TraceID      string          `json:"trace_id"`
	SpanID       string          `json:"span_id"`
	ParentSpanID *string         `json:"parent_span_id"`
	Name         string          `json:"name"`
	Kind         string          `json:"kind"`
	StartTime    string          `json:"start_time"`
	EndTime      string          `json:"end_time"`
	Status       string          `json:"status"`
	Error        json.RawMessage `json:"error"`
	Attributes   json.RawMessage `json:"attributes"`
	Input        json.RawMessage `json:"input"`
	Output       json.RawMessage `json:"output"`
}

func (h *Handler) getRun(w http.ResponseWriter, r *http.Request) {
	traceID := r.PathValue("trace_id")
	if len(traceID) != 32 || !isLowerHex(traceID) {
		writeError(w, http.StatusBadRequest, "trace_id must be 32 lowercase hex characters")
		return
	}

	run, spans, err := h.Runs.GetRun(r.Context(), projectID(r.Context()), traceID)
	switch {
	case errors.Is(err, store.ErrNotFound):
		writeError(w, http.StatusNotFound, "run not found")
		return
	case err != nil:
		h.Log.Error("read run failed", "trace_id", traceID, "err", err)
		writeError(w, http.StatusInternalServerError, "internal error")
		return
	}

	out := make([]spanJSON, len(spans))
	for i, s := range spans {
		out[i] = spanJSON{
			TraceID:      s.TraceID,
			SpanID:       s.SpanID,
			ParentSpanID: s.ParentSpanID,
			Name:         s.Name,
			Kind:         s.Kind,
			StartTime:    formatTime(s.StartTime),
			EndTime:      formatTime(s.EndTime),
			Status:       s.Status,
			Error:        s.Error, // nil []byte marshals as JSON null
			Attributes:   s.Attributes,
			Input:        s.Input,
			Output:       s.Output,
		}
	}
	writeJSON(w, http.StatusOK, map[string]any{
		"run": runJSON{
			TraceID:           run.TraceID,
			Name:              run.Name,
			Status:            run.Status,
			StartTime:         formatTime(run.StartTime),
			EndTime:           formatTime(run.EndTime),
			DurationMs:        run.DurationMs,
			SpanCount:         run.SpanCount,
			LLMCallCount:      run.LLMCallCount,
			ToolCallCount:     run.ToolCallCount,
			TotalInputTokens:  run.TotalInputTokens,
			TotalOutputTokens: run.TotalOutputTokens,
			TotalCostUSD:      run.TotalCostUSD,
			Tags:              nonNil(run.Tags),
			Models:            nonNil(run.Models),
		},
		"spans": out,
	})
}

func formatTime(t time.Time) string { return t.UTC().Format(time.RFC3339Nano) }

func nonNil(s []string) []string {
	if s == nil {
		return []string{}
	}
	return s
}
