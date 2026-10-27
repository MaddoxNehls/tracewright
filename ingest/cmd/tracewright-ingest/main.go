// Command tracewright-ingest receives agent spans over HTTP and writes them to
// Postgres. Run with no arguments (or "serve") to start the server, or
// "admin ..." to manage projects and API keys.
package main

import (
	"context"
	"errors"
	"fmt"
	"log/slog"
	"net/http"
	"os"
	"os/signal"
	"strconv"
	"syscall"
	"time"

	"github.com/prometheus/client_golang/prometheus"

	"github.com/MaddoxNehls/tracewright/ingest/internal/api"
	"github.com/MaddoxNehls/tracewright/ingest/internal/config"
	"github.com/MaddoxNehls/tracewright/ingest/internal/metrics"
	"github.com/MaddoxNehls/tracewright/ingest/internal/pipeline"
	"github.com/MaddoxNehls/tracewright/ingest/internal/pricing"
	"github.com/MaddoxNehls/tracewright/ingest/internal/store"
)

// shutdownTimeout bounds how long we wait for in-flight requests and the
// queue to drain; orchestrators typically SIGKILL after 30s.
const shutdownTimeout = 25 * time.Second

func main() {
	ctx, stop := signal.NotifyContext(context.Background(), os.Interrupt, syscall.SIGTERM)
	defer stop()

	var err error
	switch args := os.Args[1:]; {
	case len(args) == 0 || args[0] == "serve":
		err = serve(ctx, stop)
	case args[0] == "admin":
		err = runAdmin(ctx, args[1:])
	default:
		err = fmt.Errorf("unknown command %q\n\n%s", args[0], usage)
	}
	if err != nil {
		fmt.Fprintln(os.Stderr, "error:", err)
		os.Exit(1)
	}
}

const usage = `usage:
  tracewright-ingest [serve]
  tracewright-ingest admin create-project --slug SLUG --name NAME [--public]
  tracewright-ingest admin create-key --project SLUG`

func serve(ctx context.Context, stopSignals context.CancelFunc) error {
	log := slog.New(slog.NewJSONHandler(os.Stdout, nil))
	slog.SetDefault(log)

	cfg, err := config.Load(os.Getenv)
	if err != nil {
		return err
	}
	prices, err := pricing.Default()
	if err != nil {
		return err
	}

	// Writers each hold a connection for a whole flush; leave headroom for auth lookups.
	st, err := store.Open(ctx, cfg.DatabaseURL, int32(cfg.Writers+4))
	if err != nil {
		return err
	}
	defer st.Close()

	applied, err := st.Migrate(ctx)
	if err != nil {
		return err
	}
	if len(applied) > 0 {
		log.Info("applied migrations", "migrations", applied)
	}

	reg := prometheus.NewRegistry()
	m := metrics.New(reg)
	queue := pipeline.NewQueue(cfg.QueueCapacity, cfg.QueueMaxBytes)
	metrics.RegisterQueueDepth(reg, func() float64 { return float64(queue.Depth()) })

	writers := pipeline.StartWriters(queue, st, pipeline.WriterConfig{
		Writers:  cfg.Writers,
		MaxSpans: cfg.BatchMaxSpans,
		MaxWait:  cfg.BatchMaxWait,
	}, log, m)

	handler := &api.Handler{
		Auth:     api.NewAuthenticator(st, api.AuthConfig{}),
		Queue:    queue,
		Prices:   prices,
		Metrics:  m,
		Gatherer: reg,
		Log:      log,
	}
	srv := &http.Server{
		Addr:              ":" + strconv.Itoa(cfg.Port),
		Handler:           handler.Routes(),
		ReadHeaderTimeout: 5 * time.Second,
		ReadTimeout:       30 * time.Second,
		WriteTimeout:      30 * time.Second,
		IdleTimeout:       2 * time.Minute,
		ErrorLog:          slog.NewLogLogger(log.Handler(), slog.LevelWarn),
	}

	serveErr := make(chan error, 1)
	go func() { serveErr <- srv.ListenAndServe() }()
	log.Info("listening", "addr", srv.Addr, "writers", cfg.Writers,
		"queue_capacity", cfg.QueueCapacity, "batch_max_spans", cfg.BatchMaxSpans,
		"batch_max_wait", cfg.BatchMaxWait.String())

	select {
	case err = <-serveErr: // failed to start, e.g. port in use; still drain below
	case <-ctx.Done():
	}
	stopSignals() // a second Ctrl-C now kills the process immediately
	log.Info("shutting down: no longer accepting requests, draining queue", "queued_spans", queue.Depth())

	shutdownCtx, cancel := context.WithTimeout(context.Background(), shutdownTimeout)
	defer cancel()
	// Order matters: stop admitting requests first, so nothing is enqueued
	// after the writers have been told to finish.
	if err := srv.Shutdown(shutdownCtx); err != nil {
		log.Warn("http shutdown incomplete", "err", err)
	}
	if err := writers.Shutdown(shutdownCtx); err != nil {
		log.Error("queue drain timed out; unwritten batches were dropped (see write failure logs)", "err", err)
	} else {
		log.Info("queue drained")
	}

	if err != nil && !errors.Is(err, http.ErrServerClosed) {
		return err
	}
	return nil
}
