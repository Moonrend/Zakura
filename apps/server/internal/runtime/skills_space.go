// SPDX-License-Identifier: AGPL-3.0-or-later
package runtime

import (
	"context"
	"crypto/sha256"
	"encoding/hex"
	"encoding/json"
	"errors"
	"fmt"
	"net/http"
	"path"
	"sort"
	"strings"
	"sync"

	"github.com/Moonrend/Zakura/apps/server/internal/platform/db/models"
	"github.com/Moonrend/Zakura/apps/server/internal/platform/httpx"
	"github.com/go-chi/chi/v5"
	"gorm.io/gorm"
	"gorm.io/gorm/clause"
)

var errSkillConflict = errors.New("skill name conflicts with an existing Space installation; remove it explicitly before installing a different source or revision")
var skillSpaceLocks sync.Map

func lockSkillSpace(tenant, space string) func() {
	value, _ := skillSpaceLocks.LoadOrStore(tenant+"/"+space, &sync.Mutex{})
	lock := value.(*sync.Mutex)
	lock.Lock()
	return lock.Unlock
}

type spaceSkill struct {
	ID         string  `gorm:"column:id;primaryKey" json:"id"`
	TenantID   string  `gorm:"column:tenant_id" json:"-"`
	SpaceID    string  `gorm:"column:space_id" json:"spaceId"`
	SkillID    string  `gorm:"column:skill_id" json:"skillId"`
	Name       string  `gorm:"column:name" json:"name"`
	Version    *string `gorm:"column:version" json:"version"`
	Revision   string  `gorm:"column:revision" json:"revision"`
	FilesJSON  string  `gorm:"column:files_json" json:"-"`
	Path       string  `gorm:"column:path" json:"path"`
	AutoUpdate bool    `gorm:"column:auto_update" json:"autoUpdate"`
	Status     string  `gorm:"column:status" json:"status"`
	Error      *string `gorm:"column:error" json:"error"`
	CreatedAt  string  `gorm:"column:created_at" json:"createdAt"`
	UpdatedAt  string  `gorm:"column:updated_at" json:"updatedAt"`
}

func (spaceSkill) TableName() string { return "space_skills" }
func skillRevision(files []skillFile) string {
	copyFiles := append([]skillFile(nil), files...)
	sort.Slice(copyFiles, func(i, j int) bool { return copyFiles[i].Path < copyFiles[j].Path })
	hash := sha256.New()
	for _, f := range copyFiles {
		b, _ := skillFileBytes(f)
		fmt.Fprintf(hash, "%d:%s:%d:", len(f.Path), f.Path, len(b))
		_, _ = hash.Write(b)
	}
	return hex.EncodeToString(hash.Sum(nil))
}
func sameSkillVersion(a, b *string) bool {
	if a == nil || b == nil {
		return a == nil && b == nil
	}
	return *a == *b
}
func skillHTTPError(w http.ResponseWriter, err error) {
	switch {
	case errors.Is(err, errSkillConflict):
		httpx.Error(w, 409, err.Error())
	case errors.Is(err, httpx.ErrResourceScope), errors.Is(err, ErrNotFound), errors.Is(err, gorm.ErrRecordNotFound):
		httpx.Error(w, 404, "Not found")
	default:
		statusErr(w, err)
	}
}

