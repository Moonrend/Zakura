// SPDX-License-Identifier: AGPL-3.0-or-later
package runtime

import (
	"database/sql"
	"encoding/json"
	"errors"
	"net/http"
	"os"
	"path"
	"path/filepath"
	"sort"
	"strconv"
	"strings"

	"github.com/go-chi/chi/v5"
	"github.com/momo-mnsjtxy/Zakura/zakura-go-backend/internal/platform/httpx"
)

type skillFile struct {
	Path    string `json:"path"`
	Content string `json:"content"`
}

func (h *handler) registerSkills(r chi.Router) {
	r.Get("/skills/stores", h.skillStores)
	r.Get("/skills/repos", h.listSkillRepos)
	r.Post("/skills/repos/{owner}/{repo}/sync", h.syncSkillRepo)
	r.Get("/skills/cache", h.skillCacheStatus)
	r.Get("/skills/auto-update", h.skillAutoUpdateStatus)
	r.Put("/skills/auto-update", h.putSkillAutoUpdate)
	r.Post("/skills/check-updates", h.checkSkillUpdates)
	r.Get("/skills/tokens", h.listSkillTokens)
	r.Put("/skills/tokens/{provider}", h.putSkillToken)
	r.Delete("/skills/tokens/{provider}", h.deleteSkillToken)
	r.Post("/skills/resolve", h.resolveSkill)
	r.Get("/skills", h.listSkills)
	r.Post("/skills/install", h.installSkill)
	r.Get("/skills/search", h.listSkills)
	r.Get("/skills/{id}", h.getSkill)
	r.Post("/skills/{id}/update", h.updateSkill)
	r.Delete("/skills/{id}", h.deleteSkill)
	r.Patch("/skills/{id}/auto-update", h.patchSkillAutoUpdate)
	r.Get("/agents/{id}/skills", h.listAgentSkills)
	r.Post("/agents/{id}/skills", h.attachSkill)
	r.Patch("/agents/{id}/skills/{name}", h.patchAgentSkill)
	r.Delete("/agents/{id}/skills/{name}", h.detachSkill)
	r.Get("/agents/{id}/skills/{name}/file", h.getAgentSkillFile)
	r.Get("/memory-providers/meta", h.memoryProviderMeta)
	r.Get("/memory-providers", h.listMemoryProviders)
	r.Post("/memory-providers", h.createMemoryProvider)
	r.Get("/memory-providers/{id}", h.getMemoryProvider)
	r.Patch("/memory-providers/{id}", h.patchMemoryProvider)
	r.Delete("/memory-providers/{id}", h.deleteMemoryProvider)
	r.Post("/memory-providers/{id}/health", h.healthMemoryProvider)
}
func scanSkill(row interface{ Scan(...any) error }) (Skill, error) {
	var x Skill
	var src, files string
	var c, u flexibleTime
	e := row.Scan(&x.ID, &x.Name, &x.Title, &x.Description, &x.Version, &x.Builtin, &src, &x.Homepage, &x.License, &files, &x.FileCount, &x.SizeBytes, &x.AutoUpdate, &c, &u)
	if e != nil {
		return x, e
	}
	x.Source = json.RawMessage(src)
	x.Files = json.RawMessage(files)
	x.CreatedAt = c.Time
	x.UpdatedAt = u.Time
	return x, nil
}
func (h *handler) skillByID(r *http.Request, id string) (Skill, error) {
	x, e := scanSkill(h.deps.DB.QueryRowContext(r.Context(), h.store.q(`SELECT id,name,title,description,version,builtin,source_json,homepage,license,files_json,file_count,size_bytes,auto_update,created_at,updated_at FROM skills WHERE tenant_id=? AND id=?`), principal(r).TenantID, id))
	if errors.Is(e, sql.ErrNoRows) {
		e = ErrNotFound
	}
	return x, e
}
func (h *handler) listSkills(w http.ResponseWriter, r *http.Request) {
	p := principal(r)
	q := `SELECT id,name,title,description,version,builtin,source_json,homepage,license,files_json,file_count,size_bytes,auto_update,created_at,updated_at FROM skills WHERE tenant_id=?`
	args := []any{p.TenantID}
	if term := strings.TrimSpace(r.URL.Query().Get("q")); term != "" {
		q += ` AND (LOWER(name) LIKE LOWER(?) OR LOWER(title) LIKE LOWER(?) OR LOWER(description) LIKE LOWER(?))`
		x := "%" + term + "%"
		args = append(args, x, x, x)
	}
	q += ` ORDER BY builtin DESC,name`
	rows, e := h.deps.DB.QueryContext(r.Context(), h.store.q(q), args...)
	if e != nil {
		statusErr(w, e)
		return
	}
	defer rows.Close()
	out := make([]Skill, 0)
	for rows.Next() {
		x, e := scanSkill(rows)
		if e != nil {
			statusErr(w, e)
			return
		}
		x.Files = nil
		out = append(out, x)
	}
	httpx.JSON(w, 200, map[string]any{"skills": out, "items": out})
}
func validateSkillFiles(files []skillFile) (int64, error) {
	var size int64
	seen := map[string]bool{}
	for _, f := range files {
		clean := path.Clean(strings.TrimPrefix(f.Path, "/"))
		if clean == "." || strings.HasPrefix(clean, "../") || strings.Contains(clean, "\\") || seen[clean] {
			return 0, errors.New("invalid or duplicate skill file path")
		}
		seen[clean] = true
		size += int64(len(f.Content))
		if size > 10<<20 {
			return 0, errors.New("skill content exceeds 10 MiB")
		}
	}
	return size, nil
}
func (h *handler) installSkill(w http.ResponseWriter, r *http.Request) {
	var b struct {
		Name           string          `json:"name"`
		Title          string          `json:"title"`
		Description    string          `json:"description"`
		Version        *string         `json:"version"`
		Source         json.RawMessage `json:"source"`
		Homepage       *string         `json:"homepage"`
		License        *string         `json:"license"`
		Files          []skillFile     `json:"files"`
		AutoUpdate     *bool           `json:"autoUpdate"`
		SkillID        string          `json:"skillId"`
		Names          []string        `json:"names"`
		AgentIDs       []string        `json:"agentIds"`
		All            bool            `json:"all"`
		ExternalSource string          `json:"sourceUrl"`
	}
	if httpx.DecodeJSON(r, &b) != nil {
		httpx.Error(w, 400, "invalid JSON")
		return
	}
	if b.SkillID != "" || len(b.Names) > 0 {
		h.installExistingSkills(w, r, b.SkillID, b.Names, b.AgentIDs, b.All)
		return
	}
	b.Name = slugify(b.Name)
	if b.Name == "" {
		httpx.Error(w, 400, "name required")
		return
	}
	size, e := validateSkillFiles(b.Files)
	if e != nil {
		statusErr(w, e)
		return
	}
	hasManifest := false
	for _, f := range b.Files {
		if path.Base(f.Path) == "SKILL.md" {
			hasManifest = true
		}
	}
	if !hasManifest {
		httpx.Error(w, 400, "SKILL.md is required")
		return
	}
	auto := true
	if b.AutoUpdate != nil {
		auto = *b.AutoUpdate
	}
	files, _ := json.Marshal(b.Files)
	now := h.store.now()
	id := h.store.id()
	_, e = h.deps.DB.ExecContext(r.Context(), h.store.q(`INSERT INTO skills(id,tenant_id,name,title,description,version,builtin,source_json,homepage,license,files_json,file_count,size_bytes,repo_key,auto_update,created_at,updated_at) VALUES(?,?,?,?,?,?,false,?,?,?,?,?,?,NULL,?,?,?)`), id, principal(r).TenantID, b.Name, b.Title, b.Description, b.Version, validJSON(b.Source, "{}"), b.Homepage, b.License, string(files), len(b.Files), size, auto, now, now)
	if e != nil {
		statusErr(w, e)
		return
	}
	x, _ := h.skillByID(r, id)
	httpx.JSON(w, http.StatusCreated, map[string]any{"skills": []Skill{x}, "installs": []any{}, "warnings": []any{}})
}

