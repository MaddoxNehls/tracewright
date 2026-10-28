// Command loadgen drives sustained load at the ingest service and reports throughput,
// request latency, backpressure (429s), and write lag.
//
// It ramps through a list of client concurrencies. Each stage runs closed-loop clients
// for a fixed duration, waits for ingest's queue to drain, and diffs /metrics around it,
// so "written/s" counts only spans that actually reached Postgres:
//
//	go run ./cmd/loadgen -key tw_... -concurrency 1,4,16,64 -duration 30s \
//	    -database-url postgres://tracewright:tracewright@localhost:5442/tracewright
package main

import (
	"context"
	"encoding/json"
	"errors"
	"flag"
	"fmt"
	"io"
	"net/http"
	"os"
	"os/signal"
	"strconv"
	"strings"
	"sync"
	"text/tabwriter"
	"time"
)

type config struct {
	url           string
	key           string
	databaseURL   string
	concurrency   []int
	batch         int
	spansPerTrace int
	payloadMin    int
	payloadMax    int
	duration      time.Duration
	gzip          bool
	label         string
	jsonOut       string
}

// result is one stage's numbers, as printed and as written with -json.
type result struct {
	Label           string  `json:"label"`
	Concurrency     int     `json:"concurrency"`
	DurationS       float64 `json:"duration_s"`
	DrainS          float64 `json:"drain_s"`
	Requests        int     `json:"requests"`
	AcceptedSpansPS float64 `json:"accepted_spans_per_s"`
	WrittenSpansPS  float64 `json:"written_spans_per_s"`
	ThrottledPct    float64 `json:"throttled_pct"`
	Failed          int     `json:"failed"`
	WireMBPS        float64 `json:"wire_mb_per_s"`
	RawMBPS         float64 `json:"raw_mb_per_s"`
	P50Ms           float64 `json:"latency_p50_ms"`
	P95Ms           float64 `json:"latency_p95_ms"`
	P99Ms           float64 `json:"latency_p99_ms"`
	MeanFlushMs     float64 `json:"mean_flush_ms"`
	MeanFlushSpans  float64 `json:"mean_flush_spans"`
	MaxQueueDepth   float64 `json:"max_queue_depth"`
	WriteFailures   float64 `json:"write_failures"`
	LagP50Ms        float64 `json:"write_lag_p50_ms,omitempty"`
	LagP95Ms        float64 `json:"write_lag_p95_ms,omitempty"`
	LagP99Ms        float64 `json:"write_lag_p99_ms,omitempty"`
	LagMaxMs        float64 `json:"write_lag_max_ms,omitempty"`
	LagSampledSpans int64   `json:"write_lag_spans,omitempty"`
}

func main() {
	cfg, err := parseFlags(os.Args[1:])
	if err != nil {
		fmt.Fprintln(os.Stderr, "error:", err)
		os.Exit(2)
	}
	ctx, stop := signal.NotifyContext(context.Background(), os.Interrupt)
	defer stop()
	results, err := run(ctx, cfg, os.Stderr)
	if len(results) > 0 {
		printTable(os.Stdout, results)
	}
	if cfg.jsonOut != "" && len(results) > 0 {
		data, _ := json.MarshalIndent(results, "", "  ")
		if werr := os.WriteFile(cfg.jsonOut, append(data, '\n'), 0o644); werr != nil {
			err = errors.Join(err, werr)
		}
	}
	if err != nil {
		fmt.Fprintln(os.Stderr, "error:", err)
		os.Exit(1)
	}
}

