// SPDX-License-Identifier: AGPL-3.0-or-later
package runtime

import (
	"bytes"
	"context"
	"crypto/rand"
	"crypto/sha256"
	"crypto/subtle"
	"encoding/base64"
	"encoding/hex"
	"encoding/json"
	"errors"
	"fmt"
	"io"
	"net/http"
	"net/url"
	"os"
	"path/filepath"
	"regexp"
	"runtime"
	"strings"
	"sync"

	"github.com/Moonrend/Zakura/apps/server/internal/platform/db/models"
	"github.com/Moonrend/Zakura/apps/server/internal/platform/httpx"
	"github.com/go-chi/chi/v5"
)

var runnerTokenCache sync.Map

func newRunnerToken() (string, string, error) {
	raw := make([]byte, 32)
	if _, e := rand.Read(raw); e != nil {
		return "", "", e
	}
	token := "rnr_" + base64.RawURLEncoding.EncodeToString(raw)
	sum := sha256.Sum256([]byte(token))
	return token, hex.EncodeToString(sum[:]), nil
}

func (h *handler) authorizeRunnerNode(r *http.Request, nodeID string, allowQuery bool) bool {
	token := strings.TrimSpace(strings.TrimPrefix(r.Header.Get("Authorization"), "Bearer "))
	if allowQuery && token == "" {
		token = strings.TrimSpace(r.URL.Query().Get("token"))
	}
	if !strings.HasPrefix(token, "rnr_") || len(token) > 4096 {
		return false
	}
	sum := sha256.Sum256([]byte(token))
	var expectedRow struct {
		TokenHash string `gorm:"column:token_hash"`
	}
	if err := h.deps.Gorm.WithContext(r.Context()).Table("runtime_nodes").Select("token_hash").Where("id = ? AND token_hash IS NOT NULL", nodeID).Take(&expectedRow).Error; err != nil {
		return false
	}
	expected := expectedRow.TokenHash
	return subtle.ConstantTimeCompare([]byte(expected), []byte(hex.EncodeToString(sum[:]))) == 1
}
func (h *handler) registerRuntimeNode(w http.ResponseWriter, r *http.Request) {
	var b struct {
		ID, Token, Endpoint, AgentVersion string
		Capabilities, HostInfo            json.RawMessage
	}
	if httpx.DecodeJSON(r, &b) != nil {
		httpx.Error(w, 400, "invalid JSON")
		return
	}
	if b.Token == "" {
		b.Token = strings.TrimPrefix(r.Header.Get("Authorization"), "Bearer ")
	}
	if !strings.HasPrefix(b.Token, "rnr_") {
		httpx.Error(w, 400, "token (rnr_*) is required")
		return
	}
	if strings.TrimSpace(b.Endpoint) == "" {
		httpx.Error(w, 400, "endpoint is required")
		return
	}
	sum := sha256.Sum256([]byte(b.Token))
	hash := hex.EncodeToString(sum[:])
	var nodeRow struct {
		ID string `gorm:"column:id"`
	}
	var e error
	if b.ID != "" {
		e = h.deps.Gorm.WithContext(r.Context()).Table("runtime_nodes").Select("id").Where("id = ? AND token_hash = ?", b.ID, hash).Take(&nodeRow).Error
	} else {
		e = h.deps.Gorm.WithContext(r.Context()).Table("runtime_nodes").Select("id").Where("token_hash = ?", hash).Take(&nodeRow).Error
	}
	if e != nil {
		httpx.Error(w, 401, "unauthorized")
		return
	}
	nodeID := nodeRow.ID
	runnerTokenCache.Store(nodeID, b.Token)
	now := runtimeTimeString(h.store.now())
	e = h.deps.Gorm.WithContext(r.Context()).Model(&models.RuntimeNode{}).Where("id = ?", nodeID).Updates(map[string]any{"status": "online", "endpoint": b.Endpoint, "capabilities_json": validJSON(b.Capabilities, "{}"), "host_info_json": validJSON(b.HostInfo, "{}"), "agent_version": nullString(b.AgentVersion), "last_seen_at": now, "updated_at": now}).Error
	if e != nil {
		statusErr(w, e)
		return
	}
	node, e := scanRuntimeNode(h.deps.Gorm.WithContext(r.Context()).Raw(`SELECT id,name,slug,kind,status,endpoint,capabilities_json,host_info_json,storage_root,agent_version,last_seen_at,labels_json,is_shared,created_at,updated_at FROM runtime_nodes WHERE id=?`, nodeID).Row())
	if e != nil {
		statusErr(w, e)
		return
	}
	httpx.JSON(w, http.StatusOK, map[string]any{"node": node})
}
func (h *handler) runtimeMeshStatus(w http.ResponseWriter, r *http.Request) {
	cfg, err := h.getSetting(r.Context(), "tenant:"+principal(r).TenantID, "network:mesh")
	if err != nil {
		cfg = map[string]any{}
	}
	connected, _ := cfg["connected"].(bool)
	tags, _ := cfg["tags"].([]any)
	if tags == nil {
		tags = []any{}
	}
	httpx.JSON(w, http.StatusOK, map[string]any{"meshConnected": connected, "hasAuthKey": cfg["authKeyEnc"] != nil, "tags": tags, "hostJoinsTailscale": false, "meshProvider": cfg["provider"]})
}
func (h *handler) runtimeAgentBinary(w http.ResponseWriter, r *http.Request) {
	token := strings.TrimPrefix(r.Header.Get("Authorization"), "Bearer ")
	sum := sha256.Sum256([]byte(token))
	var count int64
	if !strings.HasPrefix(token, "rnr_") || h.deps.Gorm.WithContext(r.Context()).Table("runtime_nodes").Where("token_hash = ?", hex.EncodeToString(sum[:])).Count(&count) != nil || count == 0 {
		httpx.Error(w, 401, "unauthorized")
		return
	}
	osName, arch := chi.URLParam(r, "os"), chi.URLParam(r, "arch")
	if !regexp.MustCompile(`^[a-z0-9]+$`).MatchString(osName) || !regexp.MustCompile(`^[a-z0-9]+$`).MatchString(arch) {
		httpx.Error(w, 400, "invalid platform")
		return
	}
	base := os.Getenv("ZAKURA_AGENT_BINARY_DIR")
	if base == "" {
		base = "dist/agent"
	}
	name := "zakura-agent"
	if osName == "windows" {
		name += ".exe"
	}
	file := filepath.Join(base, osName+"-"+arch, name)
	abs, _ := filepath.Abs(file)
	root, _ := filepath.Abs(base)
	rel, _ := filepath.Rel(root, abs)
	if strings.HasPrefix(rel, "..") {
		httpx.Error(w, 403, "Forbidden")
		return
	}
	http.ServeFile(w, r, abs)
}
func (h *handler) runtimeInstallInfo(w http.ResponseWriter, r *http.Request) {
	node, e := h.getRuntimeNodeMap(r)
	if e != nil {
		statusErr(w, e)
		return
	}
	token, _ := runnerTokenCache.Load(chi.URLParam(r, "id"))
	if token == nil {
		httpx.Error(w, http.StatusBadRequest, "registration token is no longer available; recreate the node")
		return
	}
	install := h.runnerInstallPackage(node, token.(string))
	httpx.JSON(w, http.StatusOK, map[string]any{"node": node, "install": install, "installTailscale": nil, "meshConnected": false, "hostJoinsTailscale": false, "meshProvider": nil, "tokenHint": "rnr_…"})
}

