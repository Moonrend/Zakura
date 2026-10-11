package contextpack

import (
	"context"
	"encoding/json"
	"sort"
	"unicode/utf8"

	"github.com/Moonrend/Zakura/packages/projectkit/semantic"
)

func position(data []byte, offset int) semantic.Position {
	p := semantic.Position{Offset: offset, Line: 1, Column: 1}
	for at := 0; at < offset; {
		r, n := utf8.DecodeRune(data[at:offset])
		at += n
		if r == '\n' {
			p.Line++
			p.Column = 1
		} else {
			p.Column++
		}
	}
	return p
}
func runeBoundary(data []byte, at int) int {
	if at > len(data) {
		at = len(data)
	}
	for at > 0 && at < len(data) && !utf8.RuneStart(data[at]) {
		at--
	}
	return at
}
func windows(doc *document) []hit {
	centers := append([]hit{}, doc.hits...)
	if len(centers) == 0 && doc.meta != nil && len(doc.meta.Symbols) > 0 {
		centers = append(centers, hit{doc.meta.Symbols[0].Range.Start.Offset, doc.meta.Symbols[0].Range.End.Offset})
	}
	if len(centers) == 0 {
		centers = []hit{{0, len(doc.data)}}
	}
	spans := []hit{}
	for _, center := range centers {
		start, end := center.start, center.end
		if start < 0 || start > len(doc.data) || end < start {
			continue
		}
		if end > len(doc.data) {
			end = len(doc.data)
		}
		// Prefer a real declaration surrounding a lexical hit. The syntax tree
		// supplies a source range, not a claim that the hit is type-resolved.
		if doc.meta != nil {
			best := 2049
			for _, symbol := range doc.meta.Symbols {
				a, b := symbol.Range.Start.Offset, symbol.Range.End.Offset
				if a <= start && b >= end && b-a < best && b <= len(doc.data) {
					start, end, best = a, b, b-a
				}
			}
		}
		if end-start > 1400 {
			end = start + 1400
		}
		if end-start < 400 {
			for n := 0; start > 0 && center.start-start < 300 && n < 2; start-- {
				if doc.data[start-1] == '\n' {
					n++
				}
			}
			for n := 0; end < len(doc.data) && end-center.end < 500 && n < 3; end++ {
				if doc.data[end] == '\n' {
					n++
				}
			}
		}
		start = runeBoundary(doc.data, start)
		end = runeBoundary(doc.data, end)
		if end <= start {
			continue
		}
		duplicate := false
		for _, old := range spans {
			if start < old.end && end > old.start {
				duplicate = true
				break
			}
		}
		if !duplicate {
			spans = append(spans, hit{start, end})
		}
		if len(spans) >= 2 {
			break
		}
	}
	sort.Slice(spans, func(i, j int) bool { return spans[i].start < spans[j].start })
	return spans
}
func snippet(doc *document, span hit, id string) Snippet {
	s := Snippet{SnapshotID: id, Path: doc.entry.Path, Hash: doc.entry.Hash, Range: semantic.Range{Start: position(doc.data, span.start), End: position(doc.data, span.end)}, Text: string(doc.data[span.start:span.end]), Reasons: doc.reasons, Score: doc.score, Partial: doc.meta == nil, Truncated: span.start > 0 || span.end < len(doc.data)}
	if doc.meta != nil {
		s.Generated = doc.meta.Generated
		s.Partial = doc.meta.Status != "indexed" || len(doc.meta.BuildConditions) > 0
	}
	return s
}
func encode(pack *Pack) ([]byte, error) {
	// bytes includes itself. The digit count converges after at most two
	// iterations; use the same encoding/json default as RPC and ToolResult.
	for i := 0; i < 5; i++ {
		raw, err := json.Marshal(pack)
		if err != nil {
			return nil, err
		}
		if len(raw) == pack.Bytes {
			return raw, nil
		}
		pack.Bytes = len(raw)
	}
	return json.Marshal(pack)
}
func fitMetadata(report *Pack) error {
	report.OmittedCount = len(report.OmittedPaths)
	report.MissingCount = len(report.Missing)
	report.BoundaryCount = len(report.Boundaries)
	for _, limit := range []int{24, 12, 6, 3, 1, 0} {
		if len(report.OmittedPaths) > limit || len(report.Missing) > limit || len(report.Boundaries) > limit {
			report.Truncated = true
		}
		if len(report.OmittedPaths) > limit {
			report.OmittedPaths = report.OmittedPaths[:limit]
		}
		if len(report.Missing) > limit {
			report.Missing = report.Missing[:limit]
		}
		if len(report.Boundaries) > limit {
			report.Boundaries = report.Boundaries[:limit]
		}
		raw, err := encode(report)
		if err != nil {
			return err
		}
		if len(raw) <= report.MaxBytes/2 || limit == 0 {
			if len(raw) > report.MaxBytes {
				return ErrInvalid
			}
			return nil
		}
		report.Truncated = true
	}
	return nil
}

