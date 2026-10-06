// SPDX-License-Identifier: AGPL-3.0-or-later
package runtime

import (
	"context"
	"crypto/hmac"
	"crypto/sha256"
	"encoding/base64"
	"encoding/hex"
	"encoding/json"
	"errors"
	"fmt"
	"net/http"
	"net/url"
	"os"
	"path/filepath"
	"strings"
	"time"

	"github.com/Moonrend/Zakura/go/server/internal/platform/db/models"
	"github.com/Moonrend/Zakura/go/server/internal/platform/httpx"
	"github.com/go-chi/chi/v5"
	"gorm.io/gorm"
)

func (h *handler) projectDir(r *http.Request) (workspaceFS, string, error) {
	f, e := h.workspaceFor(r.Context(), principal(r).TenantID, chi.URLParam(r, "id"))
	if e != nil {
		return f, "", e
	}
	slug := chi.URLParam(r, "slug")
	var count int64
	e = h.deps.Gorm.WithContext(r.Context()).Table("space_projects AS p").Joins("JOIN agents a ON a.space_id = p.space_id").Where("p.tenant_id = ? AND a.id = ? AND p.slug = ?", principal(r).TenantID, chi.URLParam(r, "id"), slug).Count(&count).Error
	if e != nil || count == 0 {
		return f, "", ErrNotFound
	}
	dir, e := f.resolve(filepath.Join("projects", slug), false)
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
	instructions := map[string]any{"file": nil, "content": "", "claudeFallback": false}
	for _, name := range []string{"AGENTS.md", "CLAUDE.md"} {
		if raw, err := os.ReadFile(filepath.Join(dir, name)); err == nil {
			instructions["file"], instructions["content"], instructions["claudeFallback"] = name, string(raw), name == "CLAUDE.md"
			break
		}
	}
	events := map[string]any{}
	hookFile := any(nil)
	if raw, err := os.ReadFile(filepath.Join(dir, ".zakura", "hooks.json")); err == nil {
		_ = json.Unmarshal(raw, &events)
		hookFile = ".zakura/hooks.json"
	}
	skills := []map[string]any{}
	skillRoot := filepath.Join(dir, ".zakura", "skills")
	entries, _ := os.ReadDir(skillRoot)
	for _, entry := range entries {
		if !entry.IsDir() {
			continue
		}
		name := entry.Name()
		raw, err := os.ReadFile(filepath.Join(skillRoot, name, "SKILL.md"))
		if err != nil {
			continue
		}
		description := ""
		for _, line := range strings.Split(string(raw), "\n") {
			line = strings.TrimSpace(line)
			if line != "" && !strings.HasPrefix(line, "#") {
				description = line
				break
			}
		}
		skills = append(skills, map[string]any{"name": name, "title": name, "description": description, "path": ".zakura/skills/" + name + "/SKILL.md"})
	}
	return map[string]any{"slug": slug, "exists": true, "instructions": instructions, "skills": skills, "hooks": map[string]any{"file": hookFile, "events": events, "sources": func() []map[string]any {
		if hookFile != nil {
			return []map[string]any{{"file": hookFile, "events": events}}
		}
		return []map[string]any{}
	}()}}
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
	file := ".zakura/hooks.json"
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
	if err = atomicWrite(filepath.Join(dir, clean), raw, 0o640); err != nil {
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
		if _, err = remote.write(r.Context(), projectRemotePath(chi.URLParam(r, "slug"), ".zakura", "skills", name, "SKILL.md"), []byte(content)); err != nil {
			writeRemoteError(w, err)
			return
		}
		skill := map[string]any{"name": name, "title": func() string {
			if body.Name != "" {
				return body.Name
			}
			return name
		}(), "description": body.Description, "path": ".zakura/skills/" + name + "/SKILL.md"}
		httpx.JSON(w, http.StatusOK, map[string]any{"skill": skill, "config": remote.projectSnapshot(r.Context(), chi.URLParam(r, "slug"))})
		return
	}
	_, dir, err := h.projectDir(r)
	if err != nil {
		statusErr(w, err)
		return
	}
	target := filepath.Join(dir, ".zakura", "skills", name, "SKILL.md")
	if err = atomicWrite(target, []byte(content), 0o640); err != nil {
		statusErr(w, err)
		return
	}
	skill := map[string]any{"name": name, "title": func() string {
		if body.Name != "" {
			return body.Name
		}
		return name
	}(), "description": body.Description, "path": ".zakura/skills/" + name + "/SKILL.md"}
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
		params, _ := remotePathParams(remote.spaceID, projectRemotePath(chi.URLParam(r, "slug"), ".zakura", "skills", name))
		params["recursive"] = true
		if err = remote.runner.call(r.Context(), "host.fs.remove", params, nil); err != nil {
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
	if err = os.RemoveAll(filepath.Join(dir, ".zakura", "skills", name)); err != nil {
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
		raw, _, err := remote.read(r.Context(), projectRemotePath(chi.URLParam(r, "slug"), ".zakura", "skills", name, filepath.ToSlash(clean)), 1<<20)
		if err != nil {
			writeRemoteError(w, err)
			return
		}
		httpx.JSON(w, http.StatusOK, map[string]any{"path": filepath.ToSlash(filepath.Join(".zakura", "skills", name, clean)), "content": string(raw)})
		return
	}
	_, dir, err := h.projectDir(r)
	if err != nil {
		statusErr(w, err)
		return
	}
	raw, err := os.ReadFile(filepath.Join(dir, ".zakura", "skills", name, clean))
	if errors.Is(err, os.ErrNotExist) {
		statusErr(w, ErrNotFound)
		return
	}
	if err != nil {
		statusErr(w, err)
		return
	}
	httpx.JSON(w, http.StatusOK, map[string]any{"path": filepath.ToSlash(filepath.Join(".zakura", "skills", name, clean)), "content": string(raw)})
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
	agent := chi.URLParam(r, "id")
	var rec struct {
		EnableComputer bool `gorm:"column:enable_computer"`
	}
	if e := h.deps.Gorm.WithContext(r.Context()).Table("agents AS a").Select("s.enable_computer AS enable_computer").Joins("JOIN spaces s ON s.id = a.space_id").Where("a.tenant_id = ? AND a.id = ?", p.TenantID, agent).Take(&rec).Error; e != nil {
		statusErr(w, e)
		return
	}
	if !rec.EnableComputer {
		httpx.Error(w, http.StatusConflict, "Desktop is disabled")
		return
	}
	expires := h.store.now().Add(45 * time.Second)
	payloadMap := map[string]any{"tenantId": p.TenantID, "userId": p.UserID, "agentId": agent, "kind": kind, "exp": expires.Unix()}
	if adapterID := strings.TrimSpace(r.URL.Query().Get("adapterId")); adapterID != "" && kind == "terminal" {
		payloadMap["adapterId"] = adapterID
	}
	payload, _ := json.Marshal(payloadMap)
	body := base64.RawURLEncoding.EncodeToString(payload)
	mac := hmac.New(sha256.New, h.deps.Secret)
	mac.Write([]byte("workspace:" + body))
	token := body + "." + base64.RawURLEncoding.EncodeToString(mac.Sum(nil))
	httpx.JSON(w, http.StatusOK, map[string]any{"ticket": token, "url": strings.TrimRight(h.deps.PublicURL, "/") + "/api/agents/" + url.PathEscape(agent) + "/" + kind + "-proxy?token=" + url.QueryEscape(token)})
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
	var agent models.Agent
	if e := h.deps.Gorm.WithContext(r.Context()).Where("tenant_id = ? AND id = ?", p.TenantID, chi.URLParam(r, "id")).Take(&agent).Error; e != nil {
		statusErr(w, ErrNotFound)
		return
	}
	space := agent.SpaceID
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
	var rec struct {
		SpaceID       string  `gorm:"column:space_id"`
		RuntimeNodeID *string `gorm:"column:runtime_node_id"`
	}
	e := h.deps.Gorm.WithContext(r.Context()).Table("agents AS a").Select("a.space_id AS space_id, s.runtime_node_id AS runtime_node_id").Joins("JOIN spaces s ON s.id = a.space_id").Where("a.tenant_id = ? AND a.id = ?", p.TenantID, chi.URLParam(r, "id")).Take(&rec).Error
	source := ""
	if rec.RuntimeNodeID != nil {
		source = *rec.RuntimeNodeID
	}
	space := rec.SpaceID
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
	id := h.store.id()
	now := runtimeTimeString(h.store.now())
	phase := "queued"
	m := models.WorkspaceMigration{ID: &id, TenantID: p.TenantID, SpaceID: space, SourceNodeID: source, TargetNodeID: b.TargetRuntimeNodeID, Status: "pending", Phase: &phase, ProgressPct: 0, ExcludePatternsJSON: "[]", SourceRetained: false, CreatedAt: now, UpdatedAt: now}
	if e = h.deps.Gorm.WithContext(r.Context()).Create(&m).Error; e != nil {
		statusErr(w, e)
		return
	}
	go h.runWorkspaceMigration(h.deps.RunContext(), id, p.TenantID, space, source, b.TargetRuntimeNodeID)
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
	now := runtimeTimeString(h.store.now())
	h.deps.Gorm.WithContext(ctx).Model(&models.WorkspaceMigration{}).Where("id = ?", id).Updates(map[string]any{"status": "running", "phase": "exporting", "progress_pct": 10, "started_at": now, "updated_at": now})
	sourceRunner, e := h.hub.get(source)
	if e != nil {
		h.failMigration(ctx, id, errors.New("source runtime node is offline"))
		return
	}
	targetRunner, e := h.hub.get(target)
	if e != nil {
		h.failMigration(ctx, id, errors.New("target runtime node is offline"))
		return
	}
	archive, e := (&remoteWorkspace{runner: sourceRunner, spaceID: space}).archive(ctx, []string{"/"})
	if e != nil {
		h.failMigration(ctx, id, e)
		return
	}
	digest := sha256.Sum256(archive)
	h.deps.Gorm.WithContext(ctx).Model(&models.WorkspaceMigration{}).Where("id = ?", id).Updates(map[string]any{"phase": "transferring", "progress_pct": 50, "archive_size": fmt.Sprint(len(archive)), "archive_sha256": hex.EncodeToString(digest[:]), "manifest_json": fmt.Sprintf(`{"format":"tar.gz","filesRoot":"/","sourceNodeId":%q}`, source), "updated_at": runtimeTimeString(h.store.now())})
	targetWorkspace := &remoteWorkspace{runner: targetRunner, spaceID: space}
	h.deps.Gorm.WithContext(ctx).Model(&models.WorkspaceMigration{}).Where("id = ?", id).Updates(map[string]any{"phase": "importing", "progress_pct": 75, "updated_at": runtimeTimeString(h.store.now())})
	tempPath := "/.zakura-migration-" + id + ".tar.gz"
	if _, e = targetWorkspace.write(ctx, tempPath, archive); e == nil {
		e = targetWorkspace.extract(ctx, tempPath, "/")
	}
	params, _ := remotePathParams(space, tempPath)
	_ = targetRunner.call(h.deps.RunContext(), "host.fs.remove", params, nil)
	if e != nil {
		h.failMigration(ctx, id, e)
		return
	}
	e = h.deps.Gorm.WithContext(ctx).Transaction(func(tx *gorm.DB) error {
		if e := tx.Exec(`UPDATE spaces SET runtime_node_id=?,workspace_status='ready',updated_at=? WHERE tenant_id=? AND id=?`, target, h.store.now(), tenant, space).Error; e != nil {
			return e
		}
		return tx.Exec(`UPDATE workspace_migrations SET status='completed',phase='completed',progress_pct=100,source_retained=true,completed_at=?,updated_at=? WHERE id=?`, h.store.now(), h.store.now(), id).Error
	})
	if e != nil {
		h.failMigration(ctx, id, e)
	}
}
func (h *handler) failMigration(ctx context.Context, id string, e error) {
	now := runtimeTimeString(h.store.now())
	h.deps.Gorm.WithContext(ctx).Model(&models.WorkspaceMigration{}).Where("id = ?", id).Updates(map[string]any{"status": "failed", "phase": "failed", "error": e.Error(), "completed_at": now, "updated_at": now})
}
func (h *handler) getWorkspaceMigration(w http.ResponseWriter, r *http.Request) {
	var m models.WorkspaceMigration
	e := h.deps.Gorm.WithContext(r.Context()).Where("tenant_id = ? AND id = ?", principal(r).TenantID, chi.URLParam(r, "jobId")).Take(&m).Error
	if errors.Is(e, gorm.ErrRecordNotFound) {
		e = ErrNotFound
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
