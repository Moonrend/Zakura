package runtime

import (
	"encoding/json"
	"io"
	"net/http"
	"strings"

	"github.com/Moonrend/Zakura/apps/server/internal/computers"
	"github.com/Moonrend/Zakura/apps/server/internal/platform/httpx"
	"github.com/go-chi/chi/v5"
)

// Configuration is deliberately narrower than execution. Agent-bound credentials
// cannot manage computers; API keys additionally need an explicit manage scope.
func (h *handler) manageComputerScope(w http.ResponseWriter, r *http.Request) bool {
	p := principal(r)
	space := chi.URLParam(r, "id")
	if !computerScopeAllowed(p, space, "") || (p.Role != "owner" && p.Role != "admin" && !p.IsPlatformAdmin) || (p.APIKey && !APIKeyScopeAllows(p, "computers:manage")) {
		httpx.Error(w, 403, "computer management permission required")
		return false
	}
	if _, err := h.store.GetSpace(r.Context(), p.TenantID, space); err != nil {
		statusErr(w, err)
		return false
	}
	return true
}
func (h *handler) createComputer(w http.ResponseWriter, r *http.Request) {
	if !h.manageComputerScope(w, r) {
		return
	}
	var in struct {
		Name               string             `json:"name"`
		Provider           computers.Provider `json:"provider"`
		RuntimeNodeID      string             `json:"runtimeNodeId"`
		IdleSeconds        int                `json:"idleSeconds"`
		MaxLifetimeSeconds int                `json:"maxLifetimeSeconds"`
		Config             map[string]string  `json:"config"`
	}
	r.Body = http.MaxBytesReader(w, r.Body, 64<<10)
	decoder := json.NewDecoder(r.Body)
	decoder.DisallowUnknownFields()
	if decoder.Decode(&in) != nil || decoder.Decode(new(any)) != io.EOF {
		httpx.Error(w, 400, "invalid computer configuration")
		return
	}
	in.Name = strings.TrimSpace(in.Name)
	if in.Name == "" || len(in.Name) > 200 {
		httpx.Error(w, 400, "name is required (maximum 200 bytes)")
		return
	}
	if in.IdleSeconds == 0 {
		in.IdleSeconds = 900
	}
	if in.MaxLifetimeSeconds == 0 {
		in.MaxLifetimeSeconds = 3600
	}
	p := principal(r)
	c := computers.Computer{ID: h.store.id(), TenantID: p.TenantID, SpaceID: chi.URLParam(r, "id"), Name: in.Name, Provider: in.Provider, RuntimeNodeID: in.RuntimeNodeID, IdleSeconds: in.IdleSeconds, MaxLifetimeSeconds: in.MaxLifetimeSeconds, Capabilities: []computers.Capability{}}
	if err := c.Validate(); err != nil {
		httpx.Error(w, 400, err.Error())
		return
	}
	if c.Provider == computers.Server || c.Provider == computers.RemoteAgent || c.Provider == computers.Temporary {
		var node struct{ Kind string }
		err := h.deps.Gorm.WithContext(r.Context()).Table("runtime_nodes").Select("kind").Where("(tenant_id=? OR is_shared=TRUE) AND id=?", p.TenantID, c.RuntimeNodeID).Take(&node).Error
		if err != nil {
			httpx.Error(w, 400, "runtime node is unavailable")
			return
		}
		if (c.Provider == computers.Server || c.Provider == computers.Temporary) && node.Kind != "server" {
			httpx.Error(w, 400, "a server node is required")
			return
		}
	} else if c.RuntimeNodeID != "" {
		httpx.Error(w, 400, "provider does not accept a runtime node")
		return
	}
	// Provider configuration is write-only and sealed per card. No live runtime is
	// created here; capabilities stay empty until verified by provisioning.
	if err := computers.ValidateConfiguration(c.Provider, in.Config); err != nil {
		httpx.Error(w, 400, err.Error())
		return
	}
	raw, err := json.Marshal(in.Config)
	if err != nil {
		statusErr(w, err)
		return
	}
	sealed, err := computers.SealCredentials(h.deps.Secret, p.TenantID, c.SpaceID, c.ID, raw)
	if err != nil {
		statusErr(w, err)
		return
	}
	if err = h.computerStore().Create(r.Context(), c, sealed); err != nil {
		computerStatusError(w, err)
		return
	}
	httpx.JSON(w, 201, c)
}
func (h *handler) renameComputer(w http.ResponseWriter, r *http.Request) {
	if !h.manageComputerScope(w, r) {
		return
	}
	var in struct {
		Name string `json:"name"`
	}
	if httpx.DecodeJSON(r, &in) != nil || strings.TrimSpace(in.Name) == "" || len(in.Name) > 200 {
		httpx.Error(w, 400, "invalid computer name")
		return
	}
	if err := h.computerStore().Rename(r.Context(), principal(r).TenantID, chi.URLParam(r, "id"), chi.URLParam(r, "cid"), in.Name); err != nil {
		computerStatusError(w, err)
		return
	}
	httpx.JSON(w, 200, map[string]any{"name": strings.TrimSpace(in.Name)})
}
func (h *handler) getSpaceComputer(w http.ResponseWriter, r *http.Request) {
	p := principal(r)
	space := chi.URLParam(r, "id")
	if !computerScopeAllowed(p, space, "") {
		httpx.Error(w, 403, "computer scope denied")
		return
	}
	id, err := h.computerStore().SpaceDefault(r.Context(), p.TenantID, space)
	if err != nil {
		computerStatusError(w, err)
		return
	}
	httpx.JSON(w, 200, map[string]any{"computerId": id})
}
func (h *handler) setSpaceComputer(w http.ResponseWriter, r *http.Request) {
	if !h.manageComputerScope(w, r) {
		return
	}
	var in map[string]any
	if httpx.DecodeJSON(r, &in) != nil {
		httpx.Error(w, 400, "invalid JSON")
		return
	}
	value, ok := in["computerId"]
	id, valid := value.(string)
	if !ok || (value != nil && (!valid || id == "")) {
		httpx.Error(w, 400, "computerId must be a nonempty string or null")
		return
	}
	s := h.computerStore()
	p := principal(r)
	space := chi.URLParam(r, "id")
	var err error
	if value == nil {
		err = s.ClearSpaceDefault(r.Context(), p.TenantID, space)
	} else {
		err = s.SetSpaceDefault(r.Context(), p.TenantID, space, id)
	}
	if err != nil {
		computerStatusError(w, err)
		return
	}
	httpx.JSON(w, 200, map[string]any{"computerId": value})
}
