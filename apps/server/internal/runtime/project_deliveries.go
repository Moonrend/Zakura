// SPDX-License-Identifier: AGPL-3.0-or-later
package runtime

import (
	"context"
	"database/sql"
	"encoding/base64"
	"encoding/hex"
	"encoding/json"
	"errors"
	"fmt"
	"io"
	"net/http"
	"regexp"
	"strconv"
	"strings"
	"time"

	"github.com/Moonrend/Zakura/apps/server/internal/platform/httpx"
	"github.com/Moonrend/Zakura/apps/server/internal/projectexec"
	"github.com/Moonrend/Zakura/packages/projectkit/delivery"
	"github.com/Moonrend/Zakura/packages/projectkit/mission"
	"github.com/go-chi/chi/v5"
)

type projectDelivery struct {
	ID              string                `json:"id"`
	ProjectID       string                `json:"projectId"`
	Kind            string                `json:"kind"`
	Name            string                `json:"name"`
	Version         string                `json:"version"`
	Revision        int64                 `json:"revision"`
	Status          string                `json:"status"`
	OperationID     string                `json:"operationId,omitempty"`
	Manifest        *delivery.Manifest    `json:"manifest,omitempty"`
	Archive         *delivery.ArchiveInfo `json:"archive,omitempty"`
	TotalBytes      int64                 `json:"totalBytes,omitempty"`
	Received        int64                 `json:"received,omitempty"`
	SHA256          string                `json:"sha256,omitempty"`
	SnapshotID      string                `json:"snapshotId,omitempty"`
	UntrustedReview bool                  `json:"untrustedReview"`
	CreatedBy       string                `json:"createdBy"`
	Comment         string                `json:"comment"`
	Error           string                `json:"error,omitempty"`
	CreatedAt       time.Time             `json:"createdAt"`
	UpdatedAt       time.Time             `json:"updatedAt"`
}
type projectDeliveryChannel struct {
	Channel    string `json:"channel"`
	DeliveryID string `json:"deliveryId"`
	Revision   int64  `json:"revision"`
	AuthorID   string `json:"authorId"`
	Comment    string `json:"comment"`
	UpdatedAt  string `json:"updatedAt"`
}
type deliveryUploadResult struct {
	ID              string             `json:"id"`
	TotalBytes      int64              `json:"totalBytes"`
	Received        int64              `json:"received"`
	SHA256          string             `json:"sha256"`
	Status          string             `json:"status"`
	SnapshotID      string             `json:"snapshotId"`
	Manifest        *delivery.Manifest `json:"manifest"`
	UntrustedReview bool               `json:"untrustedReview"`
}

func (h *handler) registerProjectDeliveries(r chi.Router) {
	r.Get("/deliveries", h.projectDeliveryList)
	r.Post("/deliveries", h.projectDeliveryCreate)
	r.Get("/deliveries/channels", h.projectDeliveryChannels)
	r.Put("/deliveries/channels/{channel}", h.projectDeliveryPromote)
	r.Get("/deliveries/{did}", h.projectDeliveryGet)
	r.Post("/deliveries/{did}/inspect", h.projectDeliveryInspect)
	r.Post("/deliveries/{did}/revoke", h.projectDeliveryRevoke)
	r.Get("/deliveries/{did}/archive", h.projectDeliveryDownload)
	r.Get("/deliveries/{did}/manifest", h.projectDeliveryManifest)
	r.Get("/imports", h.projectDeliveryImportList)
	r.Post("/imports", h.projectDeliveryImportCreate)
	r.Get("/imports/{iid}", h.projectDeliveryImportGet)
	r.Post("/imports/{iid}/inspect", h.projectDeliveryImportInspect)
	r.Put("/imports/{iid}/chunks", h.projectDeliveryImportChunk)
	r.Post("/imports/{iid}/finish", h.projectDeliveryImportFinish)
	r.Delete("/imports/{iid}", h.projectDeliveryImportAbort)
	r.Post("/imports/{iid}/runs", h.projectDeliveryImportRun)
}

