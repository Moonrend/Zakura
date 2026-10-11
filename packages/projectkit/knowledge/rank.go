// SPDX-License-Identifier: AGPL-3.0-or-later
package knowledge

import (
	"math"
	"sort"
)

// Posting is the persisted frequency of a query term in a specific field.
type Posting struct {
	EntryID   string
	Term      string
	Field     string
	Frequency int
}
type Candidate struct {
	Entry    Entry
	Length   int
	Postings []Posting
}
type Corpus struct {
	Documents         int
	AverageLength     float64
	DocumentFrequency map[string]int
}

// Rank implements BM25 with k1=1.2, b=0.75 and fixed field weights. Corpus
// statistics must use exactly the same filters as the candidates. Positive
// Robertson IDF avoids negative scores in small project collections.
func Rank(candidates []Candidate, terms []string, corpus Corpus, limit, snippetRunes int) []Hit {
	if corpus.Documents <= 0 {
		return []Hit{}
	}
	if limit <= 0 {
		limit = 20
	}
	if limit > 100 {
		limit = 100
	}
	average := corpus.AverageLength
	if average <= 0 {
		average = 1
	}
	wanted := map[string]bool{}
	for _, term := range terms {
		wanted[term] = true
	}
	hits := make([]Hit, 0, len(candidates))
	for _, candidate := range candidates {
		frequencies := map[string]float64{}
		for _, posting := range candidate.Postings {
			if !wanted[posting.Term] || posting.Frequency <= 0 {
				continue
			}
			weight := 1.0
			if posting.Field == "title" {
				weight = 3
			}
			if posting.Field == "tags" {
				weight = 2
			}
			frequencies[posting.Term] += float64(posting.Frequency) * weight
		}
		score := 0.0
		matched := []string{}
		for _, term := range terms {
			frequency := frequencies[term]
			if frequency <= 0 {
				continue
			}
			matched = append(matched, term)
			df := corpus.DocumentFrequency[term]
			if df < 1 {
				df = 1
			}
			if df > corpus.Documents {
				df = corpus.Documents
			}
			idf := math.Log(1 + (float64(corpus.Documents-df)+0.5)/(float64(df)+0.5))
			norm := 1.2 * (1 - 0.75 + 0.75*float64(candidate.Length)/average)
			score += idf * (frequency * 2.2) / (frequency + norm)
		}
		if score <= 0 || math.IsNaN(score) || math.IsInf(score, 0) {
			continue
		}
		hits = append(hits, Hit{Entry: candidate.Entry, Score: score, MatchedTerms: matched, TitleHighlights: Highlights(candidate.Entry.Title, matched), Snippet: MakeSnippet(candidate.Entry.Body, matched, snippetRunes)})
	}
	sort.Slice(hits, func(i, j int) bool {
		if hits[i].Score != hits[j].Score {
			return hits[i].Score > hits[j].Score
		}
		return hits[i].Entry.ID < hits[j].Entry.ID
	})
	if len(hits) > limit {
		hits = hits[:limit]
	}
	return hits
}
