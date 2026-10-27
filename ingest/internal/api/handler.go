// Package api implements the HTTP surface of the ingest service:
// authentication, request decoding and validation, and admission into the
// write pipeline.
package api

import (
	"compress/gzip"
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"io"
	"log/slog"
	"net/http"
	"strings"
	"unicode/utf8"

	"github.com/prometheus/client_golang/prometheus"
	"github.com/prometheus/client_golang/prometheus/promhttp"

	"github.com/MaddoxNehls/tracewright/ingest/internal/config"
	"github.com/MaddoxNehls/tracewright/ingest/internal/metrics"
	"github.com/MaddoxNehls/tracewright/ingest/internal/pipeline"
	"github.com/MaddoxNehls/tracewright/ingest/internal/pricing"
)

// retryAfterSeconds is what we tell clients to wait when the queue is full.
// Writers flush at least every BATCH_MAX_WAIT, so a second is ample to free space.
const retryAfterSeconds = "1"

// Handler serves the ingest API.
type Handler struct {
	Auth     *Authenticator
	Queue    *pipeline.Queue
	Runs     RunReader
	Prices   *pricing.Table
	Metrics  *metrics.Metrics
	Gatherer prometheus.Gatherer
	Log      *slog.Logger
}

// Routes returns the service's HTTP handler with per-route latency metrics.
func (h *Handler) Routes() http.Handler {
	mux := http.NewServeMux()
	handle := func(pattern string, next http.Handler) {
		observer := h.Metrics.HTTPDuration.MustCurryWith(prometheus.Labels{"route": pattern})
		mux.Handle(pattern, promhttp.InstrumentHandlerDuration(observer, next))
	}
	handle("POST /v1/spans", h.requireAuth(http.HandlerFunc(h.postSpans)))
	handle("GET /v1/runs/{trace_id}", h.requireAuth(http.HandlerFunc(h.getRun)))
	handle("GET /healthz", http.HandlerFunc(func(w http.ResponseWriter, _ *http.Request) {
		w.Header().Set("Content-Type", "text/plain; charset=utf-8")
		io.WriteString(w, "ok")
	}))
	handle("GET /metrics", promhttp.HandlerFor(h.Gatherer, promhttp.HandlerOpts{}))
	return mux
}

// requireAuth rejects unauthenticated requests before their body is read, and
// scopes the rest of the request to the key's project.
func (h *Handler) requireAuth(next http.Handler) http.Handler {
	return http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		id, err := h.Auth.Authenticate(r.Context(), r.Header.Get("Authorization"))
		switch {
		case errors.Is(err, errUnauthorized):
			w.Header().Set("WWW-Authenticate", "Bearer")
			writeError(w, http.StatusUnauthorized, err.Error())
			return
		case err != nil:
			h.Log.Error("api key lookup failed", "err", err)
			w.Header().Set("Retry-After", retryAfterSeconds)
			writeError(w, http.StatusServiceUnavailable, "authentication temporarily unavailable")
			return
		}
		next.ServeHTTP(w, r.WithContext(context.WithValue(r.Context(), projectKey{}, id)))
	})
}

func (h *Handler) postSpans(w http.ResponseWriter, r *http.Request) {
	body, err := readBody(w, r)
	if err != nil {
		var tooLarge *http.MaxBytesError
		switch {
		case errors.As(err, &tooLarge):
			writeError(w, http.StatusRequestEntityTooLarge,
				fmt.Sprintf("request body exceeds %d bytes", config.MaxBodyBytes))
		case errors.Is(err, errUnsupportedEncoding):
			writeError(w, http.StatusUnsupportedMediaType, err.Error())
		default:
			writeError(w, http.StatusBadRequest, "could not read request body: "+err.Error())
		}
		return
	}

	var req struct {
		Spans []json.RawMessage `json:"spans"`
	}
	if !utf8.Valid(body) {
		writeError(w, http.StatusBadRequest, "request body must be valid UTF-8")
		return
	}
	sanitizeNUL(body)
	if err := json.Unmarshal(body, &req); err != nil {
		writeError(w, http.StatusBadRequest, `request body must be a JSON object like {"spans": [...]}`)
		return
	}

	n := len(req.Spans)
	h.Metrics.SpansReceived.Add(float64(n))
	if n == 0 || n > config.MaxSpansPerRequest {
		h.Metrics.SpansRejected.WithLabelValues(metrics.ReasonInvalid).Add(float64(n))
		writeError(w, http.StatusBadRequest,
			fmt.Sprintf("spans must contain 1-%d items, got %d", config.MaxSpansPerRequest, n))
		return
	}

	spans, fieldErrs := parseSpans(req.Spans, projectID(r.Context()), h.Prices)
	if len(fieldErrs) > 0 {
		h.Metrics.SpansRejected.WithLabelValues(metrics.ReasonInvalid).Add(float64(n))
		writeJSON(w, http.StatusBadRequest, map[string]any{"error": "validation failed", "details": fieldErrs})
		return
	}

	switch err := h.Queue.TryEnqueue(pipeline.Batch{Spans: spans, Bytes: len(body)}); {
	case errors.Is(err, pipeline.ErrFull):
		h.Metrics.SpansRejected.WithLabelValues(metrics.ReasonQueueFull).Add(float64(n))
		w.Header().Set("Retry-After", retryAfterSeconds)
		writeError(w, http.StatusTooManyRequests, "ingest queue is full; retry later")
	case errors.Is(err, pipeline.ErrClosed):
		w.Header().Set("Retry-After", retryAfterSeconds)
		writeError(w, http.StatusServiceUnavailable, "server is shutting down")
	case err != nil:
		h.Log.Error("enqueue failed", "err", err)
		writeError(w, http.StatusInternalServerError, "internal error")
	default:
		writeJSON(w, http.StatusAccepted, map[string]int{"accepted": n})
	}
}

var errUnsupportedEncoding = errors.New(`unsupported Content-Encoding; use "gzip" or none`)

// readBody reads the request body, decompressing gzip. The size limit applies
// to the decompressed bytes too, so a small gzip bomb can't exhaust memory.
func readBody(w http.ResponseWriter, r *http.Request) ([]byte, error) {
	body := http.MaxBytesReader(w, r.Body, config.MaxBodyBytes)
	switch strings.ToLower(strings.TrimSpace(r.Header.Get("Content-Encoding"))) {
	case "", "identity":
		return io.ReadAll(body)
	case "gzip":
		gz, err := gzip.NewReader(body)
		if err != nil {
			var tooLarge *http.MaxBytesError
			if errors.As(err, &tooLarge) {
				return nil, err
			}
			return nil, fmt.Errorf("invalid gzip stream: %w", err)
		}
		defer gz.Close()
		return io.ReadAll(http.MaxBytesReader(w, gz, config.MaxBodyBytes))
	default:
		return nil, errUnsupportedEncoding
	}
}

func writeJSON(w http.ResponseWriter, status int, v any) {
	w.Header().Set("Content-Type", "application/json")
	w.WriteHeader(status)
	json.NewEncoder(w).Encode(v)
}

func writeError(w http.ResponseWriter, status int, msg string) {
	writeJSON(w, status, map[string]string{"error": msg})
}
