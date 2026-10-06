// SPDX-License-Identifier: AGPL-3.0-or-later
package runtime

import (
	"context"
	"crypto/sha256"
	"encoding/base64"
	"encoding/hex"
	"encoding/json"
	"errors"
	"fmt"
	"io"
	"mime"
	"net/http"
	"path/filepath"
	"strconv"
	"strings"
	"time"
	"unicode/utf8"

	"github.com/Moonrend/Zakura/go/server/internal/platform/db/models"
	"github.com/Moonrend/Zakura/go/server/internal/platform/httpx"
	"github.com/go-chi/chi/v5"
	"gorm.io/gorm"
	"gorm.io/gorm/clause"
)

func (h *handler) registerZakuraBotApp(r chi.Router) {
	r.Get("/zakurabot/agents", h.zakuraBotAgents)
	r.Get("/zakurabot/bots", h.zakuraBotBots)
	r.Get("/zakurabot/spaces", h.zakuraBotSpaces)
	r.Get("/zakurabot/agents/{id}", h.zakuraBotAgent)
	r.Get("/zakurabot/agents/{id}/history", h.zakuraBotHistory)
	r.Post("/zakurabot/agents/{id}/files", h.zakuraBotUpload)
	r.Get("/zakurabot/agents/{id}/files/{fileId}", h.zakuraBotDownload)
	r.Get("/zakurabot/agents/{id}/desktop", h.zakuraBotDesktop)
	r.Get("/zakurabot/agents/{id}/desktop/frame", h.zakuraBotDesktopFrame)
	r.Post("/zakurabot/agents/{id}/exec", h.zakuraBotExec)
	r.Get("/zakurabot/agents/{id}/interactions", h.zakuraBotInteractions)
	r.Get("/zakurabot/agents/{id}/interactions/{messageId}", h.zakuraBotInteraction)
	r.Post("/zakurabot/agents/{id}/interactions/{messageId}", h.answerZakuraBotInteraction)
	r.Get("/zakurabot/agents/{id}/messages/{messageId}/reactions", h.zakuraBotReactions)
	r.Post("/zakurabot/agents/{id}/messages/{messageId}/reactions", h.addZakuraBotReaction)
	r.Delete("/zakurabot/agents/{id}/messages/{messageId}/reactions", h.deleteZakuraBotReaction)
	r.Get("/zakurabot/sessions/{agentId}", h.getZakuraBotManagedSession)
	r.Post("/zakurabot/sessions/{agentId}", h.manageZakuraBotSession)
}
func zakuraNoStore(w http.ResponseWriter)                      { w.Header().Set("Cache-Control", "no-store") }
func (h *handler) zakuraActor(r *http.Request) httpx.Principal { return principal(r) }
func (h *handler) zakuraRoster(r *http.Request) ([]map[string]any, map[string]string, error) {
	return h.zakuraBotRoster(r.Context(), h.zakuraActor(r))
}
func (h *handler) zakuraAccess(r *http.Request, agentID string) (string, error) {
	agents, bindings, err := h.zakuraRoster(r)
	if err != nil {
		return "", err
	}
	for _, agent := range agents {
		if agent["id"] == agentID && bindings[agentID] != "" {
			return bindings[agentID], nil
		}
	}
	return "", ErrNotFound
}
func (h *handler) zakuraBotAgents(w http.ResponseWriter, r *http.Request) {
	zakuraNoStore(w)
	agents, _, err := h.zakuraRoster(r)
	if err != nil {
		statusErr(w, err)
		return
	}
	httpx.JSON(w, http.StatusOK, map[string]any{"agents": agents})
}
func (h *handler) zakuraBotBots(w http.ResponseWriter, r *http.Request) {
	zakuraNoStore(w)
	agents, _, err := h.zakuraRoster(r)
	if err != nil {
		statusErr(w, err)
		return
	}
	httpx.JSON(w, http.StatusOK, map[string]any{"bots": agents})
}
func (h *handler) zakuraBotSpaces(w http.ResponseWriter, r *http.Request) {
	zakuraNoStore(w)
	p := h.zakuraActor(r)
	spaces, err := h.store.ListSpaces(r.Context(), p.TenantID)
	if err != nil {
		statusErr(w, err)
		return
	}
	agents, err := h.store.ListAgents(r.Context(), p.TenantID)
	if err != nil {
		statusErr(w, err)
		return
	}
	counts := map[string]int{}
	for _, a := range agents {
		counts[a.SpaceID]++
	}
	out := []map[string]any{}
	for _, s := range spaces {
		out = append(out, map[string]any{"id": s.ID, "name": s.Name, "slug": s.Slug, "agentCount": counts[s.ID]})
	}
	httpx.JSON(w, http.StatusOK, map[string]any{"spaces": out})
}
func (h *handler) zakuraBotAgent(w http.ResponseWriter, r *http.Request) {
	zakuraNoStore(w)
	agents, _, err := h.zakuraRoster(r)
	if err != nil {
		statusErr(w, err)
		return
	}
	for _, agent := range agents {
		if agent["id"] == chi.URLParam(r, "id") {
			httpx.JSON(w, http.StatusOK, map[string]any{"agent": agent})
			return
		}
	}
	httpx.Error(w, http.StatusNotFound, "Agent not available")
}
func (h *handler) zakuraBotHistory(w http.ResponseWriter, r *http.Request) {
	zakuraNoStore(w)
	agent := chi.URLParam(r, "id")
	binding, err := h.zakuraAccess(r, agent)
	if err != nil {
		statusErr(w, ErrNotFound)
		return
	}
	limit := 100
	if raw := r.URL.Query().Get("limit"); raw != "" {
		limit, _ = strconv.Atoi(raw)
	}
	if limit < 1 || limit > 100 {
		httpx.Error(w, http.StatusBadRequest, "limit must be between 1 and 100")
		return
	}
	before := int64(1 << 62)
	if raw := r.URL.Query().Get("before"); raw != "" {
		before, err = strconv.ParseInt(raw, 10, 64)
		if err != nil || before < 1 {
			httpx.Error(w, http.StatusBadRequest, "before must be a positive integer")
			return
		}
	}
	p := h.zakuraActor(r)
	var ms []models.ZakurabotMessage
	if err := h.deps.Gorm.WithContext(r.Context()).Where("tenant_id = ? AND device_id = ? AND binding_id = ? AND agent_id = ? AND seq < ?", p.TenantID, p.UserID, binding, agent, before).Order("seq DESC").Limit(limit).Find(&ms).Error; err != nil {
		statusErr(w, err)
		return
	}
	type item struct {
		seq   int64
		frame any
	}
	items := []item{}
	for _, m := range ms {
		var frame any
		if json.Unmarshal([]byte(m.FrameJSON), &frame) == nil {
			items = append(items, item{int64(m.Seq), frame})
		}
	}
	out := []map[string]any{}
	for i := len(items) - 1; i >= 0; i-- {
		out = append(out, map[string]any{"seq": items[i].seq, "frame": items[i].frame})
	}
	var next any
	if len(items) == limit {
		next = items[len(items)-1].seq
	}
	httpx.JSON(w, http.StatusOK, map[string]any{"items": out, "nextBefore": next})
}
func (h *handler) zakuraRunner(r *http.Request) (*runnerSession, string, bool, error) {
	p := h.zakuraActor(r)
	agent := chi.URLParam(r, "id")
	if _, err := h.zakuraAccess(r, agent); err != nil {
		return nil, "", false, err
	}
	var rec struct {
		RuntimeNodeID  string `gorm:"column:runtime_node_id"`
		SpaceID        string `gorm:"column:space_id"`
		EnableComputer bool   `gorm:"column:enable_computer"`
	}
	err := h.deps.Gorm.WithContext(r.Context()).Table("agents AS a").Select("COALESCE(s.runtime_node_id,'') AS runtime_node_id, s.id AS space_id, s.enable_computer AS enable_computer").Joins("JOIN spaces s ON s.id = a.space_id").Where("a.tenant_id = ? AND a.id = ?", p.TenantID, agent).Take(&rec).Error
	if err != nil {
		return nil, "", false, err
	}
	session, err := h.hub.get(rec.RuntimeNodeID)
	return session, rec.SpaceID, rec.EnableComputer, err
}
func safeUploadName(name string) string {
	name = filepath.Base(strings.ReplaceAll(name, "\\", "/"))
	name = strings.Map(func(r rune) rune {
		if r < 32 || r == 127 {
			return -1
		}
		return r
	}, name)
	if name == "" || name == "." {
		name = "file"
	}
	if len(name) > 240 {
		name = name[:240]
	}
	return name
}
func (h *handler) zakuraBotUpload(w http.ResponseWriter, r *http.Request) {
	zakuraNoStore(w)
	r.Body = http.MaxBytesReader(w, r.Body, (16<<20)+(64<<10))
	if err := r.ParseMultipartForm(16 << 20); err != nil {
		httpx.Error(w, http.StatusRequestEntityTooLarge, "File upload is too large")
		return
	}
	file, head, err := r.FormFile("file")
	if err != nil {
		httpx.Error(w, http.StatusBadRequest, "multipart file is required")
		return
	}
	defer file.Close()
	data, err := io.ReadAll(io.LimitReader(file, 16<<20+1))
	if err != nil || len(data) == 0 || len(data) > 16<<20 {
		httpx.Error(w, http.StatusRequestEntityTooLarge, "Files must be nonempty and at most 16 MiB")
		return
	}
	runner, space, _, err := h.zakuraRunner(r)
	if err != nil {
		httpx.Error(w, http.StatusServiceUnavailable, "File uploads are unavailable")
		return
	}
	id := h.store.id()
	name := safeUploadName(head.Filename)
	path := ".zakura/zakurabot/uploads/" + id + "/" + name
	if err = runner.call(r.Context(), "host.fs.write", map[string]any{"spaceId": space, "path": path, "base64": base64.StdEncoding.EncodeToString(data)}, nil); err != nil {
		httpx.Error(w, http.StatusServiceUnavailable, "Zakura Bot operation is temporarily unavailable")
		return
	}
	mimeType := head.Header.Get("Content-Type")
	if mimeType == "" {
		mimeType = mime.TypeByExtension(filepath.Ext(name))
	}
	if mimeType == "" {
		mimeType = "application/octet-stream"
	}
	p := h.zakuraActor(r)
	binding, _ := h.zakuraAccess(r, chi.URLParam(r, "id"))
	now := h.store.now()
	f := models.ZakurabotFile{ID: &id, TenantID: p.TenantID, DeviceID: p.UserID, BindingID: binding, AgentID: chi.URLParam(r, "id"), Path: path, Name: name, Mime: mimeType, Size: int32(len(data)), CreatedAt: runtimeTimeString(now)}
	if err = h.deps.Gorm.WithContext(r.Context()).Create(&f).Error; err != nil {
		statusErr(w, err)
		return
	}
	httpx.JSON(w, http.StatusCreated, map[string]any{"file": map[string]any{"id": id, "name": name, "mime": mimeType, "size": len(data), "type": mediaKind(mimeType), "url": strings.TrimRight(h.deps.PublicURL, "/") + "/api/zakurabot/agents/" + chi.URLParam(r, "id") + "/files/" + id}})
}
func mediaKind(mimeType string) string {
	for _, kind := range []string{"image", "audio", "video"} {
		if strings.HasPrefix(mimeType, kind+"/") {
			return kind
		}
	}
	return "file"
}
func (h *handler) zakuraBotDownload(w http.ResponseWriter, r *http.Request) {
	zakuraNoStore(w)
	p := h.zakuraActor(r)
	agent := chi.URLParam(r, "id")
	binding, err := h.zakuraAccess(r, agent)
	if err != nil {
		statusErr(w, ErrNotFound)
		return
	}
	var file models.ZakurabotFile
	err = h.deps.Gorm.WithContext(r.Context()).Where("id = ? AND tenant_id = ? AND device_id = ? AND binding_id = ? AND agent_id = ?", chi.URLParam(r, "fileId"), p.TenantID, p.UserID, binding, agent).Take(&file).Error
	if errors.Is(err, gorm.ErrRecordNotFound) {
		statusErr(w, ErrNotFound)
		return
	}
	if err != nil {
		statusErr(w, err)
		return
	}
	path, name, mimeType, size := file.Path, file.Name, file.Mime, int(file.Size)
	runner, space, _, err := h.zakuraRunner(r)
	if err != nil {
		httpx.Error(w, http.StatusServiceUnavailable, "File downloads are unavailable")
		return
	}
	var result struct {
		Base64 string `json:"base64"`
	}
	if err = runner.call(r.Context(), "host.fs.read", map[string]any{"spaceId": space, "path": path, "max": 16 << 20}, &result); err != nil {
		statusErr(w, ErrNotFound)
		return
	}
	data, err := base64.StdEncoding.DecodeString(result.Base64)
	if err != nil {
		statusErr(w, err)
		return
	}
	w.Header().Set("Content-Type", mimeType)
	w.Header().Set("Content-Length", strconv.Itoa(len(data)))
	w.Header().Set("Content-Disposition", fmt.Sprintf("attachment; filename=%q", name))
	w.Header().Set("X-Content-Type-Options", "nosniff")
	w.Header().Set("Content-Security-Policy", "default-src 'none'; sandbox")
	w.WriteHeader(http.StatusOK)
	_, _ = w.Write(data)
	_ = size
}
func (h *handler) zakuraBotDesktop(w http.ResponseWriter, r *http.Request) {
	zakuraNoStore(w)
	_, _, enabled, err := h.zakuraRunner(r)
	if err != nil {
		httpx.Error(w, http.StatusServiceUnavailable, "Desktop is unavailable")
		return
	}
	if !enabled {
		httpx.Error(w, http.StatusConflict, "Desktop is disabled")
		return
	}
	p := h.zakuraActor(r)
	var status, kind string
	var deskRec struct {
		WorkspaceStatus string `gorm:"column:workspace_status"`
		WorkspaceKind   string `gorm:"column:workspace_kind"`
	}
	_ = h.deps.Gorm.WithContext(r.Context()).Table("agents AS a").Select("s.workspace_status AS workspace_status, s.workspace_kind AS workspace_kind").Joins("JOIN spaces s ON s.id = a.space_id").Where("a.tenant_id = ? AND a.id = ?", p.TenantID, chi.URLParam(r, "id")).Take(&deskRec).Error
	status, kind = deskRec.WorkspaceStatus, deskRec.WorkspaceKind
	supported := kind != "host"
	enabled = supported && status == "running"
	frameURL := any(nil)
	if enabled {
		frameURL = strings.TrimRight(h.deps.PublicURL, "/") + "/api/zakurabot/agents/" + chi.URLParam(r, "id") + "/desktop/frame"
	}
	httpx.JSON(w, http.StatusOK, map[string]any{"enabled": enabled, "supported": supported, "status": status, "width": 1280, "height": 720, "coordinateSpace": "desktop pixels, origin top-left", "frameUrl": frameURL, "frameAuthorization": "Bearer", "maxFrameBytes": 8 << 20, "suggestedIntervalMs": 2000})
}
func (h *handler) zakuraBotDesktopFrame(w http.ResponseWriter, r *http.Request) {
	zakuraNoStore(w)
	_, _, enabled, err := h.zakuraRunner(r)
	if err != nil {
		httpx.Error(w, http.StatusServiceUnavailable, "Desktop is unavailable")
		return
	}
	if !enabled {
		httpx.Error(w, http.StatusConflict, "Desktop is disabled")
		return
	}
	var status, kind string
	var frameRec struct {
		WorkspaceStatus string `gorm:"column:workspace_status"`
		WorkspaceKind   string `gorm:"column:workspace_kind"`
	}
	_ = h.deps.Gorm.WithContext(r.Context()).Table("agents AS a").Select("s.workspace_status AS workspace_status, s.workspace_kind AS workspace_kind").Joins("JOIN spaces s ON s.id = a.space_id").Where("a.tenant_id = ? AND a.id = ?", h.zakuraActor(r).TenantID, chi.URLParam(r, "id")).Take(&frameRec).Error
	status, kind = frameRec.WorkspaceStatus, frameRec.WorkspaceKind
	if status != "running" || kind == "host" {
		httpx.Error(w, http.StatusConflict, "This workspace does not support a desktop")
		return
	}
	result, err := h.runtimeExec(r.Context(), h.zakuraActor(r).TenantID, chi.URLParam(r, "id"), "sh", "-lc", `tmp=$(mktemp --suffix=.png); if command -v gnome-screenshot >/dev/null; then gnome-screenshot -f "$tmp"; elif command -v import >/dev/null; then import -window root "$tmp"; else exit 127; fi; base64 "$tmp" | tr -d '\n'; rm -f "$tmp"`)
	if err != nil {
		httpx.Error(w, http.StatusServiceUnavailable, "Zakura Bot operation is temporarily unavailable")
		return
	}
	data, err := base64.StdEncoding.DecodeString(strings.TrimSpace(fmt.Sprint(result["stdout"])))
	if err != nil || len(data) == 0 || len(data) > 8<<20 {
		httpx.Error(w, http.StatusServiceUnavailable, "Desktop capture failed")
		return
	}
	w.Header().Set("Content-Type", "image/png")
	w.Header().Set("Content-Length", strconv.Itoa(len(data)))
	w.Header().Set("X-Content-Type-Options", "nosniff")
	w.Header().Set("X-Frame-Width", "1280")
	w.Header().Set("X-Frame-Height", "720")
	w.Header().Set("X-Frame-Captured-At", h.store.now().Format(time.RFC3339Nano))
	w.WriteHeader(http.StatusOK)
	_, _ = w.Write(data)
}
func (h *handler) zakuraBotExec(w http.ResponseWriter, r *http.Request) {
	zakuraNoStore(w)
	r.Body = http.MaxBytesReader(w, r.Body, 64<<10)
	var body struct {
		Command string `json:"command"`
	}
	if httpx.DecodeJSON(r, &body) != nil || strings.TrimSpace(body.Command) == "" || len(body.Command) > 2000 {
		httpx.Error(w, http.StatusBadRequest, "command must be 1-2000 characters")
		return
	}
	_, _, _, err := h.zakuraRunner(r)
	if err != nil {
		httpx.Error(w, http.StatusConflict, "Workspace is not running. Start the agent first.")
		return
	}
	var execRec struct {
		WorkspaceStatus string `gorm:"column:workspace_status"`
	}
	_ = h.deps.Gorm.WithContext(r.Context()).Table("agents AS a").Select("s.workspace_status AS workspace_status").Joins("JOIN spaces s ON s.id = a.space_id").Where("a.tenant_id = ? AND a.id = ?", h.zakuraActor(r).TenantID, chi.URLParam(r, "id")).Take(&execRec).Error
	workspaceStatus := execRec.WorkspaceStatus
	if workspaceStatus != "running" {
		httpx.Error(w, http.StatusConflict, "Workspace is not running. Start the agent first.")
		return
	}
	ctx, cancel := context.WithTimeout(r.Context(), time.Minute)
	defer cancel()
	result, err := h.runtimeExec(ctx, h.zakuraActor(r).TenantID, chi.URLParam(r, "id"), "bash", "-lc", body.Command)
	if err != nil && result == nil {
		httpx.Error(w, http.StatusServiceUnavailable, "Zakura Bot operation is temporarily unavailable")
		return
	}
	output := fmt.Sprint(result["stdout"]) + fmt.Sprint(result["stderr"])
	truncated := false
	if len([]byte(output)) > 256<<10 {
		output = string([]byte(output)[:256<<10])
		truncated = true
	}
	exitCode := 0
	if code, ok := result["exitCode"].(float64); ok {
		exitCode = int(code)
	}
	httpx.JSON(w, http.StatusOK, map[string]any{"output": output, "exitCode": exitCode, "finishedAt": h.store.now(), "truncated": truncated})
}
func (h *handler) zakuraBotInteractions(w http.ResponseWriter, r *http.Request) {
	zakuraNoStore(w)
	p := h.zakuraActor(r)
	agent := chi.URLParam(r, "id")
	binding, err := h.zakuraAccess(r, agent)
	if err != nil {
		statusErr(w, ErrNotFound)
		return
	}
	if state, stateErr := h.zakuraSessionStatus(r.Context(), p, agent, binding); stateErr == nil {
		if sid, _ := state["sessionId"].(string); sid != "" {
			_ = h.syncZakuraInteractions(r.Context(), p, agent, binding, sid)
		}
	}
	var ms []models.ZakurabotInteraction
	if err := h.deps.Gorm.WithContext(r.Context()).Where("tenant_id = ? AND device_id = ? AND binding_id = ? AND agent_id = ? AND status = 'pending'", p.TenantID, p.UserID, binding, agent).Order("created_at").Find(&ms).Error; err != nil {
		statusErr(w, err)
		return
	}
	out := []map[string]any{}
	for _, m := range ms {
		id := ""
		if m.ID != nil {
			id = *m.ID
		}
		var interaction map[string]any
		_ = json.Unmarshal([]byte(m.PayloadJSON), &interaction)
		interaction["status"] = "pending"
		out = append(out, map[string]any{"messageId": id, "createdAt": parseTime(m.CreatedAt).UnixMilli(), "interaction": interaction})
	}
	httpx.JSON(w, http.StatusOK, map[string]any{"interactions": out})
}
func (h *handler) getZakuraInteraction(r *http.Request) (map[string]any, error) {
	p := h.zakuraActor(r)
	agent := chi.URLParam(r, "id")
	binding, err := h.zakuraAccess(r, agent)
	if err != nil {
		return nil, ErrNotFound
	}
	if state, stateErr := h.zakuraSessionStatus(r.Context(), p, agent, binding); stateErr == nil {
		if sid, _ := state["sessionId"].(string); sid != "" {
			_ = h.syncZakuraInteractions(r.Context(), p, agent, binding, sid)
		}
	}
	var m models.ZakurabotInteraction
	err = h.deps.Gorm.WithContext(r.Context()).Where("id = ? AND tenant_id = ? AND device_id = ? AND binding_id = ? AND agent_id = ?", chi.URLParam(r, "messageId"), p.TenantID, p.UserID, binding, agent).Take(&m).Error
	if errors.Is(err, gorm.ErrRecordNotFound) {
		return nil, ErrNotFound
	}
	if err != nil {
		return nil, err
	}
	id := ""
	if m.ID != nil {
		id = *m.ID
	}
	var interaction map[string]any
	_ = json.Unmarshal([]byte(m.PayloadJSON), &interaction)
	interaction["status"] = m.Status
	return map[string]any{"messageId": id, "createdAt": parseTime(m.CreatedAt).UnixMilli(), "status": m.Status, "sessionId": m.SessionID, "sourceSessionId": m.SourceSessionID, "requestId": m.RequestID, "type": m.Type, "interaction": interaction}, nil
}

