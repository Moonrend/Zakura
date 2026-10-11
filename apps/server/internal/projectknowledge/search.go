// SPDX-License-Identifier: AGPL-3.0-or-later
package projectknowledge

import (
	"context"
	"database/sql"
	"encoding/json"
	"fmt"
	"strings"

	"github.com/Moonrend/Zakura/packages/projectkit/knowledge"
	"github.com/Moonrend/Zakura/packages/projectkit/mission"
)

func placeholders(count int) string { return strings.TrimSuffix(strings.Repeat("?,", count), ",") }
func filters(scope mission.Scope, filter knowledge.Filter) (string, []any, error) {
	q := `d.tenant_id=? AND d.project_id=? AND d.status<>'deleted'`
	args := []any{scope.TenantID, scope.ProjectID}
	if filter.Kind != "" {
		if filter.Kind != "note" && filter.Kind != "decision" && filter.Kind != "question" {
			return "", nil, invalid("invalid knowledge kind filter")
		}
		q += ` AND d.kind=?`
		args = append(args, filter.Kind)
	}
	if filter.Status != "" {
		switch filter.Status {
		case "active", "proposed", "approved", "rejected", "open", "resolved", "archived":
		default:
			return "", nil, invalid("invalid knowledge status filter")
		}
		q += ` AND d.status=?`
		args = append(args, filter.Status)
	}
	if !filter.IncludeArchived && filter.Status != "archived" {
		q += ` AND d.status<>'archived'`
	}
	if filter.RunID != "" {
		if !opaque(filter.RunID) {
			return "", nil, ErrInvalid
		}
		q += ` AND d.run_id=?`
		args = append(args, filter.RunID)
	}
	if filter.TaskID != "" {
		if !opaque(filter.TaskID) {
			return "", nil, ErrInvalid
		}
		q += ` AND d.task_id=?`
		args = append(args, filter.TaskID)
	}
	if len(filter.Tags) > 32 {
		return "", nil, invalid("at most 32 tag filters are allowed")
	}
	for _, tag := range filter.Tags {
		tag = strings.ToLower(strings.TrimSpace(tag))
		if tag == "" || len(tag) > 64 {
			return "", nil, ErrInvalid
		}
		q += ` AND EXISTS(SELECT 1 FROM execution_knowledge_tags kt WHERE kt.tenant_id=d.tenant_id AND kt.project_id=d.project_id AND kt.entry_id=d.id AND kt.tag=?)`
		args = append(args, tag)
	}
	return q, args, nil
}
func (s *Store) List(ctx context.Context, scope mission.Scope, filter knowledge.Filter, cursor string, limit int) (knowledge.ListResult, error) {
	result := knowledge.ListResult{Items: []knowledge.Entry{}}
	if err := s.requireScope(ctx, s.db, scope); err != nil {
		return result, err
	}
	if cursor != "" && !opaque(cursor) {
		return result, ErrInvalid
	}
	if limit <= 0 {
		limit = 50
	}
	if limit > 200 {
		limit = 200
	}
	where, args, err := filters(scope, filter)
	if err != nil {
		return result, err
	}
	args = append(args, cursor, limit+1)
	rows, err := s.db.QueryContext(ctx, s.rebind(`SELECT d.entry_json FROM execution_knowledge d WHERE `+where+` AND d.id>? ORDER BY d.id LIMIT ?`), args...)
	if err != nil {
		return result, err
	}
	defer rows.Close()
	for rows.Next() {
		var raw string
		var entry knowledge.Entry
		if err = rows.Scan(&raw); err != nil {
			return result, err
		}
		if err = json.Unmarshal([]byte(raw), &entry); err != nil {
			return result, err
		}
		result.Items = append(result.Items, entry)
	}
	if err = rows.Err(); err != nil {
		return result, err
	}
	if len(result.Items) > limit {
		result.Items = result.Items[:limit]
		result.NextCursor = result.Items[len(result.Items)-1].ID
	}
	return result, nil
}
func (s *Store) Search(ctx context.Context, scope mission.Scope, query knowledge.Query) (knowledge.SearchResult, error) {
	result := knowledge.SearchResult{Items: []knowledge.Hit{}, Algorithm: "bm25-cjk-bigrams-v1"}
	terms, err := knowledge.QueryTerms(query.Text)
	if err != nil {
		return result, fmt.Errorf("%w: %v", ErrInvalid, err)
	}
	result.Terms = terms
	if query.Limit <= 0 {
		query.Limit = 20
	}
	if query.Limit > 100 {
		return result, invalid("search result limit is 100")
	}
	if query.MaxCandidates == 0 {
		query.MaxCandidates = 2000
	}
	if query.MaxCandidates < 1 || query.MaxCandidates > 2000 {
		return result, invalid("candidate budget must be between 1 and 2000")
	}
	if query.SnippetRunes < 0 || query.SnippetRunes > 1000 {
		return result, invalid("snippet length must be between 0 and 1000 code points")
	}
	where, args, err := filters(scope, query.Filter)
	if err != nil {
		return result, err
	}
	// A single read transaction makes revisions, corpus statistics and posting
	// frequencies agree even while another agent edits the knowledge corpus.
	tx, err := s.db.BeginTx(ctx, &sql.TxOptions{Isolation: sql.LevelRepeatableRead, ReadOnly: true})
	if err != nil {
		return result, err
	}
	defer tx.Rollback()
	if err = s.requireScope(ctx, tx, scope); err != nil {
		return result, err
	}
	corpus := knowledge.Corpus{DocumentFrequency: map[string]int{}}
	err = tx.QueryRowContext(ctx, s.rebind(`SELECT COUNT(*),COALESCE(AVG(d.token_length),0) FROM execution_knowledge d WHERE `+where), args...).Scan(&corpus.Documents, &corpus.AverageLength)
	if err != nil {
		return result, err
	}
	result.CorpusSize = corpus.Documents
	if corpus.Documents == 0 {
		return result, tx.Commit()
	}
	termArgs := append([]any{}, args...)
	for _, term := range terms {
		termArgs = append(termArgs, term)
	}
	termWhere := `t.term IN (` + placeholders(len(terms)) + `)`
	join := ` FROM execution_knowledge d JOIN execution_knowledge_terms t ON t.tenant_id=d.tenant_id AND t.project_id=d.project_id AND t.entry_id=d.id WHERE ` + where + ` AND ` + termWhere
	rows, err := tx.QueryContext(ctx, s.rebind(`SELECT t.term,COUNT(DISTINCT d.id)`+join+` GROUP BY t.term`), termArgs...)
	if err != nil {
		return result, err
	}
	for rows.Next() {
		var term string
		var n int
		if err = rows.Scan(&term, &n); err != nil {
			rows.Close()
			return result, err
		}
		corpus.DocumentFrequency[term] = n
	}
	err = rows.Err()
	rows.Close()
	if err != nil {
		return result, err
	}
	selectionArgs := append(append([]any{}, termArgs...), query.MaxCandidates+1)
	rows, err = tx.QueryContext(ctx, s.rebind(`SELECT d.id,SUM(t.frequency)`+join+` GROUP BY d.id ORDER BY SUM(t.frequency) DESC,d.id LIMIT ?`), selectionArgs...)
	if err != nil {
		return result, err
	}
	ids := []string{}
	for rows.Next() {
		var id string
		var frequency int
		if err = rows.Scan(&id, &frequency); err != nil {
			rows.Close()
			return result, err
		}
		ids = append(ids, id)
	}
	err = rows.Err()
	rows.Close()
	if err != nil {
		return result, err
	}
	if len(ids) > query.MaxCandidates {
		result.Truncated = true
		ids = ids[:query.MaxCandidates]
	}
	result.Candidates = len(ids)
	if len(ids) == 0 {
		return result, tx.Commit()
	}
	// Candidate metadata is fetched separately from bodies. Only the final top
	// hits hydrate bodies, bounding a search to at most 100 full documents.
	byID := map[string]*knowledge.Candidate{}
	idArgs := []any{scope.TenantID, scope.ProjectID}
	for _, id := range ids {
		idArgs = append(idArgs, id)
	}
	rows, err = tx.QueryContext(ctx, s.rebind(`SELECT id,token_length FROM execution_knowledge WHERE tenant_id=? AND project_id=? AND id IN (`+placeholders(len(ids))+`)`), idArgs...)
	if err != nil {
		return result, err
	}
	for rows.Next() {
		var id string
		var length int
		if err = rows.Scan(&id, &length); err != nil {
			rows.Close()
			return result, err
		}
		byID[id] = &knowledge.Candidate{Entry: knowledge.Entry{ID: id}, Length: length}
	}
	err = rows.Err()
	rows.Close()
	if err != nil {
		return result, err
	}
	postingArgs := append([]any{}, idArgs...)
	for _, term := range terms {
		postingArgs = append(postingArgs, term)
	}
	rows, err = tx.QueryContext(ctx, s.rebind(`SELECT entry_id,term,field,frequency FROM execution_knowledge_terms WHERE tenant_id=? AND project_id=? AND entry_id IN (`+placeholders(len(ids))+`) AND term IN (`+placeholders(len(terms))+`)`), postingArgs...)
	if err != nil {
		return result, err
	}
	for rows.Next() {
		var posting knowledge.Posting
		if err = rows.Scan(&posting.EntryID, &posting.Term, &posting.Field, &posting.Frequency); err != nil {
			rows.Close()
			return result, err
		}
		if candidate := byID[posting.EntryID]; candidate != nil {
			candidate.Postings = append(candidate.Postings, posting)
		}
	}
	err = rows.Err()
	rows.Close()
	if err != nil {
		return result, err
	}
	candidates := make([]knowledge.Candidate, 0, len(ids))
	for _, id := range ids {
		if candidate := byID[id]; candidate != nil {
			candidates = append(candidates, *candidate)
		}
	}
	hits := knowledge.Rank(candidates, terms, corpus, query.Limit, query.SnippetRunes)
	for i := range hits {
		entry, e := s.entry(ctx, tx, scope, hits[i].Entry.ID, 0)
		if e != nil {
			return result, e
		}
		hits[i].Entry = entry
		hits[i].TitleHighlights = knowledge.Highlights(entry.Title, hits[i].MatchedTerms)
		hits[i].Snippet = knowledge.MakeSnippet(entry.Body, hits[i].MatchedTerms, query.SnippetRunes)
	}
	result.Items = hits
	return result, tx.Commit()
}