// Build reads each selected immutable file once, verifies its full SHA-256,
// then performs all lexical/syntax work in memory. No mutable branch, host
// files, network access, compiler execution or model instruction is accepted.
func Build(ctx context.Context, source semantic.Source, req Request) (Pack, error) {
	if err := Validate(req); err != nil {
		return Pack{}, err
	}
	if req.MaxBytes == 0 {
		req.MaxBytes = 4000
	}
	report := Pack{Version: Version, SnapshotID: req.SnapshotID, Mode: "lexical_graph", UntrustedReference: true, MaxBytes: req.MaxBytes, OmittedPaths: []string{}, Missing: []Missing{}, Boundaries: []Boundary{}, Snippets: []Snippet{}}
	mem, docs, err := load(ctx, source, req, &report)
	if err != nil {
		return report, err
	}
	limits := semantic.DefaultLimits()
	limits.MaxFiles = MaxFiles
	limits.MaxNodes = 200000
	limits.MaxReferences = 30000
	limits.MaxSymbols = 10000
	limits.MaxEdges = 10000
	limits.MaxDiagnostics = 256
	index, err := semantic.Build(ctx, mem, req.SnapshotID, limits)
	if err != nil {
		return report, err
	}
	if err = lexicalRank(ctx, docs, req, &report); err != nil {
		return report, err
	}
	if err = attachGraph(ctx, docs, index, &report); err != nil {
		return report, err
	}
	sortDocuments(docs)
	selected := []*document{}
	spans := map[string][]hit{}
	for _, doc := range docs {
		if len(doc.reasons) == 0 {
			continue
		}
		if len(selected) >= 24 {
			report.OmittedPaths = append(report.OmittedPaths, doc.entry.Path)
			report.Truncated = true
			continue
		}
		selected = append(selected, doc)
		spans[doc.entry.Path] = windows(doc)
	}
	if err = fitMetadata(&report); err != nil {
		return report, err
	}
	retained := map[string]bool{}
	// Give each ranked file an opportunity before considering its second span.
	for round := 0; round < 2; round++ {
		for _, doc := range selected {
			if err := ctx.Err(); err != nil {
				return report, err
			}
			if round >= len(spans[doc.entry.Path]) {
				continue
			}
			span := spans[doc.entry.Path][round]
			item := snippet(doc, span, req.SnapshotID)
			if item.Partial {
				report.Partial = true
			}
			saved := false
			for {
				report.Snippets = append(report.Snippets, item)
				raw, e := encode(&report)
				if e != nil {
					return report, e
				}
				if len(raw) <= report.MaxBytes {
					saved = true
					retained[doc.entry.Path] = true
					break
				}
				report.Snippets = report.Snippets[:len(report.Snippets)-1]
				if len(item.Text) <= 128 {
					break
				}
				end := runeBoundary([]byte(item.Text), len(item.Text)*2/3)
				item.Text = item.Text[:end]
				item.Range.End = position(doc.data, item.Range.Start.Offset+end)
				item.Truncated = true
				report.Truncated = true
			}
			if !saved {
				report.Truncated = true
			}
		}
	}
	for _, doc := range selected {
		if !retained[doc.entry.Path] {
			report.OmittedCount++
			if len(report.OmittedPaths) < 24 {
				report.OmittedPaths = append(report.OmittedPaths, doc.entry.Path)
			}
		}
	}
	// Final omission flags/counts may add digits. Preserve the strict complete
	// JSON budget even when every byte is HTML-escaped or a UTF-8 code point.
	for {
		raw, e := encode(&report)
		if e != nil {
			return report, e
		}
		if len(raw) <= report.MaxBytes {
			break
		}
		if len(report.OmittedPaths) > 0 {
			report.OmittedPaths = report.OmittedPaths[:len(report.OmittedPaths)-1]
			report.Truncated = true
			continue
		}
		if len(report.Snippets) > 0 {
			removed := report.Snippets[len(report.Snippets)-1].Path
			report.Snippets = report.Snippets[:len(report.Snippets)-1]
			stillPresent := false
			for _, remaining := range report.Snippets {
				if remaining.Path == removed {
					stillPresent = true
					break
				}
			}
			if !stillPresent {
				report.OmittedCount++
			}
			report.Truncated = true
			continue
		}
		return report, ErrInvalid
	}
	return report, ctx.Err()
}
