// SPDX-License-Identifier: AGPL-3.0-or-later
package knowledge

import (
	"errors"
	"sort"
	"strings"
	"unicode"
	"unicode/utf8"
)

const MaxQueryBytes = 4096
const MaxQueryTerms = 32

type Token struct {
	Term  string
	Start int
	End   int
}

func isCJK(r rune) bool {
	return unicode.Is(unicode.Han, r) || unicode.Is(unicode.Hiragana, r) || unicode.Is(unicode.Katakana, r) || unicode.Is(unicode.Hangul, r)
}

// Tokenize keeps whole Latin/digit words and emits CJK characters and adjacent
// bigrams. It has no external dictionary and therefore makes no semantic claims.
func Tokenize(text string) []Token {
	runes := []rune(text)
	result := make([]Token, 0, len(runes)/2)
	for i := 0; i < len(runes); {
		if isCJK(runes[i]) {
			result = append(result, Token{string(unicode.ToLower(runes[i])), i, i + 1})
			if i+1 < len(runes) && isCJK(runes[i+1]) {
				result = append(result, Token{strings.ToLower(string(runes[i : i+2])), i, i + 2})
			}
			i++
			continue
		}
		if unicode.IsLetter(runes[i]) || unicode.IsDigit(runes[i]) {
			start := i
			i++
			for i < len(runes) && !isCJK(runes[i]) && (unicode.IsLetter(runes[i]) || unicode.IsDigit(runes[i]) || runes[i] == '_') {
				i++
			}
			// Oversized user words are irrelevant to a bounded search query and
			// would otherwise dominate index storage.
			if i-start <= 128 {
				result = append(result, Token{strings.ToLower(string(runes[start:i])), start, i})
			}
			continue
		}
		i++
	}
	return result
}

func Frequencies(text string) (map[string]int, int) {
	terms := map[string]int{}
	tokens := Tokenize(text)
	for _, token := range tokens {
		terms[token.Term]++
	}
	return terms, len(tokens)
}

func QueryTerms(text string) ([]string, error) {
	if !utf8.ValidString(text) || len(text) > MaxQueryBytes {
		return nil, errors.New("query must be valid UTF-8 and at most 4096 bytes")
	}
	seen := map[string]bool{}
	terms := []string{}
	for _, t := range Tokenize(text) {
		if !seen[t.Term] {
			seen[t.Term] = true
			terms = append(terms, t.Term)
			if len(terms) > MaxQueryTerms {
				return nil, errors.New("query exceeds 32 distinct indexed terms")
			}
		}
	}
	if len(terms) == 0 {
		return nil, errors.New("query requires at least one searchable term")
	}
	return terms, nil
}

func Highlights(text string, terms []string) []Highlight {
	seen := map[string]bool{}
	for _, term := range terms {
		seen[term] = true
	}
	matches := []Highlight{}
	for _, token := range Tokenize(text) {
		if seen[token.Term] {
			matches = append(matches, Highlight{token.Start, token.End})
		}
	}
	sort.Slice(matches, func(i, j int) bool {
		if matches[i].Start != matches[j].Start {
			return matches[i].Start < matches[j].Start
		}
		return matches[i].End < matches[j].End
	})
	merged := []Highlight{}
	for _, h := range matches {
		if len(merged) > 0 && h.Start <= merged[len(merged)-1].End {
			if h.End > merged[len(merged)-1].End {
				merged[len(merged)-1].End = h.End
			}
		} else {
			merged = append(merged, h)
		}
	}
	return merged
}

func MakeSnippet(text string, terms []string, maxRunes int) Snippet {
	if maxRunes <= 0 {
		maxRunes = 240
	}
	if maxRunes > 1000 {
		maxRunes = 1000
	}
	runes := []rune(text)
	highlights := Highlights(text, terms)
	start := 0
	if len(highlights) > 0 && highlights[0].Start > maxRunes/3 {
		start = highlights[0].Start - maxRunes/3
	}
	end := start + maxRunes
	if end > len(runes) {
		end = len(runes)
	}
	if start > end {
		start = end
	}
	result := Snippet{Text: string(runes[start:end]), Start: start, Highlights: []Highlight{}}
	for _, h := range highlights {
		if h.End <= start || h.Start >= end {
			continue
		}
		h.Start -= start
		h.End -= start
		if h.Start < 0 {
			h.Start = 0
		}
		if h.End > end-start {
			h.End = end - start
		}
		result.Highlights = append(result.Highlights, h)
	}
	return result
}
