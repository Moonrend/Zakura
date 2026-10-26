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

// Only management callers may read editable settings. Credentials remain
// write-only; an empty secret in a partial update preserves the stored value.
func (h *handler) computerConfiguration(w http.ResponseWriter, r *http.Request) {
	if !h.manageComputerScope(w, r) {
		return
	}
	c, config, _, err := h.readComputerConfiguration(r)
	if err != nil {
		computerStatusError(w, err)
		return
	}
	public := map[string]string{}
	for _, key := range []string{"host", "user", "port", "hostKeyFingerprint", "template"} {
		if value, ok := config[key]; ok {
			public[key] = value
		}
	}
	httpx.JSON(w, 200, map[string]any{"computer": c, "config": public})
}

func computerSecretField(key string) bool {
	return key == "apiKey" || key == "privateKey" || key == "envdAccessToken"
}

func (h *handler) readComputerConfiguration(r *http.Request) (computers.Computer, map[string]string, string, error) {
	p := principal(r)
	c := computers.Computer{TenantID: p.TenantID, SpaceID: chi.URLParam(r, "id"), ID: chi.URLParam(r, "cid")}
	var sealed, caps string
	// Read the editable fields and their envelope together. Otherwise another
	// edit between two reads could pair stale policy with its newer CAS token.
	err := h.deps.DB.QueryRowContext(r.Context(), h.deps.Rebind(`SELECT name,provider,role,COALESCE(runtime_node_id,''),capabilities_json,idle_seconds,max_lifetime_seconds,COALESCE(secret_ref,'') FROM computers WHERE tenant_id=? AND space_id=? AND id=?`), c.TenantID, c.SpaceID, c.ID).Scan(&c.Name, &c.Provider, &c.Role, &c.RuntimeNodeID, &caps, &c.IdleSeconds, &c.MaxLifetimeSeconds, &sealed)
	if err != nil {
		return c, nil, "", err
	}
	if c.IsServer() {
		return c, nil, "", computers.ErrServerComputerManaged
	}
	if err = json.Unmarshal([]byte(caps), &c.Capabilities); err != nil {
		return c, nil, "", err
	}
	if c.Capabilities == nil {
		c.Capabilities = []computers.Capability{}
	}
	config := map[string]string{}
	if sealed != "" {
		plain, err := computers.OpenCredentials(h.deps.Secret, c.TenantID, c.SpaceID, c.ID, sealed)
		if err != nil {
			return c, nil, "", err
		}
		if err = json.Unmarshal(plain, &config); err != nil {
			return c, nil, "", err
		}
	}
	if config == nil {
		config = map[string]string{}
	}
	return c, config, sealed, nil
}

func (h *handler) updateComputer(w http.ResponseWriter, r *http.Request) {
	if !h.manageComputerScope(w, r) {
		return
	}
	var in struct {
		Name               *string           `json:"name"`
		RuntimeNodeID      *string           `json:"runtimeNodeId"`
		IdleSeconds        *int              `json:"idleSeconds"`
		MaxLifetimeSeconds *int              `json:"maxLifetimeSeconds"`
		Config             map[string]string `json:"config"`
	}
	r.Body = http.MaxBytesReader(w, r.Body, 64<<10)
	dec := json.NewDecoder(r.Body)
	dec.DisallowUnknownFields()
	if dec.Decode(&in) != nil || dec.Decode(new(any)) != io.EOF {
		httpx.Error(w, 400, "invalid computer configuration")
		return
	}
	if in.Name != nil && in.RuntimeNodeID == nil && in.IdleSeconds == nil && in.MaxLifetimeSeconds == nil && in.Config == nil {
		if strings.TrimSpace(*in.Name) == "" || len(strings.TrimSpace(*in.Name)) > 200 {
			httpx.Error(w, 400, "invalid computer name")
			return
		}
		if err := h.computerStore().Rename(r.Context(), principal(r).TenantID, chi.URLParam(r, "id"), chi.URLParam(r, "cid"), *in.Name); err != nil {
			computerStatusError(w, err)
			return
		}
		httpx.JSON(w, 200, map[string]any{"name": strings.TrimSpace(*in.Name)})
		return
	}
	c, config, previous, err := h.readComputerConfiguration(r)
	if err != nil {
		computerStatusError(w, err)
		return
	}
	if in.Name != nil {
		c.Name = strings.TrimSpace(*in.Name)
		if c.Name == "" || len(c.Name) > 200 {
			httpx.Error(w, 400, "invalid computer name")
			return
		}
	}
	if in.IdleSeconds != nil {
		c.IdleSeconds = *in.IdleSeconds
	}
	if in.MaxLifetimeSeconds != nil {
		c.MaxLifetimeSeconds = *in.MaxLifetimeSeconds
	}
	routeChanged := false
	if in.RuntimeNodeID != nil && *in.RuntimeNodeID != c.RuntimeNodeID {
		if c.Provider != computers.RemoteAgent && c.Provider != computers.Temporary {
			httpx.Error(w, 400, "provider does not accept a runtime node")
			return
		}
		c.RuntimeNodeID = *in.RuntimeNodeID
		if err := h.authorizeLocalNode(r.Context(), principal(r), c.RuntimeNodeID); err != nil {
			statusErr(w, err)
			return
		}
		var kind string
		if err = h.deps.DB.QueryRowContext(r.Context(), h.deps.Rebind(`SELECT kind FROM runtime_nodes WHERE id=? AND (tenant_id=? OR is_shared=TRUE)`), c.RuntimeNodeID, c.TenantID).Scan(&kind); err != nil {
			httpx.Error(w, 400, "runtime node is unavailable")
			return
		}
		if c.Provider == computers.Temporary && kind != "server" && kind != "computer" && kind != "local" {
			httpx.Error(w, 400, "a server or computer node is required")
			return
		}
		routeChanged = true
	}
	for key, value := range in.Config {
		if computerSecretField(key) && strings.TrimSpace(value) == "" {
			continue
		}
		if config[key] != value && (key == "apiKey" || c.Provider == computers.SSH || c.Provider == computers.Railway) {
			routeChanged = true
		}
		config[key] = value
	}
	if err = c.Validate(); err != nil {
		httpx.Error(w, 400, err.Error())
		return
	}
	if err = computers.ValidateConfiguration(c.Provider, config); err != nil {
		httpx.Error(w, 400, err.Error())
		return
	}
	raw, err := json.Marshal(config)
	if err != nil {
		statusErr(w, err)
		return
	}
	sealed, err := computers.SealCredentials(h.deps.Secret, c.TenantID, c.SpaceID, c.ID, raw)
	if err == nil {
		err = h.computerStore().UpdateConfiguration(r.Context(), c, previous, sealed, routeChanged)
	}
	if err != nil {
		computerStatusError(w, err)
		return
	}
	httpx.JSON(w, 200, c)
}
