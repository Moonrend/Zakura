// SPDX-License-Identifier: AGPL-3.0-or-later
package knowledge

import "time"

// Entry is a project-local reference, never an instruction to the executing
// model. Each update creates an immutable revision, including state changes.
type Entry struct {
	ID        string    `json:"id"`
	ProjectID string    `json:"projectId"`
	Kind      string    `json:"kind"`
	Title     string    `json:"title"`
	Body      string    `json:"body"`
	Format    string    `json:"format"`
	Tags      []string  `json:"tags"`
	Sources   []Source  `json:"sources"`
	RunID     string    `json:"runId,omitempty"`
	TaskID    string    `json:"taskId,omitempty"`
	Status    string    `json:"status"`
	Revision  int64     `json:"revision"`
	CreatedBy string    `json:"createdBy"`
	UpdatedBy string    `json:"updatedBy"`
	CreatedAt time.Time `json:"createdAt"`
	UpdatedAt time.Time `json:"updatedAt"`
}

// Source records provenance without fetching remote URLs or reading arbitrary
// runner objects. Referenced revisions and snapshot ownership are checked by
// the project store before the reference is accepted.
type Source struct {
	Kind       string `json:"kind"`
	Label      string `json:"label,omitempty"`
	SnapshotID string `json:"snapshotId,omitempty"`
	Path       string `json:"path,omitempty"`
	EntryID    string `json:"entryId,omitempty"`
	Revision   int64  `json:"revision,omitempty"`
	URL        string `json:"url,omitempty"`
}

type Draft struct {
	Kind    string   `json:"kind"`
	Title   string   `json:"title"`
	Body    string   `json:"body"`
	Format  string   `json:"format"`
	Tags    []string `json:"tags"`
	Sources []Source `json:"sources"`
	RunID   string   `json:"runId,omitempty"`
	TaskID  string   `json:"taskId,omitempty"`
}

type Revision struct {
	Entry     Entry     `json:"entry"`
	Action    string    `json:"action"`
	Comment   string    `json:"comment,omitempty"`
	AuthorID  string    `json:"authorId"`
	CreatedAt time.Time `json:"createdAt"`
}

type Comment struct {
	ID        string    `json:"id"`
	EntryID   string    `json:"entryId"`
	Revision  int64     `json:"revision"`
	Body      string    `json:"body"`
	AuthorID  string    `json:"authorId"`
	CreatedAt time.Time `json:"createdAt"`
}

type Filter struct {
	Kind            string   `json:"kind,omitempty"`
	Status          string   `json:"status,omitempty"`
	Tags            []string `json:"tags,omitempty"`
	RunID           string   `json:"runId,omitempty"`
	TaskID          string   `json:"taskId,omitempty"`
	IncludeArchived bool     `json:"includeArchived,omitempty"`
}

type Query struct {
	Text          string `json:"text"`
	Filter        Filter `json:"filter"`
	Limit         int    `json:"limit"`
	MaxCandidates int    `json:"maxCandidates,omitempty"`
	SnippetRunes  int    `json:"snippetRunes,omitempty"`
}

// Highlight offsets count Unicode code points within the snippet, not bytes or
// UTF-16 units. Browsers can safely render using Array.from(text) and text nodes.
type Highlight struct {
	Start int `json:"start"`
	End   int `json:"end"`
}
type Snippet struct {
	Text       string      `json:"text"`
	Start      int         `json:"start"`
	Highlights []Highlight `json:"highlights"`
}
type Hit struct {
	Entry           Entry       `json:"entry"`
	Score           float64     `json:"score"`
	TitleHighlights []Highlight `json:"titleHighlights"`
	Snippet         Snippet     `json:"snippet"`
	MatchedTerms    []string    `json:"matchedTerms"`
}
type SearchResult struct {
	Items      []Hit    `json:"items"`
	Terms      []string `json:"terms"`
	Candidates int      `json:"candidates"`
	CorpusSize int      `json:"corpusSize"`
	Truncated  bool     `json:"truncated"`
	Algorithm  string   `json:"algorithm"`
}

type ListResult struct {
	Items      []Entry `json:"items"`
	NextCursor string  `json:"nextCursor,omitempty"`
}
