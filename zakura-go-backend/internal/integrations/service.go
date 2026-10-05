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

	"github.com/go-chi/chi/v5"
	"github.com/momo-mnsjtxy/Zakura/zakura-go-backend/internal/platform/httpx"
	internalruntime "github.com/momo-mnsjtxy/Zakura/zakura-go-backend/internal/runtime"
)

func merge(dst map[string]any, src map[string]any) {
	for k, v := range src {
		dst[k] = v
	}
}
func (h *handler) installationConfig(ctx context.Context, tenant, agent, ref string) (map[string]any, error) {
	var enc string
	e := h.deps.DB.QueryRowContext(ctx, h.q(`SELECT config_enc FROM agent_connector_installations WHERE tenant_id=? AND agent_id=? AND connector_ref=? AND enabled=true`), tenant, agent, ref).Scan(&enc)
	if e != nil {
		return nil, e
	}
	raw, e := decrypt(h.deps.Secret, tenant+":"+agent+":"+ref, enc)
	if e != nil {
		return nil, e
	}
	var install struct {
		ProfileKey string         `json:"profileKey"`
		Config     map[string]any `json:"config"`
	}
	if e = json.Unmarshal(raw, &install); e != nil {
		return nil, e
	}
	out := map[string]any{}
	if install.ProfileKey != "" {
		cfg, e := h.profileConfig(ctx, tenant, install.ProfileKey)
		if e != nil {
			return nil, e
		}
		merge(out, cfg)
	}
	merge(out, install.Config)
	var settingEnc string
	if e := h.deps.DB.QueryRowContext(ctx, h.q(`SELECT config_enc FROM connector_settings WHERE scope_key=? AND connector_ref=?`), tenant, ref).Scan(&settingEnc); e == nil {
		if raw, e := decrypt(h.deps.Secret, tenant+":"+ref, settingEnc); e == nil {
			var cfg map[string]any
			if json.Unmarshal(raw, &cfg) == nil {
				merge(out, cfg)
			}
		}
	}
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
	case "email":
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
		var one string
		e = h.deps.DB.QueryRowContext(r.Context(), h.q(`SELECT agent_id FROM agent_connector_installations WHERE tenant_id=? AND connector_ref=? AND enabled=true ORDER BY created_at LIMIT 1`), tenant, ref).Scan(&one)
		agent = one
		if e == nil {
			cfg, e = h.installationConfig(r.Context(), tenant, agent, ref)
		}
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
	_, e = h.deps.DB.ExecContext(r.Context(), h.q(`INSERT INTO channel_events(id,tenant_id,provider,external_id,payload_json,delivery_status,attempts,last_error,created_at,processed_at) VALUES(?,?,?,?,?,'pending',0,NULL,?,NULL) ON CONFLICT(provider,external_id) DO NOTHING`), h.id(), tenant, ref, external, string(payload), h.now())
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
	rows, e := h.deps.DB.QueryContext(ctx, h.q(`SELECT id,tenant_id,provider,payload_json,attempts FROM channel_events WHERE delivery_status IN ('pending','retry') AND attempts<8 ORDER BY created_at LIMIT 25`))
	if e != nil {
		return
	}
	type event struct {
		id, tenant, ref, payload string
		attempts                 int
	}
	all := []event{}
	for rows.Next() {
		var x event
		if rows.Scan(&x.id, &x.tenant, &x.ref, &x.payload, &x.attempts) == nil {
			all = append(all, x)
		}
	}
	rows.Close()
	for _, x := range all {
		res, e := h.deps.DB.ExecContext(ctx, h.q(`UPDATE channel_events SET delivery_status='processing',attempts=attempts+1 WHERE id=? AND delivery_status IN ('pending','retry')`), x.id)
		if e != nil {
			continue
		}
		n, _ := res.RowsAffected()
		if n == 0 {
			continue
		}
		e = h.processChannel(ctx, x.tenant, x.ref, []byte(x.payload))
		if e != nil {
			_, _ = h.deps.DB.ExecContext(ctx, h.q(`UPDATE channel_events SET delivery_status='retry',last_error=? WHERE id=?`), e.Error(), x.id)
		} else {
			_, _ = h.deps.DB.ExecContext(ctx, h.q(`UPDATE channel_events SET delivery_status='processed',processed_at=?,last_error=NULL WHERE id=?`), h.now(), x.id)
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
	rows, e := h.deps.DB.QueryContext(r.Context(), h.q(`SELECT id,agent_id,connector_ref,enabled,created_at,updated_at FROM agent_connector_installations WHERE tenant_id=? ORDER BY created_at DESC`), p.TenantID)
	if e != nil {
		writeErr(w, e)
		return
	}
	defer rows.Close()
	items := make([]map[string]any, 0)
	for rows.Next() {
		var id, agent, ref, c, u string
		var enabled bool
		if rows.Scan(&id, &agent, &ref, &enabled, &c, &u) == nil {
			meta, _ := provider(ref)
			status := "disabled"
			if enabled {
				status = "installed"
			}
			items = append(items, map[string]any{"id": "connector:" + id, "installationId": id, "name": meta.Name, "kind": "platform", "status": status, "providerId": ref, "slug": ref, "agentIds": []string{agent}, "createdAt": c, "updatedAt": u})
		}
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
	httpx.JSON(w, 200, map[string]any{"sources": []map[string]any{{"id": "platform", "name": "Zakura integrations", "description": "Built-in verified connectors", "kind": "builtin", "format": "auto"}}})
}
func (h *handler) listPackages(w http.ResponseWriter, r *http.Request) {
	term := "%" + r.URL.Query().Get("q") + "%"
	rows, e := h.deps.DB.QueryContext(r.Context(), h.q(`SELECT id,slug,name,COALESCE(description,''),manifest_json,created_at,updated_at FROM integration_packages WHERE LOWER(name) LIKE LOWER(?) OR LOWER(description) LIKE LOWER(?) ORDER BY name LIMIT 100`), term, term)
	if e != nil {
		writeErr(w, e)
		return
	}
	defer rows.Close()
	items := make([]map[string]any, 0)
	for rows.Next() {
		var id, slug, name, desc, manifest, c, u string
		if rows.Scan(&id, &slug, &name, &desc, &manifest, &c, &u) == nil {
			meta := map[string]any{}
			_ = json.Unmarshal([]byte(manifest), &meta)
			kind, _ := meta["kind"].(string)
			if kind == "" {
				kind = "plugin"
			}
			source := r.URL.Query().Get("source")
			if source == "" {
				source = "platform"
			}
			items = append(items, map[string]any{"id": id, "name": name, "description": desc, "kind": kind, "source": source, "icon": meta["icon"], "verified": meta["verified"], "featured": meta["featured"], "counts": map[string]int{}, "needsRunner": meta["needsRunner"], "publisher": meta["publisher"], "detailId": slug, "installRef": slug, "installed": false, "createdAt": c, "updatedAt": u})
		}
	}
	source := r.URL.Query().Get("source")
	if source == "" {
		source = "platform"
	}
	httpx.JSON(w, 200, map[string]any{"items": items, "total": len(items), "sourceLabel": source, "sections": []any{}})
}
func (h *handler) getPackage(w http.ResponseWriter, r *http.Request) {
	var id, slug, name, desc, manifest string
	e := h.deps.DB.QueryRowContext(r.Context(), h.q(`SELECT id,slug,name,COALESCE(description,''),manifest_json FROM integration_packages WHERE id=? OR slug=?`), chi.URLParam(r, "id"), chi.URLParam(r, "id")).Scan(&id, &slug, &name, &desc, &manifest)
	if e != nil {
		writeErr(w, e)
		return
	}
	rows, e := h.deps.DB.QueryContext(r.Context(), h.q(`SELECT id,ref,kind,manifest_json FROM integration_components WHERE package_id=? ORDER BY id`), id)
	if e != nil {
		writeErr(w, e)
		return
	}
	defer rows.Close()
	components := make([]map[string]any, 0)
	for rows.Next() {
		var cid, ref, kind, m string
		if rows.Scan(&cid, &ref, &kind, &m) == nil {
			meta := map[string]any{}
			_ = json.Unmarshal([]byte(m), &meta)
			components = append(components, map[string]any{"id": cid, "installRef": ref, "name": func() string {
				if v, _ := meta["name"].(string); v != "" {
					return v
				}
				return ref
			}(), "description": meta["description"], "kind": kind, "needsRunner": meta["needsRunner"], "auth": meta["auth"], "hookEvents": meta["hookEvents"]})
		}
	}
	meta := map[string]any{}
	_ = json.Unmarshal([]byte(manifest), &meta)
	kind, _ := meta["kind"].(string)
	if kind == "" {
		kind = "plugin"
	}
	httpx.JSON(w, 200, map[string]any{"package": map[string]any{"id": id, "name": name, "description": desc, "summary": meta["summary"], "icon": meta["icon"], "kind": kind, "source": "platform", "sourceLabel": "platform", "homepage": meta["homepage"], "docsUrl": meta["docsUrl"], "publisher": meta["publisher"], "category": meta["category"], "version": meta["version"], "verified": meta["verified"], "featured": meta["featured"], "tags": meta["tags"], "installRef": slug, "components": components}})
}
func (h *handler) installPackage(w http.ResponseWriter, r *http.Request) {
	p := principal(r)
	var b struct {
		AgentIDs     []string        `json:"agentIds"`
		ComponentIDs []string        `json:"componentIds"`
		Config       json.RawMessage `json:"config"`
	}
	if httpx.DecodeJSON(r, &b) != nil || len(b.AgentIDs) == 0 {
		httpx.Error(w, 400, "agentIds required")
		return
	}
	rows, e := h.deps.DB.QueryContext(r.Context(), h.q(`SELECT c.id,c.ref,c.kind,c.manifest_json FROM integration_components c JOIN integration_packages p ON p.id=c.package_id WHERE p.id=? OR p.slug=?`), chi.URLParam(r, "id"), chi.URLParam(r, "id"))
	if e != nil {
		writeErr(w, e)
		return
	}
	defer rows.Close()
	type comp struct{ id, ref, kind, manifest string }
	all := []comp{}
	for rows.Next() {
		var x comp
		if rows.Scan(&x.id, &x.ref, &x.kind, &x.manifest) == nil {
			all = append(all, x)
		}
	}
	rows.Close()
	if len(all) == 0 {
		httpx.Error(w, 404, "Package not found")
		return
	}
	installed := 0
	for _, agent := range b.AgentIDs {
		var count int
		if h.deps.DB.QueryRowContext(r.Context(), h.q(`SELECT COUNT(*) FROM agents WHERE tenant_id=? AND id=?`), p.TenantID, agent).Scan(&count) != nil || count == 0 {
			continue
		}
		for _, c := range all {
			if len(b.ComponentIDs) > 0 && !contains(b.ComponentIDs, c.id) {
				continue
			}
			if c.kind == "connector" && validRef(c.ref) {
				data, _ := json.Marshal(map[string]any{"config": json.RawMessage(b.Config)})
				enc, _ := encrypt(h.deps.Secret, p.TenantID+":"+agent+":"+c.ref, data)
				now := h.now()
				if _, e = h.deps.DB.ExecContext(r.Context(), h.q(`INSERT INTO agent_connector_installations(id,tenant_id,agent_id,connector_ref,enabled,config_enc,created_at,updated_at) VALUES(?,?,?,?,true,?,?,?) ON CONFLICT(agent_id,connector_ref) DO UPDATE SET enabled=true,config_enc=?,updated_at=?`), h.id(), p.TenantID, agent, c.ref, enc, now, now, enc, now); e == nil {
					installed++
				}
			} else {
				now := h.now()
				if _, e = h.deps.DB.ExecContext(r.Context(), h.q(`INSERT INTO component_instances(id,tenant_id,agent_id,component_type,component_ref,name,config_json,secret_json,status,last_error,created_at,updated_at) VALUES(?,?,?,?,?,?,?,'{}','ready',NULL,?,?)`), h.id(), p.TenantID, agent, c.kind, c.ref, c.ref, c.manifest, now, now); e == nil {
					installed++
				}
			}
		}
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
	}
	if httpx.DecodeJSON(r, &b) != nil || b.AgentID == "" {
		httpx.Error(w, 400, "agentId required")
		return
	}
	id := strings.TrimPrefix(chi.URLParam(r, "id"), "connector:")
	p := principal(r)
	var ref, oldAgent, enc string
	var enabled bool
	e := h.deps.DB.QueryRowContext(r.Context(), h.q(`SELECT connector_ref,agent_id,config_enc,enabled FROM agent_connector_installations WHERE tenant_id=? AND id=?`), p.TenantID, id).Scan(&ref, &oldAgent, &enc, &enabled)
	if e != nil {
		writeErr(w, e)
		return
	}
	raw, e := decrypt(h.deps.Secret, p.TenantID+":"+oldAgent+":"+ref, enc)
	if e != nil {
		writeErr(w, e)
		return
	}
	newEnc, _ := encrypt(h.deps.Secret, p.TenantID+":"+b.AgentID+":"+ref, raw)
	_, e = h.deps.DB.ExecContext(r.Context(), h.q(`UPDATE agent_connector_installations SET agent_id=?,config_enc=?,updated_at=? WHERE tenant_id=? AND id=?`), b.AgentID, newEnc, h.now(), p.TenantID, id)
	if e != nil {
		writeErr(w, e)
		return
	}
	httpx.JSON(w, 200, map[string]any{"ok": true})
}
func (h *handler) deleteConnection(w http.ResponseWriter, r *http.Request) {
	id := strings.TrimPrefix(chi.URLParam(r, "id"), "connector:")
	res, e := h.deps.DB.ExecContext(r.Context(), h.q(`DELETE FROM agent_connector_installations WHERE tenant_id=? AND id=?`), principal(r).TenantID, id)
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