// Scope routes use spaceId so skill IDs and Agent aliases cannot be confused.
func (h *handler) registerSpaceSkills(r chi.Router) {
	r.Get("/spaces/{spaceId}/skills", h.listSpaceSkills)
	r.Get("/spaces/{spaceId}/skills/stores", h.skillStores)
	r.Get("/spaces/{spaceId}/skills/repos", h.listSkillRepos)
	r.Get("/spaces/{spaceId}/skills/search", h.searchSkillStore)
	r.Post("/spaces/{spaceId}/skills/resolve", h.resolveSkill)
	r.Post("/spaces/{spaceId}/skills/install", h.installSkill)
	r.Post("/spaces/{spaceId}/skills/register", h.registerSpaceSkill)
	r.Get("/spaces/{spaceId}/skills/{skillId}", h.getSpaceSkill)
	r.Post("/spaces/{spaceId}/skills/{skillId}/update", h.updateSpaceSkill)
	r.Patch("/spaces/{spaceId}/skills/{skillId}/auto-update", h.patchSpaceSkillAutoUpdate)
	r.Delete("/spaces/{spaceId}/skills/{skillId}", h.deleteSpaceSkill)
	r.Get("/spaces/{spaceId}/skills/{skillId}/file", h.getSpaceSkillFile)
}
func (h *handler) authorizeSkillSpace(w http.ResponseWriter, r *http.Request) (string, bool) {
	space := chi.URLParam(r, "spaceId")
	if space == "" {
		p := principal(r)
		if p.APIKey && (p.SpaceID != "" || p.AgentID != "") {
			httpx.Error(w, 404, "Not found")
			return "", false
		}
		return "", true
	}
	if err := httpx.AuthorizeResource(r.Context(), h.deps, principal(r), space, ""); err != nil {
		skillHTTPError(w, err)
		return "", false
	}
	return space, true
}
func (h *handler) skillAgent(w http.ResponseWriter, r *http.Request) (Agent, bool) {
	p := principal(r)
	id := chi.URLParam(r, "id")
	if err := httpx.AuthorizeResource(r.Context(), h.deps, p, "", id); err != nil {
		skillHTTPError(w, err)
		return Agent{}, false
	}
	a, err := h.store.GetAgent(r.Context(), p.TenantID, id)
	if err != nil {
		skillHTTPError(w, err)
		return Agent{}, false
	}
	return a, true
}

// Adopt legacy rows only when all references identify the exact same snapshot.
// Ambiguity is persisted and visible, never resolved by whichever Agent writes last.
func (h *handler) canonicalizeSpaceSkills(ctx context.Context, tenant, space string) error {
	unlock := lockSkillSpace(tenant, space)
	defer unlock()
	type legacySkillRef struct {
		Name    string  `gorm:"column:name"`
		SkillID string  `gorm:"column:skill_id"`
		Version *string `gorm:"column:version"`
	}
	var rows []legacySkillRef
	if err := h.deps.Gorm.WithContext(ctx).Table("agent_skills AS a").Select("a.name,a.skill_id,a.version").Joins("JOIN agents g ON g.id=a.agent_id AND g.tenant_id=a.tenant_id").Where("a.tenant_id=? AND g.space_id=?", tenant, space).Order("a.name,a.skill_id").Scan(&rows).Error; err != nil {
		return err
	}
	groups := map[string][]legacySkillRef{}
	for _, row := range rows {
		groups[row.Name] = append(groups[row.Name], row)
	}
	for name, refs := range groups {
		var count int64
		if err := h.deps.Gorm.WithContext(ctx).Model(&spaceSkill{}).Where("tenant_id=? AND space_id=? AND name=?", tenant, space, name).Count(&count).Error; err != nil {
			return err
		}
		if count > 0 {
			continue
		}
		var source models.Skill
		if err := h.deps.Gorm.WithContext(ctx).Where("tenant_id=? AND id=?", tenant, refs[0].SkillID).Take(&source).Error; err != nil {
			return err
		}
		status := "installed"
		message := ""
		for _, ref := range refs {
			if ref.SkillID != refs[0].SkillID || !sameSkillVersion(ref.Version, refs[0].Version) {
				status = "conflict"
				message = "legacy Agent references disagree on source or revision"
			}
		}
		if !sameSkillVersion(source.Version, refs[0].Version) {
			status = "conflict"
			message = "legacy installed revision is unavailable in the registry"
		}
		var files []skillFile
		_ = json.Unmarshal([]byte(source.FilesJSON), &files)
		files, _, err := normalizeSkillFiles(files)
		if err != nil {
			status = "conflict"
			message = "legacy snapshot is invalid: " + err.Error()
		}
		filesRaw, _ := json.Marshal(files)
		now := runtimeTimeString(h.store.now())
		row := spaceSkill{ID: h.store.id(), TenantID: tenant, SpaceID: space, SkillID: refs[0].SkillID, Name: name, Version: refs[0].Version, Revision: skillRevision(files), FilesJSON: string(filesRaw), Path: "/skills/" + name, AutoUpdate: source.AutoUpdate, Status: status, CreatedAt: now, UpdatedAt: now}
		if message != "" {
			row.Error = &message
		}
		if err := h.deps.Gorm.WithContext(ctx).Clauses(clause.OnConflict{Columns: []clause.Column{{Name: "space_id"}, {Name: "name"}}, DoNothing: true}).Create(&row).Error; err != nil {
			return err
		}
	}
	return nil
}

