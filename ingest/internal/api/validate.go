package api

import (
	"bytes"
	"cmp"
	"encoding/json"
	"fmt"
	"time"
	"unicode/utf8"

	"github.com/MaddoxNehls/tracewright/ingest/internal/pricing"
	"github.com/MaddoxNehls/tracewright/ingest/internal/store"
)

// FieldError pinpoints one validation failure inside a request.
type FieldError struct {
	Index   int    `json:"index"`
	Field   string `json:"field"`
	Message string `json:"message"`
}

// maxFieldErrors caps the details returned so a bad 1000-span batch doesn't
// produce a response larger than the request.
const maxFieldErrors = 100

// maxCostUSD is the largest value spans.cost_usd (numeric(12,6)) can hold.
const maxCostUSD = 999_999.999999

// wireSpan mirrors the contract's Span JSON. Every field is kept raw so that
// missing, null, and wrongly typed values can each get a precise error.
type wireSpan struct {
	TraceID      json.RawMessage `json:"trace_id"`
	SpanID       json.RawMessage `json:"span_id"`
	ParentSpanID json.RawMessage `json:"parent_span_id"`
	Name         json.RawMessage `json:"name"`
	Kind         json.RawMessage `json:"kind"`
	StartTime    json.RawMessage `json:"start_time"`
	EndTime      json.RawMessage `json:"end_time"`
	Status       json.RawMessage `json:"status"`
	Error        json.RawMessage `json:"error"`
	Attributes   json.RawMessage `json:"attributes"`
	Input        json.RawMessage `json:"input"`
	Output       json.RawMessage `json:"output"`
}

// Attribute keys with typed meaning. Unlisted keys accept any JSON value.
const (
	attrRequestModel  = "gen_ai.request.model"
	attrResponseModel = "gen_ai.response.model"
	attrInputTokens   = "gen_ai.usage.input_tokens"
	attrOutputTokens  = "gen_ai.usage.output_tokens"
	attrCostUSD       = "tracewright.cost_usd"
	attrTags          = "tracewright.tags"
	attrFinishReasons = "gen_ai.response.finish_reasons"
	attrTruncated     = "tracewright.truncated"
	attrProviderName  = "gen_ai.provider.name"
	attrOperationName = "gen_ai.operation.name"
	attrToolName      = "gen_ai.tool.name"
)

type attrType int

const (
	typeString attrType = iota
	typeStringArray
	typeCount
	typeCost
	typeBool
)

var attrTypes = map[string]attrType{
	attrProviderName:  typeString,
	attrOperationName: typeString,
	attrRequestModel:  typeString,
	attrResponseModel: typeString,
	attrToolName:      typeString,
	attrInputTokens:   typeCount,
	attrOutputTokens:  typeCount,
	attrFinishReasons: typeStringArray,
	attrTags:          typeStringArray,
	attrCostUSD:       typeCost,
	attrTruncated:     typeBool,
}

// spanParser validates and converts wire spans, accumulating every error so
// a client can fix a whole batch in one round trip.
type spanParser struct {
	projectID string
	prices    *pricing.Table
	errs      []FieldError
}

func (p *spanParser) fail(index int, field, format string, args ...any) {
	if len(p.errs) < maxFieldErrors {
		p.errs = append(p.errs, FieldError{Index: index, Field: field, Message: fmt.Sprintf(format, args...)})
	}
}

// parseSpans validates raw spans and converts them to storage rows. If any
// span is invalid it returns the errors and no spans: the contract rejects
// the whole batch.
func parseSpans(raws []json.RawMessage, projectID string, prices *pricing.Table) ([]store.Span, []FieldError) {
	p := &spanParser{projectID: projectID, prices: prices}
	spans := make([]store.Span, 0, len(raws))
	for i, raw := range raws {
		if s, ok := p.parse(i, raw); ok {
			spans = append(spans, s)
		}
	}
	if len(p.errs) > 0 {
		return nil, p.errs
	}
	return spans, nil
}

