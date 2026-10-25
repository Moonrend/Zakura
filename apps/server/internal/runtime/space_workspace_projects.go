// SPDX-License-Identifier: AGPL-3.0-or-later
package runtime

import (
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"net/http"
	"os"
	"path/filepath"
	"strings"

	"github.com/Moonrend/Zakura/apps/server/internal/platform/db/models"
	"github.com/Moonrend/Zakura/apps/server/internal/platform/httpx"
	"github.com/go-chi/chi/v5"
	"gorm.io/gorm"
)

func projectDTO(p models.SpaceProject) map[string]any {
	var id, path any
	if p.ID != nil {
		id = *p.ID
	}
	if p.HasWorkspace {
		path = "/workspace/projects/" + p.Slug
	}
	return map[string]any{"id": id, "slug": p.Slug, "name": p.Name, "description": p.Description, "instructions": p.Instructions, "hasWorkspace": p.HasWorkspace, "path": path}
}
func (h *handler) createProjectWorkspace(r *http.Request, space, slug, gitURL string) error {
	remote, selected, err := h.remoteSpaceWorkspace(r.Context(), principal(r).TenantID, space)
	if err != nil {
		return err
	}
	if selected {
		params, _ := remote.pathParams("/projects")
		if err = remote.call(r.Context(), "host.fs.mkdir", params, nil); err != nil {
			return err
		}
		if gitURL == "" {
			params, _ = remote.pathParams(projectRemotePath(slug))
			return remote.call(r.Context(), "host.fs.mkdir", params, nil)
		}
		if remote.workspace != nil {
			exec, err := h.resolveServerComputer(r.Context(), principal(r).TenantID, space)
			if err != nil {
				return err
			}
			_, err = h.workspaceInstanceExec(r.Context(), exec, "", 120000, "git", "clone", "--depth", "1", "--", gitURL, "projects/"+slug)
			return err
		}
		// Legacy host execution uses the same jailed Space root as host.fs.
		var result struct {
			ExitCode int `json:"exitCode"`
		}
		if err = remote.call(r.Context(), "host.exec", map[string]any{"spaceId": space, "workingDir": "/", "command": []string{"git", "clone", "--depth", "1", "--", gitURL, "projects/" + slug}, "timeoutMs": 120000}, &result); err != nil {
			return fmt.Errorf("git clone failed: %w", err)
		}
		if result.ExitCode != 0 {
			return errors.New("git clone failed on the Space server; inspect the project directory before retrying")
		}
		return nil
	}
	if gitURL != "" {
		return errors.New("git clone requires an online executing Space server; no runtime node is configured")
	}
	f, err := h.workspaceForSpace(r.Context(), principal(r).TenantID, space)
	if err != nil {
		return err
	}
	target, err := f.resolve(filepath.Join("projects", slug), false)
	if err != nil {
		return err
	}
	return os.MkdirAll(target, 0o750)
}

type projectIntent struct {
	ID            string         `json:"id"`
	InstanceID    *string        `json:"workspaceInstanceId,omitempty"`
	Generation    int64          `json:"workspaceGeneration,omitempty"`
	Kind          string         `json:"kind"`
	Slug          string         `json:"slug"`
	Next          string         `json:"next"`
	HasWorkspace  bool           `json:"hasWorkspace"`
	WantWorkspace bool           `json:"wantWorkspace"`
	Updates       map[string]any `json:"updates"`
}

const projectIntentsKey = "projectOperations"