func (h *handler) syncZakuraInteractions(ctx context.Context, p httpx.Principal, agent, binding, sessionID string) error {
	var ms []models.CloudAgentEvent
	if err := h.deps.Gorm.WithContext(ctx).Where("session_id = ? AND type IN ?", sessionID, []string{"ask_user_request", "permission_request", "elicitation_request", "ask_user_resolved", "permission_resolved", "elicitation_resolved"}).Order("seq").Find(&ms).Error; err != nil {
		return err
	}
	for _, event := range ms {
		eventID := ""
		if event.ID != nil {
			eventID = *event.ID
		}
		runID := ""
		if event.RunID != nil {
			runID = *event.RunID
		}
		eventSeq := int64(event.Seq)
		eventCreated := parseTime(event.CreatedAt)
		payload := map[string]any{}
		if json.Unmarshal([]byte(event.PayloadJSON), &payload) != nil {
			continue
		}
		requestID := strings.TrimSpace(fmt.Sprint(payload["requestId"]))
		if requestID == "" || requestID == "<nil>" {
			continue
		}
		if event.Type == "ask_user_resolved" || event.Type == "permission_resolved" || event.Type == "elicitation_resolved" {
			status := "answered"
			if cancelled, _ := payload["cancelled"].(bool); cancelled || payload["outcome"] == "cancelled" || payload["status"] == "cancelled" {
				status = "cancelled"
			}
			if err := h.deps.Gorm.WithContext(ctx).Model(&models.ZakurabotInteraction{}).Where("tenant_id = ? AND device_id = ? AND binding_id = ? AND agent_id = ? AND source_session_id = ? AND request_id = ? AND event_seq < ?", p.TenantID, p.UserID, binding, agent, sessionID, requestID, eventSeq).Updates(map[string]any{"status": status, "event_seq": eventSeq}).Error; err != nil {
				return err
			}
			continue
		}
		kind := map[string]string{"ask_user_request": "question", "permission_request": "approval", "elicitation_request": "form"}[event.Type]
		projected := map[string]any{"type": kind, "requestId": requestID, "status": "pending", "title": payload["title"], "options": payload["options"]}
		if kind == "question" {
			projected["title"], projected["allowMultiple"], projected["secret"], projected["mode"], projected["placeholder"], projected["expiresAt"] = payload["question"], payload["allowMultiple"], payload["secret"], payload["mode"], payload["placeholder"], payload["expiresAt"]
		}
		if kind == "form" {
			for _, key := range []string{"message", "mode", "url", "fields", "requestedSchema"} {
				if value, ok := payload[key]; ok {
					projected[key] = value
				}
			}
			if projected["title"] == nil {
				projected["title"] = payload["message"]
			}
		}
		projectedRaw, _ := json.Marshal(projected)
		digest := sha256.Sum256([]byte(p.TenantID + "\x00" + p.UserID + "\x00" + binding + "\x00" + agent + "\x00" + eventID))
		id := "zbi_" + hex.EncodeToString(digest[:])
		if err := h.deps.Gorm.WithContext(ctx).
			Clauses(clause.OnConflict{
				Columns:   []clause.Column{{Name: "id"}},
				DoNothing: true,
			}).
			Table("zakurabot_interactions").
			Create(map[string]any{"id": id, "tenant_id": p.TenantID, "device_id": p.UserID, "binding_id": binding, "agent_id": agent, "session_id": sessionID, "run_id": nullString(runID), "source_session_id": sessionID, "source_run_id": nullString(runID), "request_id": requestID, "type": kind, "payload_json": string(projectedRaw), "reply_to": nil, "status": "pending", "claimed_at": nil, "event_seq": eventSeq, "created_at": runtimeTimeString(eventCreated)}).Error; err != nil {
			return err
		}
	}
	return nil
}
func (h *handler) zakuraBotInteraction(w http.ResponseWriter, r *http.Request) {
	zakuraNoStore(w)
	item, err := h.getZakuraInteraction(r)
	if err != nil {
		statusErr(w, err)
		return
	}
	httpx.JSON(w, http.StatusOK, item)
}
func (h *handler) answerZakuraBotInteraction(w http.ResponseWriter, r *http.Request) {
	zakuraNoStore(w)
	r.Body = http.MaxBytesReader(w, r.Body, 64<<10)
	var answer map[string]any
	if httpx.DecodeJSON(r, &answer) != nil {
		httpx.Error(w, http.StatusBadRequest, "Invalid interaction response")
		return
	}
	snapshot, err := h.getZakuraInteraction(r)
	if err != nil {
		statusErr(w, err)
		return
	}
	if snapshot["status"] != "pending" {
		httpx.Error(w, http.StatusConflict, "Interaction is no longer pending")
		return
	}
	typ := fmt.Sprint(snapshot["type"])
	if !validZakuraInteractionAnswer(typ, answer) {
		httpx.Error(w, http.StatusBadRequest, "Invalid interaction response")
		return
	}
	status := "answered"
	if cancelled, _ := answer["cancelled"].(bool); cancelled {
		status = "cancelled"
	}
	p := h.zakuraActor(r)
	res := h.deps.Gorm.WithContext(r.Context()).Model(&models.ZakurabotInteraction{}).Where("id = ? AND tenant_id = ? AND device_id = ? AND status = 'pending'", chi.URLParam(r, "messageId"), p.TenantID, p.UserID).Updates(map[string]any{"status": "resolving", "claimed_at": runtimeTimeString(h.store.now())})
	if res.Error != nil {
		statusErr(w, res.Error)
		return
	}
	if res.RowsAffected == 0 {
		httpx.Error(w, http.StatusConflict, "Interaction is no longer pending")
		return
	}
	if err = h.resolveZakuraInteractionSource(r.Context(), p, snapshot, answer); err != nil {
		_ = h.deps.Gorm.WithContext(context.WithoutCancel(r.Context())).Model(&models.ZakurabotInteraction{}).Where("id = ? AND tenant_id = ? AND device_id = ? AND status = 'resolving'", chi.URLParam(r, "messageId"), p.TenantID, p.UserID).Updates(map[string]any{"status": "pending", "claimed_at": nil}).Error
		httpx.Error(w, http.StatusConflict, err.Error())
		return
	}
	res = h.deps.Gorm.WithContext(r.Context()).Model(&models.ZakurabotInteraction{}).Where("id = ? AND tenant_id = ? AND device_id = ? AND status = 'resolving'", chi.URLParam(r, "messageId"), p.TenantID, p.UserID).Updates(map[string]any{"status": status, "claimed_at": nil})
	if res.Error != nil {
		statusErr(w, res.Error)
		return
	}
	if res.RowsAffected == 0 {
		httpx.Error(w, http.StatusConflict, "Interaction is no longer pending")
		return
	}
	snapshot["status"] = status
	if interaction, _ := snapshot["interaction"].(map[string]any); interaction != nil {
		interaction["status"] = status
	}
	snapshot["answer"] = answer
	snapshot["ok"] = true
	httpx.JSON(w, http.StatusOK, snapshot)
}

