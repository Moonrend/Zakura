// SPDX-License-Identifier: AGPL-3.0-or-later
package runtime

import (
	"context"
	"encoding/json"
	"errors"
	"net/http"
	"sort"
	"strings"

	"github.com/Moonrend/Zakura/apps/server/internal/platform/db/models"
	"github.com/Moonrend/Zakura/apps/server/internal/platform/httpx"
	"github.com/go-chi/chi/v5"
	"gorm.io/gorm"
)

func validateSkillFiles(files []skillFile) (int64, error) {
	_, size, err := normalizeSkillFiles(files)
	return size, err
}

type skillInstallBody struct {
	Source        json.RawMessage `json:"source"`
	SkillID       string          `json:"skillId"`
	Names         []string        `json:"names"`
	AgentIDs      []string        `json:"agentIds"`
	All           bool            `json:"all"`
	WorkspacePath string          `json:"workspacePath"`
	Name          string          `json:"name"`
	Title         string          `json:"title"`
	Description   string          `json:"description"`
	Version       *string         `json:"version"`
	Homepage      *string         `json:"homepage"`
	License       *string         `json:"license"`
	Files         []skillFile     `json:"files"`
	AutoUpdate    *bool           `json:"autoUpdate"`
	Enabled       *bool           `json:"enabled"`
}

