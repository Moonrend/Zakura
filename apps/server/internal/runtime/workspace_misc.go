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
	"time"

	"github.com/Moonrend/Zakura/apps/server/internal/platform/db/models"
	"github.com/Moonrend/Zakura/apps/server/internal/platform/httpx"
	"github.com/go-chi/chi/v5"
	"gorm.io/gorm"
)

func (h *handler) projectDir(r *http.Request) (workspaceFS, string, error) {
	f, e := h.requestWorkspace(r)
	if e != nil {
		return f, "", e
	}
	slug := chi.URLParam(r, "slug")
	space, e := h.workspaceRequestSpace(r)
	if e != nil {
		return f, "", e
	}
	var count int64
	e = h.deps.Gorm.WithContext(r.Context()).Table("space_projects").Where("tenant_id = ? AND space_id = ? AND slug = ?", principal(r).TenantID, space, slug).Count(&count).Error
	if e != nil || count == 0 {
		return f, "", ErrNotFound
	}
	dir, e := f.resolve(filepath.Join("projects", slug), true)
	return f, dir, e
}
func atomicWrite(path string, data []byte, mode os.FileMode) error {
	if e := os.MkdirAll(filepath.Dir(path), 0o750); e != nil {
		return e
	}
	tmp, e := os.CreateTemp(filepath.Dir(path), ".zakura-*")
	if e != nil {
		return e
	}
	name := tmp.Name()
	defer os.Remove(name)
	_ = tmp.Chmod(mode)
	if _, e = tmp.Write(data); e != nil {
		tmp.Close()
		return e
	}
	if e = tmp.Sync(); e != nil {
		tmp.Close()
		return e
	}
	if e = tmp.Close(); e != nil {
		return e
	}
	return os.Rename(name, path)
}
func projectConfigSnapshot(slug, dir string) map[string]any {
	return projectSnapshotFromReader(slug, localProjectReader(dir))
}

