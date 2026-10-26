// SPDX-License-Identifier: AGPL-3.0-or-later
package integrations

import (
	"bytes"
	"context"
	"crypto/hmac"
	"crypto/sha256"
	"encoding/hex"
	"encoding/json"
	"errors"
	"fmt"
	"io"
	"net"
	"net/http"
	"net/url"
	"strings"
	"time"

	"github.com/Moonrend/Zakura/apps/server/internal/platform/db/models"
	"github.com/Moonrend/Zakura/apps/server/internal/platform/httpx"
	internalruntime "github.com/Moonrend/Zakura/apps/server/internal/runtime"
	"github.com/go-chi/chi/v5"
	"gorm.io/gorm"
	"gorm.io/gorm/clause"
)

func merge(dst map[string]any, src map[string]any) {
	for k, v := range src {
		dst[k] = v
	}
}
func (h *handler) installationConfig(ctx context.Context, tenant, agent, ref string) (map[string]any, error) {
	var owner models.Agent
	if e := h.deps.Gorm.WithContext(ctx).Where("tenant_id = ? AND id = ?", tenant, agent).First(&owner).Error; e != nil {
		return nil, e
	}
	if e := h.migrateSpaceConnectors(ctx, tenant, owner.SpaceID); e != nil {
		return nil, e
	}
	return h.spaceInstallationConfig(ctx, tenant, owner.SpaceID, ref)
}
func (h *handler) spaceInstallationConfig(ctx context.Context, tenant, space, ref string) (map[string]any, error) {
	var row spaceConnectorInstallation
	if e := h.deps.Gorm.WithContext(ctx).Where("tenant_id = ? AND space_id = ? AND connector_ref = ? AND enabled = ?", tenant, space, canonicalRef(ref), true).First(&row).Error; e != nil {
		return nil, e
	}
	cfg, e := h.spaceEnvelope(row)
	if e != nil {
		return nil, e
	}
	out := map[string]any{}
	if cfg.ProfileKey != "" {
		profile, e := h.profileConfig(ctx, tenant, cfg.ProfileKey)
		if e != nil {
			return nil, e
		}
		merge(out, profile)
	}
	merge(out, cfg.Config)
	merge(out, cfg.Settings)
	return out, nil
}
func safeURL(raw string) (string, error) {
	u, e := url.Parse(raw)
	if e != nil || u.Host == "" || (u.Scheme != "http" && u.Scheme != "https") || u.User != nil {
		return "", errors.New("invalid http(s) endpoint")
	}
	if ip := net.ParseIP(strings.Trim(u.Hostname(), "[]")); ip != nil && (ip.IsUnspecified() || ip.IsMulticast() || ip.IsLinkLocalUnicast() || ip.IsLinkLocalMulticast()) {
		return "", errors.New("unsafe endpoint")
	}
	return u.String(), nil
}