func (h *handler) loadDelivery(ctx context.Context, tenant, pid, id, kind string) (projectDelivery, error) {
	var raw string
	err := h.deps.DB.QueryRowContext(ctx, h.deps.Rebind(`SELECT record_json FROM execution_deliveries WHERE tenant_id=? AND project_id=? AND id=? AND kind=?`), tenant, pid, id, kind).Scan(&raw)
	if errors.Is(err, sql.ErrNoRows) {
		err = projectexec.ErrNotFound
	}
	if err != nil {
		return projectDelivery{}, err
	}
	var out projectDelivery
	err = json.Unmarshal([]byte(raw), &out)
	return out, err
}
func (h *handler) deliveryAudit(ctx context.Context, tx *sql.Tx, p mission.Project, d projectDelivery, action, author, comment string, detail any) error {
	raw, err := json.Marshal(detail)
	if err != nil {
		return err
	}
	_, err = tx.ExecContext(ctx, h.deps.Rebind(`INSERT INTO execution_delivery_audit(id,tenant_id,project_id,delivery_id,action,author_id,comment,detail_json,created_at) VALUES(?,?,?,?,?,?,?,?,?)`), h.store.id(), p.TenantID, p.ID, d.ID, action, author, comment, string(raw), runtimeTimeString(h.store.now()))
	return err
}
func (h *handler) insertDelivery(ctx context.Context, p mission.Project, d projectDelivery) (projectDelivery, error) {
	tx, err := h.deps.DB.BeginTx(ctx, nil)
	if err != nil {
		return d, err
	}
	defer tx.Rollback()
	if err = h.lockProjectMutation(ctx, tx, p); err != nil {
		return d, err
	}
	if err = h.projects.RequireTenantActive(ctx, tx, p.TenantID); err != nil {
		return d, err
	}
	d.Revision = 1
	d.CreatedAt = h.store.now()
	d.UpdatedAt = d.CreatedAt
	raw, err := json.Marshal(d)
	if err != nil {
		return d, err
	}
	_, err = tx.ExecContext(ctx, h.deps.Rebind(`INSERT INTO execution_deliveries(id,tenant_id,project_id,kind,name,version,revision,status,record_json,created_at,updated_at) VALUES(?,?,?,?,?,?,?,?,?,?,?)`), d.ID, p.TenantID, p.ID, d.Kind, d.Name, d.Version, d.Revision, d.Status, string(raw), runtimeTimeString(d.CreatedAt), runtimeTimeString(d.UpdatedAt))
	if err != nil {
		return d, err
	}
	if err = h.deliveryAudit(ctx, tx, p, d, "created", d.CreatedBy, d.Comment, map[string]any{"kind": d.Kind, "snapshotId": d.SnapshotID}); err != nil {
		return d, err
	}
	return d, tx.Commit()
}
func (h *handler) mutateDelivery(ctx context.Context, p mission.Project, id, kind string, expected int64, active bool, action, author, comment string, fn func(*sql.Tx, *projectDelivery) error) (projectDelivery, error) {
	tx, err := h.deps.DB.BeginTx(ctx, nil)
	if err != nil {
		return projectDelivery{}, err
	}
	defer tx.Rollback()
	if err = h.lockProjectMutation(ctx, tx, p); err != nil {
		return projectDelivery{}, err
	}
	if active {
		if err = h.projects.RequireTenantActive(ctx, tx, p.TenantID); err != nil {
			return projectDelivery{}, err
		}
	}
	var raw string
	if err = tx.QueryRowContext(ctx, h.deps.Rebind(`SELECT record_json FROM execution_deliveries WHERE tenant_id=? AND project_id=? AND id=? AND kind=?`), p.TenantID, p.ID, id, kind).Scan(&raw); err != nil {
		if errors.Is(err, sql.ErrNoRows) {
			err = projectexec.ErrNotFound
		}
		return projectDelivery{}, err
	}
	var d projectDelivery
	if err = json.Unmarshal([]byte(raw), &d); err != nil {
		return d, err
	}
	if expected != d.Revision {
		return d, projectexec.ErrConflict
	}
	if err = fn(tx, &d); err != nil {
		return d, err
	}
	d.Revision++
	d.UpdatedAt = h.store.now()
	rawBytes, err := json.Marshal(d)
	if err != nil {
		return d, err
	}
	res, err := tx.ExecContext(ctx, h.deps.Rebind(`UPDATE execution_deliveries SET revision=?,status=?,record_json=?,updated_at=? WHERE tenant_id=? AND project_id=? AND id=? AND revision=?`), d.Revision, d.Status, string(rawBytes), runtimeTimeString(d.UpdatedAt), p.TenantID, p.ID, id, expected)
	if err != nil {
		return d, err
	}
	n, err := res.RowsAffected()
	if err != nil {
		return d, err
	}
	if n != 1 {
		return d, projectexec.ErrConflict
	}
	if action != "" {
		if err = h.deliveryAudit(ctx, tx, p, d, action, author, comment, map[string]any{"revision": d.Revision, "status": d.Status, "snapshotId": d.SnapshotID}); err != nil {
			return d, err
		}
	}
	return d, tx.Commit()
}
func (h *handler) requestDelivery(r *http.Request, kind string) (mission.Project, projectDelivery, error) {
	p, err := h.requestProject(r)
	if err != nil {
		return p, projectDelivery{}, err
	}
	key := "did"
	if kind == "import" {
		key = "iid"
	}
	d, err := h.loadDelivery(r.Context(), p.TenantID, p.ID, chi.URLParam(r, key), kind)
	return p, d, err
}
func deliveryHuman(w http.ResponseWriter, r *http.Request) bool {
	if !projectHumanReviewer(w, r) {
		return false
	}
	return true
}
func deliveryComment(comment string) error {
	if strings.TrimSpace(comment) == "" || len(comment) > 4096 {
		return errors.New("a review comment of at most 4096 bytes is required")
	}
	return nil
}
func (h *handler) listDeliveries(w http.ResponseWriter, r *http.Request, kind string) {
	p, err := h.requestProject(r)
	if err != nil {
		projectHTTPError(w, err)
		return
	}
	limit := projectQueryInt(r, "limit", 100, 200)
	rows, err := h.deps.DB.QueryContext(r.Context(), h.deps.Rebind(`SELECT record_json FROM execution_deliveries WHERE tenant_id=? AND project_id=? AND kind=? ORDER BY created_at DESC,id DESC LIMIT ?`), p.TenantID, p.ID, kind, limit+1)
	if err != nil {
		projectHTTPError(w, err)
		return
	}
	defer rows.Close()
	items := make([]projectDelivery, 0)
	for rows.Next() {
		var raw string
		var d projectDelivery
		if err = rows.Scan(&raw); err != nil {
			projectHTTPError(w, err)
			return
		}
		if err = json.Unmarshal([]byte(raw), &d); err != nil {
			projectHTTPError(w, err)
			return
		}
		items = append(items, d)
	}
	if err = rows.Err(); err != nil {
		projectHTTPError(w, err)
		return
	}
	truncated := len(items) > limit
	if truncated {
		items = items[:limit]
	}
	httpx.JSON(w, 200, map[string]any{"items": items, "truncated": truncated})
}
func (h *handler) projectDeliveryList(w http.ResponseWriter, r *http.Request) {
	h.listDeliveries(w, r, "delivery")
}
func (h *handler) projectDeliveryImportList(w http.ResponseWriter, r *http.Request) {
	h.listDeliveries(w, r, "import")
}
func (h *handler) projectDeliveryGet(w http.ResponseWriter, r *http.Request) {
	_, d, e := h.requestDelivery(r, "delivery")
	if e != nil {
		projectHTTPError(w, e)
		return
	}
	httpx.JSON(w, 200, d)
}
func (h *handler) projectDeliveryImportGet(w http.ResponseWriter, r *http.Request) {
	_, d, e := h.requestDelivery(r, "import")
	if e != nil {
		projectHTTPError(w, e)
		return
	}
	httpx.JSON(w, 200, d)
}
func (h *handler) projectDeliveryManifest(w http.ResponseWriter, r *http.Request) {
	_, d, e := h.requestDelivery(r, "delivery")
	if e != nil {
		projectHTTPError(w, e)
		return
	}
	if d.Manifest == nil {
		projectHTTPError(w, projectexec.ErrInvalidState)
		return
	}
	httpx.JSON(w, 200, map[string]any{"manifest": d.Manifest, "archive": d.Archive, "status": d.Status, "signed": false})
}

