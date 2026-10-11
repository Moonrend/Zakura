// SPDX-License-Identifier: AGPL-3.0-or-later
package runtime

import (
	"context"
	"database/sql"
	"net/http"
	"strconv"

	"github.com/Moonrend/Zakura/apps/server/internal/platform/httpx"
	"github.com/Moonrend/Zakura/apps/server/internal/projectrequirements"
	"github.com/Moonrend/Zakura/packages/projectkit/mission"
	"github.com/Moonrend/Zakura/packages/projectkit/requirements"
	"github.com/go-chi/chi/v5"
)

func (h *handler) initializeProjectRequirements() {
	h.projectRequirements = projectrequirements.NewStore(h.deps.DB, h.deps.Dialect, h.deps.Rebind)
}
func (h *handler) registerProjectRequirements(r chi.Router) {
	r.Get("/requirements", h.projectRequirementsList)
	r.Post("/requirements", h.projectRequirementsCreate)
	r.Get("/requirements/runs/{rid}", h.projectRequirementsRun)
	r.Get("/requirements/{qid}", h.projectRequirementsGet)
	r.Patch("/requirements/{qid}", h.projectRequirementsUpdate)
	r.Delete("/requirements/{qid}", h.projectRequirementsDelete)
	r.Get("/requirements/{qid}/analysis", h.projectRequirementsAnalysis)
	r.Get("/requirements/{qid}/history", h.projectRequirementsHistory)
	r.Post("/requirements/{qid}/review", h.projectRequirementsReview)
	r.Post("/requirements/{qid}/archive", h.projectRequirementsArchive)
	r.Post("/requirements/{qid}/bind", h.projectRequirementsBind)
}
func (h *handler) requireProjectRequirements(ctx context.Context, scope mission.Scope, runID string) error {
	if h.projectRequirements == nil {
		return projectrequirements.ErrInvalid
	}
	return h.projectRequirements.Gate(ctx, scope, runID)
}
func (h *handler) requireProjectRequirementsTx(ctx context.Context, tx *sql.Tx, scope mission.Scope, runID string) error {
	if h.projectRequirements == nil {
		return projectrequirements.ErrInvalid
	}
	return h.projectRequirements.GateTx(ctx, tx, scope, runID)
}

