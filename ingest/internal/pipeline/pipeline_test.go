package pipeline

import (
	"context"
	"errors"
	"log/slog"
	"slices"
	"sync"
	"testing"
	"time"

	"github.com/prometheus/client_golang/prometheus"
	"github.com/prometheus/client_golang/prometheus/testutil"

	"github.com/MaddoxNehls/tracewright/ingest/internal/metrics"
	"github.com/MaddoxNehls/tracewright/ingest/internal/store"
)

func batch(n int, traceID string) Batch {
	spans := make([]store.Span, n)
	for i := range spans {
		spans[i].TraceID = traceID
	}
	return Batch{Spans: spans, Bytes: n * 100}
}

func TestQueueAdmission(t *testing.T) {
	q := NewQueue(10, 1000)

	if err := q.TryEnqueue(batch(6, "a")); err != nil {
		t.Fatal(err)
	}
	if err := q.TryEnqueue(batch(5, "b")); !errors.Is(err, ErrFull) {
		t.Fatalf("over span budget: err = %v, want ErrFull", err)
	}
	if err := q.TryEnqueue(batch(4, "c")); err != nil {
		t.Fatalf("exactly at budget: %v", err)
	}
	if q.Depth() != 10 {
		t.Errorf("depth = %d, want 10", q.Depth())
	}

	b, _ := q.receive()
	if len(b.Spans) != 6 {
		t.Fatalf("FIFO violated: got batch of %d", len(b.Spans))
	}
	if err := q.TryEnqueue(batch(6, "d")); err != nil {
		t.Errorf("receiving should free budget: %v", err)
	}
}

func TestQueueByteBudget(t *testing.T) {
	q := NewQueue(1000, 500)
	if err := q.TryEnqueue(Batch{Spans: make([]store.Span, 1), Bytes: 400}); err != nil {
		t.Fatal(err)
	}
	if err := q.TryEnqueue(Batch{Spans: make([]store.Span, 1), Bytes: 200}); !errors.Is(err, ErrFull) {
		t.Errorf("over byte budget: err = %v, want ErrFull", err)
	}
}

func TestQueueClose(t *testing.T) {
	q := NewQueue(10, 1000)
	q.TryEnqueue(batch(1, "a"))
	q.Close()
	q.Close() // idempotent

	if err := q.TryEnqueue(batch(1, "b")); !errors.Is(err, ErrClosed) {
		t.Errorf("err = %v, want ErrClosed", err)
	}
	if _, ok := q.receive(); !ok {
		t.Error("batches queued before Close must still be delivered")
	}
	if _, ok := q.receive(); ok {
		t.Error("receive should report closed once drained")
	}
}

// fakeWriter records each WriteSpans call and fails according to failures.
type fakeWriter struct {
	mu       sync.Mutex
	calls    [][]store.Span
	failures []error // consumed one per call; nil entries succeed
	failOn   func([]store.Span) error
}

func (f *fakeWriter) WriteSpans(_ context.Context, spans []store.Span) (int64, error) {
	f.mu.Lock()
	defer f.mu.Unlock()
	f.calls = append(f.calls, slices.Clone(spans))
	if f.failOn != nil {
		if err := f.failOn(spans); err != nil {
			return 0, err
		}
	}
	if len(f.failures) > 0 {
		err := f.failures[0]
		f.failures = f.failures[1:]
		if err != nil {
			return 0, err
		}
	}
	return int64(len(spans)), nil
}

func (f *fakeWriter) callSizes() []int {
	f.mu.Lock()
	defer f.mu.Unlock()
	var sizes []int
	for _, c := range f.calls {
		sizes = append(sizes, len(c))
	}
	return sizes
}

var errPermanent = errors.New("permanent")

func newWriters(t *testing.T, q *Queue, fw *fakeWriter, cfg WriterConfig) (*Writers, *metrics.Metrics) {
	t.Helper()
	m := metrics.New(prometheus.NewRegistry())
	cfg.RetryBackoff = time.Millisecond
	cfg.IsPermanent = func(err error) bool { return errors.Is(err, errPermanent) }
	return StartWriters(q, fw, cfg, slog.New(slog.DiscardHandler), m), m
}

func TestWritersCoalesceUpToMaxSpans(t *testing.T) {
	q := NewQueue(1000, 1<<20)
	for range 5 {
		q.TryEnqueue(batch(3, "t"))
	}
	fw := &fakeWriter{}
	// A long wait proves flushes are triggered by size, not time.
	w, m := newWriters(t, q, fw, WriterConfig{Writers: 1, MaxSpans: 6, MaxWait: time.Hour})
	waitFor(t, func() bool { return testutil.ToFloat64(m.SpansWritten) == 12 })

	if got := fw.callSizes(); !slices.Equal(got, []int{6, 6}) {
		t.Errorf("flush sizes = %v, want [6 6]", got)
	}
	// Shutdown drains the remaining 3 spans even though the batch isn't full.
	if err := w.Shutdown(context.Background()); err != nil {
		t.Fatal(err)
	}
	if got := fw.callSizes(); !slices.Equal(got, []int{6, 6, 3}) {
		t.Errorf("flush sizes after shutdown = %v, want [6 6 3]", got)
	}
}

