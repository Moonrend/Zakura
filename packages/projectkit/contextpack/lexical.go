package contextpack

import (
	"context"
	"math"
	"sort"
	"strings"
	"unicode"
	"unicode/utf8"
)

type hit struct{ start, end int }
type word struct {
	term       string
	start, end int
}

// Full identifier terms and CamelCase components share their original byte
// span. Unicode letters stay intact; all offsets address the exact CAS bytes.
func terms(ctx context.Context, data []byte, visit func(word)) error {
	for offset := 0; offset < len(data); {
		if offset%4096 < utf8.UTFMax {
			if err := ctx.Err(); err != nil {
				return err
			}
		}
		r, n := utf8.DecodeRune(data[offset:])
		if !unicode.IsLetter(r) && !unicode.IsDigit(r) && r != '_' {
			offset += n
			continue
		}
		start := offset
		offset += n
		for offset < len(data) {
			if offset%4096 < utf8.UTFMax {
				if err := ctx.Err(); err != nil {
					return err
				}
			}
			r, n = utf8.DecodeRune(data[offset:])
			if !unicode.IsLetter(r) && !unicode.IsDigit(r) && r != '_' {
				break
			}
			offset += n
		}
		end := offset
		// Giant repeated identifiers cannot create giant maps or query terms.
		if end-start > 128 {
			continue
		}
		full := strings.ToLower(string(data[start:end]))
		visit(word{full, start, end})
		component := start
		previous := rune(0)
		for at := start; at < end; {
			r, n = utf8.DecodeRune(data[at:end])
			next := rune(0)
			if at+n < end {
				next, _ = utf8.DecodeRune(data[at+n : end])
			}
			boundary := r == '_' || (at > component && unicode.IsUpper(r) && (unicode.IsLower(previous) || unicode.IsDigit(previous) || unicode.IsLower(next)))
			if boundary {
				if at > component {
					term := strings.ToLower(string(data[component:at]))
					if term != full {
						visit(word{term, start, end})
					}
				}
				component = at
				if r == '_' {
					component = at + n
				}
			}
			previous = r
			at += n
		}
		if component > start && component < end {
			term := strings.ToLower(string(data[component:end]))
			if term != full {
				visit(word{term, start, end})
			}
		}
	}
	return ctx.Err()
}

func lexicalRank(ctx context.Context, docs []*document, req Request, report *Pack) error {
	queryLimited := false
	queryTerms := map[string]bool{}
	// Explicit query wins when the 64-term bound is reached. Frozen task text
	// remains useful when the user/model supplies no additional query.
	for _, text := range []string{req.Query, req.Prompt} {
		if err := terms(ctx, []byte(text), func(w word) {
			if len(w.term) <= 1 {
				return
			}
			if len(queryTerms) < 64 {
				queryTerms[w.term] = true
				return
			}
			if !queryTerms[w.term] && !queryLimited {
				queryLimited = true
				report.Partial = true
				report.Boundaries = append(report.Boundaries, Boundary{Kind: "query_term_limit"})
			}
		}); err != nil {
			return err
		}
	}
	df := map[string]int{}
	totalLength := 0
	for _, doc := range docs {
		doc.terms = map[string]int{}
		if err := terms(ctx, doc.data, func(w word) {
			doc.length++
			if queryTerms[w.term] {
				doc.terms[w.term]++
				if len(doc.hits) < 128 {
					doc.hits = append(doc.hits, hit{w.start, w.end})
				}
			}
		}); err != nil {
			return err
		}
		// Paths and actual AST symbol names also provide lexical evidence.
		if err := terms(ctx, []byte(doc.entry.Path), func(w word) {
			doc.length++
			if queryTerms[w.term] {
				doc.terms[w.term]++
			}
		}); err != nil {
			return err
		}
		for term := range doc.terms {
			df[term]++
		}
		totalLength += doc.length
	}
	if len(docs) == 0 {
		return nil
	}
	average := float64(totalLength) / float64(len(docs))
	if average < 1 {
		average = 1
	}
	ordered := make([]string, 0, len(queryTerms))
	for term := range queryTerms {
		ordered = append(ordered, term)
	}
	sort.Strings(ordered)
	for _, doc := range docs {
		for _, term := range ordered {
			frequency := float64(doc.terms[term])
			if frequency == 0 {
				continue
			}
			idf := math.Log(1 + (float64(len(docs)-df[term])+0.5)/(float64(df[term])+0.5))
			doc.score += idf * frequency * 2.2 / (frequency + 1.2*(0.25+0.75*float64(doc.length)/average))
		}
		if doc.score > 0 {
			doc.reasons = append(doc.reasons, Reason{Kind: "lexical_hit", Confidence: "lexical"})
		}
		doc.score = math.Round(doc.score*1000000) / 1000000
	}
	return ctx.Err()
}

func priority(doc *document) int {
	for _, r := range doc.reasons {
		if r.Kind == "seed_claim" || r.Kind == "check_path" {
			return 2
		}
	}
	if doc.score > 0 {
		return 1
	}
	return 0
}
func sortDocuments(docs []*document) {
	sort.Slice(docs, func(i, j int) bool {
		pi, pj := priority(docs[i]), priority(docs[j])
		if pi != pj {
			return pi > pj
		}
		if docs[i].score != docs[j].score {
			return docs[i].score > docs[j].score
		}
		return docs[i].entry.Path < docs[j].entry.Path
	})
}
