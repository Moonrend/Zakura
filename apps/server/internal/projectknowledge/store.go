// SPDX-License-Identifier: AGPL-3.0-or-later
package projectknowledge

import (
	"context"
	"crypto/rand"
	"database/sql"
	"encoding/hex"
	"encoding/json"
	"errors"
	"fmt"
	"sort"
	"strings"
	"time"

	"github.com/Moonrend/Zakura/apps/server/internal/projectexec"
	"github.com/Moonrend/Zakura/packages/projectkit/knowledge"
	"github.com/Moonrend/Zakura/packages/projectkit/mission"
)

var ErrNotFound = projectexec.ErrNotFound
var ErrConflict = projectexec.ErrConflict
var ErrInvalid = projectexec.ErrInvalidState

type Store struct {
	db      *sql.DB
	dialect string
	rebind  func(string) string
	now     func() time.Time
}
type reader interface {
	QueryRowContext(context.Context, string, ...any) *sql.Row
	QueryContext(context.Context, string, ...any) (*sql.Rows, error)
}

func NewStore(db *sql.DB, dialect string, rebind func(string) string) *Store {
	if rebind == nil {
		rebind = func(q string) string { return q }
	}
	return &Store{db: db, dialect: dialect, rebind: rebind, now: func() time.Time { return time.Now().UTC() }}
}
func newID() (string, error) {
	var b [16]byte
	if _, e := rand.Read(b[:]); e != nil {
		return "", e
	}
	return hex.EncodeToString(b[:]), nil
}
func stamp(t time.Time) string     { return t.UTC().Format("2006-01-02T15:04:05.000000000Z") }
func encode(v any) (string, error) { b, e := json.Marshal(v); return string(b), e }
func notFound(err error) error {
	if errors.Is(err, sql.ErrNoRows) {
		return ErrNotFound
	}
	return err
}
func (s *Store) requireScope(ctx context.Context, q reader, scope mission.Scope) error {
	var n int
	err := q.QueryRowContext(ctx, s.rebind(`SELECT COUNT(*) FROM execution_projects WHERE tenant_id=? AND space_id=? AND id=?`), scope.TenantID, scope.SpaceID, scope.ProjectID).Scan(&n)
	if err != nil {
		return err
	}
	if n != 1 {
		return ErrNotFound
	}
	return nil
}
func (s *Store) tx(ctx context.Context, scope mission.Scope, fn func(*sql.Tx) error) error {
	tx, err := s.db.BeginTx(ctx, nil)
	if err != nil {
		return err
	}
	defer tx.Rollback()
	r, err := tx.ExecContext(ctx, s.rebind(`UPDATE execution_projects SET event_sequence=event_sequence WHERE tenant_id=? AND space_id=? AND id=?`), scope.TenantID, scope.SpaceID, scope.ProjectID)
	if err != nil {
		return err
	}
	n, err := r.RowsAffected()
	if err != nil {
		return err
	}
	if n != 1 {
		return ErrNotFound
	}
	if err = projectexec.NewStore(s.db, s.dialect, s.rebind).RequireTenantActive(ctx, tx, scope.TenantID); err != nil {
		return err
	}
	if err = fn(tx); err != nil {
		return err
	}
	return tx.Commit()
}
func (s *Store) entry(ctx context.Context, q reader, scope mission.Scope, id string, revision int64) (knowledge.Entry, error) {
	var raw string
	var err error
	if revision > 0 {
		err = q.QueryRowContext(ctx, s.rebind(`SELECT revision_json FROM execution_knowledge_revisions WHERE tenant_id=? AND project_id=? AND entry_id=? AND revision=?`), scope.TenantID, scope.ProjectID, id, revision).Scan(&raw)
		if err != nil {
			return knowledge.Entry{}, notFound(err)
		}
		var r knowledge.Revision
		err = json.Unmarshal([]byte(raw), &r)
		return r.Entry, err
	}
	err = q.QueryRowContext(ctx, s.rebind(`SELECT entry_json FROM execution_knowledge WHERE tenant_id=? AND project_id=? AND id=?`), scope.TenantID, scope.ProjectID, id).Scan(&raw)
	if err != nil {
		return knowledge.Entry{}, notFound(err)
	}
	var entry knowledge.Entry
	err = json.Unmarshal([]byte(raw), &entry)
	return entry, err
}
func (s *Store) Get(ctx context.Context, scope mission.Scope, id string, revision int64) (knowledge.Entry, error) {
	if err := s.requireScope(ctx, s.db, scope); err != nil {
		return knowledge.Entry{}, err
	}
	if revision < 0 {
		return knowledge.Entry{}, ErrInvalid
	}
	return s.entry(ctx, s.db, scope, id, revision)
}
func (s *Store) Create(ctx context.Context, scope mission.Scope, draft knowledge.Draft, author string) (knowledge.Entry, error) {
	var out knowledge.Entry
	err := s.tx(ctx, scope, func(tx *sql.Tx) error { var e error; out, e = s.create(ctx, tx, scope, draft, author); return e })
	return out, err
}
func (s *Store) create(ctx context.Context, tx *sql.Tx, scope mission.Scope, draft knowledge.Draft, author string) (knowledge.Entry, error) {
	draft, err := NormalizeDraft(draft)
	if err != nil {
		return knowledge.Entry{}, err
	}
	if err = s.validateLinks(ctx, tx, scope, draft); err != nil {
		return knowledge.Entry{}, err
	}
	var count int
	if err = tx.QueryRowContext(ctx, s.rebind(`SELECT COUNT(*) FROM execution_knowledge WHERE tenant_id=? AND project_id=?`), scope.TenantID, scope.ProjectID).Scan(&count); err != nil {
		return knowledge.Entry{}, err
	}
	if count >= 10000 {
		return knowledge.Entry{}, fmt.Errorf("%w: project knowledge limit is 10000 entries including retained history", ErrInvalid)
	}
	id, err := newID()
	if err != nil {
		return knowledge.Entry{}, err
	}
	now := s.now()
	status := "active"
	if draft.Kind == "decision" {
		status = "proposed"
	}
	if draft.Kind == "question" {
		status = "open"
	}
	out := knowledge.Entry{ID: id, ProjectID: scope.ProjectID, Kind: draft.Kind, Title: draft.Title, Body: draft.Body, Format: draft.Format, Tags: draft.Tags, Sources: draft.Sources, RunID: draft.RunID, TaskID: draft.TaskID, Status: status, Revision: 1, CreatedBy: author, UpdatedBy: author, CreatedAt: now, UpdatedAt: now}
	raw, err := encode(out)
	if err != nil {
		return knowledge.Entry{}, err
	}
	_, err = tx.ExecContext(ctx, s.rebind(`INSERT INTO execution_knowledge(id,tenant_id,project_id,kind,status,run_id,task_id,revision,token_length,entry_json,created_at,updated_at) VALUES(?,?,?,?,?,?,?,?,?,?,?,?)`), id, scope.TenantID, scope.ProjectID, out.Kind, out.Status, out.RunID, out.TaskID, out.Revision, 0, raw, stamp(now), stamp(now))
	if err != nil {
		return knowledge.Entry{}, err
	}
	if err = s.persist(ctx, tx, scope, out, "create", "", author, ""); err != nil {
		return knowledge.Entry{}, err
	}
	return out, nil
}
func (s *Store) persist(ctx context.Context, tx *sql.Tx, scope mission.Scope, entry knowledge.Entry, action, comment, author, priorStatus string) error {
	raw, err := encode(entry)
	if err != nil {
		return err
	}
	_, length := knowledge.Frequencies(entry.Title + " " + strings.Join(entry.Tags, " ") + " " + entry.Body)
	_, err = tx.ExecContext(ctx, s.rebind(`UPDATE execution_knowledge SET status=?,prior_status=?,run_id=?,task_id=?,revision=?,token_length=?,entry_json=?,updated_at=? WHERE tenant_id=? AND project_id=? AND id=?`), entry.Status, priorStatus, entry.RunID, entry.TaskID, entry.Revision, length, raw, stamp(entry.UpdatedAt), scope.TenantID, scope.ProjectID, entry.ID)
	if err != nil {
		return err
	}
	revision := knowledge.Revision{Entry: entry, Action: action, Comment: comment, AuthorID: author, CreatedAt: entry.UpdatedAt}
	revisionRaw, err := encode(revision)
	if err != nil {
		return err
	}
	_, err = tx.ExecContext(ctx, s.rebind(`INSERT INTO execution_knowledge_revisions(tenant_id,project_id,entry_id,revision,revision_json,created_at) VALUES(?,?,?,?,?,?)`), scope.TenantID, scope.ProjectID, entry.ID, entry.Revision, revisionRaw, stamp(entry.UpdatedAt))
	if err != nil {
		return err
	}
	if _, err = tx.ExecContext(ctx, s.rebind(`DELETE FROM execution_knowledge_terms WHERE tenant_id=? AND project_id=? AND entry_id=?`), scope.TenantID, scope.ProjectID, entry.ID); err != nil {
		return err
	}
	if _, err = tx.ExecContext(ctx, s.rebind(`DELETE FROM execution_knowledge_tags WHERE tenant_id=? AND project_id=? AND entry_id=?`), scope.TenantID, scope.ProjectID, entry.ID); err != nil {
		return err
	}
	if entry.Status != "deleted" {
		for _, field := range []struct{ name, text string }{{"title", entry.Title}, {"tags", strings.Join(entry.Tags, " ")}, {"body", entry.Body}} {
			terms, _ := knowledge.Frequencies(field.text)
			keys := make([]string, 0, len(terms))
			for term := range terms {
				keys = append(keys, term)
			}
			sort.Strings(keys)
			for start := 0; start < len(keys); start += 100 {
				end := start + 100
				if end > len(keys) {
					end = len(keys)
				}
				query := `INSERT INTO execution_knowledge_terms(tenant_id,project_id,entry_id,term,field,frequency) VALUES `
				values := make([]string, 0, end-start)
				args := make([]any, 0, (end-start)*6)
				for _, term := range keys[start:end] {
					values = append(values, "(?,?,?,?,?,?)")
					args = append(args, scope.TenantID, scope.ProjectID, entry.ID, term, field.name, terms[term])
				}
				if _, err = tx.ExecContext(ctx, s.rebind(query+strings.Join(values, ",")), args...); err != nil {
					return err
				}
			}
		}
		for _, tag := range entry.Tags {
			_, err = tx.ExecContext(ctx, s.rebind(`INSERT INTO execution_knowledge_tags(tenant_id,project_id,entry_id,tag) VALUES(?,?,?,?)`), scope.TenantID, scope.ProjectID, entry.ID, tag)
			if err != nil {
				return err
			}
		}
	}
	return s.event(ctx, tx, scope, entry, action, comment, author)
}
func (s *Store) Update(ctx context.Context, scope mission.Scope, id string, expected int64, draft knowledge.Draft, comment, author string) (knowledge.Entry, error) {
	var out knowledge.Entry
	err := s.tx(ctx, scope, func(tx *sql.Tx) error {
		old, e := s.entry(ctx, tx, scope, id, 0)
		if e != nil {
			return e
		}
		if expected != old.Revision {
			return ErrConflict
		}
		if old.Status == "archived" || old.Status == "deleted" {
			return fmt.Errorf("%w: restore archived entry before editing; deleted entries retain immutable history", ErrInvalid)
		}
		draft, e = NormalizeDraft(draft)
		if e != nil {
			return e
		}
		if draft.Kind != old.Kind {
			return fmt.Errorf("%w: entry kind is immutable", ErrInvalid)
		}
		if e = s.validateLinks(ctx, tx, scope, draft); e != nil {
			return e
		}
		if len(comment) > 4096 {
			return ErrInvalid
		}
		out = old
		out.Title = draft.Title
		out.Body = draft.Body
		out.Format = draft.Format
		out.Tags = draft.Tags
		out.Sources = draft.Sources
		out.RunID = draft.RunID
		out.TaskID = draft.TaskID
		out.Revision++
		out.UpdatedBy = author
		out.UpdatedAt = s.now()
		// Editing an approved decision removes its prior approval. The old
		// approved revision remains addressable for citations and audit.
		if out.Kind == "decision" {
			out.Status = "proposed"
		}
		if out.Kind == "question" && old.Status == "resolved" {
			out.Status = "open"
		}
		return s.persist(ctx, tx, scope, out, "edit", comment, author, "")
	})
	return out, err
}
func (s *Store) event(ctx context.Context, tx *sql.Tx, scope mission.Scope, entry knowledge.Entry, action, comment, author string) error {
	if _, err := tx.ExecContext(ctx, s.rebind(`UPDATE execution_projects SET event_sequence=event_sequence+1 WHERE tenant_id=? AND id=?`), scope.TenantID, scope.ProjectID); err != nil {
		return err
	}
	var sequence int64
	if err := tx.QueryRowContext(ctx, s.rebind(`SELECT event_sequence FROM execution_projects WHERE tenant_id=? AND id=?`), scope.TenantID, scope.ProjectID).Scan(&sequence); err != nil {
		return err
	}
	id, err := newID()
	if err != nil {
		return err
	}
	payload, err := json.Marshal(map[string]any{"entryId": entry.ID, "revision": entry.Revision, "kind": entry.Kind, "status": entry.Status, "authorId": author, "comment": comment})
	if err != nil {
		return err
	}
	e := mission.Event{ID: id, ProjectID: scope.ProjectID, RunID: entry.RunID, TaskID: entry.TaskID, Sequence: sequence, Kind: "knowledge." + action, Payload: payload, CreatedAt: s.now()}
	raw, err := encode(e)
	if err != nil {
		return err
	}
	_, err = tx.ExecContext(ctx, s.rebind(`INSERT INTO execution_events(id,tenant_id,project_id,run_id,task_id,sequence,event_json,created_at) VALUES(?,?,?,?,?,?,?,?)`), id, scope.TenantID, scope.ProjectID, entry.RunID, entry.TaskID, sequence, raw, stamp(e.CreatedAt))
	return err
}
