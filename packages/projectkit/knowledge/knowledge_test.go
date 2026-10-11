package knowledge

import (
	"math"
	"reflect"
	"strings"
	"testing"
)

func TestMixedChineseTokenizationAndCodePointHighlights(t *testing.T) {
	text := "🐾缓存策略 PostgreSQL-17 数据一致性"
	terms, err := QueryTerms("缓存 POSTGRESQL")
	if err != nil {
		t.Fatal(err)
	}
	if !reflect.DeepEqual(terms, []string{"缓", "缓存", "存", "postgresql"}) {
		t.Fatalf("terms: %v", terms)
	}
	highlights := Highlights(text, terms)
	if !reflect.DeepEqual(highlights, []Highlight{{1, 3}, {6, 16}}) {
		t.Fatalf("rune offsets: %v", highlights)
	}
	snippet := MakeSnippet(strings.Repeat("x ", 50)+text, terms, 20)
	if len([]rune(snippet.Text)) != 20 || len(snippet.Highlights) == 0 {
		t.Fatalf("snippet: %+v", snippet)
	}
	for _, h := range snippet.Highlights {
		if h.Start < 0 || h.End > len([]rune(snippet.Text)) || h.Start >= h.End {
			t.Fatalf("invalid highlight: %+v", h)
		}
	}
	if _, err = QueryTerms(strings.Repeat("word ", 2000)); err == nil {
		t.Fatal("oversized query accepted")
	}
	if _, err = QueryTerms(strings.Join([]string{"a", "b", "c", "d", "e", "f", "g", "h", "i", "j", "k", "l", "m", "n", "o", "p", "q", "r", "s", "t", "u", "v", "w", "x", "y", "z", "a1", "a2", "a3", "a4", "a5", "a6", "a7"}, " ")); err == nil {
		t.Fatal("more than 32 distinct terms accepted")
	}
}

func TestBM25FieldWeightLengthNormalizationAndStableTies(t *testing.T) {
	corpus := Corpus{Documents: 4, AverageLength: 10, DocumentFrequency: map[string]int{"cache": 4}}
	candidates := []Candidate{
		{Entry: Entry{ID: "z", Body: "cache"}, Length: 10, Postings: []Posting{{Term: "cache", Field: "body", Frequency: 1}}},
		{Entry: Entry{ID: "b", Title: "cache"}, Length: 10, Postings: []Posting{{Term: "cache", Field: "title", Frequency: 1}}},
		{Entry: Entry{ID: "a", Body: "cache"}, Length: 10, Postings: []Posting{{Term: "cache", Field: "body", Frequency: 1}}},
		{Entry: Entry{ID: "long", Body: "cache"}, Length: 100, Postings: []Posting{{Term: "cache", Field: "body", Frequency: 1}}},
	}
	hits := Rank(candidates, []string{"cache"}, corpus, 10, 20)
	if len(hits) != 4 || hits[0].Entry.ID != "b" || hits[1].Entry.ID != "a" || hits[2].Entry.ID != "z" || hits[3].Entry.ID != "long" {
		t.Fatalf("ranking: %+v", hits)
	}
	want := math.Log(1 + 0.5/4.5)
	if math.Abs(hits[1].Score-want) > 1e-12 {
		t.Fatalf("score %g want %g", hits[1].Score, want)
	}
	if hits[3].Score >= hits[2].Score {
		t.Fatal("length normalization failed")
	}
}