func (h *handler) projectDeliveryCreate(w http.ResponseWriter, r *http.Request) {
	if !deliveryHuman(w, r) {
		return
	}
	p, err := h.requestProject(r)
	if err != nil {
		projectHTTPError(w, err)
		return
	}
	var body struct {
		RunID                   string `json:"runId"`
		PreviewID               string `json:"previewId"`
		ExpectedPreviewRevision int64  `json:"expectedPreviewRevision"`
		Name                    string `json:"name"`
		Version                 string `json:"version"`
		Comment                 string `json:"comment"`
	}
	if httpx.DecodeJSON(r, &body) != nil {
		httpx.Error(w, 400, "Invalid delivery selection")
		return
	}
	if err = deliveryComment(body.Comment); err != nil {
		projectHTTPError(w, err)
		return
	}
	preview, err := h.loadMerge(r.Context(), p.TenantID, p.ID, body.RunID, body.PreviewID)
	if err != nil {
		projectHTTPError(w, err)
		return
	}
	if preview.Revision != body.ExpectedPreviewRevision {
		projectHTTPError(w, projectexec.ErrConflict)
		return
	}
	if (preview.Status != "approved" && preview.Status != "applied") || preview.ReviewID == "" || len(preview.Plan.Conflicts) > 0 {
		projectHTTPError(w, errors.New("only a reviewed conflict-free merge can become a delivery"))
		return
	}
	frozen, err := h.projects.GetRunProject(r.Context(), p.TenantID, p.ID, body.RunID)
	if err != nil {
		projectHTTPError(w, err)
		return
	}
	id := h.store.id()
	manifest := delivery.Manifest{Schema: delivery.Schema, Version: 1, ID: id, Name: body.Name, Release: body.Version, ProjectID: p.ID, RunID: body.RunID, SnapshotID: preview.Plan.Result.ID, Goal: frozen.Goal, Plan: frozen.Plan, Checks: preview.Verifications, Review: delivery.Review{ID: preview.ReviewID, Author: preview.ReviewedBy, Comment: preview.ReviewComment, PreviewID: preview.ID, PreviewRevision: preview.Revision, Evidence: preview.ReviewEvidence}, CreatedAt: h.store.now()}
	if err = delivery.Validate(manifest, false); err != nil {
		projectHTTPError(w, err)
		return
	}
	d := projectDelivery{ID: id, ProjectID: p.ID, Kind: "delivery", Name: body.Name, Version: body.Version, Status: "preparing", OperationID: "delivery_" + id, Manifest: &manifest, SnapshotID: manifest.SnapshotID, CreatedBy: principal(r).UserID, Comment: body.Comment}
	// Lock and re-read the preview before persisting the outbound intent.
	tx, err := h.deps.DB.BeginTx(r.Context(), nil)
	if err != nil {
		projectHTTPError(w, err)
		return
	}
	defer tx.Rollback()
	if err = h.lockProjectMutation(r.Context(), tx, p); err != nil {
		projectHTTPError(w, err)
		return
	}
	if err = h.projects.RequireTenantActive(r.Context(), tx, p.TenantID); err != nil {
		projectHTTPError(w, err)
		return
	}
	var rev int64
	var status string
	if err = tx.QueryRowContext(r.Context(), h.deps.Rebind(`SELECT revision,status FROM execution_merge_previews WHERE tenant_id=? AND project_id=? AND run_id=? AND id=?`), p.TenantID, p.ID, body.RunID, preview.ID).Scan(&rev, &status); err != nil {
		projectHTTPError(w, err)
		return
	}
	if rev != preview.Revision || status != preview.Status {
		projectHTTPError(w, projectexec.ErrConflict)
		return
	}
	if err = h.validateMergeFrozenState(r.Context(), tx, frozen, &preview); err != nil {
		projectHTTPError(w, err)
		return
	}
	if err = h.requireProjectRequirementsArtifactTx(r.Context(), tx, projectScope(p), preview.RunID, preview.TaskSnapshots, preview.Verifications, preview.Plan.Result.ID); err != nil {
		projectHTTPError(w, err)
		return
	}
	if err = h.requireProjectSignoffTx(r.Context(), tx, p, &preview); err != nil {
		projectHTTPError(w, err)
		return
	}
	manifest.Review.Evidence = preview.ReviewEvidence
	if err = delivery.Validate(manifest, false); err != nil {
		projectHTTPError(w, err)
		return
	}
	d.Revision = 1
	d.CreatedAt = h.store.now()
	d.UpdatedAt = d.CreatedAt
	raw, _ := json.Marshal(d)
	_, err = tx.ExecContext(r.Context(), h.deps.Rebind(`INSERT INTO execution_deliveries(id,tenant_id,project_id,kind,name,version,revision,status,record_json,created_at,updated_at) VALUES(?,?,?,?,?,?,?,?,?,?,?)`), d.ID, p.TenantID, p.ID, d.Kind, d.Name, d.Version, d.Revision, d.Status, string(raw), runtimeTimeString(d.CreatedAt), runtimeTimeString(d.UpdatedAt))
	if err == nil {
		err = h.deliveryAudit(r.Context(), tx, p, d, "created", d.CreatedBy, d.Comment, map[string]any{"reviewId": manifest.Review.ID, "previewRevision": preview.Revision, "snapshotId": d.SnapshotID})
	}
	if err == nil {
		err = tx.Commit()
	}
	if err != nil {
		projectHTTPError(w, err)
		return
	}
	ctx, cancel := context.WithTimeout(r.Context(), 5*time.Minute)
	defer cancel()
	var info delivery.ArchiveInfo
	err = h.projectBridge.rpc(ctx, projectScope(p), "project.delivery.prepare", map[string]any{"operationId": d.OperationID, "deliveryId": d.ID, "manifest": manifest}, &info)
	d, err = h.settleDelivery(r.Context(), p, d, info, err)
	if err != nil {
		projectHTTPError(w, err)
		return
	}
	httpx.JSON(w, 201, d)
}
func (h *handler) settleDelivery(ctx context.Context, p mission.Project, d projectDelivery, info delivery.ArchiveInfo, rpcErr error) (projectDelivery, error) {
	return h.mutateDelivery(ctx, p, d.ID, d.Kind, d.Revision, false, "archive_observed", "runner", "", func(_ *sql.Tx, current *projectDelivery) error {
		if current.Status == "revoked" {
			return projectexec.ErrInvalidState
		}
		if rpcErr != nil {
			current.Status = "unknown"
			current.Error = rpcErr.Error()
			return nil
		}
		if current.Manifest == nil {
			return errors.New("delivery lost its frozen manifest")
		}
		expected := *current.Manifest
		expected.PayloadBytes = info.Manifest.PayloadBytes
		expected.PayloadSHA256 = info.Manifest.PayloadSHA256
		a, err := delivery.ManifestHash(expected)
		if err != nil {
			return err
		}
		b, err := delivery.ManifestHash(info.Manifest)
		if err != nil {
			return err
		}
		if info.ID != current.ID || info.SnapshotID != current.SnapshotID || a != b || info.ManifestHash != a || info.Bytes < 2048 || info.Bytes > delivery.MaxArchiveBytes || len(info.SHA256) != 64 {
			return errors.New("runner delivery result differs from frozen review")
		}
		current.Status = "ready"
		current.Error = ""
		current.Manifest = &info.Manifest
		current.Archive = &info
		return nil
	})
}
func (h *handler) projectDeliveryInspect(w http.ResponseWriter, r *http.Request) {
	p, d, err := h.requestDelivery(r, "delivery")
	if err != nil {
		projectHTTPError(w, err)
		return
	}
	if d.Status == "ready" || d.Status == "revoked" {
		httpx.JSON(w, 200, d)
		return
	}
	var info delivery.ArchiveInfo
	rpcErr := h.projectBridge.rpc(r.Context(), projectScope(p), "project.delivery.info", map[string]any{"deliveryId": d.ID}, &info)
	d, err = h.settleDelivery(r.Context(), p, d, info, rpcErr)
	if err != nil {
		projectHTTPError(w, err)
		return
	}
	httpx.JSON(w, 200, d)
}