func (h *handler) putProjectHooks(w http.ResponseWriter, r *http.Request) {
	var body struct {
		Events map[string]any `json:"events"`
		File   *string        `json:"file"`
	}
	if httpx.DecodeJSON(r, &body) != nil {
		httpx.Error(w, http.StatusBadRequest, "valid JSON hooks required")
		return
	}
	file := ".agents/hooks.json"
	if body.File != nil && strings.TrimSpace(*body.File) != "" {
		file = *body.File
	}
	clean := filepath.Clean(file)
	if clean == ".." || strings.HasPrefix(clean, ".."+string(filepath.Separator)) || filepath.IsAbs(clean) {
		httpx.Error(w, http.StatusForbidden, "Forbidden")
		return
	}
	raw, _ := json.MarshalIndent(body.Events, "", "  ")
	if remote, selected, err := h.remoteProject(r); err != nil {
		writeRemoteError(w, err)
		return
	} else if selected {
		var err error
		raw, err = projectHooksContent(remote.projectReader(r.Context(), chi.URLParam(r, "slug")), filepath.ToSlash(clean), body.Events)
		if err != nil {
			httpx.Error(w, 400, err.Error())
			return
		}
		if _, err = remote.write(r.Context(), projectRemotePath(chi.URLParam(r, "slug"), filepath.ToSlash(clean)), raw); err != nil {
			writeRemoteError(w, err)
			return
		}
		httpx.JSON(w, http.StatusOK, map[string]any{"config": remote.projectSnapshot(r.Context(), chi.URLParam(r, "slug")), "path": filepath.ToSlash(clean)})
		return
	}
	_, dir, err := h.projectDir(r)
	if err != nil {
		statusErr(w, err)
		return
	}
	raw, err = projectHooksContent(localProjectReader(dir), filepath.ToSlash(clean), body.Events)
	if err != nil {
		httpx.Error(w, 400, err.Error())
		return
	}
	if err = writeProjectFile(dir, clean, raw); err != nil {
		statusErr(w, err)
		return
	}
	httpx.JSON(w, http.StatusOK, map[string]any{"config": projectConfigSnapshot(chi.URLParam(r, "slug"), dir), "path": filepath.ToSlash(clean)})
}
func (h *handler) putProjectSkill(w http.ResponseWriter, r *http.Request) {
	name := chi.URLParam(r, "name")
	var body struct{ Name, Description, Body, Content string }
	if httpx.DecodeJSON(r, &body) != nil {
		httpx.Error(w, http.StatusBadRequest, "invalid JSON")
		return
	}
	if name == "" {
		name = slugify(body.Name)
	}
	name = slugify(name)
	if name == "" {
		httpx.Error(w, http.StatusBadRequest, "name required")
		return
	}
	content := body.Content
	if content == "" {
		content = body.Body
	}
	if content == "" {
		content = "# " + body.Name + "\n\n" + body.Description + "\n"
	}
	if len(content) > 1<<20 {
		httpx.Error(w, http.StatusRequestEntityTooLarge, "skill too large")
		return
	}
	if remote, selected, err := h.remoteProject(r); err != nil {
		writeRemoteError(w, err)
		return
	} else if selected {
		if _, err = remote.write(r.Context(), projectRemotePath(chi.URLParam(r, "slug"), projectSkillDirectory(remote.projectReader(r.Context(), chi.URLParam(r, "slug")), name), "SKILL.md"), []byte(content)); err != nil {
			writeRemoteError(w, err)
			return
		}
		skill := map[string]any{"name": name, "title": func() string {
			if body.Name != "" {
				return body.Name
			}
			return name
		}(), "description": body.Description, "path": projectSkillDirectory(remote.projectReader(r.Context(), chi.URLParam(r, "slug")), name) + "/SKILL.md"}
		httpx.JSON(w, http.StatusOK, map[string]any{"skill": skill, "config": remote.projectSnapshot(r.Context(), chi.URLParam(r, "slug"))})
		return
	}
	_, dir, err := h.projectDir(r)
	if err != nil {
		statusErr(w, err)
		return
	}
	target := filepath.Join(projectSkillDirectory(localProjectReader(dir), name), "SKILL.md")
	if err = writeProjectFile(dir, target, []byte(content)); err != nil {
		statusErr(w, err)
		return
	}
	skill := map[string]any{"name": name, "title": func() string {
		if body.Name != "" {
			return body.Name
		}
		return name
	}(), "description": body.Description, "path": filepath.ToSlash(target)}
	httpx.JSON(w, http.StatusOK, map[string]any{"skill": skill, "config": projectConfigSnapshot(chi.URLParam(r, "slug"), dir)})
}
func (h *handler) deleteProjectSkill(w http.ResponseWriter, r *http.Request) {
	name := slugify(chi.URLParam(r, "name"))
	if name == "" {
		httpx.Error(w, http.StatusBadRequest, "invalid name")
		return
	}
	if remote, selected, err := h.remoteProject(r); err != nil {
		writeRemoteError(w, err)
		return
	} else if selected {
		params, _ := remotePathParams(remote.spaceID, projectRemotePath(chi.URLParam(r, "slug"), projectSkillDirectory(remote.projectReader(r.Context(), chi.URLParam(r, "slug")), name)))
		params["recursive"] = true
		if err = remote.call(r.Context(), "host.fs.remove", params, nil); err != nil {
			writeRemoteError(w, err)
			return
		}
		httpx.JSON(w, http.StatusOK, map[string]any{"config": remote.projectSnapshot(r.Context(), chi.URLParam(r, "slug"))})
		return
	}
	_, dir, err := h.projectDir(r)
	if err != nil {
		statusErr(w, err)
		return
	}
	root, err := os.OpenRoot(dir)
	if err != nil {
		statusErr(w, err)
		return
	}
	defer root.Close()
	if err = root.RemoveAll(projectSkillDirectory(localProjectReader(dir), name)); err != nil {
		statusErr(w, err)
		return
	}
	httpx.JSON(w, http.StatusOK, map[string]any{"config": projectConfigSnapshot(chi.URLParam(r, "slug"), dir)})
}
func (h *handler) getProjectSkillFile(w http.ResponseWriter, r *http.Request) {
	name := slugify(chi.URLParam(r, "name"))
	rel := r.URL.Query().Get("path")
	if rel == "" {
		rel = "SKILL.md"
	}
	clean := filepath.Clean(rel)
	if clean == ".." || strings.HasPrefix(clean, ".."+string(filepath.Separator)) || filepath.IsAbs(clean) {
		httpx.Error(w, http.StatusForbidden, "Forbidden")
		return
	}
	if remote, selected, err := h.remoteProject(r); err != nil {
		writeRemoteError(w, err)
		return
	} else if selected {
		raw, _, err := remote.read(r.Context(), projectRemotePath(chi.URLParam(r, "slug"), projectSkillDirectory(remote.projectReader(r.Context(), chi.URLParam(r, "slug")), name), filepath.ToSlash(clean)), 1<<20)
		if err != nil {
			writeRemoteError(w, err)
			return
		}
		httpx.JSON(w, http.StatusOK, map[string]any{"path": filepath.ToSlash(filepath.Join(".agents", "skills", name, clean)), "content": string(raw)})
		return
	}
	_, dir, err := h.projectDir(r)
	if err != nil {
		statusErr(w, err)
		return
	}
	raw, err := localProjectReader(dir).read(filepath.Join(projectSkillDirectory(localProjectReader(dir), name), clean))
	if errors.Is(err, os.ErrNotExist) {
		statusErr(w, ErrNotFound)
		return
	}
	if err != nil {
		statusErr(w, err)
		return
	}
	httpx.JSON(w, http.StatusOK, map[string]any{"path": filepath.ToSlash(filepath.Join(".agents", "skills", name, clean)), "content": string(raw)})
}
func (h *handler) agentDesktop(w http.ResponseWriter, r *http.Request) {
	p := principal(r)
	var rec struct {
		EnableComputer  bool    `gorm:"column:enable_computer"`
		WorkspaceStatus string  `gorm:"column:workspace_status"`
		WorkspaceKind   string  `gorm:"column:workspace_kind"`
		RuntimeNodeID   *string `gorm:"column:runtime_node_id"`
		ID              string  `gorm:"column:id"`
	}
	e := h.deps.Gorm.WithContext(r.Context()).Table("spaces AS s").Select("s.enable_computer AS enable_computer, s.workspace_status AS workspace_status, s.workspace_kind AS workspace_kind, s.runtime_node_id AS runtime_node_id, s.id AS id").Joins("JOIN agents a ON a.space_id = s.id").Where("a.tenant_id = ? AND a.id = ?", p.TenantID, chi.URLParam(r, "id")).Take(&rec).Error
	if errors.Is(e, gorm.ErrRecordNotFound) {
		statusErr(w, ErrNotFound)
		return
	}
	if e != nil {
		statusErr(w, e)
		return
	}
	enabled, status, kind, spaceID := rec.EnableComputer, rec.WorkspaceStatus, rec.WorkspaceKind, rec.ID
	supported := enabled && kind != "host"
	var mc models.ManagedContainer
	_ = h.deps.Gorm.WithContext(r.Context()).Where("tenant_id = ? AND space_id = ? AND purpose = 'workspace'", p.TenantID, spaceID).Order("created_at DESC").Take(&mc).Error
	if mc.ID != nil {
		status = mc.Status
	}
	var dockerID *string
	if mc.ID != nil {
		dockerID = mc.DockerID
	}
	reason := any(nil)
	if !enabled {
		reason = "Computer is disabled"
	} else if kind == "host" {
		reason = "Virtual desktop and browser require a container workspace"
	}
	httpx.JSON(w, http.StatusOK, map[string]any{
		"enabled": supported, "supported": supported, "computer": supported, "browser": supported,
		"display": func() any {
			if supported {
				return ":99"
			}
			return nil
		}(),
		"coordinateSpace": "desktop pixels, origin top-left", "dimensionsSource": "configured", "reason": reason,
		"containerStatus": status, "dockerId": dockerID,
		"novncUrl": nil, "novncPort": nil, "cdpUrl": nil, "cdpPort": nil, "vncPort": nil,
		"width": 1280, "height": 720,
	})
}
func (h *handler) workspaceTicket(w http.ResponseWriter, r *http.Request, kind string) {
	p := principal(r)
	agentID := chi.URLParam(r, "id")
	if err := httpx.AuthorizeResource(r.Context(), h.deps, p, "", agentID); err != nil {
		statusErr(w, ErrNotFound)
		return
	}
	a, err := h.store.GetAgent(r.Context(), p.TenantID, agentID)
	if err != nil {
		statusErr(w, err)
		return
	}
	route := chi.NewRouteContext()
	if adapter := strings.TrimSpace(r.URL.Query().Get("adapterId")); adapter != "" && kind == "terminal" {
		route.URLParams.Add("spaceId", a.SpaceID)
		route.URLParams.Add("profileId", adapter)
		h.acpTerminalTicket(w, r.WithContext(context.WithValue(r.Context(), chi.RouteCtxKey, route)))
		return
	}
	route.URLParams.Add("id", a.SpaceID)
	h.issueSpaceWorkspaceTicket(w, r.WithContext(context.WithValue(r.Context(), chi.RouteCtxKey, route)), kind)
}
func (h *handler) desktopTicket(w http.ResponseWriter, r *http.Request) {
	h.workspaceTicket(w, r, "desktop")
}
func (h *handler) terminalTicket(w http.ResponseWriter, r *http.Request) {
	h.workspaceTicket(w, r, "terminal")
}
func (h *handler) spaceGraph(w http.ResponseWriter, r *http.Request) {
	p := principal(r)
	space := chi.URLParam(r, "id")
	if _, e := h.store.GetSpace(r.Context(), p.TenantID, space); e != nil {
		statusErr(w, e)
		return
	}
	agents, e := h.store.ListAgents(r.Context(), p.TenantID)
	if e != nil {
		statusErr(w, e)
		return
	}
	nodes := []map[string]any{{"id": space, "kind": "space"}}
	edges := []map[string]any{}
	for _, a := range agents {
		if a.SpaceID != space {
			continue
		}
		nodes = append(nodes, map[string]any{"id": a.ID, "kind": "agent", "name": a.Name})
		edges = append(edges, map[string]any{"from": space, "to": a.ID, "kind": "contains"})
	}
	var recs []struct {
		AgentID       string `gorm:"column:agent_id"`
		ID            string `gorm:"column:id"`
		Name          string `gorm:"column:name"`
		ComponentType string `gorm:"column:component_type"`
	}
	if e := h.deps.Gorm.WithContext(r.Context()).Table("agent_bindings AS b").Select("b.agent_id AS agent_id, i.id AS id, i.name AS name, i.component_type AS component_type").Joins("JOIN component_instances i ON i.id = b.instance_id").Where("b.tenant_id = ? AND b.space_id = ?", p.TenantID, space).Find(&recs).Error; e != nil {
		statusErr(w, e)
		return
	}
	seen := map[string]bool{}
	for _, rec := range recs {
		if !seen[rec.ID] {
			nodes = append(nodes, map[string]any{"id": rec.ID, "kind": rec.ComponentType, "name": rec.Name})
			seen[rec.ID] = true
		}
		edges = append(edges, map[string]any{"from": rec.AgentID, "to": rec.ID, "kind": "binding"})
	}
	httpx.JSON(w, 200, map[string]any{"nodes": nodes, "edges": edges})
}