func TestWritersFlushOnMaxWait(t *testing.T) {
	q := NewQueue(1000, 1<<20)
	fw := &fakeWriter{}
	w, m := newWriters(t, q, fw, WriterConfig{Writers: 1, MaxSpans: 1000, MaxWait: 20 * time.Millisecond})
	defer w.Shutdown(context.Background())

	q.TryEnqueue(batch(2, "t"))
	waitFor(t, func() bool { return testutil.ToFloat64(m.SpansWritten) == 2 })
}

func TestWritersRetryTransientErrors(t *testing.T) {
	q := NewQueue(1000, 1<<20)
	fw := &fakeWriter{failures: []error{errors.New("conn reset"), errors.New("conn reset")}}
	w, m := newWriters(t, q, fw, WriterConfig{Writers: 1, MaxWait: time.Millisecond, MaxAttempts: 5})
	q.TryEnqueue(batch(4, "t"))
	w.Shutdown(context.Background())

	if got := len(fw.callSizes()); got != 3 {
		t.Errorf("attempts = %d, want 3", got)
	}
	if testutil.ToFloat64(m.SpansWritten) != 4 || testutil.ToFloat64(m.WriteFailures) != 0 {
		t.Errorf("written = %v, failures = %v", testutil.ToFloat64(m.SpansWritten), testutil.ToFloat64(m.WriteFailures))
	}
}

func TestWritersGiveUpAfterMaxAttempts(t *testing.T) {
	q := NewQueue(1000, 1<<20)
	transient := errors.New("conn reset")
	fw := &fakeWriter{failures: []error{transient, transient, transient}}
	w, m := newWriters(t, q, fw, WriterConfig{Writers: 1, MaxWait: time.Millisecond, MaxAttempts: 3})
	q.TryEnqueue(batch(4, "t"))
	w.Shutdown(context.Background())

	if got := len(fw.callSizes()); got != 3 {
		t.Errorf("attempts = %d, want 3", got)
	}
	if testutil.ToFloat64(m.WriteFailures) != 1 {
		t.Errorf("write_failures_total = %v, want 1", testutil.ToFloat64(m.WriteFailures))
	}
}

func TestWritersIsolatePoisonBatch(t *testing.T) {
	q := NewQueue(1000, 1<<20)
	q.TryEnqueue(batch(2, "good-1"))
	q.TryEnqueue(batch(3, "poison"))
	q.TryEnqueue(batch(4, "good-2"))

	fw := &fakeWriter{failOn: func(spans []store.Span) error {
		if slices.ContainsFunc(spans, func(s store.Span) bool { return s.TraceID == "poison" }) {
			return errPermanent
		}
		return nil
	}}
	w, m := newWriters(t, q, fw, WriterConfig{Writers: 1, MaxSpans: 1000, MaxWait: 50 * time.Millisecond})
	w.Shutdown(context.Background())

	// One combined attempt (no retries for a permanent error), then one per request.
	if got := fw.callSizes(); !slices.Equal(got, []int{9, 2, 3, 4}) {
		t.Errorf("write calls = %v, want [9 2 3 4]", got)
	}
	if testutil.ToFloat64(m.SpansWritten) != 6 || testutil.ToFloat64(m.WriteFailures) != 1 {
		t.Errorf("written = %v, failures = %v", testutil.ToFloat64(m.SpansWritten), testutil.ToFloat64(m.WriteFailures))
	}
}

func TestShutdownTimeoutAbortsRetries(t *testing.T) {
	q := NewQueue(1000, 1<<20)
	fw := &fakeWriter{failOn: func([]store.Span) error { return errors.New("db down") }}
	m := metrics.New(prometheus.NewRegistry())
	w := StartWriters(q, fw, WriterConfig{
		Writers: 1, MaxWait: time.Millisecond, MaxAttempts: 1000, RetryBackoff: 10 * time.Millisecond,
	}, slog.New(slog.DiscardHandler), m)
	q.TryEnqueue(batch(1, "t"))

	ctx, cancel := context.WithTimeout(context.Background(), 50*time.Millisecond)
	defer cancel()
	start := time.Now()
	if err := w.Shutdown(ctx); !errors.Is(err, context.DeadlineExceeded) {
		t.Errorf("err = %v, want DeadlineExceeded", err)
	}
	if time.Since(start) > 2*time.Second {
		t.Error("shutdown did not abort the retry loop promptly")
	}
	if testutil.ToFloat64(m.WriteFailures) != 1 {
		t.Errorf("aborted batch should count as a write failure")
	}
}

func waitFor(t *testing.T, cond func() bool) {
	t.Helper()
	deadline := time.Now().Add(5 * time.Second)
	for !cond() {
		if time.Now().After(deadline) {
			t.Fatal("condition not met within 5s")
		}
		time.Sleep(5 * time.Millisecond)
	}
}
