// SPDX-License-Identifier: AGPL-3.0-or-later
package integrations

import (
	"context"
	"crypto/hmac"
	"crypto/rand"
	"crypto/sha256"
	"database/sql"
	"encoding/base64"
	"encoding/json"
	"errors"
	"net/http"
	"net/url"
	"strings"
	"time"

	"github.com/go-chi/chi/v5"
	"github.com/momo-mnsjtxy/Zakura/zakura-go-backend/internal/platform/appdeps"
	"github.com/momo-mnsjtxy/Zakura/zakura-go-backend/internal/platform/httpx"
	internalruntime "github.com/momo-mnsjtxy/Zakura/zakura-go-backend/internal/runtime"
)

type handler struct {
	deps           *appdeps.Dependencies
	client         *http.Client
	runtimeStore   *internalruntime.Store
	runtimeService *internalruntime.Service
}

func RegisterRoutes(r chi.Router, deps *appdeps.Dependencies) {
	h := &handler{deps: deps, client: &http.Client{Timeout: 60 * time.Second}}
	h.runtimeStore = internalruntime.NewStore(deps)
	h.runtimeService = internalruntime.NewService(h.runtimeStore)
	r.Post("/api/connectors/{ref}/events", h.webhook)
	r.Handle("/api/remote-channels/{tenantId}/{bindingId}/webhook", http.HandlerFunc(h.remoteWebhook))
	r.Post("/api/email/inbound/{tenantId}", h.emailInbound)
	r.Post("/api/email/inbound/{tenantId}/{connectorId}", h.emailInbound)
	r.Group(func(api chi.Router) {
		api.Use(httpx.Auth(deps))
		api.Use(internalruntime.RequireAPIScope)
		h.routes(api)
	})
	h.startDeliverer(deps.RunContext())
}
func (h *handler) routes(r chi.Router) {
	r.Get("/api/connectors", h.listConnectors)
	r.Get("/api/connectors/profiles", h.listProfiles)
	r.Put("/api/connectors/profiles/{profileKey}", h.putProfile)
	r.Delete("/api/connectors/profiles/{profileKey}", h.deleteProfile)
	r.Get("/api/connectors/shared-oauth", h.sharedOAuth)
	r.Post("/api/connectors/{ref}/oauth/start", h.oauthStart)
	r.Post("/api/connectors/{ref}/install", h.install)
	r.Delete("/api/connectors/{ref}/installations/{agentId}", h.uninstall)
	r.Get("/api/agents/{id}/connectors", h.listAgentConnectors)
	r.Put("/api/connectors/{id}/credentials", h.updateCredentials)
	r.Put("/api/connectors/{ref}/settings", h.putSettings)
	r.Post("/api/connectors/{ref}/send", h.send)
	r.Get("/api/connections", h.listConnections)
	r.Get("/api/connections/search", h.searchConnections)
	r.Get("/api/connections/sources", h.connectionSources)
	r.Get("/api/connections/packages", h.listPackages)
	r.Get("/api/connections/packages/{id}", h.getPackage)
	r.Post("/api/connections/packages/{id}/install", h.installPackage)
	r.Post("/api/connections/{id}/bind", h.bindConnection)
	r.Delete("/api/connections/{id}", h.deleteConnection)
	r.Post("/api/connections/{id}/start", h.startConnection)
	r.Post("/api/connections/{id}/stop", h.stopConnection)
	r.Post("/api/connections/install", h.installConnection)
	r.Post("/api/connections/sources", h.createConnectionSource)
	r.Delete("/api/connections/sources/{id}", h.deleteConnectionSource)
	r.Get("/api/providers", h.listProviderCatalog)
	h.registerChannels(r)
}
func (h *handler) q(q string) string {
	if h.deps.Rebind != nil {
		return h.deps.Rebind(q)
	}
	return q
}
func (h *handler) now() time.Time {
	if h.deps.Clock != nil {
		return h.deps.Clock().UTC()
	}
	return time.Now().UTC()
}
func (h *handler) id() string {
	if h.deps.NewID != nil {
		return h.deps.NewID()
	}
	b := make([]byte, 12)
	_, _ = rand.Read(b)
	return base64.RawURLEncoding.EncodeToString(b)
}
func principal(r *http.Request) httpx.Principal { p, _ := httpx.PrincipalFrom(r.Context()); return p }
func writeErr(w http.ResponseWriter, e error) {
	if errors.Is(e, sql.ErrNoRows) {
		httpx.Error(w, 404, "Not found")
	} else {
		httpx.Error(w, 400, e.Error())
	}
}
func validRef(ref string) bool { _, ok := provider(ref); return ok }

