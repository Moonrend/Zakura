package runtime

import (
	"database/sql"
	"errors"
	"net/http"

	"github.com/Moonrend/Zakura/apps/server/internal/computers"
	"github.com/Moonrend/Zakura/apps/server/internal/platform/httpx"
	"github.com/go-chi/chi/v5"
)

func (h *handler) computerStore() computers.Store {
	return computers.Store{DB: h.deps.DB, Rebind: h.deps.Rebind}
}

func (h *handler) registerComputers(r chi.Router) {
	r.Get("/spaces/{id}/computers", h.listComputers)
	r.Post("/spaces/{id}/computers", h.createComputer)
	r.Patch("/spaces/{id}/computers/{cid}", h.renameComputer)
	r.Post("/spaces/{id}/computers/{cid}/runtimes", h.reserveComputerRuntime)
	r.Get("/spaces/{id}/computers/{cid}/runtimes/{rid}", h.getComputerRuntime)
	r.Post("/spaces/{id}/computers/{cid}/runtimes/{rid}/approve", h.approveComputerRuntime)
	r.Post("/spaces/{id}/computers/{cid}/runtimes/{rid}/reconcile", h.reconcileComputerRuntime)
	r.Get("/spaces/{id}/computer-default", h.getSpaceComputer)
	r.Put("/spaces/{id}/computer-default", h.setSpaceComputer)
	r.Get("/agents/{id}/cloud/sessions/{sid}/computers", h.listSessionComputers)
	r.Get("/agents/{id}/cloud/sessions/{sid}/computer", h.getSessionComputer)
	r.Put("/agents/{id}/cloud/sessions/{sid}/computer", h.setSessionComputer)
}

// Restricted keys must not escape their bound Space or agent through the new
// catalog/selection routes. Provider secrets are never returned by these routes.
func computerScopeAllowed(p httpx.Principal, space, agent string) bool {
	if p.TenantID == "" {
		return false
	}
	if p.SpaceID != "" && p.SpaceID != space {
		return false
	}
	if p.AgentID != "" && p.AgentID != agent {
		return false
	}
	return true
}
func computerStatusError(w http.ResponseWriter, err error) {
	if errors.Is(err, sql.ErrNoRows) {
		httpx.Error(w, 404, "computer selection not found")
		return
	}
	statusErr(w, err)
}
func (h *handler) listComputers(w http.ResponseWriter, r *http.Request) {
	p := principal(r)
	space := chi.URLParam(r, "id")
	if !computerScopeAllowed(p, space, "") {
		httpx.Error(w, 403, "computer scope denied")
		return
	}
	if _, err := h.store.GetSpace(r.Context(), p.TenantID, space); err != nil {
		statusErr(w, err)
		return
	}
	items, err := h.computerStore().List(r.Context(), p.TenantID, space)
	if err != nil {
		computerStatusError(w, err)
		return
	}
	httpx.JSON(w, 200, items)
}
func (h *handler) sessionComputerScope(w http.ResponseWriter, r *http.Request) (string, bool) {
	p := principal(r)
	agentID := chi.URLParam(r, "id")
	agent, err := h.store.GetAgent(r.Context(), p.TenantID, agentID)
	if err != nil {
		statusErr(w, err)
		return "", false
	}
	if !computerScopeAllowed(p, agent.SpaceID, agentID) {
		httpx.Error(w, 403, "computer scope denied")
		return "", false
	}
	if _, err = h.store.GetSession(r.Context(), p.TenantID, agentID, chi.URLParam(r, "sid")); err != nil {
		statusErr(w, err)
		return "", false
	}
	return agent.SpaceID, true
}
func (h *handler) getSessionComputer(w http.ResponseWriter, r *http.Request) {
	space, ok := h.sessionComputerScope(w, r)
	if !ok {
		return
	}
	id, err := h.computerStore().SessionDefault(r.Context(), principal(r).TenantID, space, chi.URLParam(r, "sid"))
	if err != nil {
		computerStatusError(w, err)
		return
	}
	httpx.JSON(w, 200, map[string]any{"computerId": id})
}
func (h *handler) setSessionComputer(w http.ResponseWriter, r *http.Request) {
	space, ok := h.sessionComputerScope(w, r)
	if !ok {
		return
	}
	// Require the field explicitly: malformed requests must not silently clear it.
	var in map[string]any
	if httpx.DecodeJSON(r, &in) != nil {
		httpx.Error(w, 400, "invalid JSON")
		return
	}
	value, present := in["computerId"]
	if !present {
		httpx.Error(w, 400, "computerId is required")
		return
	}
	id, valid := value.(string)
	if value != nil && (!valid || id == "") {
		httpx.Error(w, 400, "computerId must be a nonempty string or null")
		return
	}
	s := h.computerStore()
	p := principal(r)
	sid := chi.URLParam(r, "sid")
	var err error
	if value == nil {
		err = s.ClearSessionDefault(r.Context(), p.TenantID, space, sid)
	} else {
		err = s.SetSessionDefault(r.Context(), p.TenantID, space, sid, id)
	}
	if err != nil {
		computerStatusError(w, err)
		return
	}
	httpx.JSON(w, 200, map[string]any{"computerId": value})
}

// Session-scoped catalog allows an agent-bound credential to discover only its
// own Space without granting access to Space management routes.
func (h *handler) listSessionComputers(w http.ResponseWriter, r *http.Request) {
	space, ok := h.sessionComputerScope(w, r)
	if !ok {
		return
	}
	items, err := h.computerStore().List(r.Context(), principal(r).TenantID, space)
	if err != nil {
		computerStatusError(w, err)
		return
	}
	httpx.JSON(w, 200, items)
}