func (h *handler) spaceSkillRecord(ctx context.Context, tenant, space, id string) (spaceSkill, error) {
	var row spaceSkill
	err := h.deps.Gorm.WithContext(ctx).Where("tenant_id=? AND space_id=? AND (skill_id=? OR id=?)", tenant, space, id, id).Take(&row).Error
	return row, err
}
func (h *handler) spaceSkillDTO(ctx context.Context, row spaceSkill) (map[string]any, error) {
	var m models.Skill
	if err := h.deps.Gorm.WithContext(ctx).Where("tenant_id=? AND id=?", row.TenantID, row.SkillID).Take(&m).Error; err != nil {
		return nil, err
	}
	skill := skillFromModel(m)
	skill.Version = row.Version
	skill.AutoUpdate = row.AutoUpdate
	skill.CreatedAt = memoryProviderTime(row.CreatedAt)
	skill.UpdatedAt = memoryProviderTime(row.UpdatedAt)
	var files []skillFile
	_ = json.Unmarshal([]byte(row.FilesJSON), &files)
	skill.FileCount = len(files)
	skill.SizeBytes = 0
	for _, f := range files {
		b, _ := skillFileBytes(f)
		skill.SizeBytes += int64(len(b))
	}
	out := []Skill{skill}
	h.enrichSkillRepoState(ctx, out)
	raw, _ := json.Marshal(out[0])
	dto := map[string]any{}
	_ = json.Unmarshal(raw, &dto)
	delete(dto, "files")
	ids := []string{}
	err := h.deps.Gorm.WithContext(ctx).Table("agent_skills AS a").Joins("JOIN agents g ON g.id=a.agent_id AND g.tenant_id=a.tenant_id").Where("a.tenant_id=? AND g.space_id=? AND a.skill_id=? AND a.name=? AND a.enabled=?", row.TenantID, row.SpaceID, row.SkillID, row.Name, true).Order("a.agent_id").Pluck("a.agent_id", &ids).Error
	dto["agentIds"] = ids
	dto["spaceId"] = row.SpaceID
	dto["installationId"] = row.ID
	dto["revision"] = row.Revision
	dto["status"] = row.Status
	dto["error"] = row.Error
	return dto, err
}
func (h *handler) listSpaceSkills(w http.ResponseWriter, r *http.Request) {
	space, ok := h.authorizeSkillSpace(w, r)
	if !ok {
		return
	}
	tenant := principal(r).TenantID
	if err := h.canonicalizeSpaceSkills(r.Context(), tenant, space); err != nil {
		skillHTTPError(w, err)
		return
	}
	var rows []spaceSkill
	if err := h.deps.Gorm.WithContext(r.Context()).Where("tenant_id=? AND space_id=?", tenant, space).Order("name").Find(&rows).Error; err != nil {
		skillHTTPError(w, err)
		return
	}
	out := []map[string]any{}
	for _, row := range rows {
		dto, err := h.spaceSkillDTO(r.Context(), row)
		if err != nil {
			skillHTTPError(w, err)
			return
		}
		out = append(out, dto)
	}
	httpx.JSON(w, 200, map[string]any{"skills": out, "unregistered": h.unregisteredSpaceSkills(r.Context(), tenant, space, rows)})
}
func (h *handler) getSpaceSkill(w http.ResponseWriter, r *http.Request) {
	space, ok := h.authorizeSkillSpace(w, r)
	if !ok {
		return
	}
	row, err := h.spaceSkillRecord(r.Context(), principal(r).TenantID, space, chi.URLParam(r, "skillId"))
	if err != nil {
		skillHTTPError(w, err)
		return
	}
	dto, err := h.spaceSkillDTO(r.Context(), row)
	if err != nil {
		skillHTTPError(w, err)
		return
	}
	files := []skillFile{}
	_ = json.Unmarshal([]byte(row.FilesJSON), &files)
	httpx.JSON(w, 200, map[string]any{"skill": dto, "files": files})
}