func (h *handler) listConnectors(w http.ResponseWriter, r *http.Request) {
	p := principal(r)
	rows, e := h.deps.DB.QueryContext(r.Context(), h.q(`SELECT connector_ref,enabled,created_at,updated_at FROM agent_connector_installations WHERE tenant_id=?`), p.TenantID)
	if e != nil {
		writeErr(w, e)
		return
	}
	defer rows.Close()
	installed := map[string]int{}
	for rows.Next() {
		var ref string
		var enabled bool
		var c, u string
		if rows.Scan(&ref, &enabled, &c, &u) == nil && enabled {
			installed[ref]++
		}
	}
	items := make([]map[string]any, 0, len(providers))
	for _, x := range providers {
		items = append(items, map[string]any{"ref": x.Ref, "name": x.Name, "description": x.Description, "category": x.Category, "capabilities": x.Capabilities, "authKind": x.AuthKind, "installedAgents": installed[x.Ref]})
	}
	httpx.JSON(w, 200, map[string]any{"connectors": items})
}
func (h *handler) listProfiles(w http.ResponseWriter, r *http.Request) {
	p := principal(r)
	rows, e := h.deps.DB.QueryContext(r.Context(), h.q(`SELECT id,profile_key,label,kind,enabled,config_enc,created_at,updated_at FROM connector_auth_profiles WHERE scope_key IN (?, 'platform') ORDER BY scope_key DESC,profile_key`), p.TenantID)
	if e != nil {
		writeErr(w, e)
		return
	}
	defer rows.Close()
	items := make([]map[string]any, 0)
	for rows.Next() {
		var id, key, label, kind, enc, c, u string
		var enabled bool
		if rows.Scan(&id, &key, &label, &kind, &enabled, &enc, &c, &u) != nil {
			continue
		}
		fields := []string{}
		if raw, e := decrypt(h.deps.Secret, p.TenantID+":"+key, enc); e == nil {
			var cfg map[string]any
			if json.Unmarshal(raw, &cfg) == nil {
				for k, v := range cfg {
					if v != nil && v != "" {
						fields = append(fields, k)
					}
				}
			}
		}
		items = append(items, map[string]any{"id": id, "profileKey": key, "label": label, "kind": kind, "enabled": enabled, "configuredFields": fields, "createdAt": c, "updatedAt": u})
	}
	httpx.JSON(w, 200, map[string]any{"profiles": items})
}
func (h *handler) putProfile(w http.ResponseWriter, r *http.Request) {
	p := principal(r)
	key := chi.URLParam(r, "profileKey")
	var b struct {
		Label, Kind string
		Enabled     *bool           `json:"enabled"`
		Config      json.RawMessage `json:"config"`
	}
	if httpx.DecodeJSON(r, &b) != nil || key == "" || b.Kind == "" {
		httpx.Error(w, 400, "kind required")
		return
	}
	enabled := true
	if b.Enabled != nil {
		enabled = *b.Enabled
	}
	if len(b.Config) == 0 {
		b.Config = json.RawMessage(`{}`)
	}
	enc, e := encrypt(h.deps.Secret, p.TenantID+":"+key, b.Config)
	if e != nil {
		writeErr(w, e)
		return
	}
	now := h.now()
	_, e = h.deps.DB.ExecContext(r.Context(), h.q(`INSERT INTO connector_auth_profiles(id,scope_key,profile_key,label,kind,enabled,config_enc,created_at,updated_at) VALUES(?,?,?,?,?,?,?,?,?) ON CONFLICT(scope_key,profile_key) DO UPDATE SET label=?,kind=?,enabled=?,config_enc=?,updated_at=?`), h.id(), p.TenantID, key, b.Label, b.Kind, enabled, enc, now, now, b.Label, b.Kind, enabled, enc, now)
	if e != nil {
		writeErr(w, e)
		return
	}
	httpx.JSON(w, 200, map[string]any{"profile": map[string]any{"profileKey": key, "label": b.Label, "kind": b.Kind, "enabled": enabled}})
}
func (h *handler) deleteProfile(w http.ResponseWriter, r *http.Request) {
	p := principal(r)
	res, e := h.deps.DB.ExecContext(r.Context(), h.q(`DELETE FROM connector_auth_profiles WHERE scope_key=? AND profile_key=?`), p.TenantID, chi.URLParam(r, "profileKey"))
	if e != nil {
		writeErr(w, e)
		return
	}
	n, _ := res.RowsAffected()
	if n == 0 {
		httpx.Error(w, 404, "Not found")
		return
	}
	httpx.JSON(w, 200, map[string]any{"ok": true})
}
func (h *handler) sharedOAuth(w http.ResponseWriter, r *http.Request) {
	rows, e := h.deps.DB.QueryContext(r.Context(), h.q(`SELECT profile_key,label,kind,enabled FROM connector_auth_profiles WHERE scope_key='platform' AND enabled=true ORDER BY profile_key`))
	if e != nil {
		writeErr(w, e)
		return
	}
	defer rows.Close()
	items := make([]map[string]any, 0)
	for rows.Next() {
		var key, label, kind string
		var enabled bool
		if rows.Scan(&key, &label, &kind, &enabled) == nil {
			items = append(items, map[string]any{"profileKey": key, "label": label, "kind": kind, "enabled": enabled})
		}
	}
	httpx.JSON(w, 200, map[string]any{"profiles": items})
}
func (h *handler) profileConfig(ctx context.Context, tenant, key string) (map[string]any, error) {
	var scope, enc string
	e := h.deps.DB.QueryRowContext(ctx, h.q(`SELECT scope_key,config_enc FROM connector_auth_profiles WHERE scope_key IN (?, 'platform') AND profile_key=? AND enabled=true ORDER BY CASE WHEN scope_key=? THEN 0 ELSE 1 END LIMIT 1`), tenant, key, tenant).Scan(&scope, &enc)
	if e != nil {
		return nil, e
	}
	raw, e := decrypt(h.deps.Secret, scope+":"+key, enc)
	if e != nil {
		return nil, e
	}
	var cfg map[string]any
	e = json.Unmarshal(raw, &cfg)
	return cfg, e
}
func (h *handler) oauthStart(w http.ResponseWriter, r *http.Request) {
	p := principal(r)
	ref := chi.URLParam(r, "ref")
	if !validRef(ref) {
		httpx.Error(w, 404, "Unknown connector")
		return
	}
	var b struct{ ProfileKey, AgentID, RedirectURI string }
	if httpx.DecodeJSON(r, &b) != nil || b.ProfileKey == "" {
		httpx.Error(w, 400, "profileKey required")
		return
	}
	cfg, e := h.profileConfig(r.Context(), p.TenantID, b.ProfileKey)
	if e != nil {
		writeErr(w, e)
		return
	}
	authURL, _ := cfg["authorizationUrl"].(string)
	clientID, _ := cfg["clientId"].(string)
	if authURL == "" || clientID == "" {
		httpx.Error(w, 400, "OAuth profile is incomplete")
		return
	}
	statePayload, _ := json.Marshal(map[string]any{"tenantId": p.TenantID, "userId": p.UserID, "agentId": b.AgentID, "ref": ref, "profileKey": b.ProfileKey, "exp": h.now().Add(10 * time.Minute).Unix()})
	sig := hmac.New(sha256.New, h.deps.Secret)
	sig.Write(statePayload)
	state := base64.RawURLEncoding.EncodeToString(statePayload) + "." + base64.RawURLEncoding.EncodeToString(sig.Sum(nil))
	u, e := url.Parse(authURL)
	if e != nil {
		writeErr(w, e)
		return
	}
	q := u.Query()
	q.Set("client_id", clientID)
	q.Set("response_type", "code")
	q.Set("state", state)
	q.Set("redirect_uri", b.RedirectURI)
	if scopes, ok := cfg["scopes"].([]any); ok {
		vals := make([]string, 0, len(scopes))
		for _, v := range scopes {
			if x, ok := v.(string); ok {
				vals = append(vals, x)
			}
		}
		q.Set("scope", strings.Join(vals, " "))
	}
	u.RawQuery = q.Encode()
	httpx.JSON(w, 200, map[string]any{"authorizeUrl": u.String(), "state": state, "expiresAt": h.now().Add(10 * time.Minute)})
}
func (h *handler) install(w http.ResponseWriter, r *http.Request) {
	p := principal(r)
	ref := chi.URLParam(r, "ref")
	if !validRef(ref) {
		httpx.Error(w, 404, "Unknown connector")
		return
	}
	var b struct {
		AgentID    string          `json:"agentId"`
		ProfileKey string          `json:"profileKey"`
		Config     json.RawMessage `json:"config"`
		Enabled    *bool           `json:"enabled"`
	}
	if httpx.DecodeJSON(r, &b) != nil || b.AgentID == "" {
		httpx.Error(w, 400, "agentId required")
		return
	}
	var count int
	if e := h.deps.DB.QueryRowContext(r.Context(), h.q(`SELECT COUNT(*) FROM agents WHERE tenant_id=? AND id=?`), p.TenantID, b.AgentID).Scan(&count); e != nil || count == 0 {
		httpx.Error(w, 404, "Agent not found")
		return
	}
	data := map[string]any{"profileKey": b.ProfileKey, "config": json.RawMessage(b.Config)}
	raw, _ := json.Marshal(data)
	enc, e := encrypt(h.deps.Secret, p.TenantID+":"+b.AgentID+":"+ref, raw)
	if e != nil {
		writeErr(w, e)
		return
	}
	enabled := true
	if b.Enabled != nil {
		enabled = *b.Enabled
	}
	now := h.now()
	_, e = h.deps.DB.ExecContext(r.Context(), h.q(`INSERT INTO agent_connector_installations(id,tenant_id,agent_id,connector_ref,enabled,config_enc,created_at,updated_at) VALUES(?,?,?,?,?,?,?,?) ON CONFLICT(agent_id,connector_ref) DO UPDATE SET enabled=?,config_enc=?,updated_at=?`), h.id(), p.TenantID, b.AgentID, ref, enabled, enc, now, now, enabled, enc, now)
	if e != nil {
		writeErr(w, e)
		return
	}
	httpx.JSON(w, 201, map[string]any{"installation": map[string]any{"agentId": b.AgentID, "connectorRef": ref, "enabled": enabled}})
}
func (h *handler) uninstall(w http.ResponseWriter, r *http.Request) {
	p := principal(r)
	res, e := h.deps.DB.ExecContext(r.Context(), h.q(`DELETE FROM agent_connector_installations WHERE tenant_id=? AND agent_id=? AND connector_ref=?`), p.TenantID, chi.URLParam(r, "agentId"), chi.URLParam(r, "ref"))
	if e != nil {
		writeErr(w, e)
		return
	}
	n, _ := res.RowsAffected()
	if n == 0 {
		httpx.Error(w, 404, "Not found")
		return
	}
	httpx.JSON(w, 200, map[string]any{"ok": true})
}
func (h *handler) listAgentConnectors(w http.ResponseWriter, r *http.Request) {
	p := principal(r)
	rows, e := h.deps.DB.QueryContext(r.Context(), h.q(`SELECT id,connector_ref,enabled,created_at,updated_at FROM agent_connector_installations WHERE tenant_id=? AND agent_id=? ORDER BY connector_ref`), p.TenantID, chi.URLParam(r, "id"))
	if e != nil {
		writeErr(w, e)
		return
	}
	defer rows.Close()
	items := make([]map[string]any, 0)
	for rows.Next() {
		var id, ref, c, u string
		var enabled bool
		if rows.Scan(&id, &ref, &enabled, &c, &u) == nil {
			pr, _ := provider(ref)
			items = append(items, map[string]any{"id": id, "ref": ref, "name": pr.Name, "enabled": enabled, "createdAt": c, "updatedAt": u})
		}
	}
	httpx.JSON(w, 200, map[string]any{"connectors": items})
}
func (h *handler) updateCredentials(w http.ResponseWriter, r *http.Request) {
	p := principal(r)
	id := chi.URLParam(r, "id")
	var b struct {
		Config json.RawMessage `json:"config"`
	}
	if httpx.DecodeJSON(r, &b) != nil {
		httpx.Error(w, 400, "invalid JSON")
		return
	}
	var agent, ref string
	e := h.deps.DB.QueryRowContext(r.Context(), h.q(`SELECT agent_id,connector_ref FROM agent_connector_installations WHERE tenant_id=? AND id=?`), p.TenantID, id).Scan(&agent, &ref)
	if e != nil {
		writeErr(w, e)
		return
	}
	enc, e := encrypt(h.deps.Secret, p.TenantID+":"+agent+":"+ref, b.Config)
	if e == nil {
		_, e = h.deps.DB.ExecContext(r.Context(), h.q(`UPDATE agent_connector_installations SET config_enc=?,updated_at=? WHERE tenant_id=? AND id=?`), enc, h.now(), p.TenantID, id)
	}
	if e != nil {
		writeErr(w, e)
		return
	}
	httpx.JSON(w, 200, map[string]any{"ok": true})
}
func (h *handler) putSettings(w http.ResponseWriter, r *http.Request) {
	p := principal(r)
	ref := chi.URLParam(r, "ref")
	if !validRef(ref) {
		httpx.Error(w, 404, "Unknown connector")
		return
	}
	var b json.RawMessage
	if json.NewDecoder(http.MaxBytesReader(w, r.Body, 2<<20)).Decode(&b) != nil || !json.Valid(b) {
		httpx.Error(w, 400, "invalid JSON")
		return
	}
	enc, e := encrypt(h.deps.Secret, p.TenantID+":"+ref, b)
	if e != nil {
		writeErr(w, e)
		return
	}
	now := h.now()
	_, e = h.deps.DB.ExecContext(r.Context(), h.q(`INSERT INTO connector_settings(id,scope_key,connector_ref,config_enc,created_at,updated_at) VALUES(?,?,?,?,?,?) ON CONFLICT(scope_key,connector_ref) DO UPDATE SET config_enc=?,updated_at=?`), h.id(), p.TenantID, ref, enc, now, now, enc, now)
	if e != nil {
		writeErr(w, e)
		return
	}
	httpx.JSON(w, 200, map[string]any{"ok": true})
}
