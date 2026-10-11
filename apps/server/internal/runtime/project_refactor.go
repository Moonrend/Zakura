package runtime

import (
	"context"
	"net/http"
	"time"

	"github.com/Moonrend/Zakura/apps/server/internal/platform/httpx"
	"github.com/Moonrend/Zakura/apps/server/internal/projectexec"
	"github.com/Moonrend/Zakura/packages/projectkit/refactor"
	"github.com/go-chi/chi/v5"
)

func (h *handler) registerProjectRefactors(r chi.Router) {
	r.Post("/refactors/preview", h.projectRefactorPreview)
	r.Post("/refactors/apply", h.projectRefactorApply)
	r.Get("/refactors/{refactor}", h.projectRefactorCandidate)
	r.Post("/refactors/{refactor}/runs", h.projectRefactorRun)
}

type projectRefactorBody struct {
	refactor.Request
	PreviewID    string `json:"previewId,omitempty"`
	Confirmation string `json:"confirmation,omitempty"`
}

func projectRefactorArgs(body projectRefactorBody) map[string]any {
	args := map[string]any{"snapshotId": body.SnapshotID, "path": body.Path, "newName": body.NewName}
	if body.Offset != nil {
		args["offset"] = *body.Offset
	}
	if body.SymbolID != "" {
		args["symbolId"] = body.SymbolID
	}
	return args
}
func (h *handler) projectRefactorPreview(w http.ResponseWriter, r *http.Request) {
	var body projectRefactorBody
	if httpx.DecodeJSON(r, &body) != nil || !semanticSnapshotID(body.SnapshotID) || body.PreviewID != "" || body.Confirmation != "" {
		httpx.Error(w, 400, "Choose an immutable Go symbol and its proposed new name")
		return
	}
	h.projectReadRPC(w, r, "project.refactor.preview", projectRefactorArgs(body))
}
func (h *handler) projectRefactorApply(w http.ResponseWriter, r *http.Request) {
	if !projectHumanReviewer(w, r) {
		return
	}
	p, err := h.requestProject(r)
	if err != nil {
		projectHTTPError(w, err)
		return
	}
	var body projectRefactorBody
	if httpx.DecodeJSON(r, &body) != nil || !semanticSnapshotID(body.SnapshotID) || !semanticSnapshotID(body.PreviewID) || body.Confirmation != "create_branch" {
		httpx.Error(w, 400, "Explicitly confirm creation of this validated refactor branch")
		return
	}
	if err := h.projects.RequireTenantActive(r.Context(), nil, p.TenantID); err != nil {
		projectHTTPError(w, err)
		return
	}
	args := projectRefactorArgs(body)
	args["previewId"] = body.PreviewID
	args["confirmation"] = body.Confirmation
	args["operationId"] = projectOperationKey("refactor-apply", p.ID, body.PreviewID, principal(r).UserID)
	ctx, cancel := context.WithTimeout(r.Context(), 30*time.Second)
	defer cancel()
	var candidate refactor.Candidate
	if err = h.projectBridge.rpc(ctx, projectScope(p), "project.refactor.apply", args, &candidate); err != nil {
		projectHTTPError(w, err)
		return
	}
	httpx.JSON(w, 201, candidate)
}
func (h *handler) projectRefactorCandidate(w http.ResponseWriter, r *http.Request) {
	h.projectReadRPC(w, r, "project.refactor.candidate", map[string]any{"operationId": chi.URLParam(r, "refactor")})
}
func (h *handler) projectRefactorRun(w http.ResponseWriter, r *http.Request) {
	if !projectHumanReviewer(w, r) {
		return
	}
	p, err := h.requestProject(r)
	if err != nil {
		projectHTTPError(w, err)
		return
	}
	if h.rejectCampaignManagedProject(w, r, p.ID) {
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
	ctx, cancel := context.WithTimeout(r.Context(), 30*time.Second)
	defer cancel()
	var candidate refactor.Candidate
	if err = h.projectBridge.rpc(ctx, projectScope(p), "project.refactor.candidate", map[string]any{"operationId": chi.URLParam(r, "refactor")}, &candidate); err != nil {
		projectHTTPError(w, err)
		return
	}
	if candidate.ID != chi.URLParam(r, "refactor") || !candidate.RequiresHumanReview || candidate.AcceptanceInherited || !semanticSnapshotID(candidate.SnapshotID) {
		httpx.Error(w, 409, "Refactor candidate has no complete scoped receipt")
		return
	}
	run, err := h.projects.CreateRun(ctx, p.TenantID, p.ID, candidate.SnapshotID, body.ExpectedRevision)
	if err != nil {
		projectHTTPError(w, err)
		return
	}
	httpx.JSON(w, 201, run)
}
