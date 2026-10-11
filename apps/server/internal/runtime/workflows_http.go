// SPDX-License-Identifier: AGPL-3.0-or-later
package runtime

import (
	"net/http"

	"github.com/Moonrend/Zakura/apps/server/internal/platform/httpx"
	"github.com/Moonrend/Zakura/apps/server/internal/workflow"
	"github.com/go-chi/chi/v5"
)

func (h *handler) registerWorkflows(r chi.Router) {
	r.Get("/workflows/meta", h.workflowMeta)
	r.Get("/workflows/templates", h.workflowTemplates)
	r.Post("/workflows/validate", h.workflowValidate)
	r.Post("/workflows/plan", h.workflowPlan)
}

func (h *handler) workflowMeta(w http.ResponseWriter, r *http.Request) {
	w.Header().Set("Cache-Control", "no-store")
	httpx.JSON(w, 200, map[string]any{
		"version": workflow.Version, "maxNodes": workflow.MaxNodes,
		"maxEdges": workflow.MaxEdges, "maxResources": workflow.MaxResources,
		"maxDurationMs": workflow.MaxDurationMS, "maxCostMicros": workflow.MaxCostMicros,
		"maxLimit": workflow.MaxLimit, "maxAttempts": 10,
		"modes":      []string{"nominal", "retryBound"},
		"priorities": []string{"criticalPath", "id"}, "executionEnabled": false,
	})
}

func (h *handler) workflowTemplates(w http.ResponseWriter, r *http.Request) {
	w.Header().Set("Cache-Control", "no-store")
	httpx.JSON(w, 200, workflow.Templates())
}

func (h *handler) workflowValidate(w http.ResponseWriter, r *http.Request) {
	w.Header().Set("Cache-Control", "no-store")
	var req workflow.Request
	if err := httpx.DecodeJSON(r, &req); err != nil {
		httpx.Error(w, 400, "invalid workflow JSON: "+err.Error())
		return
	}
	httpx.JSON(w, 200, workflow.Validate(req.Definition, req.Options))
}

func (h *handler) workflowPlan(w http.ResponseWriter, r *http.Request) {
	w.Header().Set("Cache-Control", "no-store")
	var req workflow.Request
	if err := httpx.DecodeJSON(r, &req); err != nil {
		httpx.Error(w, 400, "invalid workflow JSON: "+err.Error())
		return
	}
	result, err := workflow.Plan(r.Context(), req)
	if err != nil {
		if r.Context().Err() != nil {
			return
		}
		httpx.Error(w, 500, "workflow planning failed")
		return
	}
	if !result.Validation.Valid {
		httpx.JSON(w, 422, result)
		return
	}
	httpx.JSON(w, 200, result)
}