func (h *handler) send(w http.ResponseWriter, r *http.Request) {
	p := principal(r)
	ref := chi.URLParam(r, "ref")
	if !validRef(ref) {
		httpx.Error(w, 404, "Unknown connector")
		return
	}
	var b struct {
		AgentID string          `json:"agentId"`
		Action  string          `json:"action"`
		Payload json.RawMessage `json:"payload"`
	}
	if httpx.DecodeJSON(r, &b) != nil || b.AgentID == "" || b.Action == "" {
		httpx.Error(w, 400, "agentId and action required")
		return
	}
	if _, e := h.resourceSpace(r, "", b.AgentID); e != nil {
		writeErr(w, e)
		return
	}
	status, result, e := h.callProvider(r.Context(), p.TenantID, b.AgentID, ref, b.Action, b.Payload)
	if e != nil {
		writeErr(w, e)
		return
	}
	httpx.JSON(w, 200, map[string]any{"status": status, "result": result})
}
func (h *handler) callProvider(ctx context.Context, tenant, agent, ref, action string, payload json.RawMessage) (int, json.RawMessage, error) {
	cfg, e := h.installationConfig(ctx, tenant, agent, ref)
	if e != nil {
		return 0, nil, e
	}
	base, _ := cfg["baseUrl"].(string)
	token, _ := cfg["accessToken"].(string)
	if token == "" {
		token, _ = cfg["token"].(string)
	}
	pathValue, _ := cfg["path"].(string)
	switch ref {
	case "slack":
		if base == "" {
			base = "https://slack.com"
		}
		if pathValue == "" {
			pathValue = "/api/" + action
		}
	case "github":
		if base == "" {
			base = "https://api.github.com"
		}
	case "gitlab":
		if base == "" {
			base = "https://gitlab.com/api/v4"
		}
	case "linear":
		if base == "" {
			base = "https://api.linear.app"
		}
		if pathValue == "" {
			pathValue = "/graphql"
		}
	case "notion":
		if base == "" {
			base = "https://api.notion.com"
		}
	case "google-workspace":
		if base == "" {
			base = "https://www.googleapis.com"
		}
	case "microsoft-365":
		if base == "" {
			base = "https://graph.microsoft.com/v1.0"
		}
	case "discord":
		if base == "" {
			base = "https://discord.com/api/v10"
		}
	case "jira":
		if base == "" {
			return 0, nil, errors.New("Jira baseUrl required")
		}
	case "feishu":
		if base == "" {
			base = "https://open.feishu.cn/open-apis"
		}
	case "email", "email-smtp", "email-mailgun", "email-resendapi", "email-amail", "email-bettermail":
		return 0, nil, errors.New("email delivery requires the SMTP channel service")
	}
	if explicit, _ := cfg["actionPath"].(map[string]any); explicit != nil {
		if v, ok := explicit[action].(string); ok {
			pathValue = v
		}
	}
	if pathValue == "" {
		pathValue = "/" + strings.TrimPrefix(action, "/")
	}
	target, e := safeURL(strings.TrimRight(base, "/") + "/" + strings.TrimLeft(pathValue, "/"))
	if e != nil {
		return 0, nil, e
	}
	var last error
	for attempt := 0; attempt < 3; attempt++ {
		req, e := http.NewRequestWithContext(ctx, http.MethodPost, target, bytes.NewReader(payload))
		if e != nil {
			return 0, nil, e
		}
		req.Header.Set("Content-Type", "application/json")
		req.Header.Set("Accept", "application/json")
		if token != "" {
			req.Header.Set("Authorization", "Bearer "+token)
		}
		if ref == "github" {
			req.Header.Set("X-GitHub-Api-Version", "2022-11-28")
		}
		if ref == "notion" {
			req.Header.Set("Notion-Version", "2022-06-28")
		}
		resp, e := h.client.Do(req)
		if e != nil {
			last = e
			if ctx.Err() != nil {
				return 0, nil, ctx.Err()
			}
			continue
		}
		raw, e := io.ReadAll(io.LimitReader(resp.Body, 16<<20))
		resp.Body.Close()
		if e != nil {
			return 0, nil, e
		}
		if (resp.StatusCode == 429 || resp.StatusCode >= 500) && attempt < 2 {
			select {
			case <-ctx.Done():
				return 0, nil, ctx.Err()
			case <-time.After(time.Duration(attempt+1) * 100 * time.Millisecond):
			}
			continue
		}
		if resp.StatusCode < 200 || resp.StatusCode >= 300 {
			return resp.StatusCode, raw, fmt.Errorf("%s status %d: %s", ref, resp.StatusCode, string(raw))
		}
		return resp.StatusCode, raw, nil
	}
	return 0, nil, last
}

