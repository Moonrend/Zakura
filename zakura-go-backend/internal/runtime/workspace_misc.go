// SPDX-License-Identifier: AGPL-3.0-or-later
package runtime

import (
	"context"
	"crypto/hmac"
	"crypto/sha256"
	"database/sql"
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

	"github.com/go-chi/chi/v5"
	"github.com/momo-mnsjtxy/Zakura/zakura-go-backend/internal/platform/appdeps"
	"github.com/momo-mnsjtxy/Zakura/zakura-go-backend/internal/platform/httpx"
)

func (h *handler) projectDir(r *http.Request) (workspaceFS, string, error) {
	f, e := h.workspaceFor(r.Context(), principal(r).TenantID, chi.URLParam(r, "id"))
	if e != nil {
		return f, "", e
	}
	slug := chi.URLParam(r, "slug")
	var count int
	e = h.deps.DB.QueryRowContext(r.Context(), h.store.q(`SELECT COUNT(*) FROM space_projects p JOIN agents a ON a.space_id=p.space_id WHERE p.tenant_id=? AND a.id=? AND p.slug=?`), principal(r).TenantID, chi.URLParam(r, "id"), slug).Scan(&count)
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
	var enabled bool
	var status, kind, spaceID string
	var node *string
	e := h.deps.DB.QueryRowContext(r.Context(), h.store.q(`SELECT s.enable_computer,s.workspace_status,s.workspace_kind,s.runtime_node_id,s.id FROM spaces s JOIN agents a ON a.space_id=s.id WHERE a.tenant_id=? AND a.id=?`), p.TenantID, chi.URLParam(r, "id")).Scan(&enabled, &status, &kind, &node, &spaceID)
	if errors.Is(e, sql.ErrNoRows) {
		statusErr(w, ErrNotFound)
		return
	}
	if e != nil {
		statusErr(w, e)
		return
	}
	supported := enabled && kind != "host"
	var dockerID sql.NullString
	var containerStatus sql.NullString
	_ = h.deps.DB.QueryRowContext(r.Context(), h.store.q(`SELECT docker_id,status FROM managed_containers WHERE tenant_id=? AND space_id=? AND purpose='workspace' ORDER BY created_at DESC LIMIT 1`), p.TenantID, spaceID).Scan(&dockerID, &containerStatus)
	if containerStatus.Valid {
		status = containerStatus.String
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
		"containerStatus": status, "dockerId": nullableString(dockerID),
		"novncUrl": nil, "novncPort": nil, "cdpUrl": nil, "cdpPort": nil, "vncPort": nil,
		"width": 1280, "height": 720,
	})
}
func (h *handler) workspaceTicket(w http.ResponseWriter, r *http.Request, kind string) {
	p := principal(r)
	agent := chi.URLParam(r, "id")
	var enabled bool
	if e := h.deps.DB.QueryRowContext(r.Context(), h.store.q(`SELECT s.enable_computer FROM agents a JOIN spaces s ON s.id=a.space_id WHERE a.tenant_id=? AND a.id=?`), p.TenantID, agent).Scan(&enabled); e != nil {
		statusErr(w, e)
		return
	}
	if !enabled {
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
	rows, e := h.deps.DB.QueryContext(r.Context(), h.store.q(`SELECT b.agent_id,i.id,i.name,i.component_type FROM agent_bindings b JOIN component_instances i ON i.id=b.instance_id WHERE b.tenant_id=? AND b.space_id=?`), p.TenantID, space)
	if e != nil {
		statusErr(w, e)
		return
	}
	defer rows.Close()
	seen := map[string]bool{}
	for rows.Next() {
		var agentID, instance, name, kind string
		if rows.Scan(&agentID, &instance, &name, &kind) == nil {
			if !seen[instance] {
				nodes = append(nodes, map[string]any{"id": instance, "kind": kind, "name": name})
				seen[instance] = true
			}
			edges = append(edges, map[string]any{"from": agentID, "to": instance, "kind": "binding"})
		}
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

func scanMigration(row interface{ Scan(...any) error }) (migrationRow, error) {
	var x migrationRow
	e := row.Scan(&x.ID, &x.TenantID, &x.SpaceID, &x.SourceNodeID, &x.TargetNodeID, &x.Status, &x.Phase, &x.Progress, &x.Message, &x.Error, &x.StartedAt, &x.CompletedAt, &x.CreatedAt, &x.UpdatedAt)
	return x, e
}
func (h *handler) listWorkspaceMigrations(w http.ResponseWriter, r *http.Request) {
	p := principal(r)
	var space string
	if e := h.deps.DB.QueryRowContext(r.Context(), h.store.q(`SELECT space_id FROM agents WHERE tenant_id=? AND id=?`), p.TenantID, chi.URLParam(r, "id")).Scan(&space); e != nil {
		statusErr(w, ErrNotFound)
		return
	}
	rows, e := h.deps.DB.QueryContext(r.Context(), h.store.q(`SELECT id,tenant_id,space_id,source_node_id,target_node_id,status,phase,progress_pct,message,error,started_at,completed_at,created_at,updated_at FROM workspace_migrations WHERE tenant_id=? AND space_id=? ORDER BY created_at DESC`), p.TenantID, space)
	if e != nil {
		statusErr(w, e)
		return
	}
	defer rows.Close()
	out := []migrationRow{}
	for rows.Next() {
		x, e := scanMigration(rows)
		if e == nil {
			out = append(out, x)
		}
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
	var space, source string
	e := h.deps.DB.QueryRowContext(r.Context(), h.store.q(`SELECT a.space_id,s.runtime_node_id FROM agents a JOIN spaces s ON s.id=a.space_id WHERE a.tenant_id=? AND a.id=?`), p.TenantID, chi.URLParam(r, "id")).Scan(&space, &source)
	if e != nil || source == "" {
		httpx.Error(w, 409, "source runtime node required")
		return
	}
	if source == b.TargetRuntimeNodeID {
		httpx.Error(w, http.StatusBadRequest, "source and target runtime nodes must differ")
		return
	}
	var targetExists int
	if e = h.deps.DB.QueryRowContext(r.Context(), h.store.q(`SELECT COUNT(*) FROM runtime_nodes WHERE id=? AND (tenant_id=? OR is_shared=true)`), b.TargetRuntimeNodeID, p.TenantID).Scan(&targetExists); e != nil || targetExists == 0 {
		statusErr(w, ErrNotFound)
		return
	}
	id := h.store.id()
	now := h.store.now()
	_, e = h.deps.DB.ExecContext(r.Context(), h.store.q(`INSERT INTO workspace_migrations(id,tenant_id,space_id,source_node_id,target_node_id,status,phase,progress_pct,message,manifest_json,archive_path,archive_size,archive_sha256,exclude_patterns_json,source_retained,error,started_at,completed_at,created_at,updated_at) VALUES(?,?,?,?,?,'pending','queued',0,NULL,NULL,NULL,NULL,NULL,'[]',false,NULL,NULL,NULL,?,?)`), id, p.TenantID, space, source, b.TargetRuntimeNodeID, now, now)
	if e != nil {
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
	var configRaw, secretRaw, status, name, ref string
	if e := h.deps.DB.QueryRowContext(r.Context(), h.store.q(`SELECT name,component_ref,config_json,secret_json,status FROM component_instances WHERE tenant_id=? AND id=? AND component_type='mcp'`), p.TenantID, instanceID).Scan(&name, &ref, &configRaw, &secretRaw, &status); errors.Is(e, sql.ErrNoRows) {
		statusErr(w, ErrNotFound)
		return
	} else if e != nil {
		statusErr(w, e)
		return
	}
	body, ok, secretErr := h.stdioBodyForInstance(mcpInstance{ID: instanceID, TenantID: p.TenantID, Name: name, Ref: ref, Config: json.RawMessage(configRaw), Secret: json.RawMessage(secretRaw)})
	if secretErr != nil {
		httpx.Error(w, http.StatusBadRequest, secretErr.Error())
		return
	}
	if !ok {
		httpx.Error(w, http.StatusBadRequest, "only container stdio MCP instances support migration")
		return
	}
	var containerID, sourceNode, dockerID, dataSpaceID string
	e := h.deps.DB.QueryRowContext(r.Context(), h.store.q(`SELECT id,runtime_node_id,docker_id,space_id FROM managed_containers WHERE tenant_id=? AND instance_id=? AND runtime_node_id IS NOT NULL AND docker_id IS NOT NULL AND space_id IS NOT NULL ORDER BY created_at DESC LIMIT 1`), p.TenantID, instanceID).Scan(&containerID, &sourceNode, &dockerID, &dataSpaceID)
	if e != nil {
		httpx.Error(w, http.StatusBadRequest, "instance has no source runtime container")
		return
	}
	if sourceNode == request.TargetRuntimeNodeID {
		httpx.JSON(w, http.StatusOK, map[string]any{"ok": true, "runtimeNodeId": sourceNode})
		return
	}
	var targetCount int
	if e = h.deps.DB.QueryRowContext(r.Context(), h.store.q(`SELECT COUNT(*) FROM runtime_nodes WHERE id=? AND (tenant_id=? OR is_shared=TRUE)`), request.TargetRuntimeNodeID, p.TenantID).Scan(&targetCount); e != nil || targetCount == 0 {
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
	if _, e = h.deps.DB.ExecContext(r.Context(), h.store.q(`UPDATE component_instances SET status='migrating',updated_at=? WHERE tenant_id=? AND id=? AND status=?`), h.store.now(), p.TenantID, instanceID, status); e != nil {
		statusErr(w, e)
		return
	}
	rollback := func(cause error) {
		var config map[string]any
		_ = json.Unmarshal([]byte(configRaw), &config)
		config["runtimeNodeId"] = sourceNode
		restored, _ := json.Marshal(config)
		_, _ = h.deps.DB.ExecContext(context.WithoutCancel(r.Context()), h.store.q(`UPDATE component_instances SET config_json=?,status=?,last_error=?,updated_at=? WHERE tenant_id=? AND id=?`), string(restored), status, cause.Error(), h.store.now(), p.TenantID, instanceID)
		if wasRunning {
			body.RuntimeNodeID = &sourceNode
			_ = h.provisionStdioMCP(context.WithoutCancel(r.Context()), p.TenantID, instanceID, body)
		}
	}
	if e = sourceRunner.call(r.Context(), "docker.stop", map[string]any{"id": dockerID, "remove": true}, nil); e != nil {
		_, _ = h.deps.DB.ExecContext(context.WithoutCancel(r.Context()), h.store.q(`UPDATE component_instances SET status=?,last_error=?,updated_at=? WHERE tenant_id=? AND id=?`), status, e.Error(), h.store.now(), p.TenantID, instanceID)
		httpx.Error(w, http.StatusBadGateway, e.Error())
		return
	}
	_, _ = h.deps.DB.ExecContext(r.Context(), h.store.q(`UPDATE managed_containers SET status='removed',docker_id=NULL,updated_at=? WHERE id=? AND tenant_id=?`), h.store.now(), containerID, p.TenantID)
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
	if _, e = h.deps.DB.ExecContext(r.Context(), h.store.q(`UPDATE component_instances SET config_json=?,status=?,last_error=NULL,updated_at=? WHERE tenant_id=? AND id=?`), string(updatedConfig), nextStatus, h.store.now(), p.TenantID, instanceID); e != nil {
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
	now := h.store.now()
	_, _ = h.deps.DB.ExecContext(ctx, h.store.q(`UPDATE workspace_migrations SET status='running',phase='exporting',progress_pct=10,started_at=?,updated_at=? WHERE id=?`), now, now, id)
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
	_, _ = h.deps.DB.ExecContext(ctx, h.store.q(`UPDATE workspace_migrations SET phase='transferring',progress_pct=50,archive_size=?,archive_sha256=?,manifest_json=?,updated_at=? WHERE id=?`), fmt.Sprint(len(archive)), hex.EncodeToString(digest[:]), fmt.Sprintf(`{"format":"tar.gz","filesRoot":"/","sourceNodeId":%q}`, source), h.store.now(), id)
	targetWorkspace := &remoteWorkspace{runner: targetRunner, spaceID: space}
	_, _ = h.deps.DB.ExecContext(ctx, h.store.q(`UPDATE workspace_migrations SET phase='importing',progress_pct=75,updated_at=? WHERE id=?`), h.store.now(), id)
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
	e = appdeps.InTx(ctx, h.deps.DB, func(tx *sql.Tx) error {
		if _, e := tx.ExecContext(ctx, h.store.q(`UPDATE spaces SET runtime_node_id=?,workspace_status='ready',updated_at=? WHERE tenant_id=? AND id=?`), target, h.store.now(), tenant, space); e != nil {
			return e
		}
		_, e := tx.ExecContext(ctx, h.store.q(`UPDATE workspace_migrations SET status='completed',phase='completed',progress_pct=100,source_retained=true,completed_at=?,updated_at=? WHERE id=?`), h.store.now(), h.store.now(), id)
		return e
	})
	if e != nil {
		h.failMigration(ctx, id, e)
	}
}
func (h *handler) failMigration(ctx context.Context, id string, e error) {
	_, _ = h.deps.DB.ExecContext(ctx, h.store.q(`UPDATE workspace_migrations SET status='failed',phase='failed',error=?,completed_at=?,updated_at=? WHERE id=?`), e.Error(), h.store.now(), h.store.now(), id)
}
func (h *handler) getWorkspaceMigration(w http.ResponseWriter, r *http.Request) {
	x, e := scanMigration(h.deps.DB.QueryRowContext(r.Context(), h.store.q(`SELECT id,tenant_id,space_id,source_node_id,target_node_id,status,phase,progress_pct,message,error,started_at,completed_at,created_at,updated_at FROM workspace_migrations WHERE tenant_id=? AND id=?`), principal(r).TenantID, chi.URLParam(r, "jobId")))
	if errors.Is(e, sql.ErrNoRows) {
		e = ErrNotFound
	}
	if e != nil {
		statusErr(w, e)
		return
	}
	httpx.JSON(w, 200, map[string]any{"migration": x})
}
func (h *handler) workspaceMigrationEvents(w http.ResponseWriter, r *http.Request) {
	tenant, id := principal(r).TenantID, chi.URLParam(r, "jobId")
	query := h.store.q(`SELECT id,tenant_id,space_id,source_node_id,target_node_id,status,phase,progress_pct,message,error,started_at,completed_at,created_at,updated_at FROM workspace_migrations WHERE tenant_id=? AND id=?`)
	x, e := scanMigration(h.deps.DB.QueryRowContext(r.Context(), query, tenant, id))
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
		next, e := scanMigration(h.deps.DB.QueryRowContext(r.Context(), query, tenant, id))
		if e != nil {
			return
		}
		x = next
		if !send(x) {
			return
		}
	}
}
