// SPDX-License-Identifier: AGPL-3.0-or-later
package runtime

import (
	"context"
	"crypto/sha256"
	"database/sql"
	"encoding/hex"
	"encoding/json"
	"errors"
	"net/http"
	"sort"
	"time"

	"github.com/Moonrend/Zakura/apps/server/internal/platform/httpx"
	"github.com/Moonrend/Zakura/apps/server/internal/projectexec"
	"github.com/Moonrend/Zakura/apps/server/internal/projectsignoff"
	"github.com/Moonrend/Zakura/packages/projectkit/mission"
	"github.com/Moonrend/Zakura/packages/projectkit/signoff"
	"github.com/Moonrend/Zakura/packages/projectkit/workspace"
	"github.com/go-chi/chi/v5"
)

func (h *handler) initializeProjectSignoffs() {
	h.projectSignoffs = projectsignoff.NewStore(h.deps.DB, h.deps.Dialect, h.deps.Rebind, h.deps.Clock)
}
func (h *handler) registerProjectSignoffs(r chi.Router) {
	r.Get("/review-policy", h.projectSignoffPolicyGet)
	r.Put("/review-policy", h.projectSignoffPolicyUpdate)
	r.Get("/review-policy/history", h.projectSignoffPolicyHistory)
	r.Get("/merges/{mid}/signoffs", h.projectSignoffGet)
	r.Post("/merges/{mid}/signoffs", h.projectSignoffVote)
	r.Post("/merges/{mid}/signoffs/{vid}/withdraw", h.projectSignoffWithdraw)
}
func projectSignoffBinding(preview *projectMergePreview) (signoff.Binding, error) {
	// Approval revisions change when people vote. Bind only the immutable
	// artifact, frozen execution and checks; never include mutable vote fields.
	raw, err := json.Marshal(struct {
		RunRevision   int64                  `json:"runRevision"`
		PlanID        string                 `json:"planId"`
		ExpectedBase  string                 `json:"expectedBase"`
		Plan          workspace.MergePlan    `json:"plan"`
		TaskSnapshots map[string]string      `json:"taskSnapshots"`
		Verifications []mission.Verification `json:"verifications"`
	}{preview.RunRevision, preview.PlanID, preview.ExpectedBase, preview.Plan, preview.TaskSnapshots, preview.Verifications})
	if err != nil {
		return signoff.Binding{}, err
	}
	digest := sha256.Sum256(raw)
	return signoff.Binding{PreviewID: preview.ID, RunID: preview.RunID, SnapshotID: preview.Plan.Result.ID, EvidenceHash: hex.EncodeToString(digest[:])}, nil
}
func setProjectSignoffResult(h *handler, preview *projectMergePreview, summary signoff.Summary, reviewer, comment string) error {
	preview.ReviewID = ""
	preview.ReviewedBy = ""
	preview.ReviewComment = ""
	preview.ReviewEvidence = nil
	if summary.Rejected {
		preview.Status = "rejected"
		preview.ReviewID = h.store.id()
		preview.ReviewedBy = reviewer
		preview.ReviewComment = comment
		return nil
	}
	preview.Status = "ready"
	if !summary.Quorum {
		return nil
	}
	raw, err := json.Marshal(summary.Evidence)
	if err != nil {
		return err
	}
	preview.Status = "approved"
	preview.ReviewID = h.store.id()
	preview.ReviewedBy = reviewer
	preview.ReviewComment = comment
	preview.ReviewEvidence = raw
	return nil
}
func (h *handler) recordProjectMergeSignoffTx(ctx context.Context, tx *sql.Tx, p mission.Project, preview *projectMergePreview, reviewerID, role, decision, comment string) error {
	if h.projectSignoffs == nil {
		return projectsignoff.ErrInvalid
	}
	if preview.Status != "ready" && preview.Status != "approved" {
		return projectexec.ErrConflict
	}
	if len(preview.Plan.Conflicts) > 0 || preview.Plan.Result.ID == "" {
		return projectexec.ErrConflict
	}
	if err := h.projects.RequireTenantActive(ctx, tx, p.TenantID); err != nil {
		return err
	}
	if decision == "approved" {
		if err := h.validateMergeFrozenState(ctx, tx, p, preview); err != nil {
			return err
		}
		if err := h.requireProjectRequirementsArtifactTx(ctx, tx, projectScope(p), preview.RunID, preview.TaskSnapshots, preview.Verifications, preview.Plan.Result.ID); err != nil {
			return err
		}
	}
	b, err := projectSignoffBinding(preview)
	if err != nil {
		return err
	}
	summary, err := h.projectSignoffs.RecordTx(ctx, tx, p, b, preview.Revision, reviewerID, role, decision, comment)
	if err != nil {
		return err
	}
	return setProjectSignoffResult(h, preview, summary, reviewerID, comment)
}

