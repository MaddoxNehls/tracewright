package store

import (
	"context"
	"errors"
	"fmt"
	"time"

	"github.com/jackc/pgx/v5"
)

// Run is a row of the runs table: the per-trace summary kept up to date by WriteSpans.
type Run struct {
	TraceID           string
	Name              string
	Status            string
	StartTime         time.Time
	EndTime           time.Time
	DurationMs        float64
	SpanCount         int
	LLMCallCount      int
	ToolCallCount     int
	TotalInputTokens  int64
	TotalOutputTokens int64
	TotalCostUSD      *float64
	Tags              []string
	Models            []string
}

// GetRun returns one run and all of its spans, ordered by start time (ties
// broken by span_id). It returns ErrNotFound if the trace does not exist in
// the project, so a key from another project learns nothing about it.
func (s *Store) GetRun(ctx context.Context, projectID, traceID string) (Run, []Span, error) {
	var run Run
	var spans []Span
	// Repeatable read so the summary and the spans come from one snapshot,
	// even if a writer commits more spans of this trace in between.
	err := pgx.BeginTxFunc(ctx, s.pool, pgx.TxOptions{IsoLevel: pgx.RepeatableRead, AccessMode: pgx.ReadOnly},
		func(tx pgx.Tx) error {
			err := tx.QueryRow(ctx, `
				SELECT trace_id, name, status, start_time, end_time, duration_ms, span_count,
				       llm_call_count, tool_call_count, total_input_tokens, total_output_tokens,
				       total_cost_usd::float8, tags, models
				FROM runs WHERE project_id = $1 AND trace_id = $2`, projectID, traceID).
				Scan(&run.TraceID, &run.Name, &run.Status, &run.StartTime, &run.EndTime, &run.DurationMs,
					&run.SpanCount, &run.LLMCallCount, &run.ToolCallCount, &run.TotalInputTokens,
					&run.TotalOutputTokens, &run.TotalCostUSD, &run.Tags, &run.Models)
			if errors.Is(err, pgx.ErrNoRows) {
				return fmt.Errorf("run %s: %w", traceID, ErrNotFound)
			}
			if err != nil {
				return fmt.Errorf("read run: %w", err)
			}

			rows, err := tx.Query(ctx, `
				SELECT span_id, parent_span_id, name, kind, start_time, end_time, status,
				       error, attributes, input, output
				FROM spans WHERE project_id = $1 AND trace_id = $2
				ORDER BY start_time, span_id`, projectID, traceID)
			if err != nil {
				return fmt.Errorf("read spans: %w", err)
			}
			spans, err = pgx.CollectRows(rows, func(row pgx.CollectableRow) (Span, error) {
				sp := Span{ProjectID: projectID, TraceID: traceID}
				err := row.Scan(&sp.SpanID, &sp.ParentSpanID, &sp.Name, &sp.Kind, &sp.StartTime,
					&sp.EndTime, &sp.Status, &sp.Error, &sp.Attributes, &sp.Input, &sp.Output)
				return sp, err
			})
			if err != nil {
				return fmt.Errorf("read spans: %w", err)
			}
			return nil
		})
	if err != nil {
		return Run{}, nil, err
	}
	run.StartTime, run.EndTime = run.StartTime.UTC(), run.EndTime.UTC()
	for i := range spans {
		spans[i].StartTime, spans[i].EndTime = spans[i].StartTime.UTC(), spans[i].EndTime.UTC()
	}
	return run, spans, nil
}
