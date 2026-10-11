// SPDX-License-Identifier: AGPL-3.0-or-later
package runtime

import (
	"context"
	"database/sql"
	"encoding/json"
	"errors"
	"net/http"
	"strings"
	"time"

	"github.com/Moonrend/Zakura/apps/server/internal/platform/httpx"
	"github.com/Moonrend/Zakura/apps/server/internal/projectexec"
	"github.com/Moonrend/Zakura/packages/projectkit/mission"
	"github.com/go-chi/chi/v5"
)

type projectSourceAttestation struct {
	ID          string          `json:"id"`
	AuthorID    string          `json:"authorId"`
	ActivityIDs []string        `json:"activityIds"`
	Comment     string          `json:"comment"`
	Status      string          `json:"status"`
	Result      json.RawMessage `json:"result"`
	Error       string          `json:"error,omitempty"`
	CreatedAt   string          `json:"createdAt"`
	UpdatedAt   string          `json:"updatedAt"`
}

func (h *handler) projectSourceActivities(w http.ResponseWriter, r *http.Request) {
	h.projectReadRPC(w, r, "project.source.activities", nil)
}

func projectSourceOperator(w http.ResponseWriter, r *http.Request) bool {
	if !projectHumanReviewer(w, r) {
		return false
	}
	p := principal(r)
	if p.Role != "owner" && p.Role != "admin" {
		httpx.Error(w, 403, "Source writer attestations require a tenant owner or administrator")
		return false
	}
	return true
}

func (h *handler) projectSourceConfirm(w http.ResponseWriter, r *http.Request) {
	if !projectSourceOperator(w, r) {
		return
	}
	p, err := h.requestProject(r)
	if err != nil {
		projectHTTPError(w, err)
		return
	}
	var body struct {
		ActivityIDs  []string `json:"activityIds"`
		Confirmation string   `json:"confirmation"`
		Comment      string   `json:"comment"`
	}
	if httpx.DecodeJSON(r, &body) != nil || body.Confirmation != "writers_stopped" || strings.TrimSpace(body.Comment) == "" || len(body.Comment) > 4096 || len(body.ActivityIDs) == 0 || len(body.ActivityIDs) > 1000 {
		httpx.Error(w, 400, "Exact activity IDs, writer-stopped confirmation and explanatory comment required")
		return
	}
	seen := map[string]bool{}
	for _, id := range body.ActivityIDs {
		if id == "" || len(id) > 128 || seen[id] {
			httpx.Error(w, 400, "Invalid or duplicate source activity identity")
			return
		}
		seen[id] = true
	}
	id := h.store.id()
	now := runtimeTimeString(h.store.now())
	ids, err := json.Marshal(body.ActivityIDs)
	if err != nil {
		projectHTTPError(w, err)
		return
	}
	err = h.recordSourceAttestation(r.Context(), p, id, principal(r).UserID, string(ids), body.Comment, now)
	if err != nil {
		projectHTTPError(w, err)
		return
	}
	ctx, cancel := context.WithTimeout(r.Context(), 60*time.Second)
	defer cancel()
	var result json.RawMessage
	confirmErr := h.projectBridge.rpc(ctx, projectScope(p), "project.source.confirm", map[string]any{"operationId": id, "activityIds": body.ActivityIDs, "reviewId": id, "approved": true, "comment": body.Comment}, &result)
	status, errorText := "confirmed", ""
	if confirmErr != nil {
		status = "unknown"
		errorText = confirmErr.Error()
		result = json.RawMessage(`null`)
	}
	finish, finishCancel := context.WithTimeout(context.WithoutCancel(r.Context()), 10*time.Second)
	defer finishCancel()
	updated, err := h.deps.DB.ExecContext(finish, h.deps.Rebind(`UPDATE execution_source_attestations SET status=?,result_json=?,error=?,updated_at=? WHERE tenant_id=? AND project_id=? AND id=?`), status, string(result), errorText, runtimeTimeString(h.store.now()), p.TenantID, p.ID, id)
	if err == nil {
		var n int64
		n, err = updated.RowsAffected()
		if err == nil && n != 1 {
			err = projectexec.ErrNotFound
		}
	}
	if err != nil {
		projectHTTPError(w, err)
		return
	}
	code := 200
	if confirmErr != nil {
		code = 202
	}
	httpx.JSON(w, code, projectSourceAttestation{ID: id, AuthorID: principal(r).UserID, ActivityIDs: body.ActivityIDs, Comment: body.Comment, Status: status, Result: result, Error: errorText, CreatedAt: now, UpdatedAt: runtimeTimeString(h.store.now())})
}

