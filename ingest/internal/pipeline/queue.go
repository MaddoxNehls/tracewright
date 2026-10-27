// Package pipeline decouples HTTP request handling from Postgres writes: a
// bounded in-memory queue absorbs bursts, and batch writers drain it.
package pipeline

import (
	"errors"
	"sync"

	"github.com/MaddoxNehls/tracewright/ingest/internal/store"
)

var (
	// ErrFull means accepting the batch would exceed the queue's span or byte budget.
	ErrFull = errors.New("queue full")
	// ErrClosed means the service is shutting down.
	ErrClosed = errors.New("queue closed")
)

// Batch is the spans of one accepted request. Requests are admitted or
// rejected whole, so a client never has to work out which spans got in.
type Batch struct {
	Spans []store.Span
	Bytes int // payload size, charged against the byte budget
}

// Queue is a bounded FIFO of batches with separate span and byte budgets.
// Span count alone doesn't bound memory: one span may carry megabytes of input.
type Queue struct {
	ch chan Batch

	mu       sync.Mutex
	closed   bool
	spans    int
	bytes    int
	maxSpans int
	maxBytes int
}

// NewQueue returns a queue holding at most maxSpans spans and maxBytes bytes.
func NewQueue(maxSpans, maxBytes int) *Queue {
	return &Queue{
		// One slot per span: since every batch holds at least one span, a
		// batch that fits the span budget always finds a free channel slot.
		ch:       make(chan Batch, maxSpans),
		maxSpans: maxSpans,
		maxBytes: maxBytes,
	}
}

// TryEnqueue admits b without blocking, or returns ErrFull or ErrClosed.
func (q *Queue) TryEnqueue(b Batch) error {
	if len(b.Spans) == 0 {
		return nil
	}
	q.mu.Lock()
	defer q.mu.Unlock()
	if q.closed {
		return ErrClosed
	}
	if q.spans+len(b.Spans) > q.maxSpans || q.bytes+b.Bytes > q.maxBytes {
		return ErrFull
	}
	q.spans += len(b.Spans)
	q.bytes += b.Bytes
	q.ch <- b // cannot block; see NewQueue
	return nil
}

// Depth returns the number of spans waiting for a writer.
func (q *Queue) Depth() int {
	q.mu.Lock()
	defer q.mu.Unlock()
	return q.spans
}

// Close stops admission. Batches already queued remain available to writers,
// which exit once the queue is drained.
func (q *Queue) Close() {
	q.mu.Lock()
	defer q.mu.Unlock()
	if !q.closed {
		q.closed = true
		close(q.ch)
	}
}

// receive blocks for the next batch and frees its budget. ok is false once
// the queue is closed and empty.
func (q *Queue) receive() (Batch, bool) {
	b, ok := <-q.ch
	if ok {
		q.release(b)
	}
	return b, ok
}

// channel lets a writer select on the queue alongside its flush timer.
// Anything received this way must be passed to release.
func (q *Queue) channel() <-chan Batch { return q.ch }

func (q *Queue) release(b Batch) {
	q.mu.Lock()
	q.spans -= len(b.Spans)
	q.bytes -= b.Bytes
	q.mu.Unlock()
}
