package runtime

import (
	"context"
	"encoding/json"
	"io"
	"net/http"
	"strings"
	"time"

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
	if in.Name == "" {
		suffix := h.store.id()
		in.Name = "电脑 " + suffix[:min(8, len(suffix))]
	}
	if len(in.Name) > 200 {
		httpx.Error(w, 400, "name must not exceed 200 bytes")
		return
	}
	if in.IdleSeconds == 0 {
		in.IdleSeconds = 900
	}
	if in.MaxLifetimeSeconds == 0 {
		in.MaxLifetimeSeconds = 3600
	}
	p := principal(r)
	c := computers.Computer{ID: h.store.id(), TenantID: p.TenantID, SpaceID: chi.URLParam(r, "id"), Name: in.Name, Provider: in.Provider, Role: computers.RoleAttached, RuntimeNodeID: in.RuntimeNodeID, IdleSeconds: in.IdleSeconds, MaxLifetimeSeconds: in.MaxLifetimeSeconds, Capabilities: []computers.Capability{}}
	// The Space already has exactly one server computer: its workspace.
	if c.Provider == computers.Server {
		httpx.Error(w, 400, "each space has exactly one server computer, created with the space; attach an ssh, e2b, railway, temporary or remote_agent computer instead")
		return
	}
	if err := c.Validate(); err != nil {
		httpx.Error(w, 400, err.Error())
		return
	}
	if c.Provider == computers.RemoteAgent || c.Provider == computers.Temporary {
		if err := h.authorizeLocalNode(r.Context(), p, c.RuntimeNodeID); err != nil {
			statusErr(w, err)
			return
		}
		var node struct {
			Kind string `gorm:"column:kind"`
		}
		err := h.deps.Gorm.WithContext(r.Context()).Table("runtime_nodes").Select("kind").Where("(tenant_id=? OR is_shared=TRUE) AND id=?", p.TenantID, c.RuntimeNodeID).Take(&node).Error
		if err != nil {
			httpx.Error(w, 400, "runtime node is unavailable")
			return
		}
		if c.Provider == computers.Temporary && node.Kind != "server" && node.Kind != "computer" && node.Kind != "local" {
			httpx.Error(w, 400, "a server or computer node is required")
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
	if c.Provider == computers.Railway && strings.TrimSpace(in.Config["privateKey"]) == "" {
		generated, err := computers.GenerateSSHPrivateKey()
		if err != nil {
			httpx.Error(w, 500, "computer configuration could not be generated")
			return
		}
		if in.Config == nil {
			in.Config = map[string]string{}
		}
		in.Config["privateKey"] = generated
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

// deleteComputer removes an attached computer. Chats that chose it fall back to
// the Space server computer, which itself can never be removed here.
func (h *handler) deleteComputer(w http.ResponseWriter, r *http.Request) {
	if !h.manageComputerScope(w, r) {
		return
	}
	p := principal(r)
	space := chi.URLParam(r, "id")
	computer := chi.URLParam(r, "cid")
	if err := h.prepareComputerDeletion(r.Context(), p.TenantID, space, computer); err != nil {
		computerStatusError(w, err)
		return
	}
	if err := h.computerStore().Delete(r.Context(), p.TenantID, space, computer); err != nil {
		computerStatusError(w, err)
		return
	}
	cleanupCtx, cancel := context.WithTimeout(context.WithoutCancel(r.Context()), 10*time.Second)
	defer cancel()
	if err := h.finishAttachedComputerDeletion(cleanupCtx, p.TenantID, space, computer); err != nil {
		computerStatusError(w, err)
		return
	}
	httpx.JSON(w, 200, map[string]any{"ok": true})
}

// getSpaceComputer reports the computer new chats start on: always the Space
// server computer.
func (h *handler) getSpaceComputer(w http.ResponseWriter, r *http.Request) {
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
	server, err := h.resolveServerComputer(r.Context(), p.TenantID, space)
	if err != nil {
		computerStatusError(w, err)
		return
	}
	httpx.JSON(w, 200, map[string]any{"computerId": server.computer.ID, "serverComputerId": server.computer.ID})
}

// setSpaceComputer keeps the retired Space default route answering: null or the
// server computer is accepted unchanged, any other computer is a conflict.
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
	p := principal(r)
	space := chi.URLParam(r, "id")
	server, err := h.resolveServerComputer(r.Context(), p.TenantID, space)
	if err != nil {
		computerStatusError(w, err)
		return
	}
	if value != nil {
		if err = h.computerStore().SetSpaceDefault(r.Context(), p.TenantID, space, id); err != nil {
			computerStatusError(w, err)
			return
		}
	}
	httpx.JSON(w, 200, map[string]any{"computerId": server.computer.ID, "serverComputerId": server.computer.ID})
}