func (h *handler) recordSourceAttestation(ctx context.Context, p mission.Project, id, author, ids, comment, now string) error {
	tx, err := h.deps.DB.BeginTx(ctx, nil)
	if err != nil {
		return err
	}
	defer tx.Rollback()
	if err := h.lockProjectMutation(ctx, tx, p); err != nil {
		return err
	}
	if err := h.projects.RequireTenantActive(ctx, tx, p.TenantID); err != nil {
		if !errors.Is(err, projectexec.ErrTenantDraining) {
			return err
		}
		// Tenant shutdown blocks new work, but its outstanding administrative
		// confirmation must remain recoverable if the original RPC never arrived.
		var unresolved int
		if queryErr := tx.QueryRowContext(ctx, h.deps.Rebind(`SELECT COUNT(*) FROM execution_source_attestations WHERE tenant_id=? AND project_id=? AND status IN ('pending','unknown')`), p.TenantID, p.ID).Scan(&unresolved); queryErr != nil {
			return queryErr
		}
		if unresolved == 0 {
			return err
		}
	}
	_, err = tx.ExecContext(ctx, h.deps.Rebind(`INSERT INTO execution_source_attestations(id,tenant_id,project_id,author_id,activity_ids_json,comment,status,created_at,updated_at) VALUES(?,?,?,?,?,?,'pending',?,?)`), id, p.TenantID, p.ID, author, ids, comment, now, now)
	if err != nil {
		return err
	}
	return tx.Commit()
}

func (h *handler) projectSourceAttestations(w http.ResponseWriter, r *http.Request) {
	if !projectSourceOperator(w, r) {
		return
	}
	p, err := h.requestProject(r)
	if err != nil {
		projectHTTPError(w, err)
		return
	}
	rows, err := h.deps.DB.QueryContext(r.Context(), h.deps.Rebind(`SELECT id,author_id,activity_ids_json,comment,status,result_json,error,created_at,updated_at FROM execution_source_attestations WHERE tenant_id=? AND project_id=? ORDER BY created_at DESC LIMIT 100`), p.TenantID, p.ID)
	if err != nil {
		projectHTTPError(w, err)
		return
	}
	defer rows.Close()
	items := []projectSourceAttestation{}
	for rows.Next() {
		var item projectSourceAttestation
		var ids, result string
		if err := rows.Scan(&item.ID, &item.AuthorID, &ids, &item.Comment, &item.Status, &result, &item.Error, &item.CreatedAt, &item.UpdatedAt); err != nil {
			projectHTTPError(w, err)
			return
		}
		if err := json.Unmarshal([]byte(ids), &item.ActivityIDs); err != nil {
			projectHTTPError(w, err)
			return
		}
		item.Result = json.RawMessage(result)
		items = append(items, item)
	}
	if err := rows.Err(); err != nil {
		projectHTTPError(w, err)
		return
	}
	httpx.JSON(w, 200, map[string]any{"items": items})
}