func (h *handler) runtimeNodeDetail(w http.ResponseWriter, r *http.Request) {
	node, err := h.getRuntimeNodeMap(r)
	if err != nil {
		statusErr(w, err)
		return
	}
	containers, err := h.runtimeNodeContainerRows(r.Context(), principal(r).TenantID, chi.URLParam(r, "id"))
	if err != nil {
		statusErr(w, err)
		return
	}
	var install any
	if token, ok := runnerTokenCache.Load(chi.URLParam(r, "id")); ok {
		install = h.runnerInstallPackage(node, token.(string))
	}
	httpx.JSON(w, http.StatusOK, map[string]any{"node": node, "containers": containers, "install": install, "installTailscale": nil, "meshConnected": false, "hostJoinsTailscale": false, "meshProvider": nil, "tailscaleError": nil, "tokenHint": nil})
}

func (h *handler) runnerInstallPackage(node map[string]any, token string) map[string]any {
	id, _ := node["id"].(string)
	slug, _ := node["slug"].(string)
	kind, _ := node["kind"].(string)
	if kind != "server" {
		kind = "computer"
	}
	base := strings.TrimRight(h.deps.PublicURL, "/")
	bootstrap := base + "/api/runtime-nodes/" + url.PathEscape(id) + "/bootstrap.sh?token=" + url.QueryEscape(token) + "&kind=" + kind
	script := fmt.Sprintf("#!/bin/sh\nset -eu\nexport ZAKURA_AGENT_SERVER=%q\nexport ZAKURA_AGENT_TOKEN=%q\nexport ZAKURA_AGENT_KIND=%q\nOS=$(uname -s | tr '[:upper:]' '[:lower:]')\nARCH=$(uname -m); [ \"$ARCH\" = x86_64 ] && ARCH=amd64; [ \"$ARCH\" = aarch64 ] && ARCH=arm64\ncurl -fsSL -H \"Authorization: Bearer $ZAKURA_AGENT_TOKEN\" \"$ZAKURA_AGENT_SERVER/api/runtime-nodes/agent-binaries/$OS/$ARCH\" -o /usr/local/bin/zakura-agent\nchmod 0755 /usr/local/bin/zakura-agent\nexec /usr/local/bin/zakura-agent --server \"$ZAKURA_AGENT_SERVER\" --node-id %q --token \"$ZAKURA_AGENT_TOKEN\" --kind \"$ZAKURA_AGENT_KIND\"\n", base, token, kind, id)
	return map[string]any{"compose": "", "filename": "install.sh", "script": script, "dockerRun": "", "enableTailscale": false, "tsHostname": nil, "slug": slug, "hasAuthKey": false, "meshConnected": false, "bootstrapUrl": bootstrap, "installCurl": "curl -fsSL " + shellQuote(bootstrap) + " | sudo sh", "installShUrl": bootstrap, "installPs1Url": base + "/api/runtime-nodes/" + url.PathEscape(id) + "/install.ps1?token=" + url.QueryEscape(token) + "&kind=" + kind, "needsReinstall": false}
}

