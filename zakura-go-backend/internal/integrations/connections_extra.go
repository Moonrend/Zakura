// SPDX-License-Identifier: AGPL-3.0-or-later
package integrations

import (
	"database/sql"
	"encoding/json"
	"net/http"
	"strings"

	"github.com/go-chi/chi/v5"
	"github.com/momo-mnsjtxy/Zakura/zakura-go-backend/internal/platform/httpx"
)

func (h *handler) setConnectionState(w http.ResponseWriter, r *http.Request, enabled bool) {
	p := principal(r)
	raw := chi.URLParam(r, "id")
	kind, id := "connector", strings.TrimPrefix(raw, "connector:")
	if strings.HasPrefix(raw, "instance:") {
		kind = "instance"
		id = strings.TrimPrefix(raw, "instance:")
	}
	var res sql.Result
	var e error
	if kind == "connector" {
		res, e = h.deps.DB.ExecContext(r.Context(), h.q(`UPDATE agent_connector_installations SET enabled=?,updated_at=? WHERE tenant_id=? AND id=?`), enabled, h.now(), p.TenantID, id)
	} else {
		status := "stopped"
		if enabled {
			status = "running"
		}
		res, e = h.deps.DB.ExecContext(r.Context(), h.q(`UPDATE component_instances SET status=?,updated_at=? WHERE tenant_id=? AND id=?`), status, h.now(), p.TenantID, id)
	}
	if e != nil {
		writeErr(w, e)
		return
	}
	n, _ := res.RowsAffected()
	if n == 0 {
		httpx.Error(w, 404, "Not found")
		return
	}
	httpx.JSON(w, 200, map[string]any{"ok": true, "enabled": enabled})
}
func (h *handler) startConnection(w http.ResponseWriter, r *http.Request) {
	h.setConnectionState(w, r, true)
}
func (h *handler) stopConnection(w http.ResponseWriter, r *http.Request) {
	h.setConnectionState(w, r, false)
}
func (h *handler) installConnection(w http.ResponseWriter, r *http.Request) {
	p := principal(r)
	var b struct {
		Source, Kind, Name string
		AgentIDs           []string        `json:"agentIds"`
		Config             json.RawMessage `json:"config"`
	}
	if httpx.DecodeJSON(r, &b) != nil || b.Source == "" || len(b.AgentIDs) == 0 {
		httpx.Error(w, 400, "source and agentIds required")
		return
	}
	ref := b.Source
	if validRef(ref) {
		installed := 0
		for _, agent := range b.AgentIDs {
			raw, _ := json.Marshal(map[string]any{"config": json.RawMessage(b.Config)})
			enc, _ := encrypt(h.deps.Secret, p.TenantID+":"+agent+":"+ref, raw)
			now := h.now()
			if _, e := h.deps.DB.ExecContext(r.Context(), h.q(`INSERT INTO agent_connector_installations(id,tenant_id,agent_id,connector_ref,enabled,config_enc,created_at,updated_at) VALUES(?,?,?,?,true,?,?,?) ON CONFLICT(agent_id,connector_ref) DO UPDATE SET enabled=true,config_enc=?,updated_at=?`), h.id(), p.TenantID, agent, ref, enc, now, now, enc, now); e == nil {
				installed++
			}
		}
		meta, _ := provider(ref)
		httpx.JSON(w, http.StatusCreated, map[string]any{"result": map[string]any{"id": "connector:" + ref, "kind": "platform", "name": meta.Name, "status": "installed", "installed": installed}})
		return
	}
	if b.Kind == "mcp" || strings.HasPrefix(b.Source, "http://") || strings.HasPrefix(b.Source, "https://") {
		if _, e := safeURL(b.Source); e != nil {
			writeErr(w, e)
			return
		}
		cfg := map[string]any{"url": b.Source}
		secretValues := map[string]any{}
		if len(b.Config) > 0 {
			_ = json.Unmarshal(b.Config, &cfg)
			cfg["url"] = b.Source
		}
		for _, key := range []string{"token", "apiKey", "accessToken", "headers", "credentials", "secret"} {
			if value, ok := cfg[key]; ok {
				secretValues[key] = value
				delete(cfg, key)
			}
		}
		cfgRaw, _ := json.Marshal(cfg)
		now := h.now()
		created := []string{}
		for _, agent := range b.AgentIDs {
			id := h.id()
			secretRaw, _ := json.Marshal(secretValues)
			enc, encErr := encrypt(h.deps.Secret, "mcp:"+id, secretRaw)
			if encErr != nil {
				writeErr(w, encErr)
				return
			}
			secretStored, _ := json.Marshal(map[string]any{"enc": enc, "configured": len(secretValues) > 0})
			if _, e := h.deps.DB.ExecContext(r.Context(), h.q(`INSERT INTO component_instances(id,tenant_id,agent_id,component_type,component_ref,name,config_json,secret_json,status,last_error,created_at,updated_at) VALUES(?,?,?,'mcp',?,?,?,?,'ready',NULL,?,?)`), id, p.TenantID, agent, slugifyLocal(b.Name), b.Name, string(cfgRaw), string(secretStored), now, now); e == nil {
				created = append(created, id)
			}
		}
		if len(created) == 0 {
			httpx.Error(w, http.StatusBadRequest, "no eligible agents")
			return
		}
		result := map[string]any{"id": created[0], "instanceId": created[0], "instanceIds": created, "kind": "mcp-http", "name": b.Name, "status": "ready"}
		httpx.JSON(w, http.StatusCreated, map[string]any{"result": result})
		return
	}
	httpx.Error(w, 400, "unknown connector or MCP source")
}
func slugifyLocal(v string) string {
	v = strings.ToLower(strings.TrimSpace(v))
	v = strings.NewReplacer(" ", "-", "/", "-", ":", "-").Replace(v)
	return strings.Trim(v, "-")
}
func (h *handler) createConnectionSource(w http.ResponseWriter, r *http.Request) {
	p := principal(r)
	var b struct{ Name, Description, Repository, Format string }
	if httpx.DecodeJSON(r, &b) != nil || b.Repository == "" {
		httpx.Error(w, 400, "repository required")
		return
	}
	if _, e := safeURL(b.Repository); e != nil {
		writeErr(w, e)
		return
	}
	if b.Name == "" {
		b.Name = b.Repository
	}
	if b.Format == "" {
		b.Format = "auto"
	}
	now := h.now()
	id := h.id()
	_, e := h.deps.DB.ExecContext(r.Context(), h.q(`INSERT INTO mcp_store_sources(id,tenant_id,name,description,source_url,format,manifest_json,servers_json,enabled,fetched_at,created_at,updated_at) VALUES(?,?,?,?,?,?,'{}','[]',true,NULL,?,?)`), id, p.TenantID, b.Name, b.Description, b.Repository, b.Format, now, now)
	if e != nil {
		writeErr(w, e)
		return
	}
	httpx.JSON(w, 201, map[string]any{"source": map[string]any{"id": id, "name": b.Name, "sourceUrl": b.Repository, "format": b.Format}})
}
func (h *handler) deleteConnectionSource(w http.ResponseWriter, r *http.Request) {
	res, e := h.deps.DB.ExecContext(r.Context(), h.q(`DELETE FROM mcp_store_sources WHERE tenant_id=? AND id=?`), principal(r).TenantID, chi.URLParam(r, "id"))
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
func (h *handler) listProviderCatalog(w http.ResponseWriter, r *http.Request) {
	items := make([]map[string]any, 0, len(providers))
	for _, p := range providers {
		items = append(items, map[string]any{"id": p.Ref, "name": p.Name, "description": p.Description, "category": p.Category, "capabilities": p.Capabilities, "authKind": p.AuthKind})
	}
	rows, e := h.deps.DB.QueryContext(r.Context(), `SELECT id,name,kind,manifest_json FROM provider_catalog WHERE enabled=true ORDER BY name`)
	if e == nil {
		defer rows.Close()
		for rows.Next() {
			var id, name, kind, manifest string
			if rows.Scan(&id, &name, &kind, &manifest) == nil {
				var meta map[string]any
				_ = json.Unmarshal([]byte(manifest), &meta)
				items = append(items, map[string]any{"id": id, "name": name, "description": meta["description"], "category": kind, "capabilities": meta["capabilities"], "configSchema": meta["configSchema"]})
			}
		}
	}
	httpx.JSON(w, 200, map[string]any{"providers": items})
}
