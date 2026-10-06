// SPDX-License-Identifier: AGPL-3.0-or-later
package runtime

import (
	"math"
	"regexp"
	"sort"
	"strings"
)

var (
	toolCamelBoundary   = regexp.MustCompile(`([a-z0-9])([A-Z])`)
	toolAcronymBoundary = regexp.MustCompile(`([A-Z]+)([A-Z][a-z])`)
)

var toolStopWords = map[string]bool{
	"a": true, "an": true, "and": true, "are": true, "as": true, "at": true,
	"be": true, "by": true, "for": true, "from": true, "in": true, "is": true,
	"it": true, "of": true, "on": true, "or": true, "that": true, "the": true,
	"this": true, "to": true, "with": true,
}

func stemToolTerm(term string) string {
	if len(term) > 4 && strings.HasSuffix(term, "ies") {
		return term[:len(term)-3] + "y"
	}
	if len(term) > 4 && (strings.HasSuffix(term, "ches") || strings.HasSuffix(term, "shes") || strings.HasSuffix(term, "sses") || strings.HasSuffix(term, "xes") || strings.HasSuffix(term, "zes")) {
		return term[:len(term)-2]
	}
	if len(term) > 3 && strings.HasSuffix(term, "s") && !strings.HasSuffix(term, "ss") {
		return term[:len(term)-1]
	}
	return term
}

func tokenizeToolText(text string) []string {
	text = toolCamelBoundary.ReplaceAllString(text, "$1 $2")
	text = toolAcronymBoundary.ReplaceAllString(text, "$1 $2")
	text = strings.ToLower(text)
	out := []string{}
	for _, term := range strings.FieldsFunc(text, func(r rune) bool {
		return !((r >= 'a' && r <= 'z') || (r >= '0' && r <= '9'))
	}) {
		if term == "" || toolStopWords[term] {
			continue
		}
		out = append(out, stemToolTerm(term))
	}
	return out
}

type toolSearchDoc struct {
	Name string
	Text string
}

func toolSchemaText(schema any, parts *[]string) {
	m, ok := schema.(map[string]any)
	if !ok || m == nil {
		return
	}
	if description, ok := m["description"].(string); ok {
		*parts = append(*parts, description)
	}
	if properties, ok := m["properties"].(map[string]any); ok {
		for name, property := range properties {
			*parts = append(*parts, name)
			toolSchemaText(property, parts)
		}
	}
	toolSchemaText(m["items"], parts)
	for _, key := range []string{"anyOf", "oneOf", "allOf"} {
		if variants, ok := m[key].([]any); ok {
			for _, variant := range variants {
				toolSchemaText(variant, parts)
			}
		}
	}
}

func buildToolSearchDoc(t agentTool) toolSearchDoc {
	parts := []string{t.Name, strings.ReplaceAll(t.Name, "_", " "), t.Description}
	toolSchemaText(t.InputSchema, &parts)
	filtered := make([]string, 0, len(parts))
	for _, part := range parts {
		if strings.TrimSpace(part) != "" {
			filtered = append(filtered, part)
		}
	}
	return toolSearchDoc{Name: t.Name, Text: strings.Join(filtered, " ")}
}

func bm25Rank(query string, docs []toolSearchDoc, limit int) []struct {
	Name  string
	Score float64
} {
	queryTerms := []string{}
	seenTerms := map[string]bool{}
	for _, term := range tokenizeToolText(query) {
		if !seenTerms[term] {
			seenTerms[term] = true
			queryTerms = append(queryTerms, term)
		}
	}
	if len(queryTerms) == 0 || len(docs) == 0 || limit <= 0 {
		return nil
	}
	const (
		k1 = 1.2
		b  = 0.75
	)
	termCounts := make([]map[string]int, len(docs))
	lengths := make([]int, len(docs))
	total := 0
	for i, doc := range docs {
		counts := map[string]int{}
		for _, term := range tokenizeToolText(doc.Text) {
			counts[term]++
		}
		termCounts[i] = counts
		for _, count := range counts {
			lengths[i] += count
		}
		total += lengths[i]
	}
	averageLength := float64(total) / float64(len(docs))
	if averageLength == 0 {
		averageLength = 1
	}
	idf := map[string]float64{}
	for _, term := range queryTerms {
		frequency := 0
		for _, counts := range termCounts {
			if _, ok := counts[term]; ok {
				frequency++
			}
		}
		idf[term] = math.Log(1 + (float64(len(docs)-frequency)+0.5)/(float64(frequency)+0.5))
	}
	matches := []struct {
		Name  string
		Score float64
	}{}
	for i, doc := range docs {
		score := 0.0
		for _, term := range queryTerms {
			count := termCounts[i][term]
			if count == 0 {
				continue
			}
			norm := k1 * (1 - b + b*float64(lengths[i])/averageLength)
			score += idf[term] * (float64(count) * (k1 + 1)) / (float64(count) + norm)
		}
		if score > 0 {
			matches = append(matches, struct {
				Name  string
				Score float64
			}{doc.Name, score})
		}
	}
	sort.SliceStable(matches, func(i, j int) bool { return matches[i].Score > matches[j].Score })
	if len(matches) > limit {
		matches = matches[:limit]
	}
	return matches
}

func runToolSearch(catalog agentCatalog, loaded map[string]bool, query string, limit int) []agentTool {
	if limit <= 0 {
		limit = 8
	}
	candidates := []agentTool{}
	byName := map[string]agentTool{}
	for _, tool := range catalog.Tools {
		if tool.Exposure != "deferred" {
			continue
		}
		if loaded != nil && loaded[tool.Name] {
			continue
		}
		candidates = append(candidates, tool)
		byName[tool.Name] = tool
	}
	docs := make([]toolSearchDoc, len(candidates))
	for i, tool := range candidates {
		docs[i] = buildToolSearchDoc(tool)
	}
	matches := bm25Rank(query, docs, limit)
	out := make([]agentTool, 0, len(matches))
	for _, match := range matches {
		out = append(out, byName[match.Name])
	}
	return out
}