func (h *handler) projectDeliveryChannels(w http.ResponseWriter, r *http.Request) {
	p, err := h.requestProject(r)
	if err != nil {
		projectHTTPError(w, err)
		return
	}
	rows, err := h.deps.DB.QueryContext(r.Context(), h.deps.Rebind(`SELECT channel,delivery_id,revision,author_id,comment,updated_at FROM execution_delivery_channels WHERE tenant_id=? AND project_id=? ORDER BY channel`), p.TenantID, p.ID)
	if err != nil {
		projectHTTPError(w, err)
		return
	}
	defer rows.Close()
	items := []projectDeliveryChannel{}
	for rows.Next() {
		var c projectDeliveryChannel
		if err = rows.Scan(&c.Channel, &c.DeliveryID, &c.Revision, &c.AuthorID, &c.Comment, &c.UpdatedAt); err != nil {
			projectHTTPError(w, err)
			return
		}
		items = append(items, c)
	}
	if err = rows.Err(); err != nil {
		projectHTTPError(w, err)
		return
	}
	httpx.JSON(w, 200, map[string]any{"items": items})
}

var deliveryChannelName = regexp.MustCompile(`^[a-z][a-z0-9_-]{0,47}$`)

func (h *handler) projectDeliveryPromote(w http.ResponseWriter, r *http.Request) {
	if !deliveryHuman(w, r) {
		return
	}
	p, err := h.requestProject(r)
	if err != nil {
		projectHTTPError(w, err)
		return
	}
	channel := chi.URLParam(r, "channel")
	if !deliveryChannelName.MatchString(channel) {
		httpx.Error(w, 400, "Invalid release channel")
		return
	}
	var body struct {
		DeliveryID       string `json:"deliveryId"`
		ExpectedRevision int64  `json:"expectedRevision"`
		Comment          string `json:"comment"`
	}
	if httpx.DecodeJSON(r, &body) != nil || body.ExpectedRevision < 0 {
		httpx.Error(w, 400, "Invalid channel revision")
		return
	}
	if err = deliveryComment(body.Comment); err != nil {
		projectHTTPError(w, err)
		return
	}
	tx, err := h.deps.DB.BeginTx(r.Context(), nil)
	if err != nil {
		projectHTTPError(w, err)
		return
	}
	defer tx.Rollback()
	if err = h.lockProjectMutation(r.Context(), tx, p); err != nil {
		projectHTTPError(w, err)
		return
	}
	if err = h.projects.RequireTenantActive(r.Context(), tx, p.TenantID); err != nil {
		projectHTTPError(w, err)
		return
	}
	var raw string
	if err = tx.QueryRowContext(r.Context(), h.deps.Rebind(`SELECT record_json FROM execution_deliveries WHERE tenant_id=? AND project_id=? AND id=? AND kind='delivery'`), p.TenantID, p.ID, body.DeliveryID).Scan(&raw); err != nil {
		projectHTTPError(w, projectexec.ErrNotFound)
		return
	}
	var d projectDelivery
	if err = json.Unmarshal([]byte(raw), &d); err != nil {
		projectHTTPError(w, err)
		return
	}
	if d.Status != "ready" || d.UntrustedReview || d.Archive == nil {
		projectHTTPError(w, projectexec.ErrInvalidState)
		return
	}
	var revision int64
	err = tx.QueryRowContext(r.Context(), h.deps.Rebind(`SELECT revision FROM execution_delivery_channels WHERE tenant_id=? AND project_id=? AND channel=?`), p.TenantID, p.ID, channel).Scan(&revision)
	if err != nil && !errors.Is(err, sql.ErrNoRows) {
		projectHTTPError(w, err)
		return
	}
	if revision != body.ExpectedRevision {
		projectHTTPError(w, projectexec.ErrConflict)
		return
	}
	if revision == 0 {
		var count int
		if err = tx.QueryRowContext(r.Context(), h.deps.Rebind(`SELECT COUNT(*) FROM execution_delivery_channels WHERE tenant_id=? AND project_id=?`), p.TenantID, p.ID).Scan(&count); err != nil {
			projectHTTPError(w, err)
			return
		}
		if count >= 32 {
			httpx.Error(w, 409, "Release channel capacity reached")
			return
		}
	}
	out := projectDeliveryChannel{Channel: channel, DeliveryID: d.ID, Revision: revision + 1, AuthorID: principal(r).UserID, Comment: body.Comment, UpdatedAt: runtimeTimeString(h.store.now())}
	_, err = tx.ExecContext(r.Context(), h.deps.Rebind(`INSERT INTO execution_delivery_channels(tenant_id,project_id,channel,delivery_id,revision,author_id,comment,updated_at) VALUES(?,?,?,?,?,?,?,?) ON CONFLICT(tenant_id,project_id,channel) DO UPDATE SET delivery_id=excluded.delivery_id,revision=excluded.revision,author_id=excluded.author_id,comment=excluded.comment,updated_at=excluded.updated_at`), p.TenantID, p.ID, channel, d.ID, out.Revision, out.AuthorID, out.Comment, out.UpdatedAt)
	if err == nil {
		err = h.deliveryAudit(r.Context(), tx, p, d, "channel_promoted", out.AuthorID, out.Comment, out)
	}
	if err == nil {
		err = tx.Commit()
	}
	if err != nil {
		projectHTTPError(w, err)
		return
	}
	httpx.JSON(w, 200, out)
}
func (h *handler) projectDeliveryRevoke(w http.ResponseWriter, r *http.Request) {
	if !deliveryHuman(w, r) {
		return
	}
	p, d, err := h.requestDelivery(r, "delivery")
	if err != nil {
		projectHTTPError(w, err)
		return
	}
	var body struct {
		ExpectedRevision int64  `json:"expectedRevision"`
		Comment          string `json:"comment"`
	}
	if httpx.DecodeJSON(r, &body) != nil {
		httpx.Error(w, 400, "Invalid revocation")
		return
	}
	if err = deliveryComment(body.Comment); err != nil {
		projectHTTPError(w, err)
		return
	}
	d, err = h.mutateDelivery(r.Context(), p, d.ID, d.Kind, body.ExpectedRevision, true, "revoked", principal(r).UserID, body.Comment, func(tx *sql.Tx, current *projectDelivery) error {
		if current.Status != "ready" {
			return projectexec.ErrInvalidState
		}
		var count int
		if err := tx.QueryRowContext(r.Context(), h.deps.Rebind(`SELECT COUNT(*) FROM execution_delivery_channels WHERE tenant_id=? AND project_id=? AND delivery_id=?`), p.TenantID, p.ID, d.ID).Scan(&count); err != nil {
			return err
		}
		if count != 0 {
			return errors.New("move release channels to another delivery before revoking this one")
		}
		current.Status = "revoked"
		return nil
	})
	if err != nil {
		projectHTTPError(w, err)
		return
	}
	httpx.JSON(w, 200, d)
}

