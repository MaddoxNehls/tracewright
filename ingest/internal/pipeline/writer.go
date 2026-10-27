package pipeline

import (
	"context"
	"log/slog"
	"math/rand/v2"
	"slices"
	"sync"
	"time"

	"github.com/MaddoxNehls/tracewright/ingest/internal/metrics"
	"github.com/MaddoxNehls/tracewright/ingest/internal/store"
)

// SpanWriter persists spans; *store.Store implements it.
type SpanWriter interface {
	WriteSpans(ctx context.Context, spans []store.Span) (inserted int64, err error)
}

// WriterConfig tunes batching and retries.
type WriterConfig struct {
	Writers      int
	MaxSpans     int           // flush when a batch reaches this many spans
	MaxWait      time.Duration // or when its first span has waited this long
	MaxAttempts  int           // total tries per batch, including the first
	RetryBackoff time.Duration // base delay; doubles each retry, with jitter
	// IsPermanent classifies errors that retrying cannot fix. Defaults to store.IsPermanent.
	IsPermanent func(error) bool
}

func (c *WriterConfig) setDefaults() {
	c.Writers = max(c.Writers, 1)
	c.MaxSpans = max(c.MaxSpans, 1)
	if c.MaxWait <= 0 {
		c.MaxWait = 200 * time.Millisecond
	}
	if c.MaxAttempts <= 0 {
		c.MaxAttempts = 5
	}
	if c.RetryBackoff <= 0 {
		c.RetryBackoff = 100 * time.Millisecond
	}
	if c.IsPermanent == nil {
		c.IsPermanent = store.IsPermanent
	}
}

// Writers is a pool of goroutines that drain a Queue into a SpanWriter.
type Writers struct {
	q       *Queue
	sw      SpanWriter
	cfg     WriterConfig
	log     *slog.Logger
	metrics *metrics.Metrics

	abort context.CancelFunc // cancels in-flight writes when shutdown runs out of time
	wg    sync.WaitGroup
}

// StartWriters launches cfg.Writers goroutines.
func StartWriters(q *Queue, sw SpanWriter, cfg WriterConfig, log *slog.Logger, m *metrics.Metrics) *Writers {
	cfg.setDefaults()
	ctx, abort := context.WithCancel(context.Background())
	w := &Writers{q: q, sw: sw, cfg: cfg, log: log, metrics: m, abort: abort}
	for range cfg.Writers {
		w.wg.Go(func() { w.run(ctx) })
	}
	return w
}

// Shutdown closes the queue and waits for writers to flush everything already
// accepted. If ctx expires first, in-flight writes are cancelled and the
// unwritten spans are reported as lost.
func (w *Writers) Shutdown(ctx context.Context) error {
	w.q.Close()
	done := make(chan struct{})
	go func() { w.wg.Wait(); close(done) }()

	select {
	case <-done:
		return nil
	case <-ctx.Done():
		w.abort()
		<-done
		return ctx.Err()
	}
}

func (w *Writers) run(ctx context.Context) {
	for {
		first, ok := w.q.receive()
		if !ok {
			return
		}
		batches := w.collect(first)
		w.flush(ctx, batches)
	}
}

// collect coalesces queued batches behind first until the batch is full, the
// wait budget is spent, or the queue closes.
func (w *Writers) collect(first Batch) []Batch {
	batches := []Batch{first}
	n := len(first.Spans)
	timer := time.NewTimer(w.cfg.MaxWait)
	defer timer.Stop()

	for n < w.cfg.MaxSpans {
		select {
		case b, ok := <-w.q.channel():
			if !ok {
				return batches
			}
			w.q.release(b)
			batches = append(batches, b)
			n += len(b.Spans)
		case <-timer.C:
			return batches
		}
	}
	return batches
}

func (w *Writers) flush(ctx context.Context, batches []Batch) {
	spans := make([]store.Span, 0, w.cfg.MaxSpans)
	for _, b := range batches {
		spans = append(spans, b.Spans...)
	}
	err := w.write(ctx, spans)
	if err == nil {
		return
	}
	// Validation should make permanent failures impossible, but if one slips
	// through, don't let a single bad request take down the requests that
	// happened to be coalesced with it.
	if len(batches) > 1 && w.cfg.IsPermanent(err) {
		for _, b := range batches {
			if err := w.write(ctx, b.Spans); err != nil {
				w.fail(b.Spans, err)
			}
		}
		return
	}
	w.fail(spans, err)
}

// write persists spans, retrying transient failures with jittered exponential backoff.
func (w *Writers) write(ctx context.Context, spans []store.Span) error {
	start := time.Now()
	defer func() { w.metrics.BatchDuration.Observe(time.Since(start).Seconds()) }()

	backoff := w.cfg.RetryBackoff
	var err error
	for attempt := 1; ; attempt++ {
		var inserted int64
		inserted, err = w.sw.WriteSpans(ctx, spans)
		if err == nil {
			w.metrics.SpansWritten.Add(float64(inserted))
			return nil
		}
		if attempt == w.cfg.MaxAttempts || w.cfg.IsPermanent(err) || ctx.Err() != nil {
			return err
		}
		w.log.Warn("batch write failed, retrying",
			"attempt", attempt, "spans", len(spans), "err", err)

		delay := backoff/2 + rand.N(backoff/2+1)
		backoff = min(backoff*2, 5*time.Second)
		select {
		case <-time.After(delay):
		case <-ctx.Done():
			return err
		}
	}
}

func (w *Writers) fail(spans []store.Span, err error) {
	w.metrics.WriteFailures.Inc()
	traces := make([]string, 0, len(spans))
	for _, s := range spans {
		traces = append(traces, s.TraceID)
	}
	slices.Sort(traces)
	w.log.Error("dropping batch after write failure",
		"spans", len(spans), "traces", slices.Compact(traces), "err", err)
}
