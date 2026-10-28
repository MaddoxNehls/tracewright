package main

import (
	"context"
	"fmt"
	"time"

	"github.com/jackc/pgx/v5/pgxpool"

	"github.com/MaddoxNehls/tracewright/ingest/internal/apikey"
)

// lagProbe measures write lag: how long after its batch was built on the client a span
// row was written, i.e. spans.received_at minus the span's end_time (which the
// workload sets to the batch's build time).
type lagProbe struct {
	pool      *pgxpool.Pool
	projectID string
	// offset is the database clock minus ours. The client runs on the host and Postgres
	// in a VM, so their clocks can disagree by more than the lag being measured.
	offset time.Duration
}

type lagResult struct {
	spans              int64
	p50, p95, p99, max time.Duration
}

func newLagProbe(ctx context.Context, databaseURL, key string) (*lagProbe, error) {
	pool, err := pgxpool.New(ctx, databaseURL)
	if err != nil {
		return nil, err
	}
	p := &lagProbe{pool: pool}
	hash := apikey.Hash(key)
	if err := pool.QueryRow(ctx, `SELECT project_id FROM api_keys WHERE key_hash = $1`, hash[:]).
		Scan(&p.projectID); err != nil {
		pool.Close()
		return nil, fmt.Errorf("find the API key's project: %w", err)
	}
	if p.offset, err = clockOffset(ctx, pool); err != nil {
		pool.Close()
		return nil, err
	}
	return p, nil
}

// clockOffset estimates the server clock's offset from the round trip with the
// smallest delay (NTP's rule: the tightest sample bounds the error best).
func clockOffset(ctx context.Context, pool *pgxpool.Pool) (time.Duration, error) {
	best, bestRTT := time.Duration(0), time.Duration(1<<62)
	for range 20 {
		var server time.Time
		sent := time.Now()
		if err := pool.QueryRow(ctx, `SELECT clock_timestamp()`).Scan(&server); err != nil {
			return 0, err
		}
		rtt := time.Since(sent)
		if rtt < bestRTT {
			best, bestRTT = server.Sub(sent.Add(rtt/2)), rtt
		}
	}
	return best, nil
}

func (p *lagProbe) measure(ctx context.Context, stage string) (lagResult, error) {
	var r lagResult
	var p50, p95, p99, mx *float64
	err := p.pool.QueryRow(ctx, `
		SELECT count(*),
		       percentile_cont(0.50) WITHIN GROUP (ORDER BY lag_ms),
		       percentile_cont(0.95) WITHIN GROUP (ORDER BY lag_ms),
		       percentile_cont(0.99) WITHIN GROUP (ORDER BY lag_ms),
		       max(lag_ms)
		FROM (SELECT EXTRACT(EPOCH FROM received_at - end_time) * 1000 - $3 AS lag_ms
		      FROM spans WHERE project_id = $1 AND attributes->>'loadgen.stage' = $2) s`,
		p.projectID, stage, float64(p.offset)/float64(time.Millisecond)).
		Scan(&r.spans, &p50, &p95, &p99, &mx)
	if err != nil {
		return r, err
	}
	ms := func(v *float64) time.Duration {
		if v == nil {
			return 0
		}
		return time.Duration(*v * float64(time.Millisecond))
	}
	r.p50, r.p95, r.p99, r.max = ms(p50), ms(p95), ms(p99), ms(mx)
	return r, nil
}

func (p *lagProbe) close() { p.pool.Close() }