// Publication must keep membership decisions valid until its intent commits.
// PostgreSQL shared row locks block role/removal/suspension updates, without
// taking the tenant parent lock after the project lock. SQLite project writes
// already exclude competing database writes for the transaction's lifetime.
func (h *handler) lockProjectSignoffMembersTx(ctx context.Context, tx *sql.Tx, p mission.Project, ids []string) error {
	if h.deps.Dialect != "postgres" && h.deps.Dialect != "postgresql" {
		return nil
	}
	sort.Strings(ids)
	seen := map[string]bool{}
	for _, id := range ids {
		if id == "" || seen[id] {
			continue
		}
		seen[id] = true
		var found string
		if err := tx.QueryRowContext(ctx, h.deps.Rebind(`SELECT id FROM users WHERE id=? FOR SHARE`), id).Scan(&found); err != nil {
			return err
		}
		if err := tx.QueryRowContext(ctx, h.deps.Rebind(`SELECT user_id FROM tenant_memberships WHERE tenant_id=? AND user_id=? FOR SHARE`), p.TenantID, id).Scan(&found); err != nil {
			return err
		}
	}
	return nil
}
func (h *handler) requireProjectSignoffTx(ctx context.Context, tx *sql.Tx, p mission.Project, preview *projectMergePreview) error {
	if h.projectSignoffs == nil {
		return projectsignoff.ErrInvalid
	}
	b, err := projectSignoffBinding(preview)
	if err != nil {
		return err
	}
	summary, err := h.projectSignoffs.SummaryTx(ctx, tx, p, b)
	if err != nil {
		return err
	}
	if !summary.Policy.Configured && len(summary.Votes) == 0 && preview.ReviewID != "" && preview.ReviewedBy != "" {
		if err = h.lockProjectSignoffMembersTx(ctx, tx, p, []string{preview.ReviewedBy}); err != nil {
			return err
		}
		m, e := h.projectSignoffs.Member(ctx, tx, p.TenantID, preview.ReviewedBy)
		if e != nil || !signoff.Eligible(summary.Policy, m, p.CreatedBy) {
			return projectsignoff.ErrInvalid
		}
		return nil
	}
	if !summary.Quorum {
		return projectsignoff.ErrInvalid
	}
	ids := []string{}
	for _, participant := range summary.Evidence.Participants {
		ids = append(ids, participant.UserID)
	}
	if err = h.lockProjectSignoffMembersTx(ctx, tx, p, ids); err != nil {
		return err
	}
	summary, err = h.projectSignoffs.SummaryTx(ctx, tx, p, b)
	if err != nil {
		return err
	}
	if !summary.Quorum {
		return projectsignoff.ErrInvalid
	}
	if preview.ReviewID == "" {
		return projectsignoff.ErrInvalid
	}
	preview.ReviewEvidence, err = json.Marshal(summary.Evidence)
	return err
}
func (h *handler) projectSignoffPolicyGet(w http.ResponseWriter, r *http.Request) {
	p, err := h.requestProject(r)
	if err != nil {
		projectHTTPError(w, err)
		return
	}
	policy, err := h.projectSignoffs.GetPolicy(r.Context(), p)
	if err != nil {
		projectHTTPError(w, err)
		return
	}
	members, truncated, err := h.projectSignoffs.Members(r.Context(), p)
	if err != nil {
		projectHTTPError(w, err)
		return
	}
	pr := principal(r)
	httpx.JSON(w, 200, map[string]any{"policy": policy, "members": members, "membersTruncated": truncated, "currentUserId": pr.UserID, "currentRole": pr.Role, "humanSession": pr.UserID != "" && pr.SessionID != "" && !pr.APIKey && !pr.OAuth, "canConfigure": pr.SessionID != "" && !pr.APIKey && !pr.OAuth && (pr.Role == "owner" || pr.Role == "admin")})
}
func (h *handler) projectSignoffPolicyHistory(w http.ResponseWriter, r *http.Request) {
	p, err := h.requestProject(r)
	if err != nil {
		projectHTTPError(w, err)
		return
	}
	history, err := h.projectSignoffs.History(r.Context(), p)
	if err != nil {
		projectHTTPError(w, err)
		return
	}
	httpx.JSON(w, 200, history)
}
func (h *handler) projectSignoffPolicyUpdate(w http.ResponseWriter, r *http.Request) {
	if !projectHumanReviewer(w, r) {
		return
	}
	pr := principal(r)
	if pr.Role != "owner" && pr.Role != "admin" {
		httpx.Error(w, 403, "Only an owner/admin may configure merge signoff policy")
		return
	}
	p, err := h.requestProject(r)
	if err != nil {
		projectHTTPError(w, err)
		return
	}
	var body struct {
		signoff.Rules
		ExpectedRevision int64 `json:"expectedRevision"`
	}
	if httpx.DecodeJSON(r, &body) != nil || body.ExpectedRevision < 0 {
		httpx.Error(w, 400, "Complete review policy and expected revision required")
		return
	}
	tx, err := h.deps.DB.BeginTx(r.Context(), nil)
	if err != nil {
		projectHTTPError(w, err)
		return
	}
	defer tx.Rollback()
	if err = h.lockProjectMutation(r.Context(), tx, p); err == nil {
		err = h.projects.RequireTenantActive(r.Context(), tx, p.TenantID)
	}
	if err != nil {
		projectHTTPError(w, err)
		return
	}
	policy, err := h.projectSignoffs.SetPolicyTx(r.Context(), tx, p, body.ExpectedRevision, body.Rules, pr.UserID)
	if err != nil {
		projectHTTPError(w, err)
		return
	}
	rows, err := tx.QueryContext(r.Context(), h.deps.Rebind(`SELECT preview_json FROM execution_merge_previews WHERE tenant_id=? AND project_id=? AND status IN ('ready','approved') ORDER BY id LIMIT 5001`), p.TenantID, p.ID)
	if err != nil {
		projectHTTPError(w, err)
		return
	}
	previews := []projectMergePreview{}
	for rows.Next() {
		var raw string
		var preview projectMergePreview
		if err = rows.Scan(&raw); err == nil {
			err = json.Unmarshal([]byte(raw), &preview)
		}
		if err != nil {
			rows.Close()
			projectHTTPError(w, err)
			return
		}
		previews = append(previews, preview)
	}
	err = rows.Err()
	rows.Close()
	if err != nil {
		projectHTTPError(w, err)
		return
	}
	if len(previews) > 5000 {
		projectHTTPError(w, projectsignoff.ErrInvalid)
		return
	}
	for _, preview := range previews {
		oldRevision := preview.Revision
		preview.Revision++
		preview.Status = "ready"
		preview.ReviewID = ""
		preview.ReviewedBy = ""
		preview.ReviewComment = ""
		preview.ReviewEvidence = nil
		preview.UpdatedAt = h.store.now()
		raw, e := json.Marshal(preview)
		if e != nil {
			projectHTTPError(w, e)
			return
		}
		_, err = tx.ExecContext(r.Context(), h.deps.Rebind(`UPDATE execution_merge_previews SET revision=?,status='ready',preview_json=?,updated_at=? WHERE tenant_id=? AND project_id=? AND id=? AND revision=?`), preview.Revision, string(raw), runtimeTimeString(preview.UpdatedAt), p.TenantID, p.ID, preview.ID, oldRevision)
		if err != nil {
			projectHTTPError(w, err)
			return
		}
		_, err = tx.ExecContext(r.Context(), h.deps.Rebind(`INSERT INTO execution_merge_audit(id,tenant_id,project_id,run_id,preview_id,author_id,action,snapshot_id,comment,created_at) VALUES(?,?,?,?,?,?,?,?,?,?)`), h.store.id(), p.TenantID, p.ID, preview.RunID, preview.ID, pr.UserID, "signoff.policy_changed", preview.Plan.Result.ID, "Approval reset for current policy", runtimeTimeString(preview.UpdatedAt))
		if err != nil {
			projectHTTPError(w, err)
			return
		}
	}
	if err = tx.Commit(); err != nil {
		projectHTTPError(w, err)
		return
	}
	httpx.JSON(w, 200, map[string]any{"policy": policy, "resetPreviews": len(previews)})
}
func (h *handler) projectSignoffGet(w http.ResponseWriter, r *http.Request) {
	p, err := h.requestProject(r)
	if err != nil {
		projectHTTPError(w, err)
		return
	}
	ctx, cancel := context.WithTimeout(r.Context(), 15*time.Second)
	defer cancel()
	tx, err := h.deps.DB.BeginTx(ctx, &sql.TxOptions{ReadOnly: true, Isolation: sql.LevelRepeatableRead})
	if err != nil {
		projectHTTPError(w, err)
		return
	}
	defer tx.Rollback()
	var raw string
	err = tx.QueryRowContext(ctx, h.deps.Rebind(`SELECT preview_json FROM execution_merge_previews WHERE tenant_id=? AND project_id=? AND run_id=? AND id=?`), p.TenantID, p.ID, r.URL.Query().Get("runId"), chi.URLParam(r, "mid")).Scan(&raw)
	if errors.Is(err, sql.ErrNoRows) {
		err = projectexec.ErrNotFound
	}
	if err != nil {
		projectHTTPError(w, err)
		return
	}
	var preview projectMergePreview
	if err = json.Unmarshal([]byte(raw), &preview); err != nil {
		projectHTTPError(w, err)
		return
	}
	b, err := projectSignoffBinding(&preview)
	if err != nil {
		projectHTTPError(w, err)
		return
	}
	summary, err := h.projectSignoffs.SummaryTx(ctx, tx, p, b)
	if err != nil {
		projectHTTPError(w, err)
		return
	}
	// Pre-policy single-review receipts have no vote records. Preserve their
	// compatibility without inventing a signing timestamp or aggregate proof.
	if !summary.Policy.Configured && len(summary.Votes) == 0 && preview.ReviewID != "" && preview.ReviewedBy != "" && (preview.Status == "approved" || preview.Status == "applying" || preview.Status == "applied" || preview.Status == "unknown") {
		summary.LegacyApproval = true
		member, e := h.projectSignoffs.Member(ctx, tx, p.TenantID, preview.ReviewedBy)
		if e != nil && !errors.Is(e, projectsignoff.ErrNotFound) {
			projectHTTPError(w, e)
			return
		}
		if e == nil && signoff.Eligible(summary.Policy, member, p.CreatedBy) && summary.CanReachQuorum {
			summary.Approvals = 1
			summary.Quorum = true
		}
	}
	httpx.JSON(w, 200, map[string]any{"preview": preview, "summary": summary})
}
func (h *handler) projectSignoffVote(w http.ResponseWriter, r *http.Request) {
	if !projectHumanReviewer(w, r) {
		return
	}
	p, err := h.requestProject(r)
	if err != nil {
		projectHTTPError(w, err)
		return
	}
	var body struct {
		ExpectedRevision int64  `json:"expectedRevision"`
		PolicyHash       string `json:"policyHash"`
		SnapshotID       string `json:"snapshotId"`
		Decision         string `json:"decision"`
		Comment          string `json:"comment"`
	}
	if httpx.DecodeJSON(r, &body) != nil || body.ExpectedRevision < 1 || body.PolicyHash == "" {
		httpx.Error(w, 400, "Exact preview revision, snapshot, policy and review required")
		return
	}
	preview, err := h.mutateMerge(r.Context(), p, r.URL.Query().Get("runId"), chi.URLParam(r, "mid"), body.ExpectedRevision, principal(r).UserID, "signoff."+body.Decision, body.Comment, func(tx *sql.Tx, preview *projectMergePreview) error {
		if preview.Plan.Result.ID != body.SnapshotID {
			return projectexec.ErrConflict
		}
		policy, e := h.projectSignoffs.GetPolicyTx(r.Context(), tx, p)
		if e != nil {
			return e
		}
		if policy.Hash != body.PolicyHash {
			return projectexec.ErrConflict
		}
		if body.Decision == "approved" {
			if e = h.validateMergeFrozenState(r.Context(), tx, p, preview); e != nil {
				return e
			}
			if e = h.requireProjectRequirementsArtifactTx(r.Context(), tx, projectScope(p), preview.RunID, preview.TaskSnapshots, preview.Verifications, preview.Plan.Result.ID); e != nil {
				return e
			}
		}
		return h.recordProjectMergeSignoffTx(r.Context(), tx, p, preview, principal(r).UserID, principal(r).Role, body.Decision, body.Comment)
	})
	if err != nil {
		projectHTTPError(w, err)
		return
	}
	httpx.JSON(w, 200, preview)
}
func (h *handler) projectSignoffWithdraw(w http.ResponseWriter, r *http.Request) {
	if !projectHumanReviewer(w, r) {
		return
	}
	p, err := h.requestProject(r)
	if err != nil {
		projectHTTPError(w, err)
		return
	}
	var body struct {
		ExpectedRevision int64  `json:"expectedRevision"`
		SnapshotID       string `json:"snapshotId"`
		PolicyHash       string `json:"policyHash"`
	}
	if httpx.DecodeJSON(r, &body) != nil || body.ExpectedRevision < 1 || body.PolicyHash == "" {
		httpx.Error(w, 400, "Exact current preview and policy required")
		return
	}
	preview, err := h.mutateMerge(r.Context(), p, r.URL.Query().Get("runId"), chi.URLParam(r, "mid"), body.ExpectedRevision, principal(r).UserID, "signoff.withdrawn", "Reviewer withdrew their approval", func(tx *sql.Tx, preview *projectMergePreview) error {
		if preview.Status != "ready" && preview.Status != "approved" {
			return projectexec.ErrInvalidState
		}
		if preview.Plan.Result.ID != body.SnapshotID {
			return projectexec.ErrConflict
		}
		if e := h.projects.RequireTenantActive(r.Context(), tx, p.TenantID); e != nil {
			return e
		}
		policy, e := h.projectSignoffs.GetPolicyTx(r.Context(), tx, p)
		if e != nil {
			return e
		}
		if policy.Hash != body.PolicyHash {
			return projectexec.ErrConflict
		}
		b, e := projectSignoffBinding(preview)
		if e != nil {
			return e
		}
		summary, e := h.projectSignoffs.WithdrawTx(r.Context(), tx, p, b, chi.URLParam(r, "vid"), principal(r).UserID)
		if e != nil {
			return e
		}
		return setProjectSignoffResult(h, preview, summary, principal(r).UserID, "Reviewer withdrew their approval")
	})
	if err != nil {
		projectHTTPError(w, err)
		return
	}
	httpx.JSON(w, 200, preview)
}