func (h *handler) projectSourceInspect(w http.ResponseWriter, r *http.Request) {
	if !projectSourceOperator(w, r) {
		return
	}
	p, err := h.requestProject(r)
	if err != nil {
		projectHTTPError(w, err)
		return
	}
	id := chi.URLParam(r, "aid")
	var status, activityJSON string
	err = h.deps.DB.QueryRowContext(r.Context(), h.deps.Rebind(`SELECT status,activity_ids_json FROM execution_source_attestations WHERE tenant_id=? AND project_id=? AND id=?`), p.TenantID, p.ID, id).Scan(&status, &activityJSON)
	if errors.Is(err, sql.ErrNoRows) {
		err = projectexec.ErrNotFound
	}
	if err != nil {
		projectHTTPError(w, err)
		return
	}
	if status != "pending" && status != "unknown" {
		httpx.JSON(w, 200, map[string]any{"id": id, "status": status})
		return
	}
	var inspected struct {
		Known  bool            `json:"known"`
		Status string          `json:"status"`
		Result json.RawMessage `json:"result"`
		Error  string          `json:"error"`
	}
	if err := h.projectBridge.rpc(r.Context(), projectScope(p), "project.operation.inspect", map[string]any{"operationId": id}, &inspected); err != nil {
		projectHTTPError(w, err)
		return
	}
	status = "unknown"
	if inspected.Known && inspected.Status == "completed" {
		status = "confirmed"
	} else if inspected.Known && inspected.Status == "failed" {
		status = "failed"
	}
	result := inspected.Result
	if len(result) == 0 {
		result = json.RawMessage(`null`)
	}
	if status == "unknown" && (!inspected.Known || inspected.Status == "unknown") {
		var activityIDs []string
		if err := json.Unmarshal([]byte(activityJSON), &activityIDs); err != nil {
			projectHTTPError(w, err)
			return
		}
		proofs, err := h.sourceAttestationProofs(r.Context(), p, id, activityIDs)
		if err != nil {
			projectHTTPError(w, err)
			return
		}
		if len(proofs) > 0 {
			status = "superseded"
			result, _ = json.Marshal(map[string]any{"proofAttestationIds": proofs, "originalInspection": inspected})
		}
	}
	updated, err := h.deps.DB.ExecContext(r.Context(), h.deps.Rebind(`UPDATE execution_source_attestations SET status=?,result_json=?,error=CASE WHEN ?='superseded' THEN error ELSE ? END,updated_at=? WHERE tenant_id=? AND project_id=? AND id=? AND status IN ('pending','unknown')`), status, string(result), status, inspected.Error, runtimeTimeString(h.store.now()), p.TenantID, p.ID, id)
	if err == nil {
		var n int64
		n, err = updated.RowsAffected()
		if err == nil && n != 1 {
			err = projectexec.ErrConflict
		}
	}
	if err != nil {
		projectHTTPError(w, err)
		return
	}
	httpx.JSON(w, 200, map[string]any{"id": id, "status": status, "inspection": inspected})
}

// Activity identities are never reused. Complete coverage by successful human
// confirmation receipts proves those registrations were settled, even if an
// earlier request never reached the runner. This resolves its administrative
// uncertainty without claiming that the earlier RPC succeeded or replaying it.
func (h *handler) sourceAttestationProofs(ctx context.Context, p mission.Project, originalID string, activityIDs []string) ([]string, error) {
	remaining := map[string]bool{}
	for _, id := range activityIDs {
		remaining[id] = true
	}
	if len(remaining) == 0 {
		return nil, nil
	}
	rows, err := h.deps.DB.QueryContext(ctx, h.deps.Rebind(`SELECT id,activity_ids_json FROM execution_source_attestations WHERE tenant_id=? AND project_id=? AND status='confirmed' AND id<>? ORDER BY created_at DESC,id`), p.TenantID, p.ID, originalID)
	if err != nil {
		return nil, err
	}
	defer rows.Close()
	proofs := []string{}
	for rows.Next() {
		var id, raw string
		if err := rows.Scan(&id, &raw); err != nil {
			return nil, err
		}
		var covered []string
		if err := json.Unmarshal([]byte(raw), &covered); err != nil {
			return nil, err
		}
		contributed := false
		for _, activityID := range covered {
			if remaining[activityID] {
				delete(remaining, activityID)
				contributed = true
			}
		}
		if contributed {
			proofs = append(proofs, id)
		}
		if len(remaining) == 0 {
			return proofs, nil
		}
	}
	return nil, rows.Err()
}
