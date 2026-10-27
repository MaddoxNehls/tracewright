// Package pricing estimates LLM call cost from token usage using an embedded
// price table (pricing.json).
package pricing

import (
	_ "embed"
	"encoding/json"
	"fmt"
	"math"
	"regexp"
)

//go:embed pricing.json
var embedded []byte

// Price is the USD cost per million tokens for one model.
type Price struct {
	Input       float64     `json:"input"`
	Output      float64     `json:"output"`
	LongContext *LongPrices `json:"long_context,omitempty"`
}

// LongPrices replace the base rates for the whole request once its prompt
// exceeds AboveInputTokens.
type LongPrices struct {
	AboveInputTokens int64   `json:"above_input_tokens"`
	Input            float64 `json:"input"`
	Output           float64 `json:"output"`
}

// Table maps model ids to prices.
type Table struct {
	models map[string]Price
}

// Default parses the embedded pricing.json.
func Default() (*Table, error) { return Parse(embedded) }

// Parse builds a Table from pricing.json-shaped data.
func Parse(data []byte) (*Table, error) {
	var file struct {
		Models map[string]Price `json:"models"`
	}
	if err := json.Unmarshal(data, &file); err != nil {
		return nil, fmt.Errorf("parse pricing: %w", err)
	}
	for id, p := range file.Models {
		if p.Input < 0 || p.Output < 0 {
			return nil, fmt.Errorf("pricing for %q: prices must be non-negative", id)
		}
		if lc := p.LongContext; lc != nil && (lc.Input < 0 || lc.Output < 0 || lc.AboveInputTokens <= 0) {
			return nil, fmt.Errorf("pricing for %q: invalid long_context tier", id)
		}
	}
	return &Table{models: file.Models}, nil
}

// datedSuffix matches snapshot suffixes like "-20251001" that the API may echo
// back in response.model; a snapshot is billed like its alias.
var datedSuffix = regexp.MustCompile(`-\d{8}$`)

// Lookup returns the price for a model id.
func (t *Table) Lookup(model string) (Price, bool) {
	if p, ok := t.models[model]; ok {
		return p, true
	}
	p, ok := t.models[datedSuffix.ReplaceAllString(model, "")]
	return p, ok
}

// Cost returns the USD cost of a call, rounded to the six decimal places the
// spans.cost_usd column stores. ok is false for unknown models: an unknown
// cost is recorded as null rather than a misleading zero.
func (t *Table) Cost(model string, inputTokens, outputTokens int64) (usd float64, ok bool) {
	p, ok := t.Lookup(model)
	if !ok {
		return 0, false
	}
	in, out := p.Input, p.Output
	if lc := p.LongContext; lc != nil && inputTokens > lc.AboveInputTokens {
		in, out = lc.Input, lc.Output
	}
	usd = (float64(inputTokens)*in + float64(outputTokens)*out) / 1e6
	return math.Round(usd*1e6) / 1e6, true
}
