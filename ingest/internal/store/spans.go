package store

import (
	"context"
	"errors"
	"fmt"
	"hash/fnv"
	"slices"
	"time"

	"github.com/jackc/pgx/v5"
	"github.com/jackc/pgx/v5/pgconn"
)

// Span is a validated span ready to persist. JSON fields hold raw JSON; a nil
// slice is stored as SQL NULL.
type Span struct {
	ProjectID    string
	TraceID      string
	SpanID       string
	ParentSpanID *string
	Name         string
	Kind         string
	StartTime    time.Time
	EndTime      time.Time
	Status       string
	Error        []byte
	Attributes   []byte
	Input        []byte
	Output       []byte

	// Denormalized from attributes so the dashboard can filter and sum cheaply.
	Model        *string
	InputTokens  *int64
	OutputTokens *int64
	CostUSD      *float64
}

var spanColumns = []string{
	"project_id", "trace_id", "span_id", "parent_span_id", "name", "kind",
	"start_time", "end_time", "status", "error", "attributes", "input", "output",
	"model", "input_tokens", "output_tokens", "cost_usd",
}

// The staging table lives for the whole connection and is emptied at commit,
// so steady-state flushes don't churn the system catalog with CREATE/DROP.
const createStageSQL = `
CREATE TEMP TABLE IF NOT EXISTS spans_stage (
    project_id     uuid        NOT NULL,
    trace_id       text        NOT NULL,
    span_id        text        NOT NULL,
    parent_span_id text,
    name           text        NOT NULL,
    kind           text        NOT NULL,
    start_time     timestamptz NOT NULL,
    end_time       timestamptz NOT NULL,
    status         text        NOT NULL,
    error          jsonb,
    attributes     jsonb       NOT NULL,
    input          jsonb,
    output         jsonb,
    model          text,
    input_tokens   bigint,
    output_tokens  bigint,
    cost_usd       numeric(12, 6)
) ON COMMIT DELETE ROWS`

const insertSpansSQL = `
INSERT INTO spans (project_id, trace_id, span_id, parent_span_id, name, kind,
                   start_time, end_time, status, error, attributes, input, output,
                   model, input_tokens, output_tokens, cost_usd)
SELECT project_id, trace_id, span_id, parent_span_id, name, kind,
       start_time, end_time, status, error, attributes, input, output,
       model, input_tokens, output_tokens, cost_usd
FROM spans_stage
ON CONFLICT (project_id, trace_id, span_id) DO NOTHING`

// recomputeRunsSQL rebuilds the runs row for every trace touched by this batch
// from the full set of stored spans, so the result is correct no matter what
// order spans arrive in. Ties on start_time break on span_id for determinism.
const recomputeRunsSQL = `
WITH affected AS (
    SELECT DISTINCT project_id, trace_id FROM spans_stage
), agg AS (
    SELECT s.project_id,
           s.trace_id,
           (array_agg(s.name ORDER BY s.start_time, s.span_id)
                FILTER (WHERE s.parent_span_id IS NULL))[1]                    AS root_name,
           (array_agg(s.name ORDER BY s.start_time, s.span_id))[1]            AS first_name,
           (array_agg(s.attributes -> 'tracewright.tags' ORDER BY s.start_time, s.span_id)
                FILTER (WHERE s.parent_span_id IS NULL))[1]                    AS root_tags,
           COALESCE(bool_or(s.parent_span_id IS NULL AND s.status = 'error'), false) AS root_errored,
           min(s.start_time)                                                   AS start_time,
           max(s.end_time)                                                     AS end_time,
           count(*)                                                            AS span_count,
           count(*) FILTER (WHERE s.kind = 'llm')                              AS llm_call_count,
           count(*) FILTER (WHERE s.kind = 'tool')                             AS tool_call_count,
           COALESCE(sum(s.input_tokens), 0)                                    AS total_input_tokens,
           COALESCE(sum(s.output_tokens), 0)                                   AS total_output_tokens,
           sum(s.cost_usd)                                                     AS total_cost_usd,
           COALESCE(array_agg(DISTINCT s.model ORDER BY s.model)
                FILTER (WHERE s.model IS NOT NULL), '{}')                      AS models
    FROM spans s
    JOIN affected a ON a.project_id = s.project_id AND a.trace_id = s.trace_id
    GROUP BY s.project_id, s.trace_id
)
INSERT INTO runs (project_id, trace_id, name, status, start_time, end_time, duration_ms,
                  span_count, llm_call_count, tool_call_count,
                  total_input_tokens, total_output_tokens, total_cost_usd,
                  tags, models, updated_at)
SELECT project_id,
       trace_id,
       COALESCE(root_name, first_name),
       CASE WHEN root_errored THEN 'error' ELSE 'ok' END,
       start_time,
       end_time,
       EXTRACT(EPOCH FROM (end_time - start_time)) * 1000,
       span_count,
       llm_call_count,
       tool_call_count,
       total_input_tokens,
       total_output_tokens,
       total_cost_usd,
       CASE WHEN jsonb_typeof(root_tags) = 'array'
            THEN ARRAY(SELECT jsonb_array_elements_text(root_tags))
            ELSE '{}'::text[] END,
       models,
       now()
FROM agg
ON CONFLICT (project_id, trace_id) DO UPDATE SET
    name                = EXCLUDED.name,
    status              = EXCLUDED.status,
    start_time          = EXCLUDED.start_time,
    end_time            = EXCLUDED.end_time,
    duration_ms         = EXCLUDED.duration_ms,
    span_count          = EXCLUDED.span_count,
    llm_call_count      = EXCLUDED.llm_call_count,
    tool_call_count     = EXCLUDED.tool_call_count,
    total_input_tokens  = EXCLUDED.total_input_tokens,
    total_output_tokens = EXCLUDED.total_output_tokens,
    total_cost_usd      = EXCLUDED.total_cost_usd,
    tags                = EXCLUDED.tags,
    models              = EXCLUDED.models,
    updated_at          = EXCLUDED.updated_at`