func shellQuote(value string) string { return "'" + strings.ReplaceAll(value, "'", "'\\''") + "'" }
func (h *handler) getRuntimeNodeMap(r *http.Request) (map[string]any, error) {
	return scanRuntimeNode(h.deps.Gorm.WithContext(r.Context()).Raw(`SELECT id,name,slug,kind,status,endpoint,capabilities_json,host_info_json,storage_root,agent_version,last_seen_at,labels_json,is_shared,created_at,updated_at FROM runtime_nodes WHERE (tenant_id=? OR is_shared=true) AND id=?`, principal(r).TenantID, chi.URLParam(r, "id")).Row())
}
func (h *handler) runtimeInstallSh(w http.ResponseWriter, r *http.Request) {
	if !h.authorizeRunnerNode(r, chi.URLParam(r, "id"), true) {
		http.Error(w, "Unauthorized", http.StatusUnauthorized)
		return
	}
	token := strings.TrimSpace(r.URL.Query().Get("token"))
	if token == "" {
		token = strings.TrimSpace(strings.TrimPrefix(r.Header.Get("Authorization"), "Bearer "))
	}
	kind := "computer"
	if r.URL.Query().Get("kind") == "server" {
		kind = "server"
	}
	w.Header().Set("Content-Type", "text/x-shellscript; charset=utf-8")
	fmt.Fprintf(w, "#!/bin/sh\nset -eu\nexport ZAKURA_AGENT_SERVER=%q\nexport ZAKURA_AGENT_TOKEN=%q\nexport ZAKURA_AGENT_KIND=%q\nOS=$(uname -s | tr '[:upper:]' '[:lower:]')\nARCH=$(uname -m); [ \"$ARCH\" = x86_64 ] && ARCH=amd64; [ \"$ARCH\" = aarch64 ] && ARCH=arm64\ncurl -fsSL -H \"Authorization: Bearer $ZAKURA_AGENT_TOKEN\" \"$ZAKURA_AGENT_SERVER/api/runtime-nodes/agent-binaries/$OS/$ARCH\" -o /usr/local/bin/zakura-agent\nchmod 0755 /usr/local/bin/zakura-agent\nexec /usr/local/bin/zakura-agent --server \"$ZAKURA_AGENT_SERVER\" --node-id %q --token \"$ZAKURA_AGENT_TOKEN\" --kind \"$ZAKURA_AGENT_KIND\"\n", strings.TrimRight(h.deps.PublicURL, "/"), token, kind, chi.URLParam(r, "id"))
}
func (h *handler) runtimeInstallPS(w http.ResponseWriter, r *http.Request) {
	if !h.authorizeRunnerNode(r, chi.URLParam(r, "id"), true) {
		http.Error(w, "Unauthorized", http.StatusUnauthorized)
		return
	}
	token := strings.TrimSpace(r.URL.Query().Get("token"))
	if token == "" {
		token = strings.TrimSpace(strings.TrimPrefix(r.Header.Get("Authorization"), "Bearer "))
	}
	kind := "computer"
	if r.URL.Query().Get("kind") == "server" {
		kind = "server"
	}
	w.Header().Set("Content-Type", "text/plain; charset=utf-8")
	w.Header().Set("X-Content-Type-Options", "nosniff")
	fmt.Fprintf(w, `$ErrorActionPreference='Stop'
$env:ZAKURA_AGENT_SERVER = '%s'
$env:ZAKURA_AGENT_TOKEN = '%s'
$env:ZAKURA_AGENT_KIND = '%s'
Invoke-WebRequest -Headers @{Authorization="Bearer $env:ZAKURA_AGENT_TOKEN"} -Uri "$env:ZAKURA_AGENT_SERVER/api/runtime-nodes/agent-binaries/windows/amd64" -OutFile "$env:ProgramData\Zakura\zakura-agent.exe"
& "$env:ProgramData\Zakura\zakura-agent.exe" --server $env:ZAKURA_AGENT_SERVER --node-id '%s' --token $env:ZAKURA_AGENT_TOKEN --kind $env:ZAKURA_AGENT_KIND
`, strings.ReplaceAll(strings.TrimRight(h.deps.PublicURL, "/"), "'", "''"), strings.ReplaceAll(token, "'", "''"), kind, chi.URLParam(r, "id"))
}