func validZakuraInteractionAnswer(kind string, answer map[string]any) bool {
	if cancelled, _ := answer["cancelled"].(bool); cancelled {
		return true
	}
	switch kind {
	case "question":
		if text, _ := answer["text"].(string); strings.TrimSpace(text) != "" && len(text) <= 8000 {
			return true
		}
		selected, ok := answer["selected"].([]any)
		return ok && len(selected) > 0 && len(selected) <= 32
	case "approval":
		option, _ := answer["optionId"].(string)
		return option != ""
	case "form":
		_, ok := answer["content"].(map[string]any)
		return ok
	default:
		return false
	}
}

func (h *handler) resolveZakuraInteractionSource(ctx context.Context, p httpx.Principal, snapshot, answer map[string]any) error {
	agent, sourceSession := chi.URLParamFromCtx(ctx, "id"), fmt.Sprint(snapshot["sourceSessionId"])
	requestID, kind := fmt.Sprint(snapshot["requestId"]), fmt.Sprint(snapshot["type"])
	if agent == "" || sourceSession == "" || requestID == "" {
		return errors.New("Interaction source is invalid")
	}
	cancelled, _ := answer["cancelled"].(bool)
	switch kind {
	case "question":
		status := "answered"
		if cancelled {
			status = "cancelled"
		}
		encoded, _ := json.Marshal(map[string]any{"cancelled": cancelled, "selected": answer["selected"], "text": answer["text"]})
		nowStr := runtimeTimeString(h.store.now())
		result := h.deps.Gorm.WithContext(ctx).Model(&models.AgentUserQuestion{}).Where("id = ? AND tenant_id = ? AND agent_id = ? AND session_id = ? AND status = 'pending' AND (expires_at IS NULL OR expires_at > ?)", requestID, p.TenantID, agent, sourceSession, nowStr).Updates(map[string]any{"status": status, "answer_json": string(encoded), "resolved_at": nowStr})
		if result.Error != nil {
			return result.Error
		}
		if result.RowsAffected == 0 {
			return errors.New("Interaction source has ended or changed")
		}
		_, _ = h.store.AppendEvent(ctx, p.TenantID, agent, sourceSession, "ask_user_resolved", nil, map[string]any{"requestId": requestID, "status": status, "cancelled": cancelled})
		return nil
	case "approval", "form":
		session, err := h.store.GetSession(ctx, p.TenantID, agent, sourceSession)
		if err != nil || session.Kind != "acp" {
			return errors.New("Interaction source has ended or changed")
		}
		live, err := h.acp.ensure(ctx, p.TenantID, agent, sourceSession)
		if err != nil {
			return errors.New("Interaction source is unavailable")
		}
		decision := map[string]any{"requestId": requestID, "cancelled": cancelled}
		if kind == "approval" {
			decision["optionId"] = answer["optionId"]
		} else if cancelled {
			decision["action"] = "cancel"
		} else {
			decision["action"], decision["content"] = "accept", answer["content"]
		}
		if err := live.resolveDecision(decision, kind == "approval"); err != nil {
			return errors.New("Interaction source has ended or changed")
		}
		resolvedType := "permission_resolved"
		if kind == "form" {
			resolvedType = "elicitation_resolved"
		}
		_, _ = h.store.AppendEvent(ctx, p.TenantID, agent, sourceSession, resolvedType, nil, decision)
		return nil
	default:
		return errors.New("Unknown interaction type")
	}
}
func validEmoji(value string) bool {
	return strings.TrimSpace(value) != "" && utf8.RuneCountInString(value) <= 16
}
func (h *handler) zakuraBotReactions(w http.ResponseWriter, r *http.Request) {
	zakuraNoStore(w)
	p := h.zakuraActor(r)
	agent := chi.URLParam(r, "id")
	binding, err := h.zakuraAccess(r, agent)
	if err != nil {
		statusErr(w, ErrNotFound)
		return
	}
	var ms []models.MessageReaction
	if err := h.deps.Gorm.WithContext(r.Context()).Where("tenant_id = ? AND device_id = ? AND binding_id = ? AND agent_id = ? AND message_id = ?", p.TenantID, p.UserID, binding, agent, chi.URLParam(r, "messageId")).Order("created_at").Find(&ms).Error; err != nil {
		statusErr(w, err)
		return
	}
	out := []map[string]any{}
	for _, m := range ms {
		out = append(out, map[string]any{"messageId": m.MessageID, "emoji": m.Emoji, "userId": m.UserID, "createdAt": parseTime(m.CreatedAt).UnixMilli()})
	}
	httpx.JSON(w, http.StatusOK, map[string]any{"reactions": out})
}
func (h *handler) addZakuraBotReaction(w http.ResponseWriter, r *http.Request) {
	zakuraNoStore(w)
	r.Body = http.MaxBytesReader(w, r.Body, 8<<10)
	var body struct {
		Emoji string `json:"emoji"`
	}
	if httpx.DecodeJSON(r, &body) != nil || !validEmoji(body.Emoji) {
		httpx.Error(w, http.StatusBadRequest, "emoji must be 1-16 characters")
		return
	}
	p := h.zakuraActor(r)
	agent := chi.URLParam(r, "id")
	binding, err := h.zakuraAccess(r, agent)
	if err != nil {
		statusErr(w, ErrNotFound)
		return
	}
	now := h.store.now()
	id := h.store.id()
	err = h.deps.Gorm.WithContext(r.Context()).
		Clauses(clause.OnConflict{
			Columns:   []clause.Column{{Name: "tenant_id"}, {Name: "device_id"}, {Name: "binding_id"}, {Name: "agent_id"}, {Name: "message_id"}, {Name: "user_id"}},
			DoUpdates: clause.AssignmentColumns([]string{"emoji", "created_at"}),
		}).
		Table("message_reactions").
		Create(map[string]any{"id": id, "tenant_id": p.TenantID, "device_id": p.UserID, "binding_id": binding, "agent_id": agent, "message_id": chi.URLParam(r, "messageId"), "user_id": p.UserID, "emoji": body.Emoji, "created_at": runtimeTimeString(now)}).Error
	if err != nil {
		statusErr(w, err)
		return
	}
	httpx.JSON(w, http.StatusCreated, map[string]any{"reaction": map[string]any{"messageId": chi.URLParam(r, "messageId"), "emoji": body.Emoji, "userId": p.UserID, "createdAt": now.UnixMilli()}})
}
func (h *handler) deleteZakuraBotReaction(w http.ResponseWriter, r *http.Request) {
	zakuraNoStore(w)
	var body struct {
		Emoji string `json:"emoji"`
	}
	_ = json.NewDecoder(r.Body).Decode(&body)
	if body.Emoji == "" {
		body.Emoji = r.URL.Query().Get("emoji")
	}
	if !validEmoji(body.Emoji) {
		httpx.Error(w, http.StatusBadRequest, "emoji must be 1-16 characters")
		return
	}
	p := h.zakuraActor(r)
	agent := chi.URLParam(r, "id")
	binding, err := h.zakuraAccess(r, agent)
	if err != nil {
		statusErr(w, ErrNotFound)
		return
	}
	res := h.deps.Gorm.WithContext(r.Context()).Where("tenant_id = ? AND device_id = ? AND binding_id = ? AND agent_id = ? AND message_id = ? AND user_id = ? AND emoji = ?", p.TenantID, p.UserID, binding, agent, chi.URLParam(r, "messageId"), p.UserID, body.Emoji).Delete(&models.MessageReaction{})
	if res.Error != nil {
		statusErr(w, res.Error)
		return
	}
	httpx.JSON(w, http.StatusOK, map[string]any{"removed": res.RowsAffected > 0})
}
func (h *handler) zakuraSessionStatus(ctx context.Context, p httpx.Principal, agent, binding string) (map[string]any, error) {
	key := "zakurabot:" + p.TenantID + ":" + p.UserID + ":" + binding + ":" + agent
	var thread models.AgentChannelThread
	err := h.deps.Gorm.WithContext(ctx).Where("tenant_id = ? AND binding_id = ? AND external_thread_key = ?", p.TenantID, binding, key).Take(&thread).Error
	if errors.Is(err, gorm.ErrRecordNotFound) {
		return map[string]any{"agentId": agent, "sessionId": nil, "status": "stopped", "activeRunId": nil}, nil
	}
	if err != nil {
		return nil, err
	}
	sid := thread.SessionID
	session, err := h.store.GetSession(ctx, p.TenantID, agent, sid)
	if err != nil {
		return nil, err
	}
	status := "started"
	if session.ActiveRunID != nil {
		status = "running"
	}
	return map[string]any{"agentId": agent, "sessionId": sid, "status": status, "activeRunId": session.ActiveRunID}, nil
}
func (h *handler) getZakuraBotManagedSession(w http.ResponseWriter, r *http.Request) {
	zakuraNoStore(w)
	agent := chi.URLParam(r, "agentId")
	rctx := chi.RouteContext(r.Context())
	rctx.URLParams.Add("id", agent)
	binding, err := h.zakuraAccess(r, agent)
	if err != nil {
		statusErr(w, ErrNotFound)
		return
	}
	session, err := h.zakuraSessionStatus(r.Context(), h.zakuraActor(r), agent, binding)
	if err != nil {
		statusErr(w, err)
		return
	}
	httpx.JSON(w, http.StatusOK, map[string]any{"session": session})
}
func (h *handler) manageZakuraBotSession(w http.ResponseWriter, r *http.Request) {
	zakuraNoStore(w)
	r.Body = http.MaxBytesReader(w, r.Body, 1024)
	var body struct {
		Action string `json:"action"`
	}
	if httpx.DecodeJSON(r, &body) != nil || (body.Action != "start" && body.Action != "stop" && body.Action != "new") {
		httpx.Error(w, http.StatusBadRequest, "Choose start, stop or new")
		return
	}
	agent := chi.URLParam(r, "agentId")
	rctx := chi.RouteContext(r.Context())
	rctx.URLParams.Add("id", agent)
	binding, err := h.zakuraAccess(r, agent)
	if err != nil {
		statusErr(w, ErrNotFound)
		return
	}
	p := h.zakuraActor(r)
	if body.Action == "new" {
		key := "zakurabot:" + p.TenantID + ":" + p.UserID + ":" + binding + ":" + agent
		_ = h.deps.Gorm.WithContext(r.Context()).Where("tenant_id = ? AND binding_id = ? AND external_thread_key = ?", p.TenantID, binding, key).Delete(&models.AgentChannelThread{}).Error
		_, err = h.zakuraBotSession(r.Context(), p, agent, binding)
	} else if body.Action == "start" {
		_, err = h.zakuraBotSession(r.Context(), p, agent, binding)
	} else {
		status, _ := h.zakuraSessionStatus(r.Context(), p, agent, binding)
		if sid, ok := status["sessionId"].(string); ok && sid != "" {
			_, _ = h.service.Cancel(r.Context(), p.TenantID, agent, sid)
		}
	}
	if err != nil {
		statusErr(w, err)
		return
	}
	session, err := h.zakuraSessionStatus(r.Context(), p, agent, binding)
	if err != nil {
		statusErr(w, err)
		return
	}
	httpx.JSON(w, http.StatusOK, map[string]any{"session": session})
}
