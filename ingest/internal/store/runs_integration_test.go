package store_test

import (
	"errors"
	"slices"
	"testing"

	"github.com/MaddoxNehls/tracewright/ingest/internal/pgtest"
	"github.com/MaddoxNehls/tracewright/ingest/internal/store"
)

func TestGetRun(t *testing.T) {
	st := pgtest.Store(t)
	project := pgtest.Project(t, st)

	root := span(project, "aaaaaaaaaaaaaaaa", nil, "research-agent", "agent", 0, 3000)
	root.Attributes = []byte(`{"tracewright.tags": ["demo"]}`)
	root.Input = []byte(`{"question": "why?"}`)
	// Same start time as the root: the tie must break on span_id.
	step := span(project, "bbbbbbbbbbbbbbbb", ptr(root.SpanID), "step-1", "custom", 0, 2000)
	tool := span(project, "cccccccccccccccc", ptr(step.SpanID), "calculator", "tool", 1000, 10)
	tool.Status, tool.Error = "error", []byte(`{"type": "CalculatorError", "message": "bad"}`)
	llm := span(project, "dddddddddddddddd", ptr(step.SpanID), "chat x", "llm", 10, 900)
	llm.Model, llm.InputTokens, llm.OutputTokens = ptr("claude-opus-5-5"), ptr[int64](100), ptr[int64](20)
	llm.Output = []byte(`{"role": "assistant"}`)
	write(t, st, tool, llm, root, step) // deliberately out of order

	run, spans, err := st.GetRun(t.Context(), project, traceID)
	if err != nil {
		t.Fatal(err)
	}
	if run.TraceID != traceID || run.Name != "research-agent" || run.SpanCount != 4 ||
		run.LLMCallCount != 1 || run.ToolCallCount != 1 || run.TotalInputTokens != 100 {
		t.Errorf("run = %+v", run)
	}
	if !run.StartTime.Equal(t0) || run.StartTime.Location().String() != "UTC" {
		t.Errorf("start_time = %v, want %v in UTC", run.StartTime, t0)
	}

	var order []string
	for _, s := range spans {
		order = append(order, s.Name)
	}
	if want := []string{"research-agent", "step-1", "chat x", "calculator"}; !slices.Equal(order, want) {
		t.Errorf("span order = %v, want %v", order, want)
	}
	got := spans[3]
	if got.ParentSpanID == nil || *got.ParentSpanID != step.SpanID || got.Status != "error" ||
		string(got.Error) != `{"type": "CalculatorError", "message": "bad"}` {
		t.Errorf("tool span = %+v", got)
	}
	if spans[0].Output != nil || spans[0].Error != nil || spans[0].ParentSpanID != nil {
		t.Errorf("root span nulls not preserved: %+v", spans[0])
	}
	if string(spans[0].Input) != `{"question": "why?"}` {
		t.Errorf("root input = %s", spans[0].Input)
	}
}

func TestGetRunIsScopedToProject(t *testing.T) {
	st := pgtest.Store(t)
	owner, other := pgtest.Project(t, st), pgtest.Project(t, st)
	write(t, st, span(owner, "aaaaaaaaaaaaaaaa", nil, "run", "agent", 0, 10))

	if _, _, err := st.GetRun(t.Context(), other, traceID); !errors.Is(err, store.ErrNotFound) {
		t.Errorf("other project: err = %v, want ErrNotFound", err)
	}
	if _, _, err := st.GetRun(t.Context(), owner, "ffffffffffffffffffffffffffffffff"); !errors.Is(err, store.ErrNotFound) {
		t.Errorf("unknown trace: err = %v, want ErrNotFound", err)
	}
}
