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

	"github.com/Moonrend/Zakura/apps/server/internal/platform/appdeps"
	"github.com/Moonrend/Zakura/apps/server/internal/platform/db/models"
	"github.com/Moonrend/Zakura/apps/server/internal/platform/httpx"
	internalruntime "github.com/Moonrend/Zakura/apps/server/internal/runtime"
	"github.com/go-chi/chi/v5"
	"gorm.io/gorm"
	"gorm.io/gorm/clause"
)

func strPtr(v string) *string { return &v }

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
	if errors.Is(e, sql.ErrNoRows) || errors.Is(e, gorm.ErrRecordNotFound) {
		httpx.Error(w, 404, "Not found")
	} else {
		httpx.Error(w, 400, e.Error())
	}
}
func validRef(ref string) bool { _, ok := provider(ref); return ok }

func (h *handler) listConnectors(w http.ResponseWriter, r *http.Request) {
	p := principal(r)
	var installs []models.AgentConnectorInstallation
	if e := h.deps.Gorm.WithContext(r.Context()).Where("tenant_id = ?", p.TenantID).Find(&installs).Error; e != nil {
		writeErr(w, e)
		return
	}
	installed := map[string]int{}
	for _, row := range installs {
		if row.Enabled {
			installed[row.ConnectorRef]++
		}
	}
	type profileState struct {
		scope   string
		label   string
		fields  []string
		enabled bool
	}
	profiles := map[string]profileState{}
	var prows []models.ConnectorAuthProfile
	if e := h.deps.Gorm.WithContext(r.Context()).
		Where("scope_key IN ?", []string{p.TenantID, "platform"}).
		Order(clause.OrderBy{Expression: clause.Expr{SQL: "CASE WHEN scope_key = ? THEN 0 ELSE 1 END", Vars: []any{p.TenantID}}}).
		Find(&prows).Error; e == nil {
		for _, row := range prows {
			if _, exists := profiles[row.ProfileKey]; exists {
				continue
			}
			fields := []string{}
			if raw, de := decrypt(h.deps.Secret, row.ScopeKey+":"+row.ProfileKey, row.ConfigEnc); de == nil {
				var cfg map[string]any
				if json.Unmarshal(raw, &cfg) == nil {
					for k, v := range cfg {
						if v != nil && v != "" {
							fields = append(fields, k)
						}
					}
				}
			}
			profiles[row.ProfileKey] = profileState{scope: row.ScopeKey, label: row.Label, fields: fields, enabled: row.Enabled}
		}
	}
	items := make([]map[string]any, 0, len(providers))
	for _, x := range providers {
		st, ok := profiles[x.Auth.Profile]
		fields := []string{}
		profileLabel := x.Auth.ProfileLabel
		if profileLabel == "" {
			profileLabel = x.Name
		}
		profileEnabled, ready := false, false
		var credentialSource any
		if ok {
			fields = st.fields
			if st.label != "" {
				profileLabel = st.label
			}
			profileEnabled = st.enabled
			ready = st.enabled
			if st.scope == p.TenantID {
				credentialSource = "tenant"
			}
		}
		status := "not_configured"
		if ready {
			status = "ready"
		}
		items = append(items, map[string]any{
			"id": x.Ref, "ref": x.Ref, "name": x.Name, "description": x.Description,
			"package": map[string]any{"slug": x.Package.Slug, "name": x.Package.Name, "icon": x.Package.Icon, "accent": x.Package.Accent, "homepage": x.Package.Homepage},
			"auth":    map[string]any{"kind": x.Auth.Kind, "profile": x.Auth.Profile, "profileLabel": x.Auth.ProfileLabel, "docsUrl": x.Auth.DocsURL, "fields": x.Auth.Fields},
			"status":  status, "ready": ready, "enabled": ready,
			"lockedByPlatform":   false,
			"profile":            map[string]any{"key": x.Auth.Profile, "label": profileLabel, "shared": false, "connectorRefs": []string{x.Ref}, "configuredFields": fields, "enabled": profileEnabled},
			"credentialSource":   credentialSource,
			"configuredFields":   fields,
			"configuredSettings": []any{},
			"authorized":         false, "installations": []any{},
			"docsUrl": x.Auth.DocsURL, "hasTools": false, "capabilities": []any{},
			"authKind": x.AuthKind, "installedAgents": installed[x.Ref],
		})
	}
	httpx.JSON(w, 200, map[string]any{"connectors": items})
}
func (h *handler) listProfiles(w http.ResponseWriter, r *http.Request) {
	p := principal(r)
	var rows []models.ConnectorAuthProfile
	if e := h.deps.Gorm.WithContext(r.Context()).
		Where("scope_key IN ?", []string{p.TenantID, "platform"}).
		Order("scope_key DESC,profile_key").
		Find(&rows).Error; e != nil {
		writeErr(w, e)
		return
	}
	items := make([]map[string]any, 0)
	for _, row := range rows {
		fields := []string{}
		if raw, e := decrypt(h.deps.Secret, p.TenantID+":"+row.ProfileKey, row.ConfigEnc); e == nil {
			var cfg map[string]any
			if json.Unmarshal(raw, &cfg) == nil {
				for k, v := range cfg {
					if v != nil && v != "" {
						fields = append(fields, k)
					}
				}
			}
		}
		items = append(items, map[string]any{"id": *row.ID, "profileKey": row.ProfileKey, "label": row.Label, "kind": row.Kind, "enabled": row.Enabled, "configuredFields": fields, "createdAt": row.CreatedAt, "updatedAt": row.UpdatedAt})
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
	now := h.now().Format(time.RFC3339Nano)
	row := models.ConnectorAuthProfile{ID: strPtr(h.id()), ScopeKey: p.TenantID, ProfileKey: key, Label: b.Label, Kind: b.Kind, Enabled: enabled, ConfigEnc: enc, CreatedAt: now, UpdatedAt: now}
	e = h.deps.Gorm.WithContext(r.Context()).Clauses(clause.OnConflict{
		Columns:   []clause.Column{{Name: "scope_key"}, {Name: "profile_key"}},
		DoUpdates: clause.AssignmentColumns([]string{"label", "kind", "enabled", "config_enc", "updated_at"}),
	}).Create(&row).Error
	if e != nil {
		writeErr(w, e)
		return
	}
	httpx.JSON(w, 200, map[string]any{"profile": map[string]any{"profileKey": key, "label": b.Label, "kind": b.Kind, "enabled": enabled}})
}
func (h *handler) deleteProfile(w http.ResponseWriter, r *http.Request) {
	p := principal(r)
	res := h.deps.Gorm.WithContext(r.Context()).Where("scope_key = ? AND profile_key = ?", p.TenantID, chi.URLParam(r, "profileKey")).Delete(&models.ConnectorAuthProfile{})
	if res.Error != nil {
		writeErr(w, res.Error)
		return
	}
	if res.RowsAffected == 0 {
		httpx.Error(w, 404, "Not found")
		return
	}
	httpx.JSON(w, 200, map[string]any{"ok": true})
}
func (h *handler) sharedOAuth(w http.ResponseWriter, r *http.Request) {
	var rows []models.ConnectorAuthProfile
	if e := h.deps.Gorm.WithContext(r.Context()).Where("scope_key = ? AND enabled = true", "platform").Order("profile_key").Find(&rows).Error; e != nil {
		writeErr(w, e)
		return
	}
	items := make([]map[string]any, 0)
	for _, row := range rows {
		items = append(items, map[string]any{"profileKey": row.ProfileKey, "label": row.Label, "kind": row.Kind, "enabled": row.Enabled})
	}
	httpx.JSON(w, 200, map[string]any{"profiles": items})
}
func (h *handler) profileConfig(ctx context.Context, tenant, key string) (map[string]any, error) {
	var row models.ConnectorAuthProfile
	e := h.deps.Gorm.WithContext(ctx).
		Where("scope_key IN ? AND profile_key = ? AND enabled = true", []string{tenant, "platform"}, key).
		Order(clause.OrderBy{Expression: clause.Expr{SQL: "CASE WHEN scope_key = ? THEN 0 ELSE 1 END", Vars: []any{tenant}}}).
		First(&row).Error
	if e != nil {
		return nil, e
	}
	raw, e := decrypt(h.deps.Secret, row.ScopeKey+":"+key, row.ConfigEnc)
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
	var count int64
	if e := h.deps.Gorm.WithContext(r.Context()).Model(&models.Agent{}).Where("tenant_id = ? AND id = ?", p.TenantID, b.AgentID).Count(&count).Error; e != nil || count == 0 {
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
	now := h.now().Format(time.RFC3339Nano)
	row := models.AgentConnectorInstallation{ID: strPtr(h.id()), TenantID: p.TenantID, AgentID: b.AgentID, ConnectorRef: ref, Enabled: enabled, ConfigEnc: enc, CreatedAt: now, UpdatedAt: now}
	e = h.deps.Gorm.WithContext(r.Context()).Clauses(clause.OnConflict{
		Columns:   []clause.Column{{Name: "agent_id"}, {Name: "connector_ref"}},
		DoUpdates: clause.AssignmentColumns([]string{"enabled", "config_enc", "updated_at"}),
	}).Create(&row).Error
	if e != nil {
		writeErr(w, e)
		return
	}
	httpx.JSON(w, 201, map[string]any{"installation": map[string]any{"agentId": b.AgentID, "connectorRef": ref, "enabled": enabled}})
}
func (h *handler) uninstall(w http.ResponseWriter, r *http.Request) {
	p := principal(r)
	res := h.deps.Gorm.WithContext(r.Context()).Where("tenant_id = ? AND agent_id = ? AND connector_ref = ?", p.TenantID, chi.URLParam(r, "agentId"), chi.URLParam(r, "ref")).Delete(&models.AgentConnectorInstallation{})
	if res.Error != nil {
		writeErr(w, res.Error)
		return
	}
	if res.RowsAffected == 0 {
		httpx.Error(w, 404, "Not found")
		return
	}
	httpx.JSON(w, 200, map[string]any{"ok": true})
}
func (h *handler) listAgentConnectors(w http.ResponseWriter, r *http.Request) {
	p := principal(r)
	var rows []models.AgentConnectorInstallation
	if e := h.deps.Gorm.WithContext(r.Context()).Where("tenant_id = ? AND agent_id = ?", p.TenantID, chi.URLParam(r, "id")).Order("connector_ref").Find(&rows).Error; e != nil {
		writeErr(w, e)
		return
	}
	items := make([]map[string]any, 0)
	for _, row := range rows {
		pr, _ := provider(row.ConnectorRef)
		items = append(items, map[string]any{"id": *row.ID, "ref": row.ConnectorRef, "name": pr.Name, "enabled": row.Enabled, "createdAt": row.CreatedAt, "updatedAt": row.UpdatedAt})
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
	var row models.AgentConnectorInstallation
	e := h.deps.Gorm.WithContext(r.Context()).Where("tenant_id = ? AND id = ?", p.TenantID, id).First(&row).Error
	if e != nil {
		writeErr(w, e)
		return
	}
	enc, e := encrypt(h.deps.Secret, p.TenantID+":"+row.AgentID+":"+row.ConnectorRef, b.Config)
	if e == nil {
		e = h.deps.Gorm.WithContext(r.Context()).Model(&models.AgentConnectorInstallation{}).
			Where("tenant_id = ? AND id = ?", p.TenantID, id).
			Updates(map[string]any{"config_enc": enc, "updated_at": h.now().Format(time.RFC3339Nano)}).Error
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
	now := h.now().Format(time.RFC3339Nano)
	row := models.ConnectorSetting{ID: strPtr(h.id()), ScopeKey: p.TenantID, ConnectorRef: ref, ConfigEnc: enc, CreatedAt: now, UpdatedAt: now}
	e = h.deps.Gorm.WithContext(r.Context()).Clauses(clause.OnConflict{
		Columns:   []clause.Column{{Name: "scope_key"}, {Name: "connector_ref"}},
		DoUpdates: clause.AssignmentColumns([]string{"config_enc", "updated_at"}),
	}).Create(&row).Error
	if e != nil {
		writeErr(w, e)
		return
	}
	httpx.JSON(w, 200, map[string]any{"ok": true})
}