func (p *spanParser) parse(i int, raw json.RawMessage) (store.Span, bool) {
	var w wireSpan
	if !isObject(raw) || json.Unmarshal(raw, &w) != nil {
		p.fail(i, "", "span must be a JSON object")
		return store.Span{}, false
	}
	before := len(p.errs)

	s := store.Span{
		ProjectID: p.projectID,
		TraceID:   p.hexID(i, "trace_id", w.TraceID, 32),
		SpanID:    p.hexID(i, "span_id", w.SpanID, 16),
		Name:      p.name(i, w.Name),
		Kind:      p.enum(i, "kind", w.Kind, "agent", "llm", "tool", "custom"),
		StartTime: p.timestamp(i, "start_time", w.StartTime),
		EndTime:   p.timestamp(i, "end_time", w.EndTime),
		Status:    p.enum(i, "status", w.Status, "ok", "error"),
		Input:     nullable(w.Input),
		Output:    nullable(w.Output),
	}
	if !isNull(w.ParentSpanID) {
		parent := p.hexID(i, "parent_span_id", w.ParentSpanID, 16)
		s.ParentSpanID = &parent
	}
	if !s.StartTime.IsZero() && !s.EndTime.IsZero() && s.EndTime.Before(s.StartTime) {
		p.fail(i, "end_time", "must not be before start_time")
	}
	s.Error = p.spanError(i, w.Error, s.Status)
	attrs := p.attributes(i, w.Attributes)
	s.Attributes = attrsJSON(w.Attributes)

	if len(p.errs) > before {
		return store.Span{}, false
	}
	p.derive(&s, attrs)
	return s, true
}

func (p *spanParser) hexID(i int, field string, raw json.RawMessage, length int) string {
	s, ok := p.str(i, field, raw)
	if !ok {
		return ""
	}
	if len(s) != length || !isLowerHex(s) {
		p.fail(i, field, "must be %d lowercase hex characters", length)
	}
	return s
}

func (p *spanParser) name(i int, raw json.RawMessage) string {
	s, ok := p.str(i, "name", raw)
	if ok {
		if n := utf8.RuneCountInString(s); n < 1 || n > 256 {
			p.fail(i, "name", "must be 1-256 characters")
		}
	}
	return s
}

func (p *spanParser) enum(i int, field string, raw json.RawMessage, allowed ...string) string {
	s, ok := p.str(i, field, raw)
	if !ok {
		return ""
	}
	for _, a := range allowed {
		if s == a {
			return s
		}
	}
	p.fail(i, field, "must be one of %q", allowed)
	return s
}

// timestamp accepts RFC 3339 times with a zero UTC offset, so both "Z" and
// "+00:00" (Python's isoformat) are fine; other offsets are rejected.
func (p *spanParser) timestamp(i int, field string, raw json.RawMessage) time.Time {
	s, ok := p.str(i, field, raw)
	if !ok {
		return time.Time{}
	}
	t, err := time.Parse(time.RFC3339Nano, s)
	if err != nil {
		p.fail(i, field, "must be an RFC 3339 timestamp")
		return time.Time{}
	}
	if _, offset := t.Zone(); offset != 0 {
		p.fail(i, field, "must be in UTC")
		return time.Time{}
	}
	return t.UTC()
}

// str decodes a required string field.
func (p *spanParser) str(i int, field string, raw json.RawMessage) (string, bool) {
	if isNull(raw) {
		p.fail(i, field, "is required")
		return "", false
	}
	var s string
	if raw[0] != '"' || json.Unmarshal(raw, &s) != nil {
		p.fail(i, field, "must be a string")
		return "", false
	}
	return s, true
}

func (p *spanParser) spanError(i int, raw json.RawMessage, status string) []byte {
	if isNull(raw) {
		if status == "error" {
			p.fail(i, "error", `is required when status is "error"`)
		}
		return nil
	}
	var e struct {
		Type    json.RawMessage `json:"type"`
		Message json.RawMessage `json:"message"`
	}
	if !isObject(raw) || json.Unmarshal(raw, &e) != nil {
		p.fail(i, "error", `must be an object with "type" and "message" strings, or null`)
		return nil
	}
	p.str(i, "error.type", e.Type)
	p.str(i, "error.message", e.Message)
	return raw
}

