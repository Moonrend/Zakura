// SPDX-License-Identifier: AGPL-3.0-or-later
package runtime

import (
	"context"
	"fmt"
	"github.com/Moonrend/Zakura/apps/server/internal/platform/httpx"
	"github.com/Moonrend/Zakura/apps/server/internal/projectexec"
	"github.com/Moonrend/Zakura/packages/projectkit/mission"
	"github.com/go-chi/chi/v5"
	"net/http"
)

func (h *handler) registerProjectPortfolio(r chi.Router) {
	r.Route("/project-portfolio", func(p chi.Router) {
		p.Use(h.projectAccess)
		p.Get("/", h.projectPortfolioOverview)
		p.Get("/policy", h.projectPortfolioPolicy)
		p.Put("/policy", h.projectPortfolioPolicyUpdate)
		p.Patch("/projects/{pid}/scheduling", h.projectPortfolioScheduling)
		p.Post("/runs/actions", h.projectPortfolioActions)
	})
}
func (h *handler) projectPortfolioOverview(w http.ResponseWriter, r *http.Request) {
	out, err := h.projects.PortfolioOverview(r.Context(), principal(r).TenantID, r.URL.Query().Get("spaceId"), projectQueryInt(r, "limit", 100, 200))
	if err != nil {
		projectHTTPError(w, err)
		return
	}
	httpx.JSON(w, 200, out)
}
func (h *handler) projectPortfolioPolicy(w http.ResponseWriter, r *http.Request) {
	out, err := h.projects.GetPortfolioPolicy(r.Context(), principal(r).TenantID)
	if err != nil {
		projectHTTPError(w, err)
		return
	}
	httpx.JSON(w, 200, out)
}
func (h *handler) projectPortfolioPolicyUpdate(w http.ResponseWriter, r *http.Request) {
	p := principal(r)
	if p.UserID == "" || p.APIKey || p.OAuth || p.SessionID == "" || (p.Role != "owner" && p.Role != "admin") {
		httpx.Error(w, 403, "Tenant resource policy requires a signed-in owner or administrator")
		return
	}
	var body struct {
		projectexec.PortfolioPolicy
		ExpectedRevision int64 `json:"expectedRevision"`
	}
	if httpx.DecodeJSON(r, &body) != nil {
		httpx.Error(w, 400, "Invalid portfolio policy JSON")
		return
	}
	for _, limit := range body.Agents {
		if _, err := h.store.GetAgent(r.Context(), p.TenantID, limit.AgentID); err != nil {
			projectHTTPError(w, err)
			return
		}
	}
	out, err := h.projects.UpdatePortfolioPolicy(r.Context(), p.TenantID, body.ExpectedRevision, body.PortfolioPolicy)
	if err != nil {
		projectHTTPError(w, err)
		return
	}
	httpx.JSON(w, 200, out)
}
func (h *handler) projectPortfolioScheduling(w http.ResponseWriter, r *http.Request) {
	if h.rejectCampaignManagedProject(w, r, chi.URLParam(r, "pid")) {
		return
	}
	var body struct {
		mission.Scheduling
		ExpectedRevision int64 `json:"expectedRevision"`
	}
	if httpx.DecodeJSON(r, &body) != nil {
		httpx.Error(w, 400, "Invalid scheduling policy JSON")
		return
	}
	out, err := h.projects.UpdateProjectScheduling(r.Context(), principal(r).TenantID, chi.URLParam(r, "pid"), body.ExpectedRevision, body.Scheduling)
	if err != nil {
		projectHTTPError(w, err)
		return
	}
	httpx.JSON(w, 200, out)
}
func (h *handler) projectPortfolioActions(w http.ResponseWriter, r *http.Request) {
	var body struct {
		Action string                           `json:"action"`
		Items  []projectexec.PortfolioRunAction `json:"items"`
	}
	if httpx.DecodeJSON(r, &body) != nil {
		httpx.Error(w, 400, "Invalid portfolio action JSON")
		return
	}
	out, err := h.projectEngine.ApplyPortfolioActions(r.Context(), principal(r).TenantID, body.Action, body.Items, func(ctx context.Context, item projectexec.PortfolioRunAction) error {
		if body.Action != "resume" {
			return nil
		}
		if _, err := h.projects.GetRun(ctx, principal(r).TenantID, item.ProjectID, item.RunID); err != nil {
			return err
		}
		var managed int
		if err := h.deps.DB.QueryRowContext(ctx, h.deps.Rebind(`SELECT COUNT(*) FROM project_campaign_variants WHERE tenant_id=? AND project_id=?`), principal(r).TenantID, item.ProjectID).Scan(&managed); err != nil {
			return err
		}
		if managed != 0 {
			return fmt.Errorf("%w: resume this project through its campaign so campaign concurrency and budget remain enforced", projectexec.ErrInvalidState)
		}
		return nil
	})
	if err != nil {
		projectHTTPError(w, err)
		return
	}
	httpx.JSON(w, 200, map[string]any{"items": out})
}