func (h *handler) installExistingSkills(w http.ResponseWriter, r *http.Request, skillID string, names, agentIDs []string, all bool) {
	tenant := principal(r).TenantID
	query := `SELECT id,name,title,description,version,builtin,source_json,homepage,license,files_json,file_count,size_bytes,auto_update,created_at,updated_at FROM skills WHERE tenant_id=? AND (`
	args := []any{tenant}
	if skillID != "" {
		query += `id=?`
		args = append(args, skillID)
	} else {
		query += strings.TrimSuffix(strings.Repeat(`name=? OR `, len(names)), ` OR `)
		for _, name := range names {
			args = append(args, slugify(name))
		}
	}
	query += `)`
	rows, err := h.deps.DB.QueryContext(r.Context(), h.store.q(query), args...)
	if err != nil {
		statusErr(w, err)
		return
	}
	skills := []Skill{}
	for rows.Next() {
		var skill Skill
		var source, files string
		var created, updated flexibleTime
		if rows.Scan(&skill.ID, &skill.Name, &skill.Title, &skill.Description, &skill.Version, &skill.Builtin, &source, &skill.Homepage, &skill.License, &files, &skill.FileCount, &skill.SizeBytes, &skill.AutoUpdate, &created, &updated) == nil {
			skill.Source = json.RawMessage(source)
			skill.Files = json.RawMessage(files)
			skill.CreatedAt = created.Time
			skill.UpdatedAt = updated.Time
			skills = append(skills, skill)
		}
	}
	rows.Close()
	if len(skills) == 0 {
		statusErr(w, ErrNotFound)
		return
	}
	if all {
		agentIDs = nil
		arows, e := h.deps.DB.QueryContext(r.Context(), h.store.q(`SELECT id FROM agents WHERE tenant_id=?`), tenant)
		if e == nil {
			for arows.Next() {
				var id string
				if arows.Scan(&id) == nil {
					agentIDs = append(agentIDs, id)
				}
			}
			arows.Close()
		}
	}
	installs := []map[string]any{}
	now := h.store.now()
	for _, agent := range agentIDs {
		for _, skill := range skills {
			id := h.store.id()
			_, e := h.deps.DB.ExecContext(r.Context(), h.store.q(`INSERT INTO agent_skills(id,tenant_id,agent_id,skill_id,name,enabled,path,version,status,error,created_at,updated_at) VALUES(?,?,?,?,?,TRUE,?,?,'installed',NULL,?,?) ON CONFLICT(agent_id,name) DO UPDATE SET skill_id=excluded.skill_id,enabled=TRUE,version=excluded.version,status='installed',error=NULL,updated_at=excluded.updated_at`), id, tenant, agent, skill.ID, skill.Name, "/skills/"+skill.Name, skill.Version, now, now)
			if e == nil {
				installs = append(installs, map[string]any{"id": id, "agentId": agent, "skillId": skill.ID, "name": skill.Name, "enabled": true, "path": "/skills/" + skill.Name, "version": skill.Version, "status": "installed"})
			}
		}
	}
	httpx.JSON(w, http.StatusOK, map[string]any{"skills": skills, "installs": installs, "warnings": []any{}})
}
func (h *handler) getSkill(w http.ResponseWriter, r *http.Request) {
	x, e := h.skillByID(r, chi.URLParam(r, "id"))
	if e != nil {
		statusErr(w, e)
		return
	}
	files := []skillFile{}
	_ = json.Unmarshal(x.Files, &files)
	httpx.JSON(w, 200, map[string]any{"skill": x, "files": files})
}
func (h *handler) deleteSkill(w http.ResponseWriter, r *http.Request) {
	res, e := h.deps.DB.ExecContext(r.Context(), h.store.q(`DELETE FROM skills WHERE tenant_id=? AND id=? AND builtin=false`), principal(r).TenantID, chi.URLParam(r, "id"))
	if e != nil {
		statusErr(w, e)
		return
	}
	n, _ := res.RowsAffected()
	if n == 0 {
		httpx.Error(w, 404, "Not found or builtin skill")
		return
	}
	httpx.JSON(w, 200, map[string]any{"ok": true})
}
func (h *handler) patchSkillAutoUpdate(w http.ResponseWriter, r *http.Request) {
	var b struct {
		AutoUpdate bool `json:"autoUpdate"`
	}
	if httpx.DecodeJSON(r, &b) != nil {
		httpx.Error(w, 400, "invalid JSON")
		return
	}
	res, e := h.deps.DB.ExecContext(r.Context(), h.store.q(`UPDATE skills SET auto_update=?,updated_at=? WHERE tenant_id=? AND id=?`), b.AutoUpdate, h.store.now(), principal(r).TenantID, chi.URLParam(r, "id"))
	if e != nil {
		statusErr(w, e)
		return
	}
	n, _ := res.RowsAffected()
	if n == 0 {
		statusErr(w, ErrNotFound)
		return
	}
	x, _ := h.skillByID(r, chi.URLParam(r, "id"))
	httpx.JSON(w, 200, map[string]any{"skill": x})
}

