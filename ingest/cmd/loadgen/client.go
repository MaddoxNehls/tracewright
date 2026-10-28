package main

import (
	"bytes"
	"compress/gzip"
	"context"
	"encoding/json"
	"io"
	"net/http"
	"slices"
	"strconv"
	"sync"
	"time"
)

// stageStats is what the clients of one stage observed.
type stageStats struct {
	mu            sync.Mutex
	requests      int
	acceptedSpans int
	throttled     int // 429
	failed        int // transport errors and any other status
	wireBytes     int64
	rawBytes      int64
	latencies     []time.Duration // every completed request, any status
}

func (s *stageStats) record(latency time.Duration, status, spans int, wire, raw int) {
	s.mu.Lock()
	defer s.mu.Unlock()
	s.requests++
	s.wireBytes += int64(wire)
	s.rawBytes += int64(raw)
	s.latencies = append(s.latencies, latency)
	switch {
	case status == http.StatusAccepted:
		s.acceptedSpans += spans
	case status == http.StatusTooManyRequests:
		s.throttled++
	default:
		s.failed++
	}
}

func (s *stageStats) percentile(q float64) time.Duration {
	if len(s.latencies) == 0 {
		return 0
	}
	sorted := slices.Clone(s.latencies)
	slices.Sort(sorted)
	return sorted[min(len(sorted)-1, int(q*float64(len(sorted))))]
}

type sender struct {
	client *http.Client
	url    string
	key    string
	gzip   bool
}

// worker sends batches back to back until ctx is done: a closed-loop client, like an
// SDK exporter with a full queue. On 429 it waits for Retry-After, as the SDKs do.
func (s *sender) worker(ctx context.Context, w *workload, batchSize int, stats *stageStats) {
	var buf bytes.Buffer
	for ctx.Err() == nil {
		raw, err := json.Marshal(map[string]any{"spans": w.batch(batchSize)})
		if err != nil {
			panic(err) // generated data always marshals
		}
		body := raw
		if s.gzip {
			buf.Reset()
			zw := gzip.NewWriter(&buf)
			zw.Write(raw)
			zw.Close()
			body = buf.Bytes()
		}

		req, _ := http.NewRequestWithContext(ctx, http.MethodPost, s.url+"/v1/spans", bytes.NewReader(body))
		req.Header.Set("Authorization", "Bearer "+s.key)
		req.Header.Set("Content-Type", "application/json")
		if s.gzip {
			req.Header.Set("Content-Encoding", "gzip")
		}
		start := time.Now()
		resp, err := s.client.Do(req)
		if err != nil {
			if ctx.Err() != nil {
				return // the stage ended mid-request; don't count it
			}
			stats.record(time.Since(start), 0, batchSize, len(body), len(raw))
			continue
		}
		io.Copy(io.Discard, resp.Body)
		resp.Body.Close()
		stats.record(time.Since(start), resp.StatusCode, batchSize, len(body), len(raw))

		if resp.StatusCode == http.StatusTooManyRequests {
			wait := time.Second
			if secs, err := strconv.Atoi(resp.Header.Get("Retry-After")); err == nil {
				wait = time.Duration(secs) * time.Second
			}
			select {
			case <-ctx.Done():
			case <-time.After(wait):
			}
		}
	}
}