// WriteSpans persists a batch in a single transaction and refreshes the runs
// rows for every affected trace. Spans that already exist are skipped, which
// makes client retries safe. It returns the number of newly inserted spans.
func (s *Store) WriteSpans(ctx context.Context, spans []Span) (int64, error) {
	if len(spans) == 0 {
		return 0, nil
	}

	var inserted int64
	err := pgx.BeginFunc(ctx, s.pool, func(tx pgx.Tx) error {
		if _, err := tx.Exec(ctx, createStageSQL); err != nil {
			return fmt.Errorf("create staging table: %w", err)
		}

		if _, err := tx.CopyFrom(ctx, pgx.Identifier{"spans_stage"}, spanColumns,
			pgx.CopyFromSlice(len(spans), func(i int) ([]any, error) {
				sp := &spans[i]
				return []any{
					sp.ProjectID, sp.TraceID, sp.SpanID, sp.ParentSpanID, sp.Name, sp.Kind,
					sp.StartTime, sp.EndTime, sp.Status, sp.Error, sp.Attributes, sp.Input, sp.Output,
					sp.Model, sp.InputTokens, sp.OutputTokens, sp.CostUSD,
				}, nil
			})); err != nil {
			return fmt.Errorf("copy into staging table: %w", err)
		}

		// Two writers flushing spans of the same trace concurrently would each
		// recompute the run from a snapshot missing the other's spans, and the
		// last commit would win with stale totals. Serialize per trace instead.
		if err := lockTraces(ctx, tx, spans); err != nil {
			return err
		}

		tag, err := tx.Exec(ctx, insertSpansSQL)
		if err != nil {
			return fmt.Errorf("insert spans: %w", err)
		}
		inserted = tag.RowsAffected()
		if inserted == 0 {
			return nil // all duplicates: runs already reflect these spans
		}

		if _, err := tx.Exec(ctx, recomputeRunsSQL); err != nil {
			return fmt.Errorf("recompute runs: %w", err)
		}
		return nil
	})
	if err != nil {
		return 0, err
	}
	return inserted, nil
}

// lockTraces takes a transaction-scoped advisory lock per affected trace.
// Keys are acquired in sorted order so concurrent writers cannot deadlock.
func lockTraces(ctx context.Context, tx pgx.Tx, spans []Span) error {
	keys := make([]int64, 0, len(spans))
	for i := range spans {
		keys = append(keys, traceLockKey(spans[i].ProjectID, spans[i].TraceID))
	}
	slices.Sort(keys)
	keys = slices.Compact(keys)

	batch := &pgx.Batch{}
	for _, k := range keys {
		batch.Queue(`SELECT pg_advisory_xact_lock($1)`, k)
	}
	if err := tx.SendBatch(ctx, batch).Close(); err != nil {
		return fmt.Errorf("lock traces: %w", err)
	}
	return nil
}

func traceLockKey(projectID, traceID string) int64 {
	h := fnv.New64a()
	h.Write([]byte(projectID))
	h.Write([]byte{0})
	h.Write([]byte(traceID))
	return int64(h.Sum64())
}

// IsPermanent reports whether err will fail again on retry: bad data or a
// constraint violation, as opposed to a dropped connection or a timeout.
func IsPermanent(err error) bool {
	var pgErr *pgconn.PgError
	if !errors.As(err, &pgErr) {
		return false
	}
	switch pgErr.Code[:2] {
	case "22", // data exception
		"23": // integrity constraint violation
		return true
	}
	return false
}