func (h *handler) runtimeBootstrapSh(w http.ResponseWriter, r *http.Request) {
	if !h.authorizeRunnerNode(r, chi.URLParam(r, "id"), true) {
		http.Error(w, "Unauthorized", http.StatusUnauthorized)
		return
	}
	target := "/api/runtime-nodes/" + url.PathEscape(chi.URLParam(r, "id")) + "/install.sh?" + r.URL.Query().Encode()
	http.Redirect(w, r, target, http.StatusFound)
}

type runnerUpdateJob struct {
	ID              string `json:"id"`
	NodeID          string `json:"nodeId"`
	Phase           string `json:"phase"`
	DownloadedBytes int64  `json:"downloadedBytes"`
	TotalBytes      int64  `json:"totalBytes"`
	StartedAt       int64  `json:"startedAt"`
	UpdatedAt       int64  `json:"updatedAt"`
	FinishedAt      *int64 `json:"finishedAt,omitempty"`
	Version         string `json:"version,omitempty"`
	Error           string `json:"error,omitempty"`
	Note            string `json:"note,omitempty"`
}

var runnerUpdateJobs = struct {
	sync.RWMutex
	values map[string]runnerUpdateJob
}{values: map[string]runnerUpdateJob{}}

func (h *handler) runtimeNodeVersion(w http.ResponseWriter, r *http.Request) {
	node, err := h.getRuntimeNodeMap(r)
	if err != nil {
		statusErr(w, err)
		return
	}
	reported, _ := node["agentVersion"]
	result := map[string]any{"version": reported, "image": nil, "containerId": nil, "live": false, "reportedVersion": reported}
	if session, err := h.hub.get(chi.URLParam(r, "id")); err == nil {
		var info struct{ Version, BinPath string }
		if session.call(r.Context(), "sys.info", map[string]any{"light": true}, &info) == nil {
			result["version"], result["image"], result["live"] = info.Version, info.BinPath, true
		}
	}
	httpx.JSON(w, http.StatusOK, result)
}
func (h *handler) runtimeUpdateInfo(w http.ResponseWriter, r *http.Request) {
	id := r.URL.Query().Get("id")
	if id == "" {
		httpx.Error(w, http.StatusBadRequest, "id required")
		return
	}
	runnerUpdateJobs.RLock()
	job, ok := runnerUpdateJobs.values[id]
	runnerUpdateJobs.RUnlock()
	if !ok || job.NodeID != chi.URLParam(r, "id") {
		statusErr(w, ErrNotFound)
		return
	}
	httpx.JSON(w, http.StatusOK, map[string]any{"update": job})
}
func (h *handler) runtimeUpdateRunner(w http.ResponseWriter, r *http.Request) {
	if _, err := h.getRuntimeNodeMap(r); err != nil {
		statusErr(w, err)
		return
	}
	session, err := h.hub.get(chi.URLParam(r, "id"))
	if err != nil {
		httpx.Error(w, http.StatusConflict, err.Error())
		return
	}
	var body struct {
		Image, URL, SHA256, Version string
		RecreateDelayMS             int `json:"recreateDelayMs"`
	}
	if err := json.NewDecoder(r.Body).Decode(&body); err != nil && err != io.EOF {
		httpx.Error(w, http.StatusBadRequest, "invalid JSON")
		return
	}
	if body.Version == "" {
		body.Version = os.Getenv("ZAKURA_AGENT_VERSION")
	}
	if body.Image == "" {
		body.Image = body.URL
	}
	jobID := h.store.id()
	now := h.store.now().UnixMilli()
	job := runnerUpdateJob{ID: jobID, NodeID: chi.URLParam(r, "id"), Phase: "queued", StartedAt: now, UpdatedAt: now, Version: body.Version}
	runnerUpdateJobs.Lock()
	runnerUpdateJobs.values[jobID] = job
	runnerUpdateJobs.Unlock()
	go h.runRunnerUpdate(h.deps.RunContext(), session, job, body.URL, body.Image, body.SHA256, body.RecreateDelayMS)
	httpx.JSON(w, http.StatusAccepted, map[string]any{"image": body.Image, "scheduled": true, "version": body.Version, "update": job})
}
func (h *handler) runRunnerUpdate(ctx context.Context, session *runnerSession, job runnerUpdateJob, downloadURL, image, sha string, delay int) {
	streamID := "update-" + job.ID
	set := func(update func(*runnerUpdateJob)) {
		runnerUpdateJobs.Lock()
		value := runnerUpdateJobs.values[job.ID]
		update(&value)
		value.UpdatedAt = h.store.now().UnixMilli()
		runnerUpdateJobs.values[job.ID] = value
		runnerUpdateJobs.Unlock()
	}
	unsubscribe := session.onStream(streamID, func(channel string, data []byte) {
		if channel != "progress" {
			return
		}
		var progress struct {
			Phase                       string
			DownloadedBytes, TotalBytes int64
		}
		if json.Unmarshal(data, &progress) == nil {
			set(func(j *runnerUpdateJob) {
				if progress.Phase != "" {
					j.Phase = progress.Phase
				}
				j.DownloadedBytes = progress.DownloadedBytes
				j.TotalBytes = progress.TotalBytes
			})
		}
	})
	defer unsubscribe()
	set(func(j *runnerUpdateJob) { j.Phase = "downloading" })
	var result struct {
		OK             bool   `json:"ok"`
		AlreadyCurrent bool   `json:"alreadyCurrent"`
		Note           string `json:"note"`
	}
	err := session.call(ctx, "sys.update", map[string]any{"url": func() string {
		if downloadURL != "" {
			return downloadURL
		}
		return image
	}(), "sha256": sha, "version": job.Version, "restart": true, "recreateDelayMs": delay, "progressStream": streamID}, &result)
	finished := h.store.now().UnixMilli()
	set(func(j *runnerUpdateJob) {
		j.FinishedAt = &finished
		if err != nil || !result.OK {
			j.Phase = "failed"
			if err != nil {
				j.Error = err.Error()
			} else {
				j.Error = result.Note
			}
		} else {
			j.Phase = "completed"
			j.Note = result.Note
		}
	})
}
func (h *handler) refreshWorkspaceImage(w http.ResponseWriter, r *http.Request) {
	var body struct {
		Image           string `json:"image"`
		RecreateRunning *bool  `json:"recreateRunning"`
	}
	if err := json.NewDecoder(r.Body).Decode(&body); err != nil && err != io.EOF {
		httpx.Error(w, http.StatusBadRequest, "invalid JSON")
		return
	}
	if body.Image == "" {
		body.Image = "sunwuyuan/zakura-workspace-dev:latest"
	}
	session, err := h.hub.get(chi.URLParam(r, "id"))
	if err != nil {
		httpx.Error(w, http.StatusServiceUnavailable, err.Error())
		return
	}
	if err = session.call(r.Context(), "docker.pull", map[string]any{"image": body.Image}, nil); err != nil {
		httpx.Error(w, http.StatusBadGateway, err.Error())
		return
	}
	recreated := []map[string]any{}
	if body.RecreateRunning == nil || *body.RecreateRunning {
		var result struct {
			Recreated []struct {
				DockerID, Name string
				Labels         map[string]string
			} `json:"recreated"`
		}
		if err = session.call(r.Context(), "docker.recreate", map[string]any{"image": body.Image}, &result); err != nil {
			httpx.Error(w, http.StatusBadGateway, err.Error())
			return
		}
		for _, item := range result.Recreated {
			recreated = append(recreated, map[string]any{"agentId": item.Labels["zakura.agent"], "spaceId": item.Labels["zakura.space"], "dockerId": item.DockerID, "name": item.Name})
		}
	}
	httpx.JSON(w, http.StatusOK, map[string]any{"image": body.Image, "images": []string{body.Image}, "status": "updated", "recreated": recreated})
}
func (h *handler) runtimeImageUpdates(w http.ResponseWriter, r *http.Request) {
	p := principal(r)
	rows, err := h.deps.Gorm.WithContext(r.Context()).Raw(`SELECT DISTINCT workspace_image FROM spaces WHERE tenant_id=? AND runtime_node_id=? AND workspace_image IS NOT NULL`, p.TenantID, chi.URLParam(r, "id")).Rows()
	if err != nil {
		statusErr(w, err)
		return
	}
	images := []string{}
	for rows.Next() {
		var image string
		if rows.Scan(&image) == nil {
			images = append(images, image)
		}
	}
	rows.Close()
	session, err := h.hub.get(chi.URLParam(r, "id"))
	if err != nil {
		httpx.Error(w, http.StatusServiceUnavailable, err.Error())
		return
	}
	var result []map[string]any
	if err = session.call(r.Context(), "docker.images", map[string]any{"images": images}, &result); err != nil {
		httpx.Error(w, http.StatusBadGateway, err.Error())
		return
	}
	for _, entry := range result {
		entry["kind"] = "workspace"
		if _, ok := entry["updateAvailable"]; !ok {
			entry["updateAvailable"] = entry["runningStale"]
		}
	}
	httpx.JSON(w, http.StatusOK, map[string]any{"images": result, "checkedAt": h.store.now().UnixMilli()})
}
func (h *handler) runtimeNodeContainers(w http.ResponseWriter, r *http.Request) {
	out, err := h.runtimeNodeContainerRows(r.Context(), principal(r).TenantID, chi.URLParam(r, "id"))
	if err != nil {
		statusErr(w, err)
		return
	}
	httpx.JSON(w, http.StatusOK, map[string]any{"containers": out})
}