type migrationRow struct {
	ID           string  `json:"id"`
	TenantID     string  `json:"tenantId"`
	SpaceID      string  `json:"spaceId"`
	SourceNodeID string  `json:"sourceNodeId"`
	TargetNodeID string  `json:"targetNodeId"`
	Status       string  `json:"status"`
	Phase        *string `json:"phase"`
	Message      *string `json:"message"`
	Error        *string `json:"error"`
	Progress     int     `json:"progressPct"`
	StartedAt    *string `json:"startedAt"`
	CompletedAt  *string `json:"completedAt"`
	CreatedAt    string  `json:"createdAt"`
	UpdatedAt    string  `json:"updatedAt"`
}

func migrationFromModel(m models.WorkspaceMigration) migrationRow {
	x := migrationRow{TenantID: m.TenantID, SpaceID: m.SpaceID, SourceNodeID: m.SourceNodeID, TargetNodeID: m.TargetNodeID, Status: m.Status, Phase: m.Phase, Message: m.Message, Error: m.Error, Progress: int(m.ProgressPct), StartedAt: m.StartedAt, CompletedAt: m.CompletedAt, CreatedAt: m.CreatedAt, UpdatedAt: m.UpdatedAt}
	if m.ID != nil {
		x.ID = *m.ID
	}
	return x
}
func (h *handler) listWorkspaceMigrations(w http.ResponseWriter, r *http.Request) {
	p := principal(r)
	space, err := h.workspaceRequestSpace(r)
	if err != nil {
		statusErr(w, err)
		return
	}
	var ms []models.WorkspaceMigration
	if e := h.deps.Gorm.WithContext(r.Context()).Where("tenant_id = ? AND space_id = ?", p.TenantID, space).Order("created_at DESC").Find(&ms).Error; e != nil {
		statusErr(w, e)
		return
	}
	out := []migrationRow{}
	for _, m := range ms {
		out = append(out, migrationFromModel(m))
	}
	httpx.JSON(w, 200, map[string]any{"migrations": out})
}
func (h *handler) createWorkspaceMigration(w http.ResponseWriter, r *http.Request) {
	p := principal(r)
	var b struct {
		TargetRuntimeNodeID string `json:"targetRuntimeNodeId"`
		TargetNodeID        string `json:"targetNodeId"`
	}
	if httpx.DecodeJSON(r, &b) != nil {
		httpx.Error(w, 400, "targetNodeId required")
		return
	}
	if b.TargetRuntimeNodeID == "" {
		b.TargetRuntimeNodeID = b.TargetNodeID
	}
	if b.TargetRuntimeNodeID == "" {
		httpx.Error(w, 400, "targetNodeId required")
		return
	}
	space, e := h.workspaceRequestSpace(r)
	if e != nil || httpx.AuthorizeResource(r.Context(), h.deps, p, space, "") != nil {
		statusErr(w, ErrNotFound)
		return
	}
	record, e := h.store.GetSpace(r.Context(), p.TenantID, space)
	source := ""
	if record.RuntimeNodeID != nil {
		source = *record.RuntimeNodeID
	}
	if e != nil || source == "" {
		httpx.Error(w, 409, "source runtime node required")
		return
	}
	if source == b.TargetRuntimeNodeID {
		httpx.Error(w, http.StatusBadRequest, "source and target runtime nodes must differ")
		return
	}
	var targetExists int64
	if e = h.deps.Gorm.WithContext(r.Context()).Model(&models.RuntimeNode{}).Where("id = ? AND (tenant_id = ? OR is_shared = true)", b.TargetRuntimeNodeID, p.TenantID).Count(&targetExists).Error; e != nil || targetExists == 0 {
		statusErr(w, ErrNotFound)
		return
	}
	for _, node := range []string{source, b.TargetRuntimeNodeID} {
		if e = h.authorizeLocalNode(r.Context(), p, node); e != nil {
			statusErr(w, e)
			return
		}
	}
	id := h.store.id()
	now := runtimeTimeString(h.store.now())
	phase := "queued"
	m := models.WorkspaceMigration{ID: &id, TenantID: p.TenantID, SpaceID: space, SourceNodeID: source, TargetNodeID: b.TargetRuntimeNodeID, Status: "pending", Phase: &phase, ProgressPct: 0, ExcludePatternsJSON: "[]", SourceRetained: false, CreatedAt: now, UpdatedAt: now}
	lease, e := h.acquireSpaceWorkspace(r.Context(), p.TenantID, space, "migrating", false, &workspaceConfig{RuntimeNodeID: &b.TargetRuntimeNodeID})
	if e != nil {
		h.serverComputerLifecycleError(w, e)
		return
	}
	if lease.Space.RuntimeNodeID == nil || *lease.Space.RuntimeNodeID != source {
		lease.release()
		statusErr(w, ErrConflict)
		return
	}
	if e = h.migrationPreflight(r.Context(), lease.Space, b.TargetRuntimeNodeID); e != nil {
		lease.release()
		httpx.Error(w, http.StatusConflict, e.Error())
		return
	}
	manifest := migrationManifest{Version: 1, Source: source, Target: b.TargetRuntimeNodeID, PreviousStatus: lease.Intent.PreviousStatus}
	rawManifest := string(rawJSON(manifest))
	m.ManifestJSON, m.SourceRetained = &rawManifest, true
	if e = lease.fenced(r.Context(), func(tx *gorm.DB) error { return tx.Create(&m).Error }); e != nil {
		lease.release()
		statusErr(w, e)
		return
	}
	go h.runLeasedWorkspaceMigration(httpx.WithPrincipal(h.deps.RunContext(), p), id, lease, b.TargetRuntimeNodeID)
	httpx.JSON(w, http.StatusCreated, map[string]any{"migration": map[string]any{"id": id, "status": "pending"}})
}
func (h *handler) createInstanceMigration(w http.ResponseWriter, r *http.Request) {
	p := principal(r)
	instanceID := chi.URLParam(r, "id")
	var request struct {
		TargetRuntimeNodeID string `json:"targetRuntimeNodeId"`
	}
	if httpx.DecodeJSON(r, &request) != nil || request.TargetRuntimeNodeID == "" {
		httpx.Error(w, http.StatusBadRequest, "targetRuntimeNodeId required")
		return
	}
	var ci models.ComponentInstance
	if e := h.deps.Gorm.WithContext(r.Context()).Where("tenant_id = ? AND id = ? AND component_type = 'mcp'", p.TenantID, instanceID).Take(&ci).Error; errors.Is(e, gorm.ErrRecordNotFound) {
		statusErr(w, ErrNotFound)
		return
	} else if e != nil {
		statusErr(w, e)
		return
	}
	configRaw, secretRaw, status, name, ref := ci.ConfigJSON, ci.SecretJSON, ci.Status, ci.Name, ci.ComponentRef
	body, ok, secretErr := h.stdioBodyForInstance(mcpInstance{ID: instanceID, TenantID: p.TenantID, Name: name, Ref: ref, Config: json.RawMessage(configRaw), Secret: json.RawMessage(secretRaw)})
	if secretErr != nil {
		httpx.Error(w, http.StatusBadRequest, secretErr.Error())
		return
	}
	if !ok {
		httpx.Error(w, http.StatusBadRequest, "only container stdio MCP instances support migration")
		return
	}
	var mc models.ManagedContainer
	e := h.deps.Gorm.WithContext(r.Context()).Where("tenant_id = ? AND instance_id = ? AND runtime_node_id IS NOT NULL AND docker_id IS NOT NULL AND space_id IS NOT NULL", p.TenantID, instanceID).Order("created_at DESC").Take(&mc).Error
	if e != nil {
		httpx.Error(w, http.StatusBadRequest, "instance has no source runtime container")
		return
	}
	containerID, sourceNode, dockerID, dataSpaceID := "", "", "", ""
	if mc.ID != nil {
		containerID = *mc.ID
	}
	if mc.RuntimeNodeID != nil {
		sourceNode = *mc.RuntimeNodeID
	}
	if mc.DockerID != nil {
		dockerID = *mc.DockerID
	}
	if mc.SpaceID != nil {
		dataSpaceID = *mc.SpaceID
	}
	if sourceNode == request.TargetRuntimeNodeID {
		httpx.JSON(w, http.StatusOK, map[string]any{"ok": true, "runtimeNodeId": sourceNode})
		return
	}
	var targetCount int64
	if e = h.deps.Gorm.WithContext(r.Context()).Model(&models.RuntimeNode{}).Where("id = ? AND (tenant_id = ? OR is_shared = TRUE)", request.TargetRuntimeNodeID, p.TenantID).Count(&targetCount).Error; e != nil || targetCount == 0 {
		statusErr(w, ErrNotFound)
		return
	}
	sourceRunner, e := h.hub.get(sourceNode)
	if e != nil {
		httpx.Error(w, http.StatusServiceUnavailable, "source runtime node is offline")
		return
	}
	targetRunner, e := h.hub.get(request.TargetRuntimeNodeID)
	if e != nil {
		httpx.Error(w, http.StatusServiceUnavailable, "target runtime node is offline")
		return
	}
	wasRunning := status == "running" || status == "starting"
	if e = h.deps.Gorm.WithContext(r.Context()).Model(&models.ComponentInstance{}).Where("tenant_id = ? AND id = ? AND status = ?", p.TenantID, instanceID, status).Updates(map[string]any{"status": "migrating", "updated_at": runtimeTimeString(h.store.now())}).Error; e != nil {
		statusErr(w, e)
		return
	}
	rollback := func(cause error) {
		var config map[string]any
		_ = json.Unmarshal([]byte(configRaw), &config)
		config["runtimeNodeId"] = sourceNode
		restored, _ := json.Marshal(config)
		h.deps.Gorm.WithContext(context.WithoutCancel(r.Context())).Model(&models.ComponentInstance{}).Where("tenant_id = ? AND id = ?", p.TenantID, instanceID).Updates(map[string]any{"config_json": string(restored), "status": status, "last_error": cause.Error(), "updated_at": runtimeTimeString(h.store.now())})
		if wasRunning {
			body.RuntimeNodeID = &sourceNode
			_ = h.provisionStdioMCP(context.WithoutCancel(r.Context()), p.TenantID, instanceID, body)
		}
	}
	if e = sourceRunner.call(r.Context(), "docker.stop", map[string]any{"id": dockerID, "remove": true}, nil); e != nil {
		h.deps.Gorm.WithContext(context.WithoutCancel(r.Context())).Model(&models.ComponentInstance{}).Where("tenant_id = ? AND id = ?", p.TenantID, instanceID).Updates(map[string]any{"status": status, "last_error": e.Error(), "updated_at": runtimeTimeString(h.store.now())})
		httpx.Error(w, http.StatusBadGateway, e.Error())
		return
	}
	h.deps.Gorm.WithContext(r.Context()).Model(&models.ManagedContainer{}).Where("id = ? AND tenant_id = ?", containerID, p.TenantID).Updates(map[string]any{"status": "removed", "docker_id": nil, "updated_at": runtimeTimeString(h.store.now())})
	dataPath := ""
	var storedConfig map[string]any
	_ = json.Unmarshal([]byte(configRaw), &storedConfig)
	if configuredPath, _ := storedConfig["dataPath"].(string); configuredPath != "" {
		dataPath = configuredPath
	} else {
		dataPath = "/.zakura/components/" + instanceID
	}
	archive, e := (&remoteWorkspace{runner: sourceRunner, spaceID: dataSpaceID}).archive(r.Context(), []string{dataPath})
	if e != nil {
		rollback(e)
		httpx.Error(w, http.StatusBadGateway, e.Error())
		return
	}
	targetWorkspace := &remoteWorkspace{runner: targetRunner, spaceID: dataSpaceID}
	temp := "/.zakura-instance-migration.tar.gz"
	if _, e = targetWorkspace.write(r.Context(), temp, archive); e == nil {
		e = targetWorkspace.extract(r.Context(), temp, "/")
	}
	params, _ := remotePathParams(dataSpaceID, temp)
	_ = targetRunner.call(context.WithoutCancel(r.Context()), "host.fs.remove", params, nil)
	if e != nil {
		rollback(e)
		httpx.Error(w, http.StatusBadGateway, e.Error())
		return
	}
	var config map[string]any
	_ = json.Unmarshal([]byte(configRaw), &config)
	config["runtimeNodeId"] = request.TargetRuntimeNodeID
	updatedConfig, _ := json.Marshal(config)
	nextStatus := "stopped"
	if wasRunning {
		nextStatus = "starting"
	}
	if e = h.deps.Gorm.WithContext(r.Context()).Model(&models.ComponentInstance{}).Where("tenant_id = ? AND id = ?", p.TenantID, instanceID).Updates(map[string]any{"config_json": string(updatedConfig), "status": nextStatus, "last_error": nil, "updated_at": runtimeTimeString(h.store.now())}).Error; e != nil {
		rollback(e)
		statusErr(w, e)
		return
	}
	if wasRunning {
		body.RuntimeNodeID = &request.TargetRuntimeNodeID
		if e = h.provisionStdioMCP(r.Context(), p.TenantID, instanceID, body); e != nil {
			rollback(e)
			httpx.Error(w, http.StatusBadGateway, e.Error())
			return
		}
	}
	httpx.JSON(w, http.StatusOK, map[string]any{"ok": true, "runtimeNodeId": request.TargetRuntimeNodeID})
}
func (h *handler) runWorkspaceMigration(ctx context.Context, id, tenant, space, source, target string) {
	lease, err := h.acquireSpaceWorkspace(ctx, tenant, space, "migrating", false, &workspaceConfig{RuntimeNodeID: &target})
	if err != nil {
		h.failMigration(ctx, id, err)
		return
	}
	if lease.Space.RuntimeNodeID == nil || *lease.Space.RuntimeNodeID != source {
		lease.release()
		h.failMigration(ctx, id, ErrConflict)
		return
	}
	if err := h.migrationPreflight(ctx, lease.Space, target); err != nil {
		lease.release()
		h.failMigration(ctx, id, err)
		return
	}
	h.runLeasedWorkspaceMigration(ctx, id, lease, target)
}
func (h *handler) failMigration(ctx context.Context, id string, e error) {
	now := runtimeTimeString(h.store.now())
	h.deps.Gorm.WithContext(ctx).Model(&models.WorkspaceMigration{}).Where("id = ?", id).Updates(map[string]any{"status": "failed", "phase": "failed", "error": e.Error(), "completed_at": now, "updated_at": now})
}
func (h *handler) authorizeWorkspaceMigration(r *http.Request, space string) error {
	if requested, ok := r.Context().Value(spaceWorkspaceRequestKey{}).(string); ok && requested != space {
		return ErrNotFound
	}
	if err := httpx.AuthorizeResource(r.Context(), h.deps, principal(r), space, ""); err != nil {
		return ErrNotFound
	}
	return nil
}

