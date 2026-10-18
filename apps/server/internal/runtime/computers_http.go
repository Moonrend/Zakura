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
	r.Post("/spaces/{id}/desktop-ticket", h.spaceDesktopTicket)
	r.Get("/spaces/{id}/computer", h.getServerComputer)
	r.Put("/spaces/{id}/computer/config", h.configureServerComputer)
	r.Post("/spaces/{id}/computer/start", h.startServerComputer)
	r.Post("/spaces/{id}/computer/stop", h.stopServerComputer)
	r.Post("/spaces/{id}/computer/recovery/acknowledge", h.acknowledgeWorkspaceRecovery)
	r.Get("/spaces/{id}/computers", h.listComputers)
	r.Post("/spaces/{id}/computers", h.createComputer)
	r.Patch("/spaces/{id}/computers/{cid}", h.updateComputer)
	r.Get("/spaces/{id}/computers/{cid}/config", h.computerConfiguration)
	r.Delete("/spaces/{id}/computers/{cid}", h.deleteComputer)
	r.Post("/spaces/{id}/computers/{cid}/terminal-ticket", h.computerTerminalTicket)
	r.Post("/spaces/{id}/computers/{cid}/runtimes", h.reserveComputerRuntime)
	r.Get("/spaces/{id}/computers/{cid}/runtimes/{rid}", h.getComputerRuntime)
	r.Post("/spaces/{id}/computers/{cid}/runtimes/{rid}/approve", h.approveComputerRuntime)
	r.Post("/spaces/{id}/computers/{cid}/runtimes/{rid}/reconcile", h.reconcileComputerRuntime)
	r.Post("/spaces/{id}/computers/{cid}/runtimes/{rid}/replace", h.replaceComputerRuntime)
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
	switch {
	case errors.Is(err, sql.ErrNoRows):
		httpx.Error(w, 404, "computer not found")
	case errors.Is(err, computers.ErrServerComputerManaged), errors.Is(err, computers.ErrComputerInUse), errors.Is(err, computers.ErrSpaceDefaultFixed), errors.Is(err, computers.ErrOwnerDeleting), errors.Is(err, computers.ErrTransitionConflict), errors.Is(err, errOwnerDeletionUncertain), errors.Is(err, errWorkspaceStarting), errors.Is(err, errWorkspaceLeaseLost):
		httpx.Error(w, http.StatusConflict, err.Error())
	default:
		statusErr(w, err)
	}
}

// spaceComputers lists the catalog, creating the Space server computer first
// when a Space predates it or was written by a path that bypassed the Space
// transaction. Listing never provisions a runtime.
func (h *handler) spaceComputers(r *http.Request, tenant, space string) ([]computers.Computer, error) {
	s := h.computerStore()
	if _, err := s.ServerComputer(r.Context(), tenant, space); errors.Is(err, computers.ErrNoServerComputer) {
		if _, err = s.EnsureServerComputer(r.Context(), tenant, space, h.store.now()); err != nil {
			return nil, err
		}
	} else if err != nil {
		return nil, err
	}
	return s.List(r.Context(), tenant, space)
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
	items, err := h.spaceComputers(r, p.TenantID, space)
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

// sessionComputerResponse reports the chat's explicit choice (null when it
// follows the server computer) next to the computer its next Run will use.
func (h *handler) sessionComputerResponse(r *http.Request, space, session string) (map[string]any, error) {
	tenant := principal(r).TenantID
	s := h.computerStore()
	server, err := s.ServerComputer(r.Context(), tenant, space)
	if errors.Is(err, computers.ErrNoServerComputer) {
		server, err = s.EnsureServerComputer(r.Context(), tenant, space, h.store.now())
	}
	if err != nil {
		return nil, err
	}
	selected, err := s.SessionDefault(r.Context(), tenant, space, session)
	if err != nil {
		return nil, err
	}
	effective := server.ID
	var choice any
	if selected != nil {
		choice, effective = *selected, *selected
	}
	return map[string]any{"computerId": choice, "effectiveComputerId": effective, "serverComputerId": server.ID}, nil
}
func (h *handler) getSessionComputer(w http.ResponseWriter, r *http.Request) {
	space, ok := h.sessionComputerScope(w, r)
	if !ok {
		return
	}
	out, err := h.sessionComputerResponse(r, space, chi.URLParam(r, "sid"))
	if err != nil {
		computerStatusError(w, err)
		return
	}
	httpx.JSON(w, 200, out)
}

// setSessionComputer changes the chat's choice for subsequent Runs. null, or
// the server computer itself, makes the chat follow the server computer.
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
	if value != nil {
		c, err := s.Get(r.Context(), p.TenantID, space, id)
		if err != nil {
			computerStatusError(w, err)
			return
		}
		if c.IsServer() {
			value = nil
		}
	}
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
	out, err := h.sessionComputerResponse(r, space, sid)
	if err != nil {
		computerStatusError(w, err)
		return
	}
	httpx.JSON(w, 200, out)
}

// Session-scoped catalog allows an agent-bound credential to discover only its
// own Space without granting access to Space management routes.
func (h *handler) listSessionComputers(w http.ResponseWriter, r *http.Request) {
	space, ok := h.sessionComputerScope(w, r)
	if !ok {
		return
	}
	items, err := h.spaceComputers(r, principal(r).TenantID, space)
	if err != nil {
		computerStatusError(w, err)
		return
	}
	httpx.JSON(w, 200, items)
}