func parseFlags(args []string) (config, error) {
	fs := flag.NewFlagSet("loadgen", flag.ContinueOnError)
	var cfg config
	var concurrency string
	fs.StringVar(&cfg.url, "url", "http://localhost:4318", "ingest base URL")
	fs.StringVar(&cfg.key, "key", os.Getenv("TRACEWRIGHT_API_KEY"), "API key (default $TRACEWRIGHT_API_KEY)")
	fs.StringVar(&cfg.databaseURL, "database-url", "", "Postgres URL; enables the write lag measurement")
	fs.StringVar(&concurrency, "concurrency", "1,4,16", "comma-separated client counts to ramp through")
	fs.IntVar(&cfg.batch, "batch", 100, "spans per request (1-1000)")
	fs.IntVar(&cfg.spansPerTrace, "spans-per-trace", 31, "spans per generated trace (1 root + 3 per step)")
	fs.IntVar(&cfg.payloadMin, "payload-min", 4096, "min LLM prompt bytes")
	fs.IntVar(&cfg.payloadMax, "payload-max", 8192, "max LLM prompt bytes")
	fs.DurationVar(&cfg.duration, "duration", 30*time.Second, "how long each stage sends")
	fs.BoolVar(&cfg.gzip, "gzip", true, "gzip request bodies, as the SDKs do")
	fs.StringVar(&cfg.label, "label", "", "experiment label for the output")
	fs.StringVar(&cfg.jsonOut, "json", "", "also write results to this JSON file")
	if err := fs.Parse(args); err != nil {
		return cfg, err
	}
	for _, part := range strings.Split(concurrency, ",") {
		n, err := strconv.Atoi(strings.TrimSpace(part))
		if err != nil || n < 1 {
			return cfg, fmt.Errorf("invalid -concurrency %q", concurrency)
		}
		cfg.concurrency = append(cfg.concurrency, n)
	}
	switch {
	case cfg.key == "":
		return cfg, errors.New("an API key is required (-key or TRACEWRIGHT_API_KEY)")
	case cfg.batch < 1 || cfg.batch > 1000:
		return cfg, errors.New("-batch must be 1-1000")
	case cfg.payloadMin < 0 || cfg.payloadMax < cfg.payloadMin:
		return cfg, errors.New("need 0 <= -payload-min <= -payload-max")
	}
	cfg.url = strings.TrimRight(cfg.url, "/")
	return cfg, nil
}

func run(ctx context.Context, cfg config, log io.Writer) ([]result, error) {
	transport := http.DefaultTransport.(*http.Transport).Clone()
	transport.MaxIdleConnsPerHost = 1024
	client := &http.Client{Transport: transport, Timeout: 30 * time.Second}

	var probe *lagProbe
	if cfg.databaseURL != "" {
		var err error
		if probe, err = newLagProbe(ctx, cfg.databaseURL, cfg.key); err != nil {
			return nil, err
		}
		defer probe.close()
		fmt.Fprintf(log, "database clock offset: %v\n", probe.offset.Round(time.Microsecond))
	}

	runID := randomHex(4)
	var results []result
	for _, conc := range cfg.concurrency {
		stage := fmt.Sprintf("%s-c%d", runID, conc)
		fmt.Fprintf(log, "stage %s: %d clients for %v\n", stage, conc, cfg.duration)
		r, err := runStage(ctx, cfg, client, probe, stage, conc)
		if err != nil {
			return results, err
		}
		results = append(results, r)
		fmt.Fprintf(log, "  written %.0f spans/s, p99 %.1f ms, 429s %.1f%%\n", r.WrittenSpansPS, r.P99Ms, r.ThrottledPct)
	}
	return results, nil
}

