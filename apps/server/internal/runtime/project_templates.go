// SPDX-License-Identifier: AGPL-3.0-or-later
package runtime

import (
	"encoding/json"
	"errors"
	"fmt"
	"io"
	"net/http"
	"strconv"

	"github.com/Moonrend/Zakura/apps/server/internal/platform/httpx"
	"github.com/Moonrend/Zakura/apps/server/internal/projecttemplates"
	"github.com/Moonrend/Zakura/packages/projectkit/blueprint"
	"github.com/go-chi/chi/v5"
)

func (h *handler) registerProjectTemplates(r chi.Router) {
	r.Route("/project-templates", func(t chi.Router) {
		t.Use(h.projectAccess)
		t.Get("/", h.templateList)
		t.Post("/", h.templateCreate)
		t.Get("/recipes", h.templateRecipes)
		t.Post("/preview", h.templatePreviewDefinition)
		t.Post("/import", h.templateImport)
		t.Route("/{templateId}", func(t chi.Router) {
			t.Get("/", h.templateGet)
			t.Patch("/", h.templateUpdate)
			t.Delete("/", h.templateDelete)
			t.Get("/versions", h.templateVersions)
			t.Get("/versions/{version}", h.templateVersion)
			t.Get("/export", h.templateExport)
			t.Post("/preview", h.templatePreview)
			t.Post("/instantiate", h.templateInstantiate)
		})
	})
}

func (h *handler) templateStore() *projecttemplates.Store {
	return projecttemplates.NewStore(h.deps.DB, h.deps.Dialect, h.deps.Rebind)
}

func templateHTTPError(w http.ResponseWriter, err error) {
	var validation *blueprint.ValidationError
	switch {
	case errors.As(err, &validation):
		httpx.JSON(w, 422, map[string]any{"error": validation.Error(), "issues": validation.Issues})
	case errors.Is(err, projecttemplates.ErrNotFound):
		httpx.Error(w, 404, "Project template not found")
	case errors.Is(err, projecttemplates.ErrConflict):
		httpx.Error(w, 409, "Project template revision changed; reload before applying this action")
	default:
		projectHTTPError(w, err)
	}
}

func templateDecode(r *http.Request, target any) error {
	r.Body = http.MaxBytesReader(nil, r.Body, blueprint.MaxDocumentBytes)
	raw, err := io.ReadAll(r.Body)
	if err != nil {
		return err
	}
	return blueprint.DecodeStrict(raw, target)
}

func templateAuthor(r *http.Request) string {
	p := principal(r)
	if p.APIKey {
		return ""
	}
	return p.UserID
}

func (h *handler) templateList(w http.ResponseWriter, r *http.Request) {
	items, err := h.templateStore().List(r.Context(), principal(r).TenantID, projectQueryInt(r, "limit", 100, 1000))
	if err != nil {
		templateHTTPError(w, err)
		return
	}
	httpx.JSON(w, 200, map[string]any{"items": items})
}

func (h *handler) templateRecipes(w http.ResponseWriter, r *http.Request) {
	httpx.JSON(w, 200, map[string]any{"items": blueprint.Recipes()})
}

type templateDefinitionBody struct {
	Definition       blueprint.Definition `json:"definition"`
	ExpectedRevision int64                `json:"expectedRevision,omitempty"`
}

func (h *handler) templateCreate(w http.ResponseWriter, r *http.Request) {
	var body templateDefinitionBody
	if err := templateDecode(r, &body); err != nil {
		templateHTTPError(w, err)
		return
	}
	item, err := h.templateStore().Create(r.Context(), principal(r).TenantID, templateAuthor(r), body.Definition)
	if err != nil {
		templateHTTPError(w, err)
		return
	}
	httpx.JSON(w, 201, item)
}

func (h *handler) templateImport(w http.ResponseWriter, r *http.Request) {
	r.Body = http.MaxBytesReader(nil, r.Body, blueprint.MaxDocumentBytes)
	raw, err := io.ReadAll(r.Body)
	if err != nil {
		templateHTTPError(w, err)
		return
	}
	definition, err := blueprint.Import(raw)
	if err != nil {
		templateHTTPError(w, err)
		return
	}
	item, err := h.templateStore().Create(r.Context(), principal(r).TenantID, templateAuthor(r), definition)
	if err != nil {
		templateHTTPError(w, err)
		return
	}
	httpx.JSON(w, 201, item)
}

func (h *handler) templateGet(w http.ResponseWriter, r *http.Request) {
	item, err := h.templateStore().Get(r.Context(), principal(r).TenantID, chi.URLParam(r, "templateId"))
	if err != nil {
		templateHTTPError(w, err)
		return
	}
	httpx.JSON(w, 200, item)
}

func (h *handler) templateUpdate(w http.ResponseWriter, r *http.Request) {
	var body templateDefinitionBody
	if err := templateDecode(r, &body); err != nil {
		templateHTTPError(w, err)
		return
	}
	item, err := h.templateStore().Update(r.Context(), principal(r).TenantID, chi.URLParam(r, "templateId"), templateAuthor(r), body.ExpectedRevision, body.Definition)
	if err != nil {
		templateHTTPError(w, err)
		return
	}
	httpx.JSON(w, 200, item)
}