// deliveryRange accepts one HTTP byte range, including suffix ranges. Multiple
// ranges would require multipart envelopes and are intentionally rejected.
func deliveryRange(value string, size int64) (start, end int64, partial bool, err error) {
	if value == "" {
		return 0, size - 1, false, nil
	}
	if !strings.HasPrefix(value, "bytes=") || strings.Contains(value, ",") {
		return 0, 0, false, errors.New("one byte range is required")
	}
	parts := strings.Split(strings.TrimPrefix(value, "bytes="), "-")
	if len(parts) != 2 {
		return 0, 0, false, errors.New("invalid byte range")
	}
	if parts[0] == "" {
		n, e := strconv.ParseInt(parts[1], 10, 64)
		if e != nil || n <= 0 {
			return 0, 0, false, errors.New("invalid suffix range")
		}
		if n > size {
			n = size
		}
		return size - n, size - 1, true, nil
	}
	start, err = strconv.ParseInt(parts[0], 10, 64)
	if err != nil || start < 0 || start >= size {
		return 0, 0, false, errors.New("range start is outside archive")
	}
	end = size - 1
	if parts[1] != "" {
		end, err = strconv.ParseInt(parts[1], 10, 64)
		if err != nil || end < start {
			return 0, 0, false, errors.New("invalid range end")
		}
		if end >= size {
			end = size - 1
		}
	}
	return start, end, true, nil
}
func (h *handler) projectDeliveryDownload(w http.ResponseWriter, r *http.Request) {
	p, d, err := h.requestDelivery(r, "delivery")
	if err != nil {
		projectHTTPError(w, err)
		return
	}
	if d.Status != "ready" || d.Archive == nil {
		projectHTTPError(w, projectexec.ErrInvalidState)
		return
	}
	info := *d.Archive
	etag := "\"" + info.SHA256 + "\""
	if r.Header.Get("If-None-Match") == etag {
		w.Header().Set("ETag", etag)
		w.WriteHeader(304)
		return
	}
	rangeValue := r.Header.Get("Range")
	if v := r.Header.Get("If-Range"); v != "" && v != etag {
		rangeValue = ""
	}
	start, end, partial, err := deliveryRange(rangeValue, info.Bytes)
	if err != nil {
		w.Header().Set("Content-Range", fmt.Sprintf("bytes */%d", info.Bytes))
		httpx.Error(w, 416, err.Error())
		return
	}
	ctx, cancel := context.WithTimeout(r.Context(), 5*time.Minute)
	defer cancel()
	// Read before writing headers so an offline runner still produces a clear error.
	read := func(offset int64, max int) ([]byte, error) {
		var chunk struct {
			Base64     string `json:"base64"`
			Offset     int64  `json:"offset"`
			NextOffset int64  `json:"nextOffset"`
			SHA256     string `json:"sha256"`
		}
		if e := h.projectBridge.rpc(ctx, projectScope(p), "project.delivery.read", map[string]any{"deliveryId": d.ID, "offset": offset, "maxBytes": max}, &chunk); e != nil {
			return nil, e
		}
		b, e := base64.StdEncoding.Strict().DecodeString(chunk.Base64)
		if e != nil || chunk.Offset != offset || chunk.NextOffset != offset+int64(len(b)) || len(b) != max || chunk.SHA256 != info.SHA256 {
			return nil, errors.New("delivery chunk identity mismatch")
		}
		return b, nil
	}
	firstSize := int(min(int64(delivery.ChunkBytes), end-start+1))
	first, err := read(start, firstSize)
	if err != nil {
		projectHTTPError(w, err)
		return
	}
	w.Header().Set("Content-Type", "application/x-tar")
	w.Header().Set("Content-Disposition", fmt.Sprintf(`attachment; filename="zakura-delivery-%s.tar"`, d.ID))
	w.Header().Set("Cache-Control", "private, no-store")
	w.Header().Set("Accept-Ranges", "bytes")
	w.Header().Set("ETag", etag)
	w.Header().Set("Content-Length", strconv.FormatInt(end-start+1, 10))
	w.Header().Set("X-Content-Type-Options", "nosniff")
	if partial {
		w.Header().Set("Content-Range", fmt.Sprintf("bytes %d-%d/%d", start, end, info.Bytes))
		w.WriteHeader(206)
	} else {
		w.WriteHeader(200)
	}
	if _, err = w.Write(first); err != nil {
		return
	}
	offset := start + int64(len(first))
	for offset <= end {
		size := int(min(int64(delivery.ChunkBytes), end-offset+1))
		chunk, e := read(offset, size)
		if e != nil {
			return
		}
		if _, e = w.Write(chunk); e != nil {
			return
		}
		offset += int64(len(chunk))
	}
}
func (h *handler) projectDeliveryImportCreate(w http.ResponseWriter, r *http.Request) {
	p, err := h.requestProject(r)
	if err != nil {
		projectHTTPError(w, err)
		return
	}
	var body struct {
		Name       string `json:"name"`
		TotalBytes int64  `json:"totalBytes"`
		SHA256     string `json:"sha256"`
	}
	if httpx.DecodeJSON(r, &body) != nil || len(body.Name) > 256 || strings.TrimSpace(body.Name) == "" || body.TotalBytes < 2048 || body.TotalBytes > delivery.MaxArchiveBytes {
		httpx.Error(w, 400, "A name and bounded archive size are required")
		return
	}
	b, err := hex.DecodeString(body.SHA256)
	if err != nil || len(b) != 32 || strings.ToLower(body.SHA256) != body.SHA256 {
		httpx.Error(w, 400, "A lowercase SHA-256 digest is required")
		return
	}
	id := h.store.id()
	d := projectDelivery{ID: id, ProjectID: p.ID, Kind: "import", Name: id, Status: "preparing", TotalBytes: body.TotalBytes, SHA256: body.SHA256, UntrustedReview: true, CreatedBy: knowledgeAuthor(r), Comment: body.Name}
	d, err = h.insertDelivery(r.Context(), p, d)
	if err != nil {
		projectHTTPError(w, err)
		return
	}
	var out deliveryUploadResult
	rpcErr := h.projectBridge.rpc(r.Context(), projectScope(p), "project.delivery.upload.begin", map[string]any{"transferId": d.ID, "totalBytes": d.TotalBytes, "sha256": d.SHA256}, &out)
	d, err = h.settleImport(r.Context(), p, d, out, rpcErr)
	if err != nil {
		projectHTTPError(w, err)
		return
	}
	httpx.JSON(w, 201, d)
}
func (h *handler) settleImport(ctx context.Context, p mission.Project, d projectDelivery, out deliveryUploadResult, rpcErr error) (projectDelivery, error) {
	return h.mutateDelivery(ctx, p, d.ID, "import", d.Revision, false, "transfer_observed", "runner", "", func(_ *sql.Tx, current *projectDelivery) error {
		if current.Status == "aborted" {
			return projectexec.ErrInvalidState
		}
		if rpcErr != nil {
			current.Status = "unknown"
			current.Error = rpcErr.Error()
			return nil
		}
		if out.ID != current.ID || out.TotalBytes != current.TotalBytes || out.SHA256 != current.SHA256 || out.Received < current.Received || out.Received > current.TotalBytes || !out.UntrustedReview {
			return errors.New("runner import result differs from admitted transfer")
		}
		switch out.Status {
		case "uploading", "completed", "aborted":
		default:
			return errors.New("invalid import transfer status")
		}
		if out.Status == "completed" {
			if out.Manifest == nil || out.SnapshotID != out.Manifest.SnapshotID {
				return errors.New("import manifest identity mismatch")
			}
			if err := delivery.Validate(*out.Manifest, true); err != nil {
				return err
			}
			if out.Received != current.TotalBytes {
				return errors.New("import completed before all bytes arrived")
			}
			current.Manifest = out.Manifest
			current.SnapshotID = out.SnapshotID
		}
		current.Status = out.Status
		current.Received = out.Received
		current.Error = ""
		current.UntrustedReview = true
		return nil
	})
}
func (h *handler) projectDeliveryImportInspect(w http.ResponseWriter, r *http.Request) {
	p, d, err := h.requestDelivery(r, "import")
	if err != nil {
		projectHTTPError(w, err)
		return
	}
	if d.Status == "aborted" {
		httpx.JSON(w, 200, d)
		return
	}
	var out deliveryUploadResult
	rpcErr := h.projectBridge.rpc(r.Context(), projectScope(p), "project.delivery.upload.status", map[string]any{"transferId": d.ID}, &out)
	d, err = h.settleImport(r.Context(), p, d, out, rpcErr)
	if err != nil {
		projectHTTPError(w, err)
		return
	}
	httpx.JSON(w, 200, d)
}
func (h *handler) projectDeliveryImportChunk(w http.ResponseWriter, r *http.Request) {
	p, d, err := h.requestDelivery(r, "import")
	if err != nil {
		projectHTTPError(w, err)
		return
	}
	if d.Status != "uploading" {
		projectHTTPError(w, projectexec.ErrInvalidState)
		return
	}
	offset, err := strconv.ParseInt(r.URL.Query().Get("offset"), 10, 64)
	if err != nil || offset < 0 || offset > d.TotalBytes {
		httpx.Error(w, 400, "Invalid delivery chunk offset")
		return
	}
	data, err := io.ReadAll(http.MaxBytesReader(w, r.Body, delivery.ChunkBytes))
	if err != nil || len(data) == 0 {
		httpx.Error(w, 400, "A bounded nonempty delivery chunk is required")
		return
	}
	var out deliveryUploadResult
	rpcErr := h.projectBridge.rpc(r.Context(), projectScope(p), "project.delivery.upload.chunk", map[string]any{"transferId": d.ID, "offset": offset, "base64": base64.StdEncoding.EncodeToString(data)}, &out)
	if rpcErr != nil {
		projectHTTPError(w, rpcErr)
		return
	}
	d, err = h.settleImport(r.Context(), p, d, out, nil)
	if err != nil {
		projectHTTPError(w, err)
		return
	}
	httpx.JSON(w, 200, d)
}
func (h *handler) projectDeliveryImportFinish(w http.ResponseWriter, r *http.Request) {
	p, d, err := h.requestDelivery(r, "import")
	if err != nil {
		projectHTTPError(w, err)
		return
	}
	if d.Status == "completed" {
		httpx.JSON(w, 200, d)
		return
	}
	if d.Status != "uploading" || d.Received != d.TotalBytes {
		projectHTTPError(w, projectexec.ErrInvalidState)
		return
	}
	ctx, cancel := context.WithTimeout(r.Context(), 5*time.Minute)
	defer cancel()
	var out deliveryUploadResult
	rpcErr := h.projectBridge.rpc(ctx, projectScope(p), "project.delivery.upload.finish", map[string]any{"operationId": "import_" + d.ID, "transferId": d.ID}, &out)
	d, err = h.settleImport(r.Context(), p, d, out, rpcErr)
	if err != nil {
		projectHTTPError(w, err)
		return
	}
	httpx.JSON(w, 200, d)
}
func (h *handler) projectDeliveryImportAbort(w http.ResponseWriter, r *http.Request) {
	p, d, err := h.requestDelivery(r, "import")
	if err != nil {
		projectHTTPError(w, err)
		return
	}
	if d.Status == "completed" {
		projectHTTPError(w, projectexec.ErrInvalidState)
		return
	}
	if d.Status == "aborted" {
		httpx.JSON(w, 200, d)
		return
	}
	var out deliveryUploadResult
	rpcErr := h.projectBridge.rpc(r.Context(), projectScope(p), "project.delivery.upload.abort", map[string]any{"transferId": d.ID}, &out)
	d, err = h.settleImport(r.Context(), p, d, out, rpcErr)
	if err != nil {
		projectHTTPError(w, err)
		return
	}
	httpx.JSON(w, 200, d)
}
func (h *handler) projectDeliveryImportRun(w http.ResponseWriter, r *http.Request) {
	if h.rejectCampaignManagedProject(w, r, chi.URLParam(r, "pid")) {
		return
	}
	if !deliveryHuman(w, r) {
		return
	}
	p, d, err := h.requestDelivery(r, "import")
	if err != nil {
		projectHTTPError(w, err)
		return
	}
	if d.Status != "completed" || d.SnapshotID == "" {
		projectHTTPError(w, projectexec.ErrInvalidState)
		return
	}
	var body struct {
		ExpectedRevision int64 `json:"expectedRevision"`
	}
	if httpx.DecodeJSON(r, &body) != nil || body.ExpectedRevision != p.Revision {
		projectHTTPError(w, projectexec.ErrConflict)
		return
	}
	if err = h.validateProjectAgents(r.Context(), p); err != nil {
		projectHTTPError(w, err)
		return
	}
	var out deliveryUploadResult
	if err = h.projectBridge.rpc(r.Context(), projectScope(p), "project.delivery.upload.status", map[string]any{"transferId": d.ID}, &out); err != nil {
		projectHTTPError(w, err)
		return
	}
	if out.Status != "completed" || out.SnapshotID != d.SnapshotID || out.SHA256 != d.SHA256 || !out.UntrustedReview {
		projectHTTPError(w, errors.New("import is not durably complete on its runner"))
		return
	}
	// The current local plan, checks, agent assignments and budgets are frozen by
	// CreateRun. No foreign approval, task result or execution configuration is used.
	run, err := h.projects.CreateRun(r.Context(), p.TenantID, p.ID, d.SnapshotID, body.ExpectedRevision)
	if err != nil {
		projectHTTPError(w, err)
		return
	}
	httpx.JSON(w, 201, run)
}
