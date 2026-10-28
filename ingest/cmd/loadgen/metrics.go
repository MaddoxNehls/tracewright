package main

import (
	"bufio"
	"context"
	"fmt"
	"net/http"
	"strconv"
	"strings"
)

// promSnapshot sums each metric's samples across label sets: enough for counters and
// gauges, and for a histogram's _sum and _count.
type promSnapshot map[string]float64

func scrapeMetrics(ctx context.Context, client *http.Client, baseURL string) (promSnapshot, error) {
	req, _ := http.NewRequestWithContext(ctx, http.MethodGet, baseURL+"/metrics", nil)
	resp, err := client.Do(req)
	if err != nil {
		return nil, err
	}
	defer resp.Body.Close()
	if resp.StatusCode != http.StatusOK {
		return nil, fmt.Errorf("GET /metrics: %s", resp.Status)
	}
	return parseMetrics(bufio.NewScanner(resp.Body))
}

func parseMetrics(sc *bufio.Scanner) (promSnapshot, error) {
	snap := promSnapshot{}
	for sc.Scan() {
		line := sc.Text()
		if line == "" || strings.HasPrefix(line, "#") {
			continue
		}
		name, rest, _ := strings.Cut(line, " ")
		if i := strings.IndexByte(name, '{'); i >= 0 {
			// Labels can contain spaces; the value follows the closing brace.
			end := strings.LastIndexByte(line, '}')
			name, rest = line[:i], strings.TrimSpace(line[end+1:])
		}
		value, err := strconv.ParseFloat(strings.Fields(rest)[0], 64)
		if err != nil {
			continue
		}
		snap[name] += value
	}
	return snap, sc.Err()
}

func (after promSnapshot) delta(before promSnapshot, name string) float64 {
	return after[name] - before[name]
}
