// SPDX-License-Identifier: AGPL-3.0-or-later
package projectknowledge

import (
	"context"
	"database/sql"
	"encoding/json"
	"strings"
	"unicode/utf8"

	"github.com/Moonrend/Zakura/packages/projectkit/knowledge"
	"github.com/Moonrend/Zakura/packages/projectkit/mission"
)

func HumanAction(action string) bool {
	return action == "approve" || action == "reject" || action == "resolve" || action == "reopen"
}
func (s *Store) Transition(ctx context.Context, scope mission.Scope, id string, expected int64, action, comment, author string, human bool) (knowledge.Entry, error) {
	var out knowledge.Entry
	if HumanAction(action) && !human {
		return out, invalid("decision review and question resolution require a human reviewer")
	}
	if strings.TrimSpace(comment) == "" || len(comment) > 4096 || !utf8.ValidString(comment) {
		return out, invalid("an explanatory comment of at most 4096 valid UTF-8 bytes is required")
	}
	err := s.tx(ctx, scope, func(tx *sql.Tx) error {
		entry, e := s.entry(ctx, tx, scope, id, 0)
		if e != nil {
			return e
		}
		if entry.Revision != expected {
			return ErrConflict
		}
		if entry.Status == "deleted" {
			return invalid("deleted entries retain immutable audit history")
		}
		prior := ""
		switch action {
		case "approve", "reject":
			if entry.Kind != "decision" || entry.Status != "proposed" {
				return invalid("only proposed decisions can be reviewed")
			}
			if action == "approve" {
				entry.Status = "approved"
			} else {
				entry.Status = "rejected"
			}
		case "resolve":
			if entry.Kind != "question" || entry.Status != "open" {
				return invalid("only open questions can be resolved")
			}
			entry.Status = "resolved"
		case "reopen":
			if entry.Kind != "question" || entry.Status != "resolved" {
				return invalid("only resolved questions can be reopened")
			}
			entry.Status = "open"
		case "archive":
			if entry.Status == "archived" {
				return invalid("entry is already archived")
			}
			prior = entry.Status
			entry.Status = "archived"
		case "restore":
			if entry.Status != "archived" {
				return invalid("only archived entries can be restored")
			}
			if e = tx.QueryRowContext(ctx, s.rebind(`SELECT prior_status FROM execution_knowledge WHERE tenant_id=? AND project_id=? AND id=?`), scope.TenantID, scope.ProjectID, id).Scan(&prior); e != nil {
				return e
			}
			if prior == "" || prior == "archived" || prior == "deleted" {
				return invalid("archive has no restorable state")
			}
			entry.Status = prior
			prior = ""
		case "delete":
			entry.Status = "deleted"
			entry.Body = ""
			entry.Sources = []knowledge.Source{}
			entry.Tags = []string{}
		default:
			return invalid("unsupported knowledge action")
		}
		entry.Revision++
		entry.UpdatedAt = s.now()
		entry.UpdatedBy = author
		out = entry
		return s.persist(ctx, tx, scope, entry, action, comment, author, prior)
	})
	return out, err
}
func (s *Store) History(ctx context.Context, scope mission.Scope, id string, before int64, limit int) ([]knowledge.Revision, error) {
	if err := s.requireScope(ctx, s.db, scope); err != nil {
		return nil, err
	}
	if _, err := s.entry(ctx, s.db, scope, id, 0); err != nil {
		return nil, err
	}
	if limit <= 0 {
		limit = 50
	}
	if limit > 200 {
		limit = 200
	}
	args := []any{scope.TenantID, scope.ProjectID, id}
	q := `SELECT revision_json FROM execution_knowledge_revisions WHERE tenant_id=? AND project_id=? AND entry_id=?`
	if before > 0 {
		q += ` AND revision<?`
		args = append(args, before)
	}
	q += ` ORDER BY revision DESC LIMIT ?`
	args = append(args, limit)
	rows, err := s.db.QueryContext(ctx, s.rebind(q), args...)
	if err != nil {
		return nil, err
	}
	defer rows.Close()
	items := []knowledge.Revision{}
	for rows.Next() {
		var raw string
		var revision knowledge.Revision
		if err = rows.Scan(&raw); err != nil {
			return nil, err
		}
		if err = json.Unmarshal([]byte(raw), &revision); err != nil {
			return nil, err
		}
		items = append(items, revision)
	}
	return items, rows.Err()
}
func (s *Store) AddComment(ctx context.Context, scope mission.Scope, id string, expected int64, body, author string) (knowledge.Comment, error) {
	var out knowledge.Comment
	if strings.TrimSpace(body) == "" || len(body) > 16384 || !utf8.ValidString(body) {
		return out, invalid("comment must be valid UTF-8 and at most 16384 bytes")
	}
	err := s.tx(ctx, scope, func(tx *sql.Tx) error {
		entry, e := s.entry(ctx, tx, scope, id, 0)
		if e != nil {
			return e
		}
		if expected != entry.Revision {
			return ErrConflict
		}
		if entry.Status == "deleted" {
			return invalid("deleted entries cannot receive new comments")
		}
		id, e := newID()
		if e != nil {
			return e
		}
		out = knowledge.Comment{ID: id, EntryID: entry.ID, Revision: entry.Revision, Body: body, AuthorID: author, CreatedAt: s.now()}
		raw, e := encode(out)
		if e != nil {
			return e
		}
		_, e = tx.ExecContext(ctx, s.rebind(`INSERT INTO execution_knowledge_comments(id,tenant_id,project_id,entry_id,revision,comment_json,created_at) VALUES(?,?,?,?,?,?,?)`), id, scope.TenantID, scope.ProjectID, entry.ID, entry.Revision, raw, stamp(out.CreatedAt))
		if e != nil {
			return e
		}
		return s.event(ctx, tx, scope, entry, "comment", body, author)
	})
	return out, err
}
func (s *Store) Comments(ctx context.Context, scope mission.Scope, id, cursor string, limit int) ([]knowledge.Comment, error) {
	if err := s.requireScope(ctx, s.db, scope); err != nil {
		return nil, err
	}
	if _, err := s.entry(ctx, s.db, scope, id, 0); err != nil {
		return nil, err
	}
	if limit <= 0 {
		limit = 100
	}
	if limit > 200 {
		limit = 200
	}
	if cursor != "" && !opaque(cursor) {
		return nil, ErrInvalid
	}
	query := `SELECT comment_json FROM execution_knowledge_comments WHERE tenant_id=? AND project_id=? AND entry_id=?`
	args := []any{scope.TenantID, scope.ProjectID, id}
	if cursor != "" {
		var createdAt string
		err := s.db.QueryRowContext(ctx, s.rebind(`SELECT created_at FROM execution_knowledge_comments WHERE tenant_id=? AND project_id=? AND entry_id=? AND id=?`), scope.TenantID, scope.ProjectID, id, cursor).Scan(&createdAt)
		if err != nil {
			return nil, notFound(err)
		}
		query += ` AND (created_at>? OR (created_at=? AND id>?))`
		args = append(args, createdAt, createdAt, cursor)
	}
	query += ` ORDER BY created_at,id LIMIT ?`
	args = append(args, limit)
	rows, err := s.db.QueryContext(ctx, s.rebind(query), args...)
	if err != nil {
		return nil, err
	}
	defer rows.Close()
	items := []knowledge.Comment{}
	for rows.Next() {
		var raw string
		var comment knowledge.Comment
		if err = rows.Scan(&raw); err != nil {
			return nil, err
		}
		if err = json.Unmarshal([]byte(raw), &comment); err != nil {
			return nil, err
		}
		items = append(items, comment)
	}
	return items, rows.Err()
}