func (h *handler) templateDelete(w http.ResponseWriter, r *http.Request) {
	expected, err := strconv.ParseInt(r.URL.Query().Get("expectedRevision"), 10, 64)
	if err != nil || expected < 1 {
		httpx.Error(w, 400, "expectedRevision must be a positive integer")
		return
	}
	if err = h.templateStore().Delete(r.Context(), principal(r).TenantID, chi.URLParam(r, "templateId"), expected); err != nil {
		templateHTTPError(w, err)
		return
	}
	w.WriteHeader(http.StatusNoContent)
}

func (h *handler) templateVersions(w http.ResponseWriter, r *http.Request) {
	items, err := h.templateStore().Versions(r.Context(), principal(r).TenantID, chi.URLParam(r, "templateId"), projectQueryInt(r, "limit", 100, 1000))
	if err != nil {
		templateHTTPError(w, err)
		return
	}
	httpx.JSON(w, 200, map[string]any{"items": items})
}

func (h *handler) templateVersion(w http.ResponseWriter, r *http.Request) {
	version, err := strconv.Atoi(chi.URLParam(r, "version"))
	if err != nil || version < 1 {
		httpx.Error(w, 400, "version must be positive")
		return
	}
	item, err := h.templateStore().Version(r.Context(), principal(r).TenantID, chi.URLParam(r, "templateId"), version)
	if err != nil {
		templateHTTPError(w, err)
		return
	}
	httpx.JSON(w, 200, item)
}

func (h *handler) templateExport(w http.ResponseWriter, r *http.Request) {
	store := h.templateStore()
	item, err := store.Get(r.Context(), principal(r).TenantID, chi.URLParam(r, "templateId"))
	if err != nil {
		templateHTTPError(w, err)
		return
	}
	definition := item.Definition
	if raw := r.URL.Query().Get("version"); raw != "" {
		version, err := strconv.Atoi(raw)
		if err != nil || version < 1 {
			httpx.Error(w, 400, "version must be positive")
			return
		}
		selected, err := store.Version(r.Context(), principal(r).TenantID, item.ID, version)
		if err != nil {
			templateHTTPError(w, err)
			return
		}
		definition = selected.Definition
	}
	document, err := blueprint.Export(definition)
	if err != nil {
		templateHTTPError(w, err)
		return
	}
	httpx.JSON(w, 200, document)
}

type templateExpandBody struct {
	blueprint.Inputs
	ExpectedRevision int64 `json:"expectedRevision"`
	Version          int   `json:"version,omitempty"`
}

type templateDirectBody struct {
	blueprint.Inputs
	Definition blueprint.Definition `json:"definition"`
}

func (h *handler) expandTemplate(r *http.Request, d blueprint.Definition, inputs blueprint.Inputs) (blueprint.Expansion, error) {
	expansion, err := blueprint.Expand(d, inputs)
	if err != nil {
		return expansion, err
	}
	expansion.Project.TenantID = principal(r).TenantID
	expansion.Project.CreatedBy = templateAuthor(r)
	if err = h.validateProjectAgents(r.Context(), expansion.Project); err != nil {
		return blueprint.Expansion{}, err
	}
	// Validate even roles whose conditional tasks are absent from this expansion.
	for role, id := range inputs.AgentMapping {
		agent, err := h.store.GetAgent(r.Context(), principal(r).TenantID, id)
		if err != nil {
			return blueprint.Expansion{}, err
		}
		if agent.SpaceID != inputs.SpaceID {
			return blueprint.Expansion{}, fmt.Errorf("role %s agent belongs to another space", role)
		}
		var config struct {
			Runtime string `json:"runtime"`
		}
		_ = json.Unmarshal(agent.Config, &config)
		if config.Runtime == "acp" {
			return blueprint.Expansion{}, fmt.Errorf("role %s requires a gateway agent", role)
		}
	}
	return expansion, nil
}

func (h *handler) templatePreviewDefinition(w http.ResponseWriter, r *http.Request) {
	var body templateDirectBody
	if err := templateDecode(r, &body); err != nil {
		templateHTTPError(w, err)
		return
	}
	expansion, err := h.expandTemplate(r, body.Definition, body.Inputs)
	if err != nil {
		templateHTTPError(w, err)
		return
	}
	httpx.JSON(w, 200, expansion)
}

func (h *handler) templatePreview(w http.ResponseWriter, r *http.Request) {
	h.templateExpand(w, r, false)
}
func (h *handler) templateInstantiate(w http.ResponseWriter, r *http.Request) {
	h.templateExpand(w, r, true)
}

func (h *handler) templateExpand(w http.ResponseWriter, r *http.Request, instantiate bool) {
	var body templateExpandBody
	if err := templateDecode(r, &body); err != nil {
		templateHTTPError(w, err)
		return
	}
	version, err := h.templateStore().Select(r.Context(), principal(r).TenantID, chi.URLParam(r, "templateId"), body.ExpectedRevision, body.Version)
	if err != nil {
		templateHTTPError(w, err)
		return
	}
	expansion, err := h.expandTemplate(r, version.Definition, body.Inputs)
	if err != nil {
		templateHTTPError(w, err)
		return
	}
	if !instantiate {
		httpx.JSON(w, 200, expansion)
		return
	}
	project, err := h.projects.CreateProject(r.Context(), expansion.Project)
	if err != nil {
		templateHTTPError(w, err)
		return
	}
	expansion.Project = project
	httpx.JSON(w, 201, struct {
		blueprint.Expansion
		TemplateID      string `json:"templateId"`
		TemplateVersion int    `json:"templateVersion"`
	}{Expansion: expansion, TemplateID: version.TemplateID, TemplateVersion: version.Version})
}