// DB row lock complements the process lock for multiple server replicas.
func lockSpaceSkillTx(tx *gorm.DB, tenant, space string) error {
	var row models.Space
	return tx.Clauses(clause.Locking{Strength: "UPDATE"}).Where("tenant_id=? AND id=?", tenant, space).Take(&row).Error
}
func (h *handler) installSpaceSnapshot(ctx context.Context, tenant, space string, skill Skill) (spaceSkill, error) {
	var files []skillFile
	if err := json.Unmarshal(skill.Files, &files); err != nil {
		return spaceSkill{}, err
	}
	files, _, err := normalizeSkillFiles(files)
	if err != nil {
		return spaceSkill{}, err
	}
	revision := skillRevision(files)
	unlock := lockSkillSpace(tenant, space)
	defer unlock()
	// Acquire before opening the workspace or taking the snapshot transaction's
	// Space row lock. stageSkill reuses this context without another DB claim.
	ctx, finishWrite, err := h.claimSharedWorkspaceWrite(ctx, tenant, space)
	if err != nil {
		return spaceSkill{}, err
	}
	defer finishWrite(nil)
	var result spaceSkill
	workspace, err := h.skillWorkspace(ctx, tenant, space)
	if err != nil {
		return result, err
	}
	defer workspace.close()
	ctx = context.WithValue(ctx, skillWorkspaceKey{}, workspace)
	var pending func(bool) error
	err = h.deps.Gorm.WithContext(ctx).Transaction(func(tx *gorm.DB) error {
		if err := lockSpaceSkillTx(tx, tenant, space); err != nil {
			return err
		}
		var old spaceSkill
		err := tx.Where("tenant_id=? AND space_id=? AND name=?", tenant, space, skill.Name).Take(&old).Error
		if err == nil {
			if old.Status != "installed" || old.SkillID != skill.ID || old.Revision != revision {
				return errSkillConflict
			}
			result = old
			return nil
		}
		if !errors.Is(err, gorm.ErrRecordNotFound) {
			return err
		}
		finish, err := h.stageSkill(ctx, tenant, space, skill.Name, files, false, false)
		if err != nil {
			return err
		}
		committed := false
		defer func() {
			if !committed {
				_ = finish(false)
			}
		}()
		raw, _ := json.Marshal(files)
		now := runtimeTimeString(h.store.now())
		result = spaceSkill{ID: h.store.id(), TenantID: tenant, SpaceID: space, SkillID: skill.ID, Name: skill.Name, Version: skill.Version, Revision: revision, FilesJSON: string(raw), Path: "/skills/" + skill.Name, AutoUpdate: skill.AutoUpdate, Status: "installed", CreatedAt: now, UpdatedAt: now}
		if err = tx.Create(&result).Error; err != nil {
			return err
		}
		committed = true
		// Finalization is deferred until the transaction itself commits below.
		pending = finish
		return nil
	})
	if pending != nil {
		if e := pending(err == nil); err == nil && e != nil {
			err = e
		}
	}
	return result, err
}