func (h *handler) listAgentSkills(w http.ResponseWriter, r *http.Request) {
	p := principal(r)
	agent := chi.URLParam(r, "id")
	if _, e := h.store.GetAgent(r.Context(), p.TenantID, agent); e != nil {
		statusErr(w, e)
		return
	}
	rows, e := h.deps.DB.QueryContext(r.Context(), h.store.q(`SELECT a.id,a.name,a.enabled,a.path,a.version,a.status,a.error,s.id,s.title,s.description FROM agent_skills a JOIN skills s ON s.id=a.skill_id WHERE a.tenant_id=? AND a.agent_id=? ORDER BY a.name`), p.TenantID, agent)
	if e != nil {
		statusErr(w, e)
		return
	}
	defer rows.Close()
	out := make([]map[string]any, 0)
	registered := map[string]bool{}
	for rows.Next() {
		var id, name, pth, status, skillID, title, description string
		var enabled bool
		var version, errText *string
		if e := rows.Scan(&id, &name, &enabled, &pth, &version, &status, &errText, &skillID, &title, &description); e != nil {
			statusErr(w, e)
			return
		}
		registered[name] = true
		out = append(out, map[string]any{"id": id, "name": name, "enabled": enabled, "path": pth, "version": version, "status": status, "error": errText, "skillId": skillID, "title": title, "description": description})
	}
	rows.Close()
	unregistered := []string{}
	if remote, selected, err := h.remoteWorkspace(r.Context(), p.TenantID, agent); err == nil && selected {
		_, entries, _ := remote.list(r.Context(), "/skills")
		for _, entry := range entries {
			if !entry.IsDir || registered[entry.Name] {
				continue
			}
			if _, _, err := remote.read(r.Context(), "/skills/"+entry.Name+"/SKILL.md", 1<<20); err == nil {
				unregistered = append(unregistered, entry.Name)
			}
		}
	} else if err == nil {
		if workspace, localErr := h.workspaceFor(r.Context(), p.TenantID, agent); localErr == nil {
			entries, _ := os.ReadDir(filepath.Join(workspace.root, "skills"))
			for _, entry := range entries {
				if entry.IsDir() && !registered[entry.Name()] {
					if _, statErr := os.Stat(filepath.Join(workspace.root, "skills", entry.Name(), "SKILL.md")); statErr == nil {
						unregistered = append(unregistered, entry.Name())
					}
				}
			}
		}
	}
	sort.Strings(unregistered)
	httpx.JSON(w, 200, map[string]any{"skills": out, "unregistered": unregistered})
}
func (h *handler) attachSkill(w http.ResponseWriter, r *http.Request) {
	var b struct {
		SkillID       string   `json:"skillId"`
		Name          string   `json:"name"`
		Enabled       *bool    `json:"enabled"`
		Names         []string `json:"names"`
		Source        string   `json:"source"`
		WorkspacePath string   `json:"workspacePath"`
	}
	if httpx.DecodeJSON(r, &b) != nil {
		httpx.Error(w, 400, "invalid JSON")
		return
	}
	p := principal(r)
	agent := chi.URLParam(r, "id")
	if _, e := h.store.GetAgent(r.Context(), p.TenantID, agent); e != nil {
		statusErr(w, e)
		return
	}
	if b.SkillID == "" {
		if len(b.Names) > 0 {
			b.Name = b.Names[0]
		}
		if b.Name == "" && b.Source != "" {
			parts := strings.FieldsFunc(strings.TrimSuffix(b.Source, "/"), func(r rune) bool { return r == '/' || r == '#' })
			if len(parts) > 0 {
				b.Name = parts[len(parts)-1]
			}
		}
		_ = h.deps.DB.QueryRowContext(r.Context(), h.store.q(`SELECT id FROM skills WHERE tenant_id=? AND name=?`), p.TenantID, slugify(b.Name)).Scan(&b.SkillID)
	}
	var name string
	var version *string
	e := h.deps.DB.QueryRowContext(r.Context(), h.store.q(`SELECT name,version FROM skills WHERE tenant_id=? AND id=?`), p.TenantID, b.SkillID).Scan(&name, &version)
	if errors.Is(e, sql.ErrNoRows) {
		statusErr(w, ErrNotFound)
		return
	}
	if e != nil {
		statusErr(w, e)
		return
	}
	if b.Name != "" {
		name = slugify(b.Name)
	}
	enabled := true
	if b.Enabled != nil {
		enabled = *b.Enabled
	}
	now := h.store.now()
	_, e = h.deps.DB.ExecContext(r.Context(), h.store.q(`INSERT INTO agent_skills(id,tenant_id,agent_id,skill_id,name,enabled,path,version,status,error,created_at,updated_at) VALUES(?,?,?,?,?,?,?,?,'installed',NULL,?,?)`), h.store.id(), p.TenantID, agent, b.SkillID, name, enabled, "/skills/"+name, version, now, now)
	if e != nil {
		statusErr(w, e)
		return
	}
	var skill Skill
	skill, _ = h.skillByID(r, b.SkillID)
	install := map[string]any{"name": name, "skillId": b.SkillID, "agentId": agent, "enabled": enabled, "path": "/skills/" + name, "version": version, "status": "installed"}
	httpx.JSON(w, http.StatusCreated, map[string]any{"skills": []Skill{skill}, "installs": []any{install}, "warnings": []any{}})
}
func (h *handler) patchAgentSkill(w http.ResponseWriter, r *http.Request) {
	var b struct {
		Enabled bool `json:"enabled"`
	}
	if httpx.DecodeJSON(r, &b) != nil {
		httpx.Error(w, 400, "invalid JSON")
		return
	}
	p := principal(r)
	res, e := h.deps.DB.ExecContext(r.Context(), h.store.q(`UPDATE agent_skills SET enabled=?,updated_at=? WHERE tenant_id=? AND agent_id=? AND name=?`), b.Enabled, h.store.now(), p.TenantID, chi.URLParam(r, "id"), chi.URLParam(r, "name"))
	if e != nil {
		statusErr(w, e)
		return
	}
	n, _ := res.RowsAffected()
	if n == 0 {
		statusErr(w, ErrNotFound)
		return
	}
	rows, e := h.deps.DB.QueryContext(r.Context(), h.store.q(`SELECT a.id,a.name,a.enabled,a.path,a.version,a.status,a.error,a.skill_id,s.title,s.description FROM agent_skills a JOIN skills s ON s.id=a.skill_id WHERE a.tenant_id=? AND a.agent_id=? AND a.name=?`), p.TenantID, chi.URLParam(r, "id"), chi.URLParam(r, "name"))
	if e != nil {
		statusErr(w, e)
		return
	}
	defer rows.Close()
	if rows.Next() {
		var id, name, path, status, skillID, title, description string
		var enabled bool
		var version, errText *string
		if rows.Scan(&id, &name, &enabled, &path, &version, &status, &errText, &skillID, &title, &description) == nil {
			httpx.JSON(w, http.StatusOK, map[string]any{"skill": map[string]any{"id": id, "name": name, "enabled": enabled, "path": path, "version": version, "status": status, "error": errText, "skillId": skillID, "title": title, "description": description}})
			return
		}
	}
	statusErr(w, ErrNotFound)
}
func (h *handler) detachSkill(w http.ResponseWriter, r *http.Request) {
	p := principal(r)
	res, e := h.deps.DB.ExecContext(r.Context(), h.store.q(`DELETE FROM agent_skills WHERE tenant_id=? AND agent_id=? AND name=?`), p.TenantID, chi.URLParam(r, "id"), chi.URLParam(r, "name"))
	if e != nil {
		statusErr(w, e)
		return
	}
	n, _ := res.RowsAffected()
	if n == 0 {
		statusErr(w, ErrNotFound)
		return
	}
	httpx.JSON(w, 200, map[string]any{"ok": true})
}
func (h *handler) getAgentSkillFile(w http.ResponseWriter, r *http.Request) {
	p := principal(r)
	var filesRaw string
	e := h.deps.DB.QueryRowContext(r.Context(), h.store.q(`SELECT s.files_json FROM agent_skills a JOIN skills s ON s.id=a.skill_id WHERE a.tenant_id=? AND a.agent_id=? AND a.name=?`), p.TenantID, chi.URLParam(r, "id"), chi.URLParam(r, "name")).Scan(&filesRaw)
	if errors.Is(e, sql.ErrNoRows) {
		statusErr(w, ErrNotFound)
		return
	}
	if e != nil {
		statusErr(w, e)
		return
	}
	requested := path.Clean(strings.TrimPrefix(r.URL.Query().Get("path"), "/"))
	var files []skillFile
	_ = json.Unmarshal([]byte(filesRaw), &files)
	for _, f := range files {
		if path.Clean(strings.TrimPrefix(f.Path, "/")) == requested {
			w.Header().Set("Content-Type", "text/plain; charset=utf-8")
			w.WriteHeader(200)
			_, _ = w.Write([]byte(f.Content))
			return
		}
	}
	statusErr(w, ErrNotFound)
}

