package pricing

import "testing"

func TestDefaultTableLoads(t *testing.T) {
	tbl, err := Default()
	if err != nil {
		t.Fatalf("Default: %v", err)
	}
	if len(tbl.models) == 0 {
		t.Fatal("embedded pricing.json has no models")
	}
}

func TestCost(t *testing.T) {
	tbl, err := Default()
	if err != nil {
		t.Fatal(err)
	}

	tests := []struct {
		name      string
		model     string
		in, out   int64
		wantUSD   float64
		wantKnown bool
	}{
		{"opus 5.5", "claude-opus-5-5", 1_000_000, 1_000_000, 24.00, true},
		{"sonnet 5.5 small call", "claude-sonnet-5-5", 1200, 350, 0.0024 + 0.0035, true},
		{"haiku 4.5", "claude-haiku-4-5", 10_000, 2_000, 0.01 + 0.01, true},
		{"dated snapshot bills as alias", "claude-haiku-4-5-20251001", 10_000, 2_000, 0.02, true},
		{"zero tokens", "claude-opus-5-5", 0, 0, 0, true},
		{"haiku 5.5 at threshold uses base rate", "claude-haiku-5-5", 100_000, 1_000_000, 0.01 + 0.50, true},
		{"haiku 5.5 above threshold uses long-context rate", "claude-haiku-5-5", 100_001, 1_000_000, 2.550001, true},
		{"rounds to 6 decimals", "claude-opus-5-5", 1, 0, 0.000004, true},
		{"unknown model", "gpt-5", 1000, 1000, 0, false},
		{"provider-prefixed ids are not guessed", "anthropic/claude-opus-5-5", 1000, 1000, 0, false},
		{"empty model", "", 1000, 1000, 0, false},
	}
	for _, tt := range tests {
		t.Run(tt.name, func(t *testing.T) {
			got, known := tbl.Cost(tt.model, tt.in, tt.out)
			if known != tt.wantKnown {
				t.Fatalf("known = %v, want %v", known, tt.wantKnown)
			}
			if diff := got - tt.wantUSD; diff > 1e-9 || diff < -1e-9 {
				t.Errorf("cost = %.9f, want %.9f", got, tt.wantUSD)
			}
		})
	}
}

func TestParseRejectsBadTables(t *testing.T) {
	tests := map[string]string{
		"malformed json":      `{"models": `,
		"negative price":      `{"models": {"m": {"input": -1, "output": 1}}}`,
		"bad long tier":       `{"models": {"m": {"input": 1, "output": 1, "long_context": {"above_input_tokens": 0, "input": 1, "output": 1}}}}`,
		"negative long price": `{"models": {"m": {"input": 1, "output": 1, "long_context": {"above_input_tokens": 10, "input": -1, "output": 1}}}}`,
	}
	for name, data := range tests {
		t.Run(name, func(t *testing.T) {
			if _, err := Parse([]byte(data)); err == nil {
				t.Error("expected error")
			}
		})
	}
}
