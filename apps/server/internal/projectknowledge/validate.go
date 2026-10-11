// SPDX-License-Identifier: AGPL-3.0-or-later
package projectknowledge

import (
	"context"
	"encoding/json"
	"fmt"
	"net/url"
	"path"
	"sort"
	"strings"
	"unicode/utf8"

	"github.com/Moonrend/Zakura/packages/projectkit/knowledge"
	"github.com/Moonrend/Zakura/packages/projectkit/mission"
)

func invalid(message string) error { return fmt.Errorf("%w: %s", ErrInvalid, message) }
func opaque(value string) bool {
	if value == "" || len(value) > 128 {
		return false
	}
	first := value[0]
	if !(first >= 'a' && first <= 'z' || first >= 'A' && first <= 'Z' || first >= '0' && first <= '9') {
		return false
	}
	for _, r := range value {
		if !(r >= 'a' && r <= 'z' || r >= 'A' && r <= 'Z' || r >= '0' && r <= '9' || r == '_' || r == '-' || r == '.') {
			return false
		}
	}
	return true
}
func NormalizeDraft(draft knowledge.Draft) (knowledge.Draft, error) {
	if draft.Kind == "" {
		draft.Kind = "note"
	}
	if draft.Kind != "note" && draft.Kind != "decision" && draft.Kind != "question" {
		return draft, invalid("kind must be note, decision or question")
	}
	draft.Title = strings.TrimSpace(draft.Title)
	if draft.Title == "" || len(draft.Title) > 512 || !utf8.ValidString(draft.Title) {
		return draft, invalid("title must contain valid UTF-8 and at most 512 bytes")
	}
	if len(draft.Body) > 65536 || !utf8.ValidString(draft.Body) || strings.TrimSpace(draft.Body) == "" {
		return draft, invalid("body must contain valid UTF-8 and at most 65536 bytes")
	}
	if draft.Format == "" {
		draft.Format = "markdown"
	}
	if draft.Format != "markdown" && draft.Format != "plain" {
		return draft, invalid("format must be markdown or plain")
	}
	if len(draft.Tags) > 32 {
		return draft, invalid("at most 32 tags are allowed")
	}
	seen := map[string]bool{}
	tags := []string{}
	for _, tag := range draft.Tags {
		tag = strings.ToLower(strings.TrimSpace(tag))
		if tag == "" || len(tag) > 64 || !utf8.ValidString(tag) || strings.ContainsAny(tag, "\x00\r\n") {
			return draft, invalid("tags must be nonempty valid UTF-8 of at most 64 bytes")
		}
		if !seen[tag] {
			tags = append(tags, tag)
			seen[tag] = true
		}
	}
	sort.Strings(tags)
	draft.Tags = tags
	if draft.RunID != "" && !opaque(draft.RunID) || draft.TaskID != "" && !opaque(draft.TaskID) {
		return draft, invalid("invalid run or task identity")
	}
	if draft.TaskID != "" && draft.RunID == "" {
		return draft, invalid("task association requires its run identity")
	}
	if len(draft.Sources) > 32 {
		return draft, invalid("at most 32 provenance sources are allowed")
	}
	if draft.Sources == nil {
		draft.Sources = []knowledge.Source{}
	}
	for _, source := range draft.Sources {
		if len(source.Label) > 512 || !utf8.ValidString(source.Label) {
			return draft, invalid("invalid source label")
		}
		switch source.Kind {
		case "snapshot":
			if !opaque(source.SnapshotID) || source.Path == "" || len(source.Path) > 4096 || !utf8.ValidString(source.Path) || strings.ContainsAny(source.Path, "\\\x00") || strings.HasPrefix(source.Path, "/") || path.Clean(source.Path) != source.Path || source.Path == "." || strings.HasPrefix(source.Path, "../") || source.EntryID != "" || source.URL != "" || source.Revision != 0 {
				return draft, invalid("snapshot sources require an owned snapshot and clean relative path")
			}
		case "knowledge":
			if !opaque(source.EntryID) || source.Revision <= 0 || source.SnapshotID != "" || source.Path != "" || source.URL != "" {
				return draft, invalid("knowledge sources require an exact entry revision")
			}
		case "url":
			u, err := url.Parse(source.URL)
			if err != nil || u.Scheme != "https" || u.Hostname() == "" || u.User != nil || len(source.URL) > 4096 || !utf8.ValidString(source.URL) || source.EntryID != "" || source.SnapshotID != "" || source.Path != "" || source.Revision != 0 {
				return draft, invalid("URL provenance requires a HTTPS URL without credentials")
			}
		default:
			return draft, invalid("unsupported provenance kind")
		}
	}
	terms, _ := knowledge.Frequencies(draft.Title + " " + strings.Join(draft.Tags, " ") + " " + draft.Body)
	if len(terms) > 8192 {
		return draft, invalid("entry exceeds 8192 distinct indexed terms")
	}
	return draft, nil
}
func (s *Store) validateLinks(ctx context.Context, q reader, scope mission.Scope, draft knowledge.Draft) error {
	if draft.RunID != "" {
		var n int
		err := q.QueryRowContext(ctx, s.rebind(`SELECT COUNT(*) FROM execution_runs WHERE tenant_id=? AND project_id=? AND id=?`), scope.TenantID, scope.ProjectID, draft.RunID).Scan(&n)
		if err != nil {
			return err
		}
		if n != 1 {
			return ErrNotFound
		}
	}
	if draft.TaskID != "" {
		var n int
		err := q.QueryRowContext(ctx, s.rebind(`SELECT COUNT(*) FROM execution_tasks WHERE tenant_id=? AND project_id=? AND run_id=? AND id=?`), scope.TenantID, scope.ProjectID, draft.RunID, draft.TaskID).Scan(&n)
		if err != nil {
			return err
		}
		if n != 1 {
			return ErrNotFound
		}
	}
	for _, source := range draft.Sources {
		switch source.Kind {
		case "knowledge":
			entry, err := s.entry(ctx, q, scope, source.EntryID, source.Revision)
			if err != nil {
				return err
			}
			if entry.Status == "deleted" {
				return invalid("cannot cite a deleted revision")
			}
		case "snapshot":
			if err := s.snapshotOwned(ctx, q, scope, source.SnapshotID); err != nil {
				return err
			}
		}
	}
	return nil
}
func (s *Store) snapshotOwned(ctx context.Context, q reader, scope mission.Scope, id string) error {
	// LIKE only narrows candidates. Exact JSON fields are compared afterwards;
	// textual occurrences in model messages never grant snapshot ownership.
	pattern := "%" + strings.ReplaceAll(strings.ReplaceAll(id, "!", "!!"), "_", "!_") + "%"
	rows, err := q.QueryContext(ctx, s.rebind(`SELECT run_json FROM execution_runs WHERE tenant_id=? AND project_id=? AND run_json LIKE ? ESCAPE '!'`), scope.TenantID, scope.ProjectID, pattern)
	if err != nil {
		return err
	}
	owned := false
	for rows.Next() {
		var raw string
		if err = rows.Scan(&raw); err != nil {
			rows.Close()
			return err
		}
		var run mission.Run
		if err = json.Unmarshal([]byte(raw), &run); err != nil {
			rows.Close()
			return err
		}
		if run.BaseSnapshot == id {
			owned = true
			break
		}
	}
	err = rows.Err()
	rows.Close()
	if err != nil {
		return err
	}
	if owned {
		return nil
	}
	rows, err = q.QueryContext(ctx, s.rebind(`SELECT task_json FROM execution_tasks WHERE tenant_id=? AND project_id=? AND task_json LIKE ? ESCAPE '!'`), scope.TenantID, scope.ProjectID, pattern)
	if err != nil {
		return err
	}
	for rows.Next() {
		var raw string
		if err = rows.Scan(&raw); err != nil {
			rows.Close()
			return err
		}
		var task mission.Task
		if err = json.Unmarshal([]byte(raw), &task); err != nil {
			rows.Close()
			return err
		}
		if task.BaseSnapshot == id || task.ForkSnapshotID == id || task.SnapshotID == id {
			owned = true
			break
		}
	}
	err = rows.Err()
	rows.Close()
	if err != nil {
		return err
	}
	if owned {
		return nil
	}
	// A final merge result is an explicitly scoped immutable snapshot too.
	rows, err = q.QueryContext(ctx, s.rebind(`SELECT preview_json FROM execution_merge_previews WHERE tenant_id=? AND project_id=? AND preview_json LIKE ? ESCAPE '!'`), scope.TenantID, scope.ProjectID, pattern)
	if err != nil {
		return err
	}
	for rows.Next() {
		var raw string
		if err = rows.Scan(&raw); err != nil {
			rows.Close()
			return err
		}
		var preview struct {
			Plan struct {
				Result struct {
					ID string `json:"id"`
				} `json:"result"`
			} `json:"plan"`
		}
		if err = json.Unmarshal([]byte(raw), &preview); err != nil {
			rows.Close()
			return err
		}
		if preview.Plan.Result.ID == id {
			owned = true
			break
		}
	}
	err = rows.Err()
	rows.Close()
	if err != nil {
		return err
	}
	if !owned {
		return ErrNotFound
	}
	return nil
}
