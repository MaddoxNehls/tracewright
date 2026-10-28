package main

import (
	"crypto/rand"
	"encoding/hex"
	"fmt"
	mathrand "math/rand/v2"
	"strings"
	"time"
)

// wireSpan is the contract's Span JSON.
type wireSpan struct {
	TraceID      string         `json:"trace_id"`
	SpanID       string         `json:"span_id"`
	ParentSpanID *string        `json:"parent_span_id"`
	Name         string         `json:"name"`
	Kind         string         `json:"kind"`
	StartTime    string         `json:"start_time"`
	EndTime      string         `json:"end_time"`
	Status       string         `json:"status"`
	Error        map[string]any `json:"error"`
	Attributes   map[string]any `json:"attributes"`
	Input        any            `json:"input"`
	Output       any            `json:"output"`
}

// workload generates research-agent-shaped traces: a root agent span, then steps of
// {step span, LLM call with a multi-KB prompt, tool call}. Timestamps are filled in when
// a batch is cut, so a span's end_time is the moment its batch was built; the write lag
// query relies on that.
type workload struct {
	rng           *mathrand.Rand
	spansPerTrace int
	payloadMin    int
	payloadMax    int
	stage         string
	pending       []wireSpan
}

func newWorkload(seed uint64, spansPerTrace, payloadMin, payloadMax int, stage string) *workload {
	return &workload{
		rng:           mathrand.New(mathrand.NewPCG(seed, seed^0x9e3779b97f4a7c15)),
		spansPerTrace: max(spansPerTrace, 2),
		payloadMin:    payloadMin,
		payloadMax:    max(payloadMax, payloadMin),
		stage:         stage,
	}
}

// batch returns the next n spans, starting new traces as needed.
func (w *workload) batch(n int) []wireSpan {
	for len(w.pending) < n {
		w.pending = append(w.pending, w.trace()...)
	}
	out := make([]wireSpan, n)
	copy(out, w.pending[:n])
	w.pending = w.pending[n:]

	now := time.Now().UTC()
	for i := range out {
		dur := time.Duration(5+w.rng.IntN(50)) * time.Millisecond
		if out[i].Kind == "llm" {
			dur = time.Duration(300+w.rng.IntN(2500)) * time.Millisecond
		}
		out[i].EndTime = now.Format(time.RFC3339Nano)
		out[i].StartTime = now.Add(-dur).Format(time.RFC3339Nano)
	}
	return out
}

func (w *workload) trace() []wireSpan {
	traceID := randomHex(16)
	attrs := func(extra map[string]any) map[string]any {
		extra["loadgen.stage"] = w.stage
		return extra
	}
	root := wireSpan{
		TraceID: traceID, SpanID: randomHex(8), Name: "research-agent", Kind: "agent", Status: "ok",
		Attributes: attrs(map[string]any{"tracewright.tags": []string{"loadgen"}}),
		Input:      map[string]any{"question": w.words(20)},
	}
	spans := []wireSpan{root}
	for step := 1; len(spans) < w.spansPerTrace; step++ {
		stepSpan := wireSpan{
			TraceID: traceID, SpanID: randomHex(8), ParentSpanID: &root.SpanID,
			Name: fmt.Sprintf("step-%d", step), Kind: "custom", Status: "ok",
			Attributes: attrs(map[string]any{"agent.step": step}),
		}
		llm := wireSpan{
			TraceID: traceID, SpanID: randomHex(8), ParentSpanID: &stepSpan.SpanID,
			Name: "chat claude-opus-5-5", Kind: "llm", Status: "ok",
			Attributes: attrs(map[string]any{
				"gen_ai.provider.name":           "anthropic",
				"gen_ai.operation.name":          "chat",
				"gen_ai.request.model":           "claude-opus-5-5",
				"gen_ai.response.model":          "claude-opus-5-5",
				"gen_ai.usage.input_tokens":      1000 + w.rng.IntN(1500),
				"gen_ai.usage.output_tokens":     50 + w.rng.IntN(400),
				"gen_ai.response.finish_reasons": []string{"tool_use"},
			}),
			Input: map[string]any{
				"system":   "You are a careful research assistant.",
				"messages": []map[string]any{{"role": "user", "content": w.text(w.payloadMin + w.rng.IntN(w.payloadMax-w.payloadMin+1))}},
			},
			Output: map[string]any{"role": "assistant", "content": w.text(300 + w.rng.IntN(500))},
		}
		tool := wireSpan{
			TraceID: traceID, SpanID: randomHex(8), ParentSpanID: &stepSpan.SpanID,
			Name: "search_corpus", Kind: "tool", Status: "ok",
			Attributes: attrs(map[string]any{"gen_ai.tool.name": "search_corpus"}),
			Input:      map[string]any{"query": w.words(5)},
			Output:     []map[string]any{{"doc_id": "apollo-11", "excerpt": w.text(250)}},
		}
		if w.rng.IntN(20) == 0 { // the occasional failed tool call
			tool.Status = "error"
			tool.Error = map[string]any{"type": "TimeoutError", "message": "search backend timed out"}
		}
		spans = append(spans, stepSpan, llm, tool)
	}
	return spans[:w.spansPerTrace]
}

// vocabulary keeps prompts compressing roughly like English text does under gzip.
var vocabulary = strings.Fields(`the a of and to in is was for on that with as by at from it
mission launch orbit moon lunar apollo rocket crew module landing spacecraft program
nasa soviet first flight earth station shuttle engine fuel stage samples kilograms
year days hours history research article source answer question search result note
calculate total share percent between after before during which who when how many
returned collected surface astronaut cosmonaut satellite telescope probe voyager
record achieved reached interstellar space agency budget design test failure success`)

func (w *workload) words(n int) string {
	var b strings.Builder
	for i := range n {
		if i > 0 {
			b.WriteByte(' ')
		}
		b.WriteString(vocabulary[w.rng.IntN(len(vocabulary))])
	}
	return b.String()
}

// text returns about n bytes of word salad.
func (w *workload) text(n int) string {
	var b strings.Builder
	b.Grow(n + 16)
	for b.Len() < n {
		if b.Len() > 0 {
			b.WriteByte(' ')
		}
		b.WriteString(vocabulary[w.rng.IntN(len(vocabulary))])
	}
	return b.String()
}

func randomHex(bytes int) string {
	b := make([]byte, bytes)
	rand.Read(b)
	return hex.EncodeToString(b)
}