func (h *handler) replaceSpaceSnapshot(ctx context.Context, row spaceSkill, files []skillFile, version *string, remove bool) error {
	normalized, _, err := normalizeSkillFiles(files)
	if !remove && err != nil {
		return err
	}
	unlock := lockSkillSpace(row.TenantID, row.SpaceID)
	defer unlock()
	ctx, finishWrite, err := h.claimSharedWorkspaceWrite(ctx, row.TenantID, row.SpaceID)
	if err != nil {
		return err
	}
	defer finishWrite(nil)
	workspace, err := h.skillWorkspace(ctx, row.TenantID, row.SpaceID)
	if err != nil {
		return err
	}
	defer workspace.close()
	ctx = context.WithValue(ctx, skillWorkspaceKey{}, workspace)
	var finish func(bool) error
	err = h.deps.Gorm.WithContext(ctx).Transaction(func(tx *gorm.DB) error {
		if err := lockSpaceSkillTx(tx, row.TenantID, row.SpaceID); err != nil {
			return err
		}
		var current spaceSkill
		if err := tx.Where("id=? AND revision=?", row.ID, row.Revision).Take(&current).Error; err != nil {
			return errSkillConflict
		}
		if !remove && current.Status != "installed" {
			return errSkillConflict
		}
		if !remove {
			exists, err := workspace.exists(ctx, current.Path)
			if err != nil {
				return err
			}
			if exists {
				actual, err := readSkillWorkspaceFiles(ctx, workspace, skillRelative(current.Path))
				if err != nil {
					return err
				}
				if skillRevision(actual) != current.Revision {
					return errors.New("installed skill files changed locally; refusing to overwrite local edits")
				}
			}
		}
		var e error
		finish, e = h.stageSkill(ctx, row.TenantID, row.SpaceID, row.Name, normalized, true, remove)
		if e != nil {
			return e
		}
		if remove {
			if e = tx.Where("tenant_id=? AND name=? AND agent_id IN (SELECT id FROM agents WHERE tenant_id=? AND space_id=?)", row.TenantID, row.Name, row.TenantID, row.SpaceID).Delete(&models.AgentSkill{}).Error; e != nil {
				return e
			}
			return tx.Where("id=?", row.ID).Delete(&spaceSkill{}).Error
		}
		raw, _ := json.Marshal(normalized)
		now := runtimeTimeString(h.store.now())
		if e = tx.Model(&spaceSkill{}).Where("id=?", row.ID).Updates(map[string]any{"files_json": string(raw), "revision": skillRevision(normalized), "version": version, "status": "installed", "error": nil, "updated_at": now}).Error; e != nil {
			return e
		}
		return tx.Model(&models.AgentSkill{}).Where("tenant_id=? AND skill_id=? AND name=? AND agent_id IN (SELECT id FROM agents WHERE tenant_id=? AND space_id=?)", row.TenantID, row.SkillID, row.Name, row.TenantID, row.SpaceID).Updates(map[string]any{"version": version, "status": "installed", "error": nil, "updated_at": now}).Error
	})
	if finish != nil {
		if e := finish(err == nil); err == nil && e != nil {
			err = e
		}
	}
	return err
}
func (h *handler) deleteSpaceSkill(w http.ResponseWriter, r *http.Request) {
	space, ok := h.authorizeSkillSpace(w, r)
	if !ok {
		return
	}
	row, err := h.spaceSkillRecord(r.Context(), principal(r).TenantID, space, chi.URLParam(r, "skillId"))
	if err == nil {
		err = h.replaceSpaceSnapshot(r.Context(), row, nil, nil, true)
	}
	if err != nil {
		skillHTTPError(w, err)
		return
	}
	httpx.JSON(w, 200, map[string]any{"ok": true})
}
func (h *handler) patchSpaceSkillAutoUpdate(w http.ResponseWriter, r *http.Request) {
	space, ok := h.authorizeSkillSpace(w, r)
	if !ok {
		return
	}
	var b struct {
		Enabled *bool `json:"enabled"`
	}
	if httpx.DecodeJSON(r, &b) != nil || b.Enabled == nil {
		httpx.Error(w, 400, "enabled is required")
		return
	}
	row, err := h.spaceSkillRecord(r.Context(), principal(r).TenantID, space, chi.URLParam(r, "skillId"))
	if err == nil {
		err = h.deps.Gorm.WithContext(r.Context()).Model(&spaceSkill{}).Where("id=?", row.ID).Updates(map[string]any{"auto_update": *b.Enabled, "updated_at": runtimeTimeString(h.store.now())}).Error
	}
	if err != nil {
		skillHTTPError(w, err)
		return
	}
	h.getSpaceSkill(w, r)
}
func (h *handler) updateSpaceSkill(w http.ResponseWriter, r *http.Request) {
	space, ok := h.authorizeSkillSpace(w, r)
	if !ok {
		return
	}
	row, err := h.spaceSkillRecord(r.Context(), principal(r).TenantID, space, chi.URLParam(r, "skillId"))
	if err == nil {
		var files []skillFile
		var version *string
		files, version, err = h.cachedSkillUpdate(r.Context(), row.TenantID, row.SkillID)
		if err == nil {
			err = h.replaceSpaceSnapshot(r.Context(), row, files, version, false)
		}
	}
	if err != nil {
		skillHTTPError(w, err)
		return
	}
	h.getSpaceSkill(w, r)
}
func (h *handler) cachedSkillUpdate(ctx context.Context, tenant, id string) ([]skillFile, *string, error) {
	var skill models.Skill
	if err := h.deps.Gorm.WithContext(ctx).Where("tenant_id=? AND id=?", tenant, id).Take(&skill).Error; err != nil {
		return nil, nil, err
	}
	if skill.RepoKey == nil {
		return nil, nil, errors.New("skill has no cached repository source")
	}
	var repo models.PlatformSkillRepo
	if err := h.deps.Gorm.WithContext(ctx).Where("repo_key=?", *skill.RepoKey).Take(&repo).Error; err != nil {
		return nil, nil, err
	}
	var packages []skillCachedPackage
	if err := json.Unmarshal([]byte(repo.PackagesJSON), &packages); err != nil {
		return nil, nil, err
	}
	for _, p := range packages {
		if p.Name == skill.Name {
			version := p.Version
			if version == "" && repo.Version != nil {
				version = *repo.Version
			}
			return p.Files, &version, nil
		}
	}
	return nil, nil, ErrNotFound
}
func (h *handler) getSpaceSkillFile(w http.ResponseWriter, r *http.Request) {
	space, ok := h.authorizeSkillSpace(w, r)
	if !ok {
		return
	}
	row, err := h.spaceSkillRecord(r.Context(), principal(r).TenantID, space, chi.URLParam(r, "skillId"))
	if err != nil {
		skillHTTPError(w, err)
		return
	}
	writeSkillFile(w, r, row.FilesJSON)
}
func writeSkillFile(w http.ResponseWriter, r *http.Request, raw string) {
	requested := r.URL.Query().Get("path")
	if requested == "" {
		requested = "SKILL.md"
	}
	var files []skillFile
	_ = json.Unmarshal([]byte(raw), &files)
	for _, f := range files {
		if f.Path == requested {
			if f.Encoding == "" {
				f.Encoding = "utf8"
			}
			httpx.JSON(w, 200, f)
			return
		}
	}
	httpx.Error(w, 404, "Not found")
}