func (h *handler) webhook(w http.ResponseWriter, r *http.Request) {
	ref := chi.URLParam(r, "ref")
	if !validRef(ref) {
		httpx.Error(w, 404, "Unknown connector")
		return
	}
	raw, e := io.ReadAll(http.MaxBytesReader(w, r.Body, 2<<20))
	if e != nil {
		httpx.Error(w, 413, "payload too large")
		return
	}
	tenant := r.URL.Query().Get("tenantId")
	if tenant == "" {
		tenant = r.Header.Get("X-Zakura-Tenant")
	}
	if tenant == "" {
		httpx.Error(w, 400, "tenantId required")
		return
	}
	agent := r.URL.Query().Get("agentId")
	var cfg map[string]any
	if agent != "" {
		cfg, e = h.installationConfig(r.Context(), tenant, agent, ref)
	} else {
		// Routing must be explicit; never select an arbitrary Agent/Space.
		e = errors.New("agentId required")
	}
	if e != nil {
		httpx.Error(w, 401, "connector not configured")
		return
	}
	if !verifyWebhook(ref, cfg, r.Header, raw) {
		httpx.Error(w, 401, "invalid signature")
		return
	}
	external := r.Header.Get("X-GitHub-Delivery")
	if external == "" {
		external = r.Header.Get("X-Slack-Request-Timestamp") + ":" + r.Header.Get("X-Slack-Signature")
	}
	if external == "" {
		sum := sha256.Sum256(raw)
		external = hex.EncodeToString(sum[:])
	}
	var body map[string]any
	if json.Unmarshal(raw, &body) != nil {
		httpx.Error(w, 400, "invalid JSON")
		return
	}
	body["agentId"] = agent
	body["raw"] = json.RawMessage(raw)
	payload, _ := json.Marshal(body)
	event := models.ChannelEvent{ID: strPtr(h.id()), TenantID: tenant, Provider: ref, ExternalID: external, PayloadJSON: string(payload), DeliveryStatus: "pending", Attempts: 0, CreatedAt: h.now().Format(time.RFC3339Nano)}
	e = h.deps.Gorm.WithContext(r.Context()).Clauses(clause.OnConflict{Columns: []clause.Column{{Name: "provider"}, {Name: "external_id"}}, DoNothing: true}).Create(&event).Error
	if e != nil {
		writeErr(w, e)
		return
	}
	httpx.JSON(w, 202, map[string]any{"accepted": true, "externalId": external})
}
func verifyWebhook(ref string, cfg map[string]any, head http.Header, body []byte) bool {
	secret, _ := cfg["webhookSecret"].(string)
	if secret == "" {
		secret, _ = cfg["signingSecret"].(string)
	}
	if secret == "" {
		return false
	}
	given := head.Get("X-Zakura-Signature")
	data := body
	if ref == "github" {
		given = strings.TrimPrefix(head.Get("X-Hub-Signature-256"), "sha256=")
	} else if ref == "slack" {
		given = strings.TrimPrefix(head.Get("X-Slack-Signature"), "v0=")
		data = []byte("v0:" + head.Get("X-Slack-Request-Timestamp") + ":" + string(body))
	}
	mac := hmac.New(sha256.New, []byte(secret))
	mac.Write(data)
	expected := hex.EncodeToString(mac.Sum(nil))
	return hmac.Equal([]byte(strings.ToLower(given)), []byte(expected))
}
func (h *handler) startDeliverer(ctx context.Context) {
	go func() {
		ticker := time.NewTicker(5 * time.Second)
		defer ticker.Stop()
		for {
			select {
			case <-ctx.Done():
				return
			case <-ticker.C:
				h.deliverPending(ctx)
			}
		}
	}()
}
func (h *handler) deliverPending(ctx context.Context) {
	var all []models.ChannelEvent
	if e := h.deps.Gorm.WithContext(ctx).Where("delivery_status IN ? AND attempts < ?", []string{"pending", "retry"}, 8).Order("created_at").Limit(25).Find(&all).Error; e != nil {
		return
	}
	for _, x := range all {
		res := h.deps.Gorm.WithContext(ctx).Model(&models.ChannelEvent{}).
			Where("id = ? AND delivery_status IN ?", *x.ID, []string{"pending", "retry"}).
			Updates(map[string]any{"delivery_status": "processing", "attempts": gorm.Expr("attempts + 1")})
		if res.Error != nil || res.RowsAffected == 0 {
			continue
		}
		if e := h.processChannel(ctx, x.TenantID, x.Provider, []byte(x.PayloadJSON)); e != nil {
			h.deps.Gorm.WithContext(ctx).Model(&models.ChannelEvent{}).Where("id = ?", *x.ID).Updates(map[string]any{"delivery_status": "retry", "last_error": e.Error()})
		} else {
			h.deps.Gorm.WithContext(ctx).Model(&models.ChannelEvent{}).Where("id = ?", *x.ID).Updates(map[string]any{"delivery_status": "processed", "processed_at": h.now().Format(time.RFC3339Nano), "last_error": nil})
		}
	}
}
func (h *handler) processChannel(ctx context.Context, tenant, ref string, raw []byte) error {
	var p map[string]any
	if e := json.Unmarshal(raw, &p); e != nil {
		return e
	}
	agent, _ := p["agentId"].(string)
	if agent == "" {
		return errors.New("missing agentId")
	}
	content := extractInboundText(ref, p)
	if strings.TrimSpace(content) == "" {
		return errors.New("event contains no message text")
	}
	origin, _ := json.Marshal(map[string]any{"channel": ref, "external": p})
	session, e := h.runtimeStore.CreateSession(ctx, tenant, "", agent, internalruntime.Session{Title: "Inbound from " + ref, Kind: "chat", Origin: origin})
	if e != nil {
		return e
	}
	_, _, e = h.runtimeService.StartTurn(ctx, tenant, agent, session.ID, content, nil, nil, true)
	return e
}
func extractInboundText(ref string, p map[string]any) string {
	for _, key := range []string{"text", "content", "message", "body", "subject", "title"} {
		if v, ok := p[key].(string); ok && v != "" {
			return v
		}
	}
	if event, ok := p["event"].(map[string]any); ok {
		if v, ok := event["text"].(string); ok {
			return v
		}
	}
	if comment, ok := p["comment"].(map[string]any); ok {
		if v, ok := comment["body"].(string); ok {
			return v
		}
	}
	return ""
}