func (h *handler) runtimeNodeContainerRows(ctx context.Context, tenant, nodeID string) ([]map[string]any, error) {
	rows, err := h.deps.Gorm.WithContext(ctx).Raw(`SELECT id,docker_id,name,image,purpose,status,allocated_to,runtime_node_id,created_at,updated_at FROM managed_containers WHERE tenant_id=? AND runtime_node_id=? ORDER BY created_at DESC`, tenant, nodeID).Rows()
	if err != nil {
		return nil, err
	}
	defer rows.Close()
	out := []map[string]any{}
	for rows.Next() {
		var id, name, image, purpose, status, c, u string
		var docker, allocated, node *string
		if rows.Scan(&id, &docker, &name, &image, &purpose, &status, &allocated, &node, &c, &u) == nil {
			out = append(out, map[string]any{"id": id, "dockerId": docker, "name": name, "image": image, "purpose": purpose, "status": status, "allocatedTo": allocated, "runtimeNodeId": node, "createdAt": c, "updatedAt": u})
		}
	}
	return out, rows.Err()
}
func (h *handler) runtimeNodeAllocate(w http.ResponseWriter, r *http.Request) {
	var b map[string]any
	if json.NewDecoder(r.Body).Decode(&b) != nil {
		httpx.Error(w, 400, "invalid JSON")
		return
	}
	b["runtimeNodeId"] = chi.URLParam(r, "id")
	raw, _ := json.Marshal(b)
	r.Body = io.NopCloser(bytes.NewReader(raw))
	h.allocateContainer(w, r)
}
func (h *handler) deleteWorkspaceResidual(w http.ResponseWriter, r *http.Request) {
	p := principal(r)
	var nodeSpaceRow struct {
		Storage string `gorm:"column:storage_root"`
		SpaceID string `gorm:"column:space_id"`
	}
	e := h.deps.Gorm.WithContext(r.Context()).Raw(`SELECT n.storage_root AS storage_root,a.space_id AS space_id FROM runtime_nodes n JOIN agents a ON a.tenant_id=n.tenant_id WHERE n.tenant_id=? AND n.id=? AND a.id=?`, p.TenantID, chi.URLParam(r, "nodeId"), chi.URLParam(r, "agentId")).Take(&nodeSpaceRow).Error
	if e != nil {
		statusErr(w, ErrNotFound)
		return
	}
	storage, space := nodeSpaceRow.Storage, nodeSpaceRow.SpaceID
	root := filepath.Join(storage, "workspaces", p.TenantID, space)
	base := filepath.Join(storage, "workspaces")
	rel, e := filepath.Rel(base, root)
	if e != nil || strings.HasPrefix(rel, "..") {
		httpx.Error(w, 403, "Forbidden")
		return
	}
	if e = os.RemoveAll(root); e != nil {
		statusErr(w, e)
		return
	}
	httpx.JSON(w, 200, map[string]any{"ok": true})
}
func (h *handler) runtimeDocker(w http.ResponseWriter, r *http.Request) {
	raw, _, e := dockerCall(r.Context(), http.MethodGet, "/version", nil)
	if e != nil {
		httpx.JSON(w, 200, map[string]any{"available": false, "error": e.Error()})
		return
	}
	var version any
	_ = json.Unmarshal(raw, &version)
	httpx.JSON(w, 200, map[string]any{"available": true, "version": version, "goos": runtime.GOOS, "goarch": runtime.GOARCH})
}

var _ = context.Background
var _ = errors.Is