func (h *handler) memoryProviderMeta(w http.ResponseWriter, r *http.Request) {
	httpx.JSON(w, 200, map[string]any{"kinds": memoryProviderKinds()})
}

func memoryProviderKinds() []map[string]any {
	return []map[string]any{
		{"kind": "builtin", "name": "Built-in", "description": "Local layered memory with keyword, graph, and optional embedding retrieval", "storesLocally": true},
		{"kind": "traditional", "name": "Traditional memory", "description": "Plain text notes returned as a complete context", "storesLocally": true},
		{"kind": "mem0", "name": "mem0", "description": "Connect an existing mem0 deployment", "storesLocally": false},
		{"kind": "openviking", "name": "OpenViking", "description": "Connect an OpenViking context filesystem", "storesLocally": false},
	}
}

func memoryProviderKindMeta(kind string) map[string]any {
	for _, item := range memoryProviderKinds() {
		if item["kind"] == kind {
			return item
		}
	}
	return map[string]any{"kind": kind, "name": kind, "description": "", "storesLocally": false}
}

func (h *handler) memoryProviderDTO(id, tenant, name, slug, kind, configRaw string, isDefault bool, status string, lastError *string, created, updated flexibleTime) map[string]any {
	config := map[string]any{}
	_ = json.Unmarshal([]byte(configRaw), &config)
	configured := false
	if _, ok := config["apiKeyEnc"].(string); ok {
		configured = true
		delete(config, "apiKeyEnc")
	}
	if key, ok := config["apiKey"].(string); ok && key != "" {
		configured = true
	}
	if configured {
		config["apiKey"] = "***"
	} else {
		delete(config, "apiKey")
	}
	return map[string]any{"id": id, "tenantId": tenant, "name": name, "slug": slug, "kind": kind, "config": config, "isDefault": isDefault, "status": status, "lastError": lastError, "createdAt": created.Time, "updatedAt": updated.Time, "meta": memoryProviderKindMeta(kind)}
}