func decodeProjectIntent(v any) (projectIntent, error) {
	var p projectIntent
	raw, err := json.Marshal(v)
	if err == nil {
		err = json.Unmarshal(raw, &p)
	}
	return p, err
}
func (h *handler) reserveProjectIntent(ctx context.Context, tenant, space string, in projectIntent) (projectIntent, error) {
	var out projectIntent
	accepted, ok := ctx.Value(workspaceRequestTargetKey{}).(Space)
	if !ok || accepted.TenantID != tenant || accepted.ID != space {
		var err error
		accepted, err = h.store.GetSpace(ctx, tenant, space)
		if err != nil {
			return out, err
		}
	}
	in.InstanceID, in.Generation = accepted.CurrentWorkspaceInstanceID, accepted.WorkspaceGeneration
	err := h.deps.Gorm.WithContext(ctx).Transaction(func(tx *gorm.DB) error {
		if err := lockWorkspaceInstance(tx, tenant, space, in.InstanceID, in.Generation); err != nil {
			return err
		}
		var row models.Space
		if err := tx.Where("tenant_id=? AND id=?", tenant, space).Take(&row).Error; err != nil {
			return err
		}
		cfg := map[string]any{}
		if err := json.Unmarshal([]byte(row.ConfigJSON), &cfg); err != nil {
			return err
		}
		ops, _ := cfg[projectIntentsKey].(map[string]any)
		if ops == nil {
			ops = map[string]any{}
		}
		key, old, err := projectIntentAt(ops, in)
		if err != nil {
			return err
		}
		if key != "" {
			a, _ := json.Marshal(old.Updates)
			b, _ := json.Marshal(in.Updates)
			if old.Kind != in.Kind || old.Next != in.Next || string(a) != string(b) {
				return errors.New("project has a pending operation; retry that operation first")
			}
			out = old
			return nil
		}
		// Reserve both names, so a second rename/create cannot take a pending target.
		for _, value := range ops {
			other, e := decodeProjectIntent(value)
			if e != nil {
				return e
			}
			if !projectIntentMatches(other, in.InstanceID, in.Generation) {
				continue
			}
			if other.Next == in.Next || other.Slug == in.Next || other.Next == in.Slug {
				return ErrConflict
			}
		}
		ops[projectIntentSlot(in)] = in
		cfg[projectIntentsKey] = ops
		raw, err := json.Marshal(cfg)
		if err != nil {
			return err
		}
		result := tx.Table("spaces").Where("tenant_id=? AND id=? AND config_json=?", tenant, space, row.ConfigJSON).Updates(map[string]any{"config_json": string(raw), "updated_at": runtimeTimeString(h.store.now())})
		if result.Error != nil {
			return result.Error
		}
		if result.RowsAffected != 1 {
			return ErrConflict
		}
		out = in
		return nil
	})
	return out, err
}
func (h *handler) applyProjectIntentFS(ctx context.Context, tenant, space string, in projectIntent) error {
	if (!in.HasWorkspace && !in.WantWorkspace) || (in.Kind != "delete" && in.Next == in.Slug && in.WantWorkspace == in.HasWorkspace) {
		return nil
	}
	ctx = context.WithValue(ctx, workspaceRequestTargetKey{}, Space{ID: space, TenantID: tenant, CurrentWorkspaceInstanceID: in.InstanceID, WorkspaceGeneration: in.Generation})
	remote, selected, err := h.remoteSpaceWorkspace(ctx, tenant, space)
	if err != nil {
		return err
	}
	if selected {
		if in.Kind == "delete" {
			params, _ := remote.pathParams(projectRemotePath(in.Slug))
			params["recursive"] = true
			err = remote.call(ctx, "host.fs.remove", params, nil)
			if workspaceMissing(err) {
				return nil
			}
			return err
		}
		if in.HasWorkspace && in.Next != in.Slug {
			from, to := projectRemotePath(in.Slug), projectRemotePath(in.Next)
			params, _ := remote.pathParams(from)
			var src runnerFSEntry
			srcErr := remote.call(ctx, "host.fs.stat", params, &src)
			target, _ := remote.pathParams(to)
			var dst runnerFSEntry
			dstErr := remote.call(ctx, "host.fs.stat", target, &dst)
			if workspaceMissing(srcErr) && dstErr == nil {
				return nil
			} // retry after the remote rename completed
			if srcErr != nil {
				return srcErr
			}
			if dstErr == nil {
				return errors.New("project destination already exists")
			}
			if !workspaceMissing(dstErr) {
				return dstErr
			}
			params = map[string]any{"spaceId": space, "oldPath": from, "newPath": to}
			if remote.root != "" {
				params["root"] = remote.root
			}
			return remote.call(ctx, "host.fs.rename", params, nil)
		}
		if in.WantWorkspace && !in.HasWorkspace {
			params, _ := remote.pathParams(projectRemotePath(in.Next))
			return remote.call(ctx, "host.fs.mkdir", params, nil)
		}
		return nil
	}
	f, err := h.workspaceForSpace(ctx, tenant, space)
	if err != nil {
		return err
	}
	from, err := f.resolve(filepath.Join("projects", in.Slug), false)
	if err != nil {
		return err
	}
	if in.Kind == "delete" {
		return os.RemoveAll(from)
	}
	if in.HasWorkspace && in.Next != in.Slug {
		to, err := f.resolve(filepath.Join("projects", in.Next), false)
		if err != nil {
			return err
		}
		_, srcErr := os.Stat(from)
		_, dstErr := os.Stat(to)
		if errors.Is(srcErr, os.ErrNotExist) && dstErr == nil {
			return nil
		}
		if srcErr != nil {
			return srcErr
		}
		if dstErr == nil {
			return errors.New("project destination already exists")
		}
		if !errors.Is(dstErr, os.ErrNotExist) {
			return dstErr
		}
		return os.Rename(from, to)
	}
	if in.WantWorkspace && !in.HasWorkspace {
		return os.MkdirAll(from, 0o750)
	}
	return nil
}
func workspaceMissing(err error) bool {
	if err == nil {
		return false
	}
	s := strings.ToLower(err.Error())
	return errors.Is(err, os.ErrNotExist) || errors.Is(err, ErrNotFound) || strings.Contains(s, "no such file") || strings.Contains(s, "not exist") || strings.Contains(s, "cannot find")
}