func (p *spanParser) attributes(i int, raw json.RawMessage) map[string]json.RawMessage {
	if isNull(raw) {
		return nil
	}
	var attrs map[string]json.RawMessage
	if !isObject(raw) || json.Unmarshal(raw, &attrs) != nil {
		p.fail(i, "attributes", "must be an object")
		return nil
	}
	for key, val := range attrs {
		typ, known := attrTypes[key]
		if !known || isNull(val) {
			continue
		}
		field := "attributes." + key
		switch typ {
		case typeString:
			p.str(i, field, val)
		case typeStringArray:
			var ss []string
			if val[0] != '[' || json.Unmarshal(val, &ss) != nil {
				p.fail(i, field, "must be an array of strings")
			}
		case typeCount:
			if _, ok := parseCount(val); !ok {
				p.fail(i, field, "must be a non-negative integer")
			}
		case typeCost:
			var f float64
			if !isNumber(val) || json.Unmarshal(val, &f) != nil || f < 0 || f > maxCostUSD {
				p.fail(i, field, "must be a number between 0 and %.6f", maxCostUSD)
			}
		case typeBool:
			if !bytes.Equal(val, []byte("true")) && !bytes.Equal(val, []byte("false")) {
				p.fail(i, field, "must be a boolean")
			}
		}
	}
	return attrs
}

// derive fills the denormalized model, token, and cost columns from
// already-validated attributes.
func (p *spanParser) derive(s *store.Span, attrs map[string]json.RawMessage) {
	stringAttr := func(key string) string {
		var v string
		_ = json.Unmarshal(attrs[key], &v)
		return v
	}
	countAttr := func(key string) *int64 {
		if n, ok := parseCount(attrs[key]); ok {
			return &n
		}
		return nil
	}

	// The response model is what actually served the call; the request
	// model may be an alias.
	if m := cmp.Or(stringAttr(attrResponseModel), stringAttr(attrRequestModel)); m != "" {
		s.Model = &m
	}
	s.InputTokens = countAttr(attrInputTokens)
	s.OutputTokens = countAttr(attrOutputTokens)

	if raw, ok := attrs[attrCostUSD]; ok && !isNull(raw) {
		var cost float64
		_ = json.Unmarshal(raw, &cost)
		s.CostUSD = &cost
		return
	}
	// Without any usage there is nothing to price; null beats a fake $0.
	if s.Model == nil || (s.InputTokens == nil && s.OutputTokens == nil) {
		return
	}
	if cost, ok := p.prices.Cost(*s.Model, deref(s.InputTokens), deref(s.OutputTokens)); ok {
		s.CostUSD = &cost
	}
}

func parseCount(raw json.RawMessage) (int64, bool) {
	if !isNumber(raw) {
		return 0, false
	}
	var n json.Number
	if json.Unmarshal(raw, &n) != nil {
		return 0, false
	}
	v, err := n.Int64()
	return v, err == nil && v >= 0
}

// sanitizeNUL rewrites JSON NUL escapes to U+FFFD escapes in place. Postgres
// cannot store NUL in text or jsonb, and failing the whole batch over one
// stray byte in an LLM transcript would be worse than replacing it.
func sanitizeNUL(body []byte) {
	if !bytes.Contains(body, []byte(`\u0000`)) {
		return
	}
	for i := 0; i < len(body)-1; i++ {
		if body[i] != '\\' {
			continue
		}
		if body[i+1] == 'u' && i+6 <= len(body) && string(body[i+2:i+6]) == "0000" {
			copy(body[i+2:i+6], "fffd")
		}
		i++ // skip the escaped character so `\\u0000` (a literal backslash) is left alone
	}
}

func attrsJSON(raw json.RawMessage) []byte {
	if isNull(raw) {
		return []byte("{}")
	}
	return raw
}

func nullable(raw json.RawMessage) []byte {
	if isNull(raw) {
		return nil
	}
	return raw
}

func isNull(raw json.RawMessage) bool   { return len(raw) == 0 || string(raw) == "null" }
func isObject(raw json.RawMessage) bool { return len(raw) > 0 && raw[0] == '{' }
func isNumber(raw json.RawMessage) bool {
	return len(raw) > 0 && (raw[0] == '-' || '0' <= raw[0] && raw[0] <= '9')
}

func isLowerHex(s string) bool {
	for _, c := range s {
		if !('0' <= c && c <= '9' || 'a' <= c && c <= 'f') {
			return false
		}
	}
	return true
}

func deref(p *int64) int64 {
	if p == nil {
		return 0
	}
	return *p
}