func (h *handler) requireProjectRequirementsArtifactTx(ctx context.Context, tx *sql.Tx, scope mission.Scope, runID string, taskSnapshots map[string]string, verifications []mission.Verification, finalSnapshotID string) error {
	if h.projectRequirements == nil {
		return projectrequirements.ErrInvalid
	}
	return h.projectRequirements.ArtifactGateTx(ctx, tx, scope, runID, taskSnapshots, verifications, finalSnapshotID)
}
func requirementsHuman(w http.ResponseWriter, r *http.Request) bool {
	p := principal(r)
	if p.UserID == "" || p.APIKey || p.OAuth || p.SessionID == "" || (p.Role != "owner" && p.Role != "admin" && p.Role != "member") {
		httpx.Error(w, 403, "Requirements review requires an authenticated human member session")
		return false
	}
	return true
}
func (h *handler) requirementsProject(r *http.Request) (mission.Project, error) {
	if h.projectRequirements == nil {
		return mission.Project{}, projectrequirements.ErrInvalid
	}
	return h.requestProject(r)
}
func (h *handler) projectRequirementsList(w http.ResponseWriter, r *http.Request) {
	p, err := h.requirementsProject(r)
	if err != nil {
		projectHTTPError(w, err)
		return
	}
	result, err := h.projectRequirements.List(r.Context(), projectScope(p), r.URL.Query().Get("cursor"), projectQueryInt(r, "limit", 50, 100), r.URL.Query().Get("includeRetired") == "true")
	if err != nil {
		projectHTTPError(w, err)
		return
	}
	httpx.JSON(w, 200, result)
}
func (h *handler) projectRequirementsCreate(w http.ResponseWriter, r *http.Request) {
	p, err := h.requirementsProject(r)
	if err != nil {
		projectHTTPError(w, err)
		return
	}
	var draft requirements.Draft
	if httpx.DecodeJSON(r, &draft) != nil {
		httpx.Error(w, 400, "Invalid requirement clauses")
		return
	}
	baseline, err := h.projectRequirements.Create(r.Context(), projectScope(p), draft, knowledgeAuthor(r))
	if err != nil {
		projectHTTPError(w, err)
		return
	}
	httpx.JSON(w, 201, baseline)
}
func (h *handler) projectRequirementsGet(w http.ResponseWriter, r *http.Request) {
	p, err := h.requirementsProject(r)
	if err != nil {
		projectHTTPError(w, err)
		return
	}
	revision := int64(0)
	if value := r.URL.Query().Get("revision"); value != "" {
		revision, err = strconv.ParseInt(value, 10, 64)
		if err != nil || revision <= 0 {
			httpx.Error(w, 400, "Invalid immutable baseline revision")
			return
		}
	}
	baseline, err := h.projectRequirements.Get(r.Context(), projectScope(p), chi.URLParam(r, "qid"), revision)
	if err != nil {
		projectHTTPError(w, err)
		return
	}
	httpx.JSON(w, 200, baseline)
}
func (h *handler) projectRequirementsUpdate(w http.ResponseWriter, r *http.Request) {
	p, err := h.requirementsProject(r)
	if err != nil {
		projectHTTPError(w, err)
		return
	}
	var body struct {
		requirements.Draft
		ExpectedRevision int64  `json:"expectedRevision"`
		Comment          string `json:"comment"`
	}
	if httpx.DecodeJSON(r, &body) != nil || body.ExpectedRevision <= 0 {
		httpx.Error(w, 400, "Complete requirement clauses and expected revision required")
		return
	}
	baseline, err := h.projectRequirements.Update(r.Context(), projectScope(p), chi.URLParam(r, "qid"), body.ExpectedRevision, body.Draft, body.Comment, knowledgeAuthor(r))
	if err != nil {
		projectHTTPError(w, err)
		return
	}
	httpx.JSON(w, 200, baseline)
}
func (h *handler) projectRequirementsReview(w http.ResponseWriter, r *http.Request) {
	if !requirementsHuman(w, r) {
		return
	}
	p, err := h.requirementsProject(r)
	if err != nil {
		projectHTTPError(w, err)
		return
	}
	var body struct {
		ExpectedRevision        int64  `json:"expectedRevision"`
		ExpectedProjectRevision int64  `json:"expectedProjectRevision"`
		Decision                string `json:"decision"`
		Comment                 string `json:"comment"`
	}
	if httpx.DecodeJSON(r, &body) != nil || body.ExpectedRevision <= 0 || body.ExpectedProjectRevision <= 0 {
		httpx.Error(w, 400, "Expected baseline/project revisions, decision and review comment required")
		return
	}
	baseline, err := h.projectRequirements.Review(r.Context(), projectScope(p), chi.URLParam(r, "qid"), body.ExpectedRevision, body.ExpectedProjectRevision, body.Decision, body.Comment, principal(r).UserID, true)
	if err != nil {
		projectHTTPError(w, err)
		return
	}
	httpx.JSON(w, 200, baseline)
}
func (h *handler) projectRequirementsDelete(w http.ResponseWriter, r *http.Request) {
	h.projectRequirementsRetire(w, r, "delete")
}
func (h *handler) projectRequirementsArchive(w http.ResponseWriter, r *http.Request) {
	h.projectRequirementsRetire(w, r, "archive")
}
func (h *handler) projectRequirementsRetire(w http.ResponseWriter, r *http.Request, action string) {
	p, err := h.requirementsProject(r)
	if err != nil {
		projectHTTPError(w, err)
		return
	}
	var body struct {
		ExpectedRevision int64  `json:"expectedRevision"`
		Comment          string `json:"comment"`
	}
	if httpx.DecodeJSON(r, &body) != nil || body.ExpectedRevision <= 0 {
		httpx.Error(w, 400, "Expected revision and explanatory comment required")
		return
	}
	baseline, err := h.projectRequirements.Retire(r.Context(), projectScope(p), chi.URLParam(r, "qid"), body.ExpectedRevision, action, body.Comment, knowledgeAuthor(r))
	if err != nil {
		projectHTTPError(w, err)
		return
	}
	httpx.JSON(w, 200, baseline)
}
func (h *handler) projectRequirementsHistory(w http.ResponseWriter, r *http.Request) {
	p, err := h.requirementsProject(r)
	if err != nil {
		projectHTTPError(w, err)
		return
	}
	before := int64(0)
	if value := r.URL.Query().Get("before"); value != "" {
		before, err = strconv.ParseInt(value, 10, 64)
		if err != nil || before <= 0 {
			httpx.Error(w, 400, "Invalid revision cursor")
			return
		}
	}
	items, err := h.projectRequirements.History(r.Context(), projectScope(p), chi.URLParam(r, "qid"), before, projectQueryInt(r, "limit", 50, 200))
	if err != nil {
		projectHTTPError(w, err)
		return
	}
	httpx.JSON(w, 200, map[string]any{"items": items})
}
func (h *handler) projectRequirementsAnalysis(w http.ResponseWriter, r *http.Request) {
	p, err := h.requirementsProject(r)
	if err != nil {
		projectHTTPError(w, err)
		return
	}
	baseline, err := h.projectRequirements.Get(r.Context(), projectScope(p), chi.URLParam(r, "qid"), 0)
	if err != nil {
		projectHTTPError(w, err)
		return
	}
	httpx.JSON(w, 200, requirements.Analyze(baseline.Clauses, p.Plan))
}
func (h *handler) projectRequirementsBind(w http.ResponseWriter, r *http.Request) {
	p, err := h.requirementsProject(r)
	if err != nil {
		projectHTTPError(w, err)
		return
	}
	var body struct {
		ExpectedRevision int64  `json:"expectedRevision"`
		RunID            string `json:"runId"`
	}
	if httpx.DecodeJSON(r, &body) != nil || body.ExpectedRevision <= 0 || body.RunID == "" {
		httpx.Error(w, 400, "Expected approved baseline revision and run identity required")
		return
	}
	binding, err := h.projectRequirements.Bind(r.Context(), projectScope(p), chi.URLParam(r, "qid"), body.RunID, body.ExpectedRevision, knowledgeAuthor(r))
	if err != nil {
		projectHTTPError(w, err)
		return
	}
	httpx.JSON(w, 201, binding)
}
func (h *handler) projectRequirementsRun(w http.ResponseWriter, r *http.Request) {
	p, err := h.requirementsProject(r)
	if err != nil {
		projectHTTPError(w, err)
		return
	}
	rid := chi.URLParam(r, "rid")
	binding, found, coverage, err := h.projectRequirements.RunCoverage(r.Context(), projectScope(p), rid)
	if err != nil {
		projectHTTPError(w, err)
		return
	}
	if !found {
		httpx.JSON(w, 200, map[string]any{"binding": nil, "coverage": coverage})
		return
	}
	httpx.JSON(w, 200, map[string]any{"binding": binding, "coverage": coverage})
}