// External filesystem changes are intentionally outside the DB transaction.
// Durable intent survives runner failure or a DB failure after the remote side
// succeeded. Repeating the exact request reconciles it before committing refs.
func (h *handler) finishProjectIntent(ctx context.Context, tenant, space string, in projectIntent) error {
	for attempt := 0; attempt < 8; attempt++ {
		err := h.deps.Gorm.WithContext(ctx).Transaction(func(tx *gorm.DB) error {
			if err := lockWorkspaceInstance(tx, tenant, space, in.InstanceID, in.Generation); err != nil {
				return err
			}
			var row models.Space
			if err := tx.Where("tenant_id=? AND id=?", tenant, space).Take(&row).Error; err != nil {
				return err
			}
			cfg := map[string]any{}
			if err := json.Unmarshal([]byte(row.ConfigJSON), &cfg); err != nil {
				return err
			}
			ops, _ := cfg[projectIntentsKey].(map[string]any)
			key, saved, err := projectIntentAt(ops, in)
			if err != nil || key == "" || saved.ID != in.ID {
				return ErrConflict
			}
			var project models.SpaceProject
			if err := tx.Where("tenant_id=? AND space_id=? AND slug=?", tenant, space, in.Slug).Take(&project).Error; err != nil {
				return err
			}
			if in.InstanceID != nil && project.ID != nil {
				var disk string
				if err := tx.Table("workspace_instances").Select("disk_id").Where("tenant_id=? AND space_id=? AND id=?", tenant, space, *in.InstanceID).Scan(&disk).Error; err != nil {
					return err
				}
				if disk == "" {
					return ErrConflict
				}
				if err := h.saveProjectDiskPresence(tx, tenant, space, disk, *project.ID, in.Next, in.Kind != "delete" && in.WantWorkspace); err != nil {
					return err
				}
			}
			projects := tx.Where("tenant_id=? AND space_id=? AND slug=?", tenant, space, in.Slug)
			if in.Kind == "delete" {
				if err = projects.Delete(&models.SpaceProject{}).Error; err != nil {
					return err
				}
			} else {
				if err = projects.Model(&models.SpaceProject{}).Updates(in.Updates).Error; err != nil {
					return err
				}
			}
			if in.Kind == "delete" || in.Next != in.Slug {
				agents := tx.Model(&models.Agent{}).Select("id").Where("tenant_id=? AND space_id=?", tenant, space)
				for _, table := range []string{"cloud_agent_sessions", "agent_schedules"} {
					for _, old := range []string{in.Slug, "projects/" + in.Slug} {
						var next any
						if in.Kind != "delete" {
							next = in.Next
							if strings.HasPrefix(old, "projects/") {
								next = "projects/" + in.Next
							}
						}
						if err = tx.Table(table).Where("tenant_id=? AND agent_id IN (?) AND project=?", tenant, agents, old).Updates(map[string]any{"project": next, "updated_at": runtimeTimeString(h.store.now())}).Error; err != nil {
							return err
						}
					}
				}
			}
			delete(ops, key)
			if len(ops) == 0 {
				delete(cfg, projectIntentsKey)
			} else {
				cfg[projectIntentsKey] = ops
			}
			raw, _ := json.Marshal(cfg)
			res := tx.Model(&models.Space{}).Where("tenant_id=? AND id=? AND config_json=?", tenant, space, row.ConfigJSON).Updates(map[string]any{"config_json": string(raw), "updated_at": runtimeTimeString(h.store.now())})
			if res.Error != nil {
				return res.Error
			}
			if res.RowsAffected != 1 {
				return ErrConflict
			}
			return nil
		})
		if !errors.Is(err, ErrConflict) {
			return err
		}
	}
	return ErrConflict
}
func (h *handler) mutateProject(w http.ResponseWriter, r *http.Request, remove bool) {
	tenant := principal(r).TenantID
	space, err := h.workspaceRequestSpace(r)
	if err != nil {
		statusErr(w, err)
		return
	}
	slug := chi.URLParam(r, "slug")
	var existing models.SpaceProject
	if err = h.deps.Gorm.WithContext(r.Context()).Where("tenant_id=? AND space_id=? AND slug=?", tenant, space, slug).Take(&existing).Error; err != nil {
		if errors.Is(err, gorm.ErrRecordNotFound) {
			err = ErrNotFound
		}
		statusErr(w, err)
		return
	}
	presence, err := h.projectDiskPresence(r.Context(), tenant, space, []models.SpaceProject{existing})
	if err != nil {
		statusErr(w, err)
		return
	}
	existing.HasWorkspace = presence[slug]
	in := projectIntent{ID: h.store.id(), Kind: "update", Slug: slug, Next: slug, HasWorkspace: existing.HasWorkspace, WantWorkspace: existing.HasWorkspace, Updates: map[string]any{}}
	if remove {
		in.Kind = "delete"
	} else {
		patch, e := decodeMap(r)
		if e != nil {
			httpx.Error(w, 400, "invalid JSON")
			return
		}
		for _, key := range []string{"name", "description", "instructions", "slug"} {
			if v, ok := patch[key]; ok {
				value, valid := v.(string)
				if !valid {
					httpx.Error(w, 400, "invalid "+key)
					return
				}
				if key == "slug" {
					if value != slugify(value) || value == "" {
						httpx.Error(w, 400, "invalid slug")
						return
					}
					in.Next = value
				}
				in.Updates[key] = value
			}
		}
		for _, key := range []string{"hasWorkspace", "withWorkspace"} {
			if v, ok := patch[key]; ok {
				flag, valid := v.(bool)
				if !valid {
					httpx.Error(w, 400, "invalid "+key)
					return
				}
				in.WantWorkspace = flag
				in.Updates["has_workspace"] = flag
			}
		}
		if len(in.Updates) == 0 {
			httpx.Error(w, 400, "no supported fields")
			return
		}
	}
	if in.Next != slug {
		var count int64
		if err = h.deps.Gorm.WithContext(r.Context()).Model(&models.SpaceProject{}).Where("tenant_id=? AND space_id=? AND slug=?", tenant, space, in.Next).Count(&count).Error; err != nil {
			statusErr(w, err)
			return
		}
		if count > 0 {
			statusErr(w, ErrConflict)
			return
		}
	}
	in, err = h.reserveProjectIntent(r.Context(), tenant, space, in)
	if err != nil {
		httpx.Error(w, 409, err.Error())
		return
	}
	if err = h.applyProjectIntentFS(r.Context(), tenant, space, in); err == nil {
		in.Updates["updated_at"] = runtimeTimeString(h.store.now())
		err = h.finishProjectIntent(r.Context(), tenant, space, in)
	}
	if err != nil {
		httpx.JSON(w, 409, map[string]any{"error": err.Error(), "pendingOperation": in, "retryable": true})
		return
	}
	if remove {
		httpx.JSON(w, 200, map[string]any{"ok": true, "deleted": true})
		return
	}
	if err = h.deps.Gorm.WithContext(r.Context()).Where("tenant_id=? AND space_id=? AND slug=?", tenant, space, in.Next).Take(&existing).Error; err != nil {
		statusErr(w, err)
		return
	}
	existing.HasWorkspace = in.WantWorkspace
	httpx.JSON(w, 200, map[string]any{"project": projectDTO(existing)})
}