func (h *handler) updateSkillFromCache(ctx context.Context, tenant, skillID string) (Skill, error) {
	files, version, err := h.cachedSkillUpdate(ctx, tenant, skillID)
	if err != nil {
		return Skill{}, err
	}
	files, size, err := normalizeSkillFiles(files)
	if err != nil {
		return Skill{}, err
	}
	var rows []spaceSkill
	if err = h.deps.Gorm.WithContext(ctx).Where("tenant_id=? AND skill_id=?", tenant, skillID).Find(&rows).Error; err != nil {
		return Skill{}, err
	}
	for _, row := range rows {
		if err = h.replaceSpaceSnapshot(ctx, row, files, version, false); err != nil {
			return Skill{}, err
		}
	}
	raw, _ := json.Marshal(files)
	if err = h.deps.Gorm.WithContext(ctx).Model(&models.Skill{}).Where("tenant_id=? AND id=?", tenant, skillID).Updates(map[string]any{"files_json": string(raw), "version": version, "file_count": len(files), "size_bytes": size, "updated_at": runtimeTimeString(h.store.now())}).Error; err != nil {
		return Skill{}, err
	}
	var m models.Skill
	err = h.deps.Gorm.WithContext(ctx).Where("tenant_id=? AND id=?", tenant, skillID).Take(&m).Error
	return skillFromModel(m), err
}
func (h *handler) enabledSpacePromptSkills(ctx context.Context, tenant, agent string) []promptSkill {
	a, err := h.store.GetAgent(ctx, tenant, agent)
	if err != nil {
		return nil
	}
	if err = h.canonicalizeSpaceSkills(ctx, tenant, a.SpaceID); err != nil {
		return nil
	}
	var rows []struct {
		Name        string `gorm:"column:name"`
		Description string `gorm:"column:description"`
		Path        string `gorm:"column:path"`
	}
	err = h.deps.Gorm.WithContext(ctx).Table("agent_skills AS a").Select("i.name,s.description,i.path").Joins("JOIN agents g ON g.id=a.agent_id AND g.tenant_id=a.tenant_id").Joins("JOIN space_skills i ON i.space_id=g.space_id AND i.tenant_id=a.tenant_id AND i.name=a.name AND i.skill_id=a.skill_id").Joins("JOIN skills s ON s.id=i.skill_id AND s.tenant_id=i.tenant_id").Where("a.tenant_id=? AND a.agent_id=? AND a.enabled=? AND i.status='installed'", tenant, agent, true).Order("i.name").Scan(&rows).Error
	if err != nil {
		return nil
	}
	out := []promptSkill{}
	for _, row := range rows {
		out = append(out, promptSkill{Name: row.Name, Description: row.Description, Path: path.Join(row.Path, "SKILL.md")})
	}
	return out
}
func (h *handler) unregisteredSpaceSkills(ctx context.Context, tenant, space string, rows []spaceSkill) []string {
	out := []string{}
	fs, err := h.skillWorkspace(ctx, tenant, space)
	if err != nil {
		return out
	}
	defer fs.close()
	entries, err := fs.list(ctx, "/skills")
	if err != nil {
		return out
	}
	known := map[string]bool{}
	for _, row := range rows {
		known[row.Name] = true
	}
	for _, entry := range entries {
		if entry.IsDir && !known[entry.Name] && entry.Name == slugify(entry.Name) {
			if _, err := fs.read(ctx, "/skills/"+entry.Name+"/SKILL.md"); err == nil {
				out = append(out, entry.Name)
			}
		}
	}
	sort.Strings(out)
	return out
}
func (h *handler) workspaceSkillFiles(ctx context.Context, tenant, space, workspacePath string) ([]skillFile, error) {
	p := strings.TrimPrefix(workspacePath, "/workspace")
	p = strings.TrimPrefix(p, "/")
	if path.Clean(p) != p || !strings.HasPrefix(p, "skills/") || len(strings.Split(p, "/")) != 2 {
		return nil, errors.New("workspacePath must identify /skills/<name>")
	}
	fs, err := h.skillWorkspace(ctx, tenant, space)
	if err != nil {
		return nil, err
	}
	defer fs.close()
	return readSkillWorkspaceFiles(ctx, fs, p)
}
func readSkillWorkspaceFiles(ctx context.Context, fs *skillWorkspace, p string) ([]skillFile, error) {
	var err error
	files := []skillFile{}
	var walk func(string) error
	walk = func(dir string) error {
		entries, err := fs.list(ctx, "/"+path.Join(p, dir))
		if err != nil {
			return err
		}
		for _, entry := range entries {
			if entry.Name != path.Base(entry.Name) || strings.ContainsAny(entry.Name, "\\\x00:") {
				return errors.New("invalid workspace entry")
			}
			rel := path.Join(dir, entry.Name)
			if entry.IsDir {
				if strings.Count(rel, "/") > 12 {
					return errors.New("skill directory too deep")
				}
				if err = walk(rel); err != nil {
					return err
				}
				continue
			}
			if len(files) >= 64 {
				return errors.New("skill has too many files")
			}
			b, e := fs.read(ctx, "/"+path.Join(p, rel))
			if e != nil {
				return e
			}
			files = append(files, skillFileFromBytes(rel, b))
		}
		return nil
	}
	if err = walk(""); err != nil {
		return nil, err
	}
	files, _, err = normalizeSkillFiles(files)
	return files, err
}
func (h *handler) registerSpaceSkill(w http.ResponseWriter, r *http.Request) {
	space, ok := h.authorizeSkillSpace(w, r)
	if !ok {
		return
	}
	var b struct {
		WorkspacePath string `json:"workspacePath"`
	}
	if httpx.DecodeJSON(r, &b) != nil || b.WorkspacePath == "" {
		httpx.Error(w, 400, "workspacePath required")
		return
	}
	skill, err := h.registerWorkspaceSnapshot(r.Context(), principal(r).TenantID, space, b.WorkspacePath)
	if err != nil {
		skillHTTPError(w, err)
		return
	}
	httpx.JSON(w, 201, map[string]any{"skills": []Skill{skill}, "installs": []any{}, "warnings": []string{}})
}
func (h *handler) registerWorkspaceSnapshot(ctx context.Context, tenant, space, p string) (Skill, error) {
	files, err := h.workspaceSkillFiles(ctx, tenant, space, p)
	if err != nil {
		return Skill{}, err
	}
	name := path.Base(p)
	manifest := ""
	for _, f := range files {
		if f.Path == "SKILL.md" {
			manifest = f.Content
		}
	}
	title, description := skillManifestMeta(manifest, name)
	raw, _ := json.Marshal(files)
	source, _ := json.Marshal(map[string]any{"kind": "workspace", "path": p})
	skill, err := h.registerSkillPackage(ctx, tenant, skillCachedPackage{Name: name, Title: title, Description: description, Files: files, Version: skillRevision(files)}, source, nil)
	if err != nil {
		return Skill{}, err
	}
	unlock := lockSkillSpace(tenant, space)
	defer unlock()
	now := runtimeTimeString(h.store.now())
	row := spaceSkill{ID: h.store.id(), TenantID: tenant, SpaceID: space, SkillID: skill.ID, Name: name, Version: skill.Version, Revision: skillRevision(files), FilesJSON: string(raw), Path: "/skills/" + name, AutoUpdate: false, Status: "installed", CreatedAt: now, UpdatedAt: now}
	err = h.deps.Gorm.WithContext(ctx).Transaction(func(tx *gorm.DB) error {
		if err := lockSpaceSkillTx(tx, tenant, space); err != nil {
			return err
		}
		var old spaceSkill
		e := tx.Where("space_id=? AND name=?", space, name).Take(&old).Error
		if e == nil {
			if old.SkillID == row.SkillID && old.Revision == row.Revision {
				return nil
			}
			return errSkillConflict
		}
		if !errors.Is(e, gorm.ErrRecordNotFound) {
			return e
		}
		return tx.Create(&row).Error
	})
	return skill, err
}