func (h *handler) listConnections(w http.ResponseWriter, r *http.Request) {
	p := principal(r)
	spaces, e := h.allowedSpaces(r)
	if e != nil {
		writeErr(w, e)
		return
	}
	for _, space := range spaces {
		if e = h.migrateSpaceConnectors(r.Context(), p.TenantID, space); e != nil {
			writeErr(w, e)
			return
		}
	}
	var rows []spaceConnectorInstallation
	if e = h.deps.Gorm.WithContext(r.Context()).Where("tenant_id = ? AND space_id IN ?", p.TenantID, spaces).Order("created_at DESC").Find(&rows).Error; e != nil {
		writeErr(w, e)
		return
	}
	items := []map[string]any{}
	for _, row := range rows {
		items = append(items, connectionView(row))
	}
	var instances []models.ComponentInstance
	if e = h.deps.Gorm.WithContext(r.Context()).Where("tenant_id = ? AND component_type = ?", p.TenantID, "mcp").Find(&instances).Error; e != nil {
		writeErr(w, e)
		return
	}
	for _, row := range instances {
		if row.ID == nil {
			continue
		}
		owner, e := h.authorizeInstance(r, *row.ID)
		if e != nil || !contains(spaces, owner) {
			continue
		}
		var cfg map[string]any
		_ = json.Unmarshal([]byte(row.ConfigJSON), &cfg)
		kind := "mcp-http"
		if cfg["transport"] == "stdio" {
			kind = "mcp-stdio"
		}
		items = append(items, map[string]any{"id": "instance:" + *row.ID, "instanceId": *row.ID, "spaceId": owner, "name": row.Name, "kind": kind, "status": row.Status, "providerId": row.ComponentRef, "agentIds": []string{}, "createdAt": row.CreatedAt, "updatedAt": row.UpdatedAt})
	}
	var conflicts []legacySpaceConnector
	if e = h.deps.Gorm.WithContext(r.Context()).Where("tenant_id = ? AND space_id IN ? AND resolved = ?", p.TenantID, spaces, false).Order("id").Find(&conflicts).Error; e != nil {
		writeErr(w, e)
		return
	}
	for _, row := range conflicts {
		items = append(items, map[string]any{"id": "legacy:" + row.ID, "spaceId": row.SpaceID, "name": row.ConnectorRef, "kind": "platform", "status": "conflict", "providerId": canonicalRef(row.ConnectorRef), "legacyAgentId": row.AgentID, "legacyRef": row.ConnectorRef, "agentIds": []string{}, "createdAt": row.CreatedAt, "updatedAt": row.UpdatedAt})
	}
	httpx.JSON(w, 200, map[string]any{"items": items})
}
func (h *handler) searchConnections(w http.ResponseWriter, r *http.Request) {
	term := strings.ToLower(r.URL.Query().Get("q"))
	items := make([]map[string]any, 0)
	for _, p := range providers {
		if term == "" || strings.Contains(strings.ToLower(p.Name+" "+p.Description+" "+p.Ref), term) {
			auth := "apiKey"
			if p.AuthKind == "oauth2" {
				auth = "oauth"
			} else if p.AuthKind == "none" {
				auth = "none"
			}
			items = append(items, map[string]any{"id": "connector:" + p.Ref, "name": p.Name, "description": p.Description, "kind": "platform", "source": "platform", "auth": auth, "needsRunner": false, "tags": []string{p.Category}, "installRef": p.Ref, "connectorId": p.Ref})
		}
	}
	httpx.JSON(w, 200, map[string]any{"items": items, "total": len(items)})
}
func (h *handler) connectionSources(w http.ResponseWriter, r *http.Request) {
	p := principal(r)
	sources := []map[string]any{{"id": "platform", "name": "Zakura integrations", "description": "Built-in verified connectors", "kind": "builtin", "format": "auto"}}
	var rows []models.McpStoreSource
	if e := h.deps.Gorm.WithContext(r.Context()).Where("tenant_id = ?", p.TenantID).Order("created_at").Find(&rows).Error; e != nil {
		writeErr(w, e)
		return
	}
	for _, row := range rows {
		description := row.Description
		if description == "" {
			description = "Custom source"
		}
		sources = append(sources, map[string]any{"id": *row.ID, "name": row.Name, "description": description, "kind": "custom", "format": row.Format, "url": row.SourceURL})
	}
	httpx.JSON(w, 200, map[string]any{"sources": sources})
}
func (h *handler) listPackages(w http.ResponseWriter, r *http.Request) {
	term := "%" + r.URL.Query().Get("q") + "%"
	var rows []models.IntegrationPackage
	if e := h.deps.Gorm.WithContext(r.Context()).Where("LOWER(name) LIKE LOWER(?) OR LOWER(description) LIKE LOWER(?)", term, term).Order("name").Limit(100).Find(&rows).Error; e != nil {
		writeErr(w, e)
		return
	}
	items := make([]map[string]any, 0)
	for _, row := range rows {
		desc := ""
		if row.Description != nil {
			desc = *row.Description
		}
		meta := map[string]any{}
		_ = json.Unmarshal([]byte(row.ManifestJSON), &meta)
		kind, _ := meta["kind"].(string)
		if kind == "" {
			kind = "plugin"
		}
		source := r.URL.Query().Get("source")
		if source == "" {
			source = "platform"
		}
		items = append(items, map[string]any{"id": *row.ID, "name": row.Name, "description": desc, "kind": kind, "source": source, "icon": meta["icon"], "verified": meta["verified"], "featured": meta["featured"], "counts": map[string]int{}, "needsRunner": meta["needsRunner"], "publisher": meta["publisher"], "detailId": row.Slug, "installRef": row.Slug, "installed": false, "createdAt": row.CreatedAt, "updatedAt": row.UpdatedAt})
	}
	source := r.URL.Query().Get("source")
	if source == "" {
		source = "platform"
	}
	httpx.JSON(w, 200, map[string]any{"items": items, "total": len(items), "sourceLabel": source, "sections": []any{}})
}
func (h *handler) getPackage(w http.ResponseWriter, r *http.Request) {
	var pkg models.IntegrationPackage
	if e := h.deps.Gorm.WithContext(r.Context()).Where("id = ? OR slug = ?", chi.URLParam(r, "id"), chi.URLParam(r, "id")).First(&pkg).Error; e != nil {
		writeErr(w, e)
		return
	}
	var rows []models.IntegrationComponent
	if e := h.deps.Gorm.WithContext(r.Context()).Where("package_id = ?", pkg.ID).Order("id").Find(&rows).Error; e != nil {
		writeErr(w, e)
		return
	}
	components := make([]map[string]any, 0)
	for _, row := range rows {
		meta := map[string]any{}
		_ = json.Unmarshal([]byte(row.ManifestJSON), &meta)
		name := row.Ref
		if v, _ := meta["name"].(string); v != "" {
			name = v
		}
		components = append(components, map[string]any{"id": *row.ID, "installRef": row.Ref, "name": name, "description": meta["description"], "kind": row.Kind, "needsRunner": meta["needsRunner"], "auth": meta["auth"], "hookEvents": meta["hookEvents"]})
	}
	desc := ""
	if pkg.Description != nil {
		desc = *pkg.Description
	}
	meta := map[string]any{}
	_ = json.Unmarshal([]byte(pkg.ManifestJSON), &meta)
	kind, _ := meta["kind"].(string)
	if kind == "" {
		kind = "plugin"
	}
	httpx.JSON(w, 200, map[string]any{"package": map[string]any{"id": *pkg.ID, "name": pkg.Name, "description": desc, "summary": meta["summary"], "icon": meta["icon"], "kind": kind, "source": "platform", "sourceLabel": "platform", "homepage": meta["homepage"], "docsUrl": meta["docsUrl"], "publisher": meta["publisher"], "category": meta["category"], "version": meta["version"], "verified": meta["verified"], "featured": meta["featured"], "tags": meta["tags"], "installRef": pkg.Slug, "components": components}})
}
func (h *handler) installPackage(w http.ResponseWriter, r *http.Request) {
	p := principal(r)
	var b struct {
		SpaceID       string          `json:"spaceId"`
		RuntimeNodeID *string         `json:"runtimeNodeId"`
		Name          string          `json:"name"`
		AgentIDs      []string        `json:"agentIds"`
		ComponentIDs  []string        `json:"componentIds"`
		Config        json.RawMessage `json:"config"`
	}
	if httpx.DecodeJSON(r, &b) != nil {
		httpx.Error(w, 400, "invalid JSON")
		return
	}
	space, e := h.installTarget(r, b.SpaceID, b.AgentIDs)
	if e != nil {
		writeErr(w, e)
		return
	}
	if e = h.migrateSpaceConnectors(r.Context(), p.TenantID, space); e != nil {
		writeErr(w, e)
		return
	}
	var all []models.IntegrationComponent
	if e := h.deps.Gorm.WithContext(r.Context()).Table("integration_components AS c").
		Select("c.id, c.ref, c.kind, c.manifest_json").
		Joins("JOIN integration_packages p ON p.id = c.package_id").
		Where("p.id = ? OR p.slug = ?", chi.URLParam(r, "id"), chi.URLParam(r, "id")).
		Find(&all).Error; e != nil {
		writeErr(w, e)
		return
	}
	if len(all) == 0 {
		httpx.Error(w, 404, "Package not found")
		return
	}
	installed := 0
	var cfg map[string]any
	if len(b.Config) > 0 && json.Unmarshal(b.Config, &cfg) != nil {
		httpx.Error(w, 400, "invalid config")
		return
	}
	// Validate all components before making any writes. MCP provisioning belongs
	// to the runtime installer, never synthetic ready rows.
	for _, c := range all {
		if len(b.ComponentIDs) > 0 && !contains(b.ComponentIDs, *c.ID) {
			continue
		}
		if c.Kind != "connector" || !validRef(c.Ref) {
			httpx.Error(w, 400, "use the runtime installer for this component")
			return
		}
	}
	for _, c := range all {
		if len(b.ComponentIDs) > 0 && !contains(b.ComponentIDs, *c.ID) {
			continue
		}
		if _, e := h.saveSpaceConnector(r.Context(), p.TenantID, space, c.Ref, connectorEnvelope{Config: cfg}, true); e != nil {
			writeErr(w, e)
			return
		}
		installed++
	}
	result := map[string]any{"id": chi.URLParam(r, "id"), "kind": "plugin", "name": chi.URLParam(r, "id"), "status": "installed", "installed": installed}
	httpx.JSON(w, http.StatusCreated, map[string]any{"result": result})
}
func contains(xs []string, v string) bool {
	for _, x := range xs {
		if x == v {
			return true
		}
	}
	return false
}
func (h *handler) bindConnection(w http.ResponseWriter, r *http.Request) {
	var b struct {
		AgentID string `json:"agentId"`
		SpaceID string `json:"spaceId"`
	}
	if httpx.DecodeJSON(r, &b) != nil {
		httpx.Error(w, 400, "invalid JSON")
		return
	}
	rawID := chi.URLParam(r, "id")
	if strings.HasPrefix(rawID, "instance:") {
		id := strings.TrimPrefix(rawID, "instance:")
		if _, e := h.authorizeInstance(r, id); e != nil {
			writeErr(w, e)
			return
		}
		space, e := h.resourceSpace(r, b.SpaceID, b.AgentID)
		if e != nil {
			writeErr(w, e)
			return
		}
		hook, ok := h.lifecycle.(interface {
			Bind(context.Context, string, string, string) error
		})
		if !ok {
			httpx.Error(w, 503, "runtime binding unavailable")
			return
		}
		if e = hook.Bind(r.Context(), principal(r).TenantID, space, id); e != nil {
			writeErr(w, e)
			return
		}
		httpx.JSON(w, 200, map[string]any{"ok": true, "spaceId": space})
		return
	}
	row, e := h.loadConnection(r, rawID)
	if e != nil {
		writeErr(w, e)
		return
	}
	space, e := h.resourceSpace(r, b.SpaceID, b.AgentID)
	if e != nil {
		writeErr(w, e)
		return
	}
	if space != row.SpaceID {
		httpx.Error(w, 400, "connector belongs to another Space")
		return
	}
	// Compatibility adapter: Agent consumes the existing Space owner. No copy,
	// reassignment, or encryption-scope change is necessary.
	httpx.JSON(w, 200, map[string]any{"ok": true, "spaceId": row.SpaceID})
}
func (h *handler) deleteConnection(w http.ResponseWriter, r *http.Request) {
	if raw := chi.URLParam(r, "id"); strings.HasPrefix(raw, "instance:") {
		id := strings.TrimPrefix(raw, "instance:")
		if _, e := h.authorizeInstance(r, id); e != nil {
			writeErr(w, e)
			return
		}
		hook, ok := h.lifecycle.(interface {
			Delete(context.Context, string, string) error
		})
		if !ok {
			httpx.Error(w, 503, "runtime removal unavailable")
			return
		}
		if e := hook.Delete(r.Context(), principal(r).TenantID, id); e != nil {
			writeErr(w, e)
			return
		}
		httpx.JSON(w, 200, map[string]any{"ok": true})
		return
	}
	row, e := h.loadConnection(r, chi.URLParam(r, "id"))
	if e != nil {
		writeErr(w, e)
		return
	}
	if e = h.deps.Gorm.WithContext(r.Context()).Where("tenant_id = ? AND id = ?", row.TenantID, row.ID).Delete(&spaceConnectorInstallation{}).Error; e != nil {
		writeErr(w, e)
		return
	}
	httpx.JSON(w, 200, map[string]any{"ok": true})
}