func (h *handler) installSkill(w http.ResponseWriter, r *http.Request) {
	space, ok := h.authorizeSkillSpace(w, r)
	if !ok {
		return
	}
	var b skillInstallBody
	if httpx.DecodeJSON(r, &b) != nil {
		httpx.Error(w, 400, "invalid JSON")
		return
	}
	h.performSkillInstall(w, r, space, b)
}
func (h *handler) attachSkill(w http.ResponseWriter, r *http.Request) {
	a, ok := h.skillAgent(w, r)
	if !ok {
		return
	}
	var b skillInstallBody
	if httpx.DecodeJSON(r, &b) != nil {
		httpx.Error(w, 400, "invalid JSON")
		return
	}
	b.AgentIDs = []string{a.ID}
	b.All = false
	h.performSkillInstall(w, r, a.SpaceID, b)
}
func (h *handler) performSkillInstall(w http.ResponseWriter, r *http.Request, space string, b skillInstallBody) {
	ctx := r.Context()
	p := principal(r)
	tenant := p.TenantID
	agents := []Agent{}
	if b.All {
		query := h.deps.Gorm.WithContext(ctx).Where("tenant_id=?", tenant)
		if space != "" {
			query = query.Where("space_id=?", space)
		}
		var ids []string
		if err := query.Model(&models.Agent{}).Pluck("id", &ids).Error; err != nil {
			skillHTTPError(w, err)
			return
		}
		b.AgentIDs = ids
	}
	seen := map[string]bool{}
	for _, id := range b.AgentIDs {
		if seen[id] {
			continue
		}
		seen[id] = true
		if err := httpx.AuthorizeResource(ctx, h.deps, p, space, id); err != nil {
			skillHTTPError(w, err)
			return
		}
		a, err := h.store.GetAgent(ctx, tenant, id)
		if err != nil {
			skillHTTPError(w, err)
			return
		}
		agents = append(agents, a)
	}
	// A bound principal must never reach tenant-wide registry management through
	// a direct handler call (the parent middleware also enforces this).
	if space == "" && len(agents) == 0 && p.APIKey && (p.SpaceID != "" || p.AgentID != "") {
		httpx.Error(w, 404, "Not found")
		return
	}
	if b.WorkspacePath != "" {
		if space == "" {
			httpx.Error(w, 400, "Space is required for workspace registration")
			return
		}
		skill, err := h.registerWorkspaceSnapshot(ctx, tenant, space, b.WorkspacePath)
		if err != nil {
			skillHTTPError(w, err)
			return
		}
		b.SkillID = skill.ID
	}
	skills := []Skill{}
	warnings := []string{}
	if b.SkillID != "" {
		skill, err := h.skillByID(r, b.SkillID)
		if err != nil {
			skillHTTPError(w, err)
			return
		}
		skills = append(skills, skill)
	} else if len(b.Source) > 0 && string(b.Source) != "null" {
		var input string
		if err := json.Unmarshal(b.Source, &input); err != nil {
			if yes, id := builtinSourceRef(b.Source); yes {
				input = "builtin:" + id
			} else {
				httpx.Error(w, 400, "source must be an installation string")
				return
			}
		}
		src, packages, notes, err := h.resolveSkillPackages(ctx, tenant, input)
		if err != nil {
			skillHTTPError(w, err)
			return
		}
		warnings = append(warnings, notes...)
		if len(b.Names) > 0 {
			selected := []skillCachedPackage{}
			for _, pkg := range packages {
				if listContains(b.Names, pkg.Name) {
					selected = append(selected, pkg)
				}
			}
			if len(selected) != len(b.Names) {
				httpx.Error(w, 400, "selected skill not found in source")
				return
			}
			packages = selected
		}
		if len(packages) == 0 {
			httpx.Error(w, 404, "source contains no skills")
			return
		}
		if src.Kind == "builtin" {
			h.syncBuiltinSkills(ctx, tenant)
			for _, pkg := range packages {
				var m models.Skill
				if err := h.deps.Gorm.WithContext(ctx).Where("tenant_id=? AND name=? AND builtin=true", tenant, pkg.Name).Take(&m).Error; err != nil {
					skillHTTPError(w, err)
					return
				}
				skills = append(skills, skillFromModel(m))
			}
		} else {
			key := repoKeyOfSource(src)
			source := skillSourceJSON(src)
			// Validate every conflict before registering or materializing any selection.
			for _, pkg := range packages {
				var old models.Skill
				err := h.deps.Gorm.WithContext(ctx).Where("tenant_id=? AND name=?", tenant, pkg.Name).Take(&old).Error
				if err == nil && !skillSourceMatches(old.SourceJSON, string(source)) {
					skillHTTPError(w, errSkillConflict)
					return
				}
				if err != nil && !errors.Is(err, gorm.ErrRecordNotFound) {
					skillHTTPError(w, err)
					return
				}
			}
			for _, pkg := range packages {
				skill, err := h.registerSkillPackage(ctx, tenant, pkg, source, &key)
				if err != nil {
					skillHTTPError(w, err)
					return
				}
				skill.Files, _ = json.Marshal(pkg.Files)
				if pkg.Version != "" {
					version := pkg.Version
					skill.Version = &version
				}
				skills = append(skills, skill)
			}
		}
	} else if len(b.Files) > 0 {
		version := ""
		if b.Version != nil {
			version = *b.Version
		}
		source := json.RawMessage(`{"kind":"upload"}`)
		skill, err := h.registerSkillPackage(ctx, tenant, skillCachedPackage{Name: slugify(b.Name), Title: b.Title, Description: b.Description, Version: version, Files: b.Files, Homepage: b.Homepage, License: b.License}, source, nil)
		if err != nil {
			skillHTTPError(w, err)
			return
		}
		skills = append(skills, skill)
	} else if len(b.Names) > 0 || b.Name != "" {
		names := b.Names
		if len(names) == 0 {
			names = []string{b.Name}
		}
		for _, name := range names {
			var m models.Skill
			if err := h.deps.Gorm.WithContext(ctx).Where("tenant_id=? AND name=?", tenant, slugify(name)).Take(&m).Error; err != nil {
				skillHTTPError(w, err)
				return
			}
			skills = append(skills, skillFromModel(m))
		}
	} else {
		httpx.Error(w, 400, "source, skillId or workspacePath required")
		return
	}
	spaces := map[string]bool{}
	if space != "" {
		spaces[space] = true
	}
	for _, a := range agents {
		spaces[a.SpaceID] = true
	}
	// Legacy rows must be canonicalized before new writes can claim their names.
	for target := range spaces {
		if err := h.canonicalizeSpaceSkills(ctx, tenant, target); err != nil {
			skillHTTPError(w, err)
			return
		}
	}
	installed := map[string]spaceSkill{}
	completed := []map[string]any{}
	failInstall := func(err error) {
		if len(completed) == 0 {
			skillHTTPError(w, err)
			return
		}
		code := 400
		if errors.Is(err, errSkillConflict) {
			code = 409
		}
		httpx.JSON(w, code, map[string]any{"error": err.Error(), "partial": true, "installed": completed, "warnings": warnings})
	}
	spaceIDs := []string{}
	for target := range spaces {
		spaceIDs = append(spaceIDs, target)
	}
	sort.Strings(spaceIDs)
	for _, target := range spaceIDs {
		for _, skill := range skills {
			if b.SkillID != "" {
				existing, e := h.spaceSkillRecord(ctx, tenant, target, skill.ID)
				if e == nil {
					if existing.Status != "installed" {
						failInstall(errSkillConflict)
						return
					}
					installed[target+"/"+skill.ID] = existing
					completed = append(completed, map[string]any{"spaceId": target, "skillId": skill.ID, "name": skill.Name})
					continue
				}
				if !errors.Is(e, gorm.ErrRecordNotFound) {
					failInstall(e)
					return
				}
			}
			row, err := h.installSpaceSnapshot(ctx, tenant, target, skill)
			if err != nil {
				failInstall(err)
				return
			}
			installed[target+"/"+skill.ID] = row
			completed = append(completed, map[string]any{"spaceId": target, "skillId": skill.ID, "name": skill.Name})
		}
	}
	installs := []map[string]any{}
	enabled := true
	if b.Enabled != nil {
		enabled = *b.Enabled
	}
	for _, a := range agents {
		for _, skill := range skills {
			row := installed[a.SpaceID+"/"+skill.ID]
			ref, err := h.enableSpaceSkill(ctx, tenant, a.ID, row, enabled)
			if err != nil {
				failInstall(err)
				return
			}
			installs = append(installs, ref)
		}
	}
	httpx.JSON(w, 201, map[string]any{"skills": skills, "installs": installs, "warnings": warnings})
}
func (h *handler) installExistingSkills(w http.ResponseWriter, r *http.Request, skillID string, names, agentIDs []string, all bool) {
	h.performSkillInstall(w, r, "", skillInstallBody{SkillID: skillID, Names: names, AgentIDs: agentIDs, All: all})
}
func (h *handler) enableSpaceSkill(ctx context.Context, tenant, agent string, row spaceSkill, enabled bool) (map[string]any, error) {
	unlock := lockSkillSpace(tenant, row.SpaceID)
	defer unlock()
	now := runtimeTimeString(h.store.now())
	id := h.store.id()
	var ref models.AgentSkill
	err := h.deps.Gorm.WithContext(ctx).Transaction(func(tx *gorm.DB) error {
		if err := lockSpaceSkillTx(tx, tenant, row.SpaceID); err != nil {
			return err
		}
		var current spaceSkill
		if err := tx.Where("id=? AND tenant_id=? AND space_id=? AND status='installed'", row.ID, tenant, row.SpaceID).Take(&current).Error; err != nil {
			return err
		}
		var old models.AgentSkill
		e := tx.Where("tenant_id=? AND agent_id=? AND name=?", tenant, agent, row.Name).Take(&old).Error
		if e == nil && old.SkillID != row.SkillID {
			return errSkillConflict
		}
		if e != nil && !errors.Is(e, gorm.ErrRecordNotFound) {
			return e
		}
		ref = models.AgentSkill{ID: &id, TenantID: tenant, AgentID: agent, SkillID: row.SkillID, Name: row.Name, Enabled: enabled, Path: current.Path, Version: current.Version, Status: "installed", CreatedAt: now, UpdatedAt: now}
		if e == nil {
			ref.ID = old.ID
			ref.CreatedAt = old.CreatedAt
			return tx.Model(&models.AgentSkill{}).Where("id=?", *old.ID).Updates(map[string]any{"enabled": enabled, "path": current.Path, "version": current.Version, "status": "installed", "error": nil, "updated_at": now}).Error
		}
		return tx.Create(&ref).Error
	})
	if err != nil {
		return nil, err
	}
	return map[string]any{"id": ref.ID, "agentId": agent, "skillId": ref.SkillID, "name": ref.Name, "enabled": ref.Enabled, "path": ref.Path, "version": ref.Version, "status": ref.Status, "error": ref.Error}, nil
}
func (h *handler) listAgentSkills(w http.ResponseWriter, r *http.Request) {
	a, ok := h.skillAgent(w, r)
	if !ok {
		return
	}
	if err := h.canonicalizeSpaceSkills(r.Context(), a.TenantID, a.SpaceID); err != nil {
		skillHTTPError(w, err)
		return
	}
	var rows []spaceSkill
	if err := h.deps.Gorm.WithContext(r.Context()).Where("tenant_id=? AND space_id=?", a.TenantID, a.SpaceID).Order("name").Find(&rows).Error; err != nil {
		skillHTTPError(w, err)
		return
	}
	refs := []models.AgentSkill{}
	if err := h.deps.Gorm.WithContext(r.Context()).Where("tenant_id=? AND agent_id=?", a.TenantID, a.ID).Find(&refs).Error; err != nil {
		skillHTTPError(w, err)
		return
	}
	byName := map[string]models.AgentSkill{}
	for _, ref := range refs {
		byName[ref.Name] = ref
	}
	out := []map[string]any{}
	for _, row := range rows {
		dto, err := h.spaceSkillDTO(r.Context(), row)
		if err != nil {
			skillHTTPError(w, err)
			return
		}
		ref := byName[row.Name]
		enabled := ref.SkillID == row.SkillID && ref.Enabled
		dto["id"] = row.ID
		dto["skillId"] = row.SkillID
		dto["agentId"] = a.ID
		dto["enabled"] = enabled
		dto["path"] = row.Path
		out = append(out, dto)
	}
	httpx.JSON(w, 200, map[string]any{"skills": out, "unregistered": h.unregisteredSpaceSkills(r.Context(), a.TenantID, a.SpaceID, rows)})
}
func (h *handler) getAgentSkillFile(w http.ResponseWriter, r *http.Request) {
	a, ok := h.skillAgent(w, r)
	if !ok {
		return
	}
	var row spaceSkill
	err := h.deps.Gorm.WithContext(r.Context()).Where("tenant_id=? AND space_id=? AND name=?", a.TenantID, a.SpaceID, chi.URLParam(r, "name")).Take(&row).Error
	if err != nil {
		skillHTTPError(w, err)
		return
	}
	writeSkillFile(w, r, row.FilesJSON)
}
func (h *handler) resolveSkill(w http.ResponseWriter, r *http.Request) {
	if _, ok := h.authorizeSkillSpace(w, r); !ok {
		return
	}
	var b struct {
		Source  string `json:"source"`
		RepoKey string `json:"repoKey"`
		Name    string `json:"name"`
	}
	if httpx.DecodeJSON(r, &b) != nil {
		httpx.Error(w, 400, "invalid JSON")
		return
	}
	if strings.TrimSpace(b.Source) == "" {
		httpx.Error(w, 400, "source required")
		return
	}
	src, packages, warnings, err := h.resolveSkillPackages(r.Context(), principal(r).TenantID, b.Source)
	if err != nil {
		skillHTTPError(w, err)
		return
	}
	skills := []map[string]any{}
	for _, pkg := range packages {
		files := []map[string]any{}
		var total int
		body := ""
		for _, f := range pkg.Files {
			raw, _ := skillFileBytes(f)
			total += len(raw)
			files = append(files, map[string]any{"path": f.Path, "size": len(raw)})
			if f.Path == "SKILL.md" {
				body = skillBody(f.Content)
			}
		}
		var count int64
		_ = h.deps.Gorm.WithContext(r.Context()).Model(&models.Skill{}).Where("tenant_id=? AND name=?", principal(r).TenantID, pkg.Name).Count(&count).Error
		skills = append(skills, map[string]any{"name": pkg.Name, "title": pkg.Title, "description": pkg.Description, "body": body, "files": files, "sizeBytes": total, "version": pkg.Version, "homepage": pkg.Homepage, "license": pkg.License, "installed": count > 0})
	}
	source := skillSourceJSON(src)
	httpx.JSON(w, 200, map[string]any{"source": source, "skills": skills, "warnings": warnings})
}