func runStage(ctx context.Context, cfg config, client *http.Client, probe *lagProbe, stage string, conc int) (result, error) {
	before, err := scrapeMetrics(ctx, client, cfg.url)
	if err != nil {
		return result{}, err
	}
	stats := &stageStats{}
	s := &sender{client: client, url: cfg.url, key: cfg.key, gzip: cfg.gzip}

	stageCtx, cancel := context.WithTimeout(ctx, cfg.duration)
	var maxDepth float64
	var scrapeErrors int
	var lastScrapeErr error
	var wg sync.WaitGroup
	start := time.Now()
	for i := range conc {
		wg.Go(func() {
			w := newWorkload(uint64(start.UnixNano())+uint64(i), cfg.spansPerTrace, cfg.payloadMin, cfg.payloadMax, stage)
			s.worker(stageCtx, w, cfg.batch, stats)
		})
	}
	// Sample the queue depth while the clients run.
	wg.Go(func() {
		tick := time.NewTicker(250 * time.Millisecond)
		defer tick.Stop()
		for {
			select {
			case <-stageCtx.Done():
				return
			case <-tick.C:
				m, err := scrapeMetrics(stageCtx, client, cfg.url)
				if err != nil {
					if stageCtx.Err() == nil {
						scrapeErrors++
						lastScrapeErr = err
					}
					continue
				}
				maxDepth = max(maxDepth, m["tracewright_queue_depth"])
			}
		}
	})
	wg.Wait()
	cancel()
	sent := time.Since(start)
	if scrapeErrors > 0 {
		fmt.Fprintf(os.Stderr, "  %d queue depth samples failed (last: %v); max queue is a lower bound\n", scrapeErrors, lastScrapeErr)
	}

	// Everything accepted is still being written; "written/s" waits for it.
	after, err := waitForDrain(ctx, client, cfg.url)
	if err != nil {
		return result{}, err
	}
	total := time.Since(start)

	r := result{
		Label:           cfg.label,
		Concurrency:     conc,
		DurationS:       sent.Seconds(),
		DrainS:          (total - sent).Seconds(),
		Requests:        stats.requests,
		AcceptedSpansPS: float64(stats.acceptedSpans) / sent.Seconds(),
		WrittenSpansPS:  after.delta(before, "tracewright_spans_written_total") / total.Seconds(),
		Failed:          stats.failed,
		WireMBPS:        float64(stats.wireBytes) / 1e6 / sent.Seconds(),
		RawMBPS:         float64(stats.rawBytes) / 1e6 / sent.Seconds(),
		P50Ms:           ms(stats.percentile(0.50)),
		P95Ms:           ms(stats.percentile(0.95)),
		P99Ms:           ms(stats.percentile(0.99)),
		MaxQueueDepth:   maxDepth,
		WriteFailures:   after.delta(before, "tracewright_write_failures_total"),
	}
	if stats.requests > 0 {
		r.ThrottledPct = 100 * float64(stats.throttled) / float64(stats.requests)
	}
	if flushes := after.delta(before, "tracewright_batch_write_duration_seconds_count"); flushes > 0 {
		r.MeanFlushMs = 1000 * after.delta(before, "tracewright_batch_write_duration_seconds_sum") / flushes
		r.MeanFlushSpans = after.delta(before, "tracewright_spans_written_total") / flushes
	}
	if probe != nil {
		lag, err := probe.measure(ctx, stage)
		if err != nil {
			return r, fmt.Errorf("measure write lag: %w", err)
		}
		r.LagP50Ms, r.LagP95Ms, r.LagP99Ms, r.LagMaxMs = ms(lag.p50), ms(lag.p95), ms(lag.p99), ms(lag.max)
		r.LagSampledSpans = lag.spans
	}
	return r, nil
}

// waitForDrain polls /metrics until ingest's queue is empty and nothing is mid-write.
func waitForDrain(ctx context.Context, client *http.Client, url string) (promSnapshot, error) {
	deadline := time.Now().Add(2 * time.Minute)
	var last promSnapshot
	for {
		m, err := scrapeMetrics(ctx, client, url)
		if err != nil {
			return nil, err
		}
		settled := last != nil && m["tracewright_spans_written_total"] == last["tracewright_spans_written_total"]
		if m["tracewright_queue_depth"] == 0 && settled {
			return m, nil
		}
		if time.Now().After(deadline) {
			return m, errors.New("ingest queue did not drain within 2 minutes")
		}
		last = m
		select {
		case <-ctx.Done():
			return nil, ctx.Err()
		case <-time.After(200 * time.Millisecond):
		}
	}
}

func ms(d time.Duration) float64 { return float64(d.Microseconds()) / 1000 }

func printTable(out io.Writer, results []result) {
	tw := tabwriter.NewWriter(out, 0, 0, 2, ' ', tabwriter.AlignRight)
	fmt.Fprintln(tw, "label\tclients\taccepted/s\twritten/s\tMB/s raw\tp50 ms\tp95 ms\tp99 ms\t429 %\tflush ms\tspans/flush\tmax queue\tlag p50\tlag p95\tlag p99\t")
	for _, r := range results {
		fmt.Fprintf(tw, "%s\t%d\t%.0f\t%.0f\t%.1f\t%.1f\t%.1f\t%.1f\t%.1f\t%.1f\t%.0f\t%.0f\t%.0f\t%.0f\t%.0f\t\n",
			r.Label, r.Concurrency, r.AcceptedSpansPS, r.WrittenSpansPS, r.RawMBPS, r.P50Ms, r.P95Ms, r.P99Ms,
			r.ThrottledPct, r.MeanFlushMs, r.MeanFlushSpans, r.MaxQueueDepth, r.LagP50Ms, r.LagP95Ms, r.LagP99Ms)
	}
	tw.Flush()
}