func (h *handler) getWorkspaceMigration(w http.ResponseWriter, r *http.Request) {
	var m models.WorkspaceMigration
	e := h.deps.Gorm.WithContext(r.Context()).Where("tenant_id = ? AND id = ?", principal(r).TenantID, chi.URLParam(r, "jobId")).Take(&m).Error
	if errors.Is(e, gorm.ErrRecordNotFound) {
		e = ErrNotFound
	}
	if e == nil {
		e = h.authorizeWorkspaceMigration(r, m.SpaceID)
	}
	if e != nil {
		statusErr(w, e)
		return
	}
	httpx.JSON(w, 200, map[string]any{"migration": migrationFromModel(m)})
}
func (h *handler) workspaceMigrationEvents(w http.ResponseWriter, r *http.Request) {
	tenant, id := principal(r).TenantID, chi.URLParam(r, "jobId")
	load := func() (migrationRow, error) {
		var m models.WorkspaceMigration
		if e := h.deps.Gorm.WithContext(r.Context()).Where("tenant_id = ? AND id = ?", tenant, id).Take(&m).Error; e != nil {
			return migrationRow{}, e
		}
		if err := h.authorizeWorkspaceMigration(r, m.SpaceID); err != nil {
			return migrationRow{}, err
		}
		return migrationFromModel(m), nil
	}
	x, e := load()
	if e != nil {
		statusErr(w, ErrNotFound)
		return
	}
	w.Header().Set("Content-Type", "text/event-stream")
	w.Header().Set("Cache-Control", "no-cache")
	w.Header().Set("Connection", "keep-alive")
	flusher, _ := w.(http.Flusher)
	send := func(v migrationRow) bool {
		raw, _ := json.Marshal(v)
		if _, e := fmt.Fprintf(w, "data: %s\n\n", raw); e != nil {
			return false
		}
		if flusher != nil {
			flusher.Flush()
		}
		return true
	}
	if !send(x) {
		return
	}
	for i := 0; i < 120; i++ {
		if x.Status == "completed" || x.Status == "failed" || x.Status == "cancelled" {
			return
		}
		select {
		case <-r.Context().Done():
			return
		case <-time.After(500 * time.Millisecond):
		}
		next, e := load()
		if e != nil {
			return
		}
		x = next
		if !send(x) {
			return
		}
	}
}
