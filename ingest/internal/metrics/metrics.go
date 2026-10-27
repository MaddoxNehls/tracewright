// Package metrics defines the service's Prometheus instruments.
package metrics

import (
	"github.com/prometheus/client_golang/prometheus"
	"github.com/prometheus/client_golang/prometheus/collectors"
)

const namespace = "tracewright"

// Rejection reasons for SpansRejected. Only cases where the span count is
// known are counted; requests rejected before parsing (401, 413, malformed
// JSON) show up in HTTPDuration's status code label instead.
const (
	ReasonInvalid   = "invalid"
	ReasonQueueFull = "queue_full"
)

// Metrics groups every instrument the service records.
type Metrics struct {
	SpansReceived prometheus.Counter
	SpansWritten  prometheus.Counter
	SpansRejected *prometheus.CounterVec
	WriteFailures prometheus.Counter
	BatchDuration prometheus.Histogram
	HTTPDuration  *prometheus.HistogramVec
}

// New creates the instruments and registers them, plus Go runtime and process
// collectors, on reg. Passing a fresh registry keeps tests isolated.
func New(reg prometheus.Registerer) *Metrics {
	m := &Metrics{
		SpansReceived: prometheus.NewCounter(prometheus.CounterOpts{
			Namespace: namespace, Name: "spans_received_total",
			Help: "Spans in authenticated, well-formed requests, before validation.",
		}),
		SpansWritten: prometheus.NewCounter(prometheus.CounterOpts{
			Namespace: namespace, Name: "spans_written_total",
			Help: "Spans newly inserted into Postgres (idempotent re-sends are not counted).",
		}),
		SpansRejected: prometheus.NewCounterVec(prometheus.CounterOpts{
			Namespace: namespace, Name: "spans_rejected_total",
			Help: "Spans rejected at the API, by reason.",
		}, []string{"reason"}),
		WriteFailures: prometheus.NewCounter(prometheus.CounterOpts{
			Namespace: namespace, Name: "write_failures_total",
			Help: "Batches dropped after exhausting write retries.",
		}),
		BatchDuration: prometheus.NewHistogram(prometheus.HistogramOpts{
			Namespace: namespace, Name: "batch_write_duration_seconds",
			Help:    "Time to write one batch to Postgres, including retries.",
			Buckets: prometheus.ExponentialBuckets(0.002, 2, 12), // 2ms .. ~4s
		}),
		HTTPDuration: prometheus.NewHistogramVec(prometheus.HistogramOpts{
			Namespace: namespace, Name: "http_request_duration_seconds",
			Help:    "HTTP request latency by route, method, and status code.",
			Buckets: prometheus.DefBuckets,
		}, []string{"route", "method", "code"}),
	}
	for _, reason := range []string{ReasonInvalid, ReasonQueueFull} {
		m.SpansRejected.WithLabelValues(reason) // export zeros so rate() works from the start
	}
	reg.MustRegister(
		m.SpansReceived, m.SpansWritten, m.SpansRejected, m.WriteFailures,
		m.BatchDuration, m.HTTPDuration,
		collectors.NewGoCollector(),
		collectors.NewProcessCollector(collectors.ProcessCollectorOpts{}),
	)
	return m
}

// RegisterQueueDepth exposes the live queue depth, sampled at scrape time.
func RegisterQueueDepth(reg prometheus.Registerer, depth func() float64) {
	reg.MustRegister(prometheus.NewGaugeFunc(prometheus.GaugeOpts{
		Namespace: namespace, Name: "queue_depth",
		Help: "Spans accepted but not yet picked up by a writer.",
	}, depth))
}