func (h *handler) listMemoryProviders(w http.ResponseWriter, r *http.Request) {
	p := principal(r)
	rows, e := h.deps.DB.QueryContext(r.Context(), h.store.q(`SELECT id,tenant_id,name,slug,kind,config_json,is_default,status,last_error,created_at,updated_at FROM memory_providers WHERE tenant_id=? ORDER BY created_at`), p.TenantID)
	if e != nil {
		statusErr(w, e)
		return
	}
	defer rows.Close()
	out := make([]map[string]any, 0)
	for rows.Next() {
		var id, tenant, name, slug, kind, cfg, status string
		var isDefault bool
		var lastError *string
		var c, u flexibleTime
		if rows.Scan(&id, &tenant, &name, &slug, &kind, &cfg, &isDefault, &status, &lastError, &c, &u) != nil {
			continue
		}
		out = append(out, h.memoryProviderDTO(id, tenant, name, slug, kind, cfg, isDefault, status, lastError, c, u))
	}
	agents := []map[string]any{}
	agentRows, e := h.deps.DB.QueryContext(r.Context(), h.store.q(`SELECT id,name,slug,enable_memory,memory_provider_id FROM agents WHERE tenant_id=? ORDER BY name`), p.TenantID)
	if e == nil {
		for agentRows.Next() {
			var id, name, slug string
			var enabled bool
			var providerID *string
			if agentRows.Scan(&id, &name, &slug, &enabled, &providerID) == nil {
				agents = append(agents, map[string]any{"id": id, "name": name, "slug": slug, "enableMemory": enabled, "memoryProviderId": providerID})
			}
		}
		agentRows.Close()
	}
	httpx.JSON(w, 200, map[string]any{"providers": out, "agents": agents, "kinds": memoryProviderKinds(), "note": "Manage memory providers here; select one for each Agent on its memory page."})
}
func (h *handler) createMemoryProvider(w http.ResponseWriter, r *http.Request) {
	var b struct {
		Name, Kind, Slug string
		Config           map[string]any `json:"config"`
		IsDefault        bool           `json:"isDefault"`
	}
	if httpx.DecodeJSON(r, &b) != nil || b.Name == "" || b.Kind == "" {
		httpx.Error(w, 400, "name and kind required")
		return
	}
	if !listContains([]string{"builtin", "traditional", "mem0", "openviking"}, b.Kind) {
		httpx.Error(w, http.StatusBadRequest, "invalid kind")
		return
	}
	p := principal(r)
	if !p.IsPlatformAdmin && p.Role != "owner" && p.Role != "admin" {
		httpx.Error(w, http.StatusForbidden, "Admin only")
		return
	}
	if b.Slug == "" {
		b.Slug = slugify(b.Name)
	}
	id := h.store.id()
	if key, ok := b.Config["apiKey"].(string); ok && key != "" {
		plain, _ := json.Marshal(map[string]any{"apiKey": key})
		enc, err := secretBox(h.deps.Secret, "memory-provider:"+id, plain)
		if err != nil {
			statusErr(w, err)
			return
		}
		delete(b.Config, "apiKey")
		b.Config["apiKeyEnc"] = enc
	}
	now := h.store.now()
	var existing int
	_ = h.deps.DB.QueryRowContext(r.Context(), h.store.q(`SELECT COUNT(*) FROM memory_providers WHERE tenant_id=?`), p.TenantID).Scan(&existing)
	if existing == 0 {
		b.IsDefault = true
	}
	if b.IsDefault {
		_, _ = h.deps.DB.ExecContext(r.Context(), h.store.q(`UPDATE memory_providers SET is_default=FALSE,updated_at=? WHERE tenant_id=?`), now, p.TenantID)
	}
	configRaw, _ := json.Marshal(b.Config)
	_, e := h.deps.DB.ExecContext(r.Context(), h.store.q(`INSERT INTO memory_providers(id,tenant_id,name,slug,kind,config_json,secret_json,enabled,is_default,status,last_error,created_at,updated_at) VALUES(?,?,?,?,?,?, '{}',TRUE,?,'ready',NULL,?,?)`), id, p.TenantID, strings.TrimSpace(b.Name), strings.ToLower(b.Slug), b.Kind, string(configRaw), b.IsDefault, now, now)
	if e != nil {
		statusErr(w, e)
		return
	}
	var tenant, name, slug, kind, stored, status string
	var isDefault bool
	var lastError *string
	var c, u flexibleTime
	if e = h.deps.DB.QueryRowContext(r.Context(), h.store.q(`SELECT tenant_id,name,slug,kind,config_json,is_default,status,last_error,created_at,updated_at FROM memory_providers WHERE id=?`), id).Scan(&tenant, &name, &slug, &kind, &stored, &isDefault, &status, &lastError, &c, &u); e != nil {
		statusErr(w, e)
		return
	}
	httpx.JSON(w, http.StatusCreated, h.memoryProviderDTO(id, tenant, name, slug, kind, stored, isDefault, status, lastError, c, u))
}
func (h *handler) getMemoryProvider(w http.ResponseWriter, r *http.Request) {
	var id, tenant, name, slug, kind, cfg, status string
	var isDefault bool
	var lastError *string
	var c, u flexibleTime
	e := h.deps.DB.QueryRowContext(r.Context(), h.store.q(`SELECT id,tenant_id,name,slug,kind,config_json,is_default,status,last_error,created_at,updated_at FROM memory_providers WHERE tenant_id=? AND id=?`), principal(r).TenantID, chi.URLParam(r, "id")).Scan(&id, &tenant, &name, &slug, &kind, &cfg, &isDefault, &status, &lastError, &c, &u)
	if errors.Is(e, sql.ErrNoRows) {
		statusErr(w, ErrNotFound)
		return
	}
	if e != nil {
		statusErr(w, e)
		return
	}
	httpx.JSON(w, 200, h.memoryProviderDTO(id, tenant, name, slug, kind, cfg, isDefault, status, lastError, c, u))
}
func (h *handler) patchMemoryProvider(w http.ResponseWriter, r *http.Request) {
	p := principal(r)
	if !p.IsPlatformAdmin && p.Role != "owner" && p.Role != "admin" {
		httpx.Error(w, http.StatusForbidden, "Admin only")
		return
	}
	m, e := decodeMap(r)
	if e != nil {
		httpx.Error(w, 400, "invalid JSON")
		return
	}
	sets := []string{}
	args := []any{}
	for k, col := range map[string]string{"name": "name", "status": "status", "lastError": "last_error"} {
		if v, ok := m[k]; ok {
			sets = append(sets, col+"=?")
			args = append(args, v)
		}
	}
	if v, ok := m["config"]; ok {
		var existingRaw string
		if e = h.deps.DB.QueryRowContext(r.Context(), h.store.q(`SELECT config_json FROM memory_providers WHERE tenant_id=? AND id=?`), p.TenantID, chi.URLParam(r, "id")).Scan(&existingRaw); e != nil {
			statusErr(w, ErrNotFound)
			return
		}
		existing := map[string]any{}
		_ = json.Unmarshal([]byte(existingRaw), &existing)
		patch, _ := v.(map[string]any)
		for key, value := range patch {
			existing[key] = value
		}
		if key, ok := existing["apiKey"].(string); ok {
			if key == "***" {
				delete(existing, "apiKey")
			} else if key != "" {
				plain, _ := json.Marshal(map[string]any{"apiKey": key})
				enc, encErr := secretBox(h.deps.Secret, "memory-provider:"+chi.URLParam(r, "id"), plain)
				if encErr != nil {
					statusErr(w, encErr)
					return
				}
				delete(existing, "apiKey")
				existing["apiKeyEnc"] = enc
			}
		}
		b, _ := json.Marshal(existing)
		sets = append(sets, "config_json=?")
		args = append(args, string(b))
	}
	if value, ok := m["isDefault"].(bool); ok && value {
		_, _ = h.deps.DB.ExecContext(r.Context(), h.store.q(`UPDATE memory_providers SET is_default=FALSE,updated_at=? WHERE tenant_id=?`), h.store.now(), p.TenantID)
		sets = append(sets, "is_default=TRUE")
	}
	if len(sets) == 0 {
		h.getMemoryProvider(w, r)
		return
	}
	sets = append(sets, "updated_at=?")
	args = append(args, h.store.now(), p.TenantID, chi.URLParam(r, "id"))
	res, e := h.deps.DB.ExecContext(r.Context(), h.store.q(`UPDATE memory_providers SET `+strings.Join(sets, ",")+` WHERE tenant_id=? AND id=?`), args...)
	if e != nil {
		statusErr(w, e)
		return
	}
	n, _ := res.RowsAffected()
	if n == 0 {
		statusErr(w, ErrNotFound)
		return
	}
	h.getMemoryProvider(w, r)
}
func (h *handler) deleteMemoryProvider(w http.ResponseWriter, r *http.Request) {
	p := principal(r)
	if !p.IsPlatformAdmin && p.Role != "owner" && p.Role != "admin" {
		httpx.Error(w, http.StatusForbidden, "Admin only")
		return
	}
	var bound int
	_ = h.deps.DB.QueryRowContext(r.Context(), h.store.q(`SELECT COUNT(*) FROM agents WHERE tenant_id=? AND memory_provider_id=?`), p.TenantID, chi.URLParam(r, "id")).Scan(&bound)
	if bound > 0 {
		httpx.Error(w, http.StatusBadRequest, "agents are still bound to this provider")
		return
	}
	var wasDefault bool
	_ = h.deps.DB.QueryRowContext(r.Context(), h.store.q(`SELECT is_default FROM memory_providers WHERE tenant_id=? AND id=?`), p.TenantID, chi.URLParam(r, "id")).Scan(&wasDefault)
	res, e := h.deps.DB.ExecContext(r.Context(), h.store.q(`DELETE FROM memory_providers WHERE tenant_id=? AND id=?`), p.TenantID, chi.URLParam(r, "id"))
	if e != nil {
		statusErr(w, e)
		return
	}
	n, _ := res.RowsAffected()
	if n == 0 {
		statusErr(w, ErrNotFound)
		return
	}
	if wasDefault {
		_, _ = h.deps.DB.ExecContext(r.Context(), h.store.q(`UPDATE memory_providers SET is_default=TRUE,updated_at=? WHERE id=(SELECT id FROM memory_providers WHERE tenant_id=? ORDER BY created_at,id LIMIT 1)`), h.store.now(), p.TenantID)
	}
	httpx.JSON(w, 200, map[string]any{"ok": true})
}
func (h *handler) healthMemoryProvider(w http.ResponseWriter, r *http.Request) {
	p := principal(r)
	if !p.IsPlatformAdmin && p.Role != "owner" && p.Role != "admin" {
		httpx.Error(w, http.StatusForbidden, "Admin only")
		return
	}
	var kind, cfgRaw string
	if e := h.deps.DB.QueryRowContext(r.Context(), h.store.q(`SELECT kind,config_json FROM memory_providers WHERE tenant_id=? AND id=?`), p.TenantID, chi.URLParam(r, "id")).Scan(&kind, &cfgRaw); errors.Is(e, sql.ErrNoRows) {
		statusErr(w, ErrNotFound)
		return
	} else if e != nil {
		statusErr(w, e)
		return
	}
	if kind == "builtin" || kind == "traditional" {
		httpx.JSON(w, http.StatusOK, map[string]any{"status": "healthy", "message": "local store"})
		return
	}
	config := map[string]any{}
	_ = json.Unmarshal([]byte(cfgRaw), &config)
	baseURL, _ := config["baseUrl"].(string)
	if baseURL == "" {
		httpx.JSON(w, http.StatusOK, map[string]any{"status": "unhealthy", "message": "baseUrl required"})
		return
	}
	u, e := safeProviderURL(baseURL, func() string {
		if kind == "openviking" {
			return "health"
		}
		return "health"
	}())
	if e != nil {
		httpx.JSON(w, http.StatusOK, map[string]any{"status": "unhealthy", "message": e.Error()})
		return
	}
	req, _ := http.NewRequestWithContext(r.Context(), http.MethodGet, u.String(), nil)
	resp, e := h.service.gateway.client.Do(req)
	if e != nil {
		httpx.JSON(w, http.StatusOK, map[string]any{"status": "unhealthy", "message": e.Error()})
		return
	}
	_ = resp.Body.Close()
	status := "healthy"
	if resp.StatusCode < 200 || resp.StatusCode >= 300 {
		status = "unhealthy"
	}
	httpx.JSON(w, http.StatusOK, map[string]any{"status": status, "message": resp.Status})
}

var _ = strconv.Itoa
