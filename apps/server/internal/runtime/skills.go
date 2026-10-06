// SPDX-License-Identifier: AGPL-3.0-or-later
package runtime

import (
	"encoding/json"
	"errors"
	"net/http"
	"os"
	"path"
	"path/filepath"
	"sort"
	"strings"
	"time"

	"github.com/Moonrend/Zakura/apps/server/internal/platform/db/models"
	"github.com/Moonrend/Zakura/apps/server/internal/platform/httpx"
	"github.com/go-chi/chi/v5"
	"gorm.io/gorm"
	"gorm.io/gorm/clause"
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
func runtimeTimeString(t time.Time) string { return t.UTC().Format(time.RFC3339Nano) }

func skillFromModel(m models.Skill) Skill {
	x := Skill{Name: m.Name, Title: m.Title, Description: m.Description, Version: m.Version, Builtin: m.Builtin, Homepage: m.Homepage, License: m.License, FileCount: int(m.FileCount), SizeBytes: int64(m.SizeBytes), AutoUpdate: m.AutoUpdate}
	if m.ID != nil {
		x.ID = *m.ID
	}
	x.Source = json.RawMessage(m.SourceJSON)
	x.Files = json.RawMessage(m.FilesJSON)
	var c, u flexibleTime
	_ = c.Scan(m.CreatedAt)
	_ = u.Scan(m.UpdatedAt)
	x.CreatedAt, x.UpdatedAt = c.Time, u.Time
	return x
}

func (h *handler) skillByID(r *http.Request, id string) (Skill, error) {
	var m models.Skill
	e := h.deps.Gorm.WithContext(r.Context()).Where("tenant_id = ? AND id = ?", principal(r).TenantID, id).Take(&m).Error
	if errors.Is(e, gorm.ErrRecordNotFound) {
		e = ErrNotFound
	}
	if e != nil {
		return Skill{}, e
	}
	return skillFromModel(m), nil
}
func (h *handler) listSkills(w http.ResponseWriter, r *http.Request) {
	p := principal(r)
	q := h.deps.Gorm.WithContext(r.Context()).Model(&models.Skill{}).Where("tenant_id = ?", p.TenantID)
	if term := strings.TrimSpace(r.URL.Query().Get("q")); term != "" {
		x := "%" + strings.ToLower(term) + "%"
		q = q.Where(`(LOWER(name) LIKE ? OR LOWER(title) LIKE ? OR LOWER(description) LIKE ?)`, x, x, x)
	}
	var ms []models.Skill
	if e := q.Order("builtin DESC, name").Find(&ms).Error; e != nil {
		statusErr(w, e)
		return
	}
	out := make([]Skill, 0, len(ms))
	for _, m := range ms {
		x := skillFromModel(m)
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
	m := models.Skill{ID: &id, TenantID: principal(r).TenantID, Name: b.Name, Title: b.Title, Description: b.Description, Version: b.Version, SourceJSON: validJSON(b.Source, "{}"), Homepage: b.Homepage, License: b.License, FilesJSON: string(files), FileCount: int32(len(b.Files)), SizeBytes: int32(size), AutoUpdate: auto, CreatedAt: runtimeTimeString(now), UpdatedAt: runtimeTimeString(now)}
	if e = h.deps.Gorm.WithContext(r.Context()).Create(&m).Error; e != nil {
		statusErr(w, e)
		return
	}
	x, _ := h.skillByID(r, id)
	httpx.JSON(w, http.StatusCreated, map[string]any{"skills": []Skill{x}, "installs": []any{}, "warnings": []any{}})
}

func (h *handler) installExistingSkills(w http.ResponseWriter, r *http.Request, skillID string, names, agentIDs []string, all bool) {
	tenant := principal(r).TenantID
	q := h.deps.Gorm.WithContext(r.Context()).Model(&models.Skill{}).Where("tenant_id = ?", tenant)
	if skillID != "" {
		q = q.Where("id = ?", skillID)
	} else {
		slugs := make([]string, 0, len(names))
		for _, name := range names {
			slugs = append(slugs, slugify(name))
		}
		q = q.Where("name IN ?", slugs)
	}
	var ms []models.Skill
	if err := q.Find(&ms).Error; err != nil {
		statusErr(w, err)
		return
	}
	skills := []Skill{}
	for _, m := range ms {
		skills = append(skills, skillFromModel(m))
	}
	if len(skills) == 0 {
		statusErr(w, ErrNotFound)
		return
	}
	if all {
		agentIDs = nil
		_ = h.deps.Gorm.WithContext(r.Context()).Model(&models.Agent{}).Where("tenant_id = ?", tenant).Pluck("id", &agentIDs).Error
	}
	installs := []map[string]any{}
	now := runtimeTimeString(h.store.now())
	for _, agent := range agentIDs {
		for _, skill := range skills {
			id := h.store.id()
			e := h.deps.Gorm.WithContext(r.Context()).
				Clauses(clause.OnConflict{
					Columns: []clause.Column{{Name: "agent_id"}, {Name: "name"}},
					DoUpdates: clause.Assignments(map[string]any{
						"skill_id": gorm.Expr("excluded.skill_id"), "enabled": true, "version": gorm.Expr("excluded.version"),
						"status": "installed", "error": nil, "updated_at": gorm.Expr("excluded.updated_at"),
					}),
				}).
				Table("agent_skills").
				Create(map[string]any{"id": id, "tenant_id": tenant, "agent_id": agent, "skill_id": skill.ID, "name": skill.Name, "enabled": true, "path": "/skills/" + skill.Name, "version": skill.Version, "status": "installed", "error": nil, "created_at": now, "updated_at": now}).Error
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
	res := h.deps.Gorm.WithContext(r.Context()).Where("tenant_id = ? AND id = ? AND builtin = false", principal(r).TenantID, chi.URLParam(r, "id")).Delete(&models.Skill{})
	if res.Error != nil {
		statusErr(w, res.Error)
		return
	}
	if res.RowsAffected == 0 {
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
	res := h.deps.Gorm.WithContext(r.Context()).Model(&models.Skill{}).Where("tenant_id = ? AND id = ?", principal(r).TenantID, chi.URLParam(r, "id")).Updates(map[string]any{"auto_update": b.AutoUpdate, "updated_at": runtimeTimeString(h.store.now())})
	if res.Error != nil {
		statusErr(w, res.Error)
		return
	}
	if res.RowsAffected == 0 {
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
	type agentSkillRecord struct {
		ID          string  `gorm:"column:id"`
		Name        string  `gorm:"column:name"`
		Enabled     bool    `gorm:"column:enabled"`
		Path        string  `gorm:"column:path"`
		Version     *string `gorm:"column:version"`
		Status      string  `gorm:"column:status"`
		Error       *string `gorm:"column:error"`
		SkillID     string  `gorm:"column:skill_id"`
		Title       string  `gorm:"column:title"`
		Description string  `gorm:"column:description"`
	}
	var recs []agentSkillRecord
	if e := h.deps.Gorm.WithContext(r.Context()).Raw(`SELECT a.id AS id, a.name AS name, a.enabled AS enabled, a.path AS path, a.version AS version, a.status AS status, a.error AS error, s.id AS skill_id, s.title AS title, s.description AS description FROM agent_skills a JOIN skills s ON s.id = a.skill_id WHERE a.tenant_id = ? AND a.agent_id = ? ORDER BY a.name`, p.TenantID, agent).Scan(&recs).Error; e != nil {
		statusErr(w, e)
		return
	}
	out := make([]map[string]any, 0)
	registered := map[string]bool{}
	for _, rec := range recs {
		registered[rec.Name] = true
		out = append(out, map[string]any{"id": rec.ID, "name": rec.Name, "enabled": rec.Enabled, "path": rec.Path, "version": rec.Version, "status": rec.Status, "error": rec.Error, "skillId": rec.SkillID, "title": rec.Title, "description": rec.Description})
	}
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
		var found models.Skill
		if err := h.deps.Gorm.WithContext(r.Context()).Where("tenant_id = ? AND name = ?", p.TenantID, slugify(b.Name)).Take(&found).Error; err == nil && found.ID != nil {
			b.SkillID = *found.ID
		}
	}
	var sm models.Skill
	e := h.deps.Gorm.WithContext(r.Context()).Where("tenant_id = ? AND id = ?", p.TenantID, b.SkillID).Take(&sm).Error
	if errors.Is(e, gorm.ErrRecordNotFound) {
		statusErr(w, ErrNotFound)
		return
	}
	if e != nil {
		statusErr(w, e)
		return
	}
	name := sm.Name
	version := sm.Version
	if b.Name != "" {
		name = slugify(b.Name)
	}
	enabled := true
	if b.Enabled != nil {
		enabled = *b.Enabled
	}
	now := h.store.now()
	asID := h.store.id()
	as := models.AgentSkill{ID: &asID, TenantID: p.TenantID, AgentID: agent, SkillID: b.SkillID, Name: name, Enabled: enabled, Path: "/skills/" + name, Version: version, Status: "installed", CreatedAt: runtimeTimeString(now), UpdatedAt: runtimeTimeString(now)}
	if e = h.deps.Gorm.WithContext(r.Context()).Create(&as).Error; e != nil {
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
	res := h.deps.Gorm.WithContext(r.Context()).Model(&models.AgentSkill{}).Where("tenant_id = ? AND agent_id = ? AND name = ?", p.TenantID, chi.URLParam(r, "id"), chi.URLParam(r, "name")).Updates(map[string]any{"enabled": b.Enabled, "updated_at": runtimeTimeString(h.store.now())})
	if res.Error != nil {
		statusErr(w, res.Error)
		return
	}
	if res.RowsAffected == 0 {
		statusErr(w, ErrNotFound)
		return
	}
	type agentSkillRow struct {
		ID          string  `gorm:"column:id"`
		Name        string  `gorm:"column:name"`
		Enabled     bool    `gorm:"column:enabled"`
		Path        string  `gorm:"column:path"`
		Version     *string `gorm:"column:version"`
		Status      string  `gorm:"column:status"`
		Error       *string `gorm:"column:error"`
		SkillID     string  `gorm:"column:skill_id"`
		Title       string  `gorm:"column:title"`
		Description string  `gorm:"column:description"`
	}
	var rec agentSkillRow
	e := h.deps.Gorm.WithContext(r.Context()).Table("agent_skills AS a").Select("a.id AS id, a.name AS name, a.enabled AS enabled, a.path AS path, a.version AS version, a.status AS status, a.error AS error, a.skill_id AS skill_id, s.title AS title, s.description AS description").Joins("JOIN skills s ON s.id = a.skill_id").Where("a.tenant_id = ? AND a.agent_id = ? AND a.name = ?", p.TenantID, chi.URLParam(r, "id"), chi.URLParam(r, "name")).Take(&rec).Error
	if errors.Is(e, gorm.ErrRecordNotFound) {
		statusErr(w, ErrNotFound)
		return
	}
	if e != nil {
		statusErr(w, e)
		return
	}
	httpx.JSON(w, http.StatusOK, map[string]any{"skill": map[string]any{"id": rec.ID, "name": rec.Name, "enabled": rec.Enabled, "path": rec.Path, "version": rec.Version, "status": rec.Status, "error": rec.Error, "skillId": rec.SkillID, "title": rec.Title, "description": rec.Description}})
}
func (h *handler) detachSkill(w http.ResponseWriter, r *http.Request) {
	p := principal(r)
	res := h.deps.Gorm.WithContext(r.Context()).Where("tenant_id = ? AND agent_id = ? AND name = ?", p.TenantID, chi.URLParam(r, "id"), chi.URLParam(r, "name")).Delete(&models.AgentSkill{})
	if res.Error != nil {
		statusErr(w, res.Error)
		return
	}
	if res.RowsAffected == 0 {
		statusErr(w, ErrNotFound)
		return
	}
	httpx.JSON(w, 200, map[string]any{"ok": true})
}
func (h *handler) getAgentSkillFile(w http.ResponseWriter, r *http.Request) {
	p := principal(r)
	var row struct {
		FilesJSON string `gorm:"column:files_json"`
	}
	e := h.deps.Gorm.WithContext(r.Context()).Table("agent_skills AS a").Select("s.files_json AS files_json").Joins("JOIN skills s ON s.id = a.skill_id").Where("a.tenant_id = ? AND a.agent_id = ? AND a.name = ?", p.TenantID, chi.URLParam(r, "id"), chi.URLParam(r, "name")).Take(&row).Error
	if errors.Is(e, gorm.ErrRecordNotFound) {
		statusErr(w, ErrNotFound)
		return
	}
	if e != nil {
		statusErr(w, e)
		return
	}
	filesRaw := row.FilesJSON
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

func memoryProviderTime(v string) time.Time {
	var t flexibleTime
	_ = t.Scan(v)
	return t.Time
}

func (h *handler) memoryProviderDTO(id, tenant, name, slug, kind, configRaw string, isDefault bool, status string, lastError *string, created, updated time.Time) map[string]any {
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
	return map[string]any{"id": id, "tenantId": tenant, "name": name, "slug": slug, "kind": kind, "config": config, "isDefault": isDefault, "status": status, "lastError": lastError, "createdAt": created, "updatedAt": updated, "meta": memoryProviderKindMeta(kind)}
}

func (h *handler) listMemoryProviders(w http.ResponseWriter, r *http.Request) {
	p := principal(r)
	var ms []models.MemoryProvider
	if e := h.deps.Gorm.WithContext(r.Context()).Where("tenant_id = ?", p.TenantID).Order("created_at").Find(&ms).Error; e != nil {
		statusErr(w, e)
		return
	}
	out := make([]map[string]any, 0, len(ms))
	for _, m := range ms {
		id := ""
		if m.ID != nil {
			id = *m.ID
		}
		out = append(out, h.memoryProviderDTO(id, m.TenantID, m.Name, m.Slug, m.Kind, m.ConfigJSON, m.IsDefault, m.Status, m.LastError, memoryProviderTime(m.CreatedAt), memoryProviderTime(m.UpdatedAt)))
	}
	agents := []map[string]any{}
	var ams []models.Agent
	if e := h.deps.Gorm.WithContext(r.Context()).Where("tenant_id = ?", p.TenantID).Order("name").Find(&ams).Error; e == nil {
		for _, a := range ams {
			id := ""
			if a.ID != nil {
				id = *a.ID
			}
			agents = append(agents, map[string]any{"id": id, "name": a.Name, "slug": a.Slug, "enableMemory": a.EnableMemory, "memoryProviderId": a.MemoryProviderID})
		}
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
	nowStr := runtimeTimeString(now)
	var existing int64
	_ = h.deps.Gorm.WithContext(r.Context()).Model(&models.MemoryProvider{}).Where("tenant_id = ?", p.TenantID).Count(&existing).Error
	if existing == 0 {
		b.IsDefault = true
	}
	if b.IsDefault {
		h.deps.Gorm.WithContext(r.Context()).Model(&models.MemoryProvider{}).Where("tenant_id = ?", p.TenantID).Updates(map[string]any{"is_default": false, "updated_at": nowStr})
	}
	configRaw, _ := json.Marshal(b.Config)
	m := models.MemoryProvider{ID: &id, TenantID: p.TenantID, Name: strings.TrimSpace(b.Name), Slug: strings.ToLower(b.Slug), Kind: b.Kind, ConfigJSON: string(configRaw), SecretJSON: "{}", Enabled: true, IsDefault: b.IsDefault, Status: "ready", CreatedAt: nowStr, UpdatedAt: nowStr}
	if e := h.deps.Gorm.WithContext(r.Context()).Create(&m).Error; e != nil {
		statusErr(w, e)
		return
	}
	var stored models.MemoryProvider
	if e := h.deps.Gorm.WithContext(r.Context()).Where("id = ?", id).Take(&stored).Error; e != nil {
		statusErr(w, e)
		return
	}
	sid := id
	if stored.ID != nil {
		sid = *stored.ID
	}
	httpx.JSON(w, http.StatusCreated, h.memoryProviderDTO(sid, stored.TenantID, stored.Name, stored.Slug, stored.Kind, stored.ConfigJSON, stored.IsDefault, stored.Status, stored.LastError, memoryProviderTime(stored.CreatedAt), memoryProviderTime(stored.UpdatedAt)))
}
func (h *handler) getMemoryProvider(w http.ResponseWriter, r *http.Request) {
	var m models.MemoryProvider
	e := h.deps.Gorm.WithContext(r.Context()).Where("tenant_id = ? AND id = ?", principal(r).TenantID, chi.URLParam(r, "id")).Take(&m).Error
	if errors.Is(e, gorm.ErrRecordNotFound) {
		statusErr(w, ErrNotFound)
		return
	}
	if e != nil {
		statusErr(w, e)
		return
	}
	id := ""
	if m.ID != nil {
		id = *m.ID
	}
	httpx.JSON(w, 200, h.memoryProviderDTO(id, m.TenantID, m.Name, m.Slug, m.Kind, m.ConfigJSON, m.IsDefault, m.Status, m.LastError, memoryProviderTime(m.CreatedAt), memoryProviderTime(m.UpdatedAt)))
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
	updates := map[string]any{}
	for k, col := range map[string]string{"name": "name", "status": "status", "lastError": "last_error"} {
		if v, ok := m[k]; ok {
			updates[col] = v
		}
	}
	if v, ok := m["config"]; ok {
		var existingRow struct {
			ConfigJSON string `gorm:"column:config_json"`
		}
		if e = h.deps.Gorm.WithContext(r.Context()).Table("memory_providers").Select("config_json").Where("tenant_id = ? AND id = ?", p.TenantID, chi.URLParam(r, "id")).Take(&existingRow).Error; e != nil {
			statusErr(w, ErrNotFound)
			return
		}
		existing := map[string]any{}
		_ = json.Unmarshal([]byte(existingRow.ConfigJSON), &existing)
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
		updates["config_json"] = string(b)
	}
	if value, ok := m["isDefault"].(bool); ok && value {
		h.deps.Gorm.WithContext(r.Context()).Model(&models.MemoryProvider{}).Where("tenant_id = ?", p.TenantID).Updates(map[string]any{"is_default": false, "updated_at": runtimeTimeString(h.store.now())})
		updates["is_default"] = true
	}
	if len(updates) == 0 {
		h.getMemoryProvider(w, r)
		return
	}
	updates["updated_at"] = runtimeTimeString(h.store.now())
	res := h.deps.Gorm.WithContext(r.Context()).Model(&models.MemoryProvider{}).Where("tenant_id = ? AND id = ?", p.TenantID, chi.URLParam(r, "id")).Updates(updates)
	if res.Error != nil {
		statusErr(w, res.Error)
		return
	}
	if res.RowsAffected == 0 {
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
	var bound int64
	_ = h.deps.Gorm.WithContext(r.Context()).Model(&models.Agent{}).Where("tenant_id = ? AND memory_provider_id = ?", p.TenantID, chi.URLParam(r, "id")).Count(&bound).Error
	if bound > 0 {
		httpx.Error(w, http.StatusBadRequest, "agents are still bound to this provider")
		return
	}
	var wasDefault bool
	var mp models.MemoryProvider
	if e := h.deps.Gorm.WithContext(r.Context()).Where("tenant_id = ? AND id = ?", p.TenantID, chi.URLParam(r, "id")).Take(&mp).Error; e == nil {
		wasDefault = mp.IsDefault
	}
	res := h.deps.Gorm.WithContext(r.Context()).Where("tenant_id = ? AND id = ?", p.TenantID, chi.URLParam(r, "id")).Delete(&models.MemoryProvider{})
	if res.Error != nil {
		statusErr(w, res.Error)
		return
	}
	if res.RowsAffected == 0 {
		statusErr(w, ErrNotFound)
		return
	}
	if wasDefault {
		h.deps.Gorm.WithContext(r.Context()).Exec(`UPDATE memory_providers SET is_default=TRUE,updated_at=? WHERE id=(SELECT id FROM memory_providers WHERE tenant_id=? ORDER BY created_at,id LIMIT 1)`, runtimeTimeString(h.store.now()), p.TenantID)
	}
	httpx.JSON(w, 200, map[string]any{"ok": true})
}
func (h *handler) healthMemoryProvider(w http.ResponseWriter, r *http.Request) {
	p := principal(r)
	if !p.IsPlatformAdmin && p.Role != "owner" && p.Role != "admin" {
		httpx.Error(w, http.StatusForbidden, "Admin only")
		return
	}
	var row struct {
		Kind       string `gorm:"column:kind"`
		ConfigJSON string `gorm:"column:config_json"`
	}
	if e := h.deps.Gorm.WithContext(r.Context()).Table("memory_providers").Select("kind, config_json").Where("tenant_id = ? AND id = ?", p.TenantID, chi.URLParam(r, "id")).Take(&row).Error; errors.Is(e, gorm.ErrRecordNotFound) {
		statusErr(w, ErrNotFound)
		return
	} else if e != nil {
		statusErr(w, e)
		return
	}
	kind, cfgRaw := row.Kind, row.ConfigJSON
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
