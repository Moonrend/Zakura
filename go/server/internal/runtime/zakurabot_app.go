// SPDX-License-Identifier: AGPL-3.0-or-later
package runtime

import (
	"context"
	"crypto/sha256"
	"database/sql"
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

	"github.com/go-chi/chi/v5"
	"github.com/Moonrend/Zakura/go/server/internal/platform/httpx"
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
	rows, err := h.deps.DB.QueryContext(r.Context(), h.store.q(`SELECT seq,frame_json FROM zakurabot_messages WHERE tenant_id=? AND device_id=? AND binding_id=? AND agent_id=? AND seq<? ORDER BY seq DESC LIMIT ?`), p.TenantID, p.UserID, binding, agent, before, limit)
	if err != nil {
		statusErr(w, err)
		return
	}
	type item struct {
		seq   int64
		frame any
	}
	items := []item{}
	for rows.Next() {
		var seq int64
		var raw string
		if rows.Scan(&seq, &raw) == nil {
			var frame any
			if json.Unmarshal([]byte(raw), &frame) == nil {
				items = append(items, item{seq, frame})
			}
		}
	}
	rows.Close()
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
	var nodeID, spaceID string
	var enabled bool
	err := h.deps.DB.QueryRowContext(r.Context(), h.store.q(`SELECT COALESCE(s.runtime_node_id,''),s.id,s.enable_computer FROM agents a JOIN spaces s ON s.id=a.space_id WHERE a.tenant_id=? AND a.id=?`), p.TenantID, agent).Scan(&nodeID, &spaceID, &enabled)
	if err != nil {
		return nil, "", false, err
	}
	session, err := h.hub.get(nodeID)
	return session, spaceID, enabled, err
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
	_, err = h.deps.DB.ExecContext(r.Context(), h.store.q(`INSERT INTO zakurabot_files(id,tenant_id,device_id,binding_id,agent_id,path,name,mime,size,created_at) VALUES(?,?,?,?,?,?,?,?,?,?)`), id, p.TenantID, p.UserID, binding, chi.URLParam(r, "id"), path, name, mimeType, len(data), now)
	if err != nil {
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
	var path, name, mimeType string
	var size int
	err = h.deps.DB.QueryRowContext(r.Context(), h.store.q(`SELECT path,name,mime,size FROM zakurabot_files WHERE id=? AND tenant_id=? AND device_id=? AND binding_id=? AND agent_id=?`), chi.URLParam(r, "fileId"), p.TenantID, p.UserID, binding, agent).Scan(&path, &name, &mimeType, &size)
	if errors.Is(err, sql.ErrNoRows) {
		statusErr(w, ErrNotFound)
		return
	}
	if err != nil {
		statusErr(w, err)
		return
	}
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
	_ = h.deps.DB.QueryRowContext(r.Context(), h.store.q(`SELECT s.workspace_status,s.workspace_kind FROM agents a JOIN spaces s ON s.id=a.space_id WHERE a.tenant_id=? AND a.id=?`), p.TenantID, chi.URLParam(r, "id")).Scan(&status, &kind)
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
	_ = h.deps.DB.QueryRowContext(r.Context(), h.store.q(`SELECT s.workspace_status,s.workspace_kind FROM agents a JOIN spaces s ON s.id=a.space_id WHERE a.tenant_id=? AND a.id=?`), h.zakuraActor(r).TenantID, chi.URLParam(r, "id")).Scan(&status, &kind)
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
	var workspaceStatus string
	_ = h.deps.DB.QueryRowContext(r.Context(), h.store.q(`SELECT s.workspace_status FROM agents a JOIN spaces s ON s.id=a.space_id WHERE a.tenant_id=? AND a.id=?`), h.zakuraActor(r).TenantID, chi.URLParam(r, "id")).Scan(&workspaceStatus)
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
	rows, err := h.deps.DB.QueryContext(r.Context(), h.store.q(`SELECT id,payload_json,created_at FROM zakurabot_interactions WHERE tenant_id=? AND device_id=? AND binding_id=? AND agent_id=? AND status='pending' ORDER BY created_at`), p.TenantID, p.UserID, binding, agent)
	if err != nil {
		statusErr(w, err)
		return
	}
	out := []map[string]any{}
	for rows.Next() {
		var id, payload, created string
		if rows.Scan(&id, &payload, &created) == nil {
			var interaction map[string]any
			_ = json.Unmarshal([]byte(payload), &interaction)
			interaction["status"] = "pending"
			out = append(out, map[string]any{"messageId": id, "createdAt": parseTime(created).UnixMilli(), "interaction": interaction})
		}
	}
	rows.Close()
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
	var id, payload, status, created, session, sourceSession, requestID, typ string
	err = h.deps.DB.QueryRowContext(r.Context(), h.store.q(`SELECT id,payload_json,status,created_at,session_id,source_session_id,request_id,type FROM zakurabot_interactions WHERE id=? AND tenant_id=? AND device_id=? AND binding_id=? AND agent_id=?`), chi.URLParam(r, "messageId"), p.TenantID, p.UserID, binding, agent).Scan(&id, &payload, &status, &created, &session, &sourceSession, &requestID, &typ)
	if errors.Is(err, sql.ErrNoRows) {
		return nil, ErrNotFound
	}
	if err != nil {
		return nil, err
	}
	var interaction map[string]any
	_ = json.Unmarshal([]byte(payload), &interaction)
	interaction["status"] = status
	return map[string]any{"messageId": id, "createdAt": parseTime(created).UnixMilli(), "status": status, "sessionId": session, "sourceSessionId": sourceSession, "requestId": requestID, "type": typ, "interaction": interaction}, nil
}

func (h *handler) syncZakuraInteractions(ctx context.Context, p httpx.Principal, agent, binding, sessionID string) error {
	rows, err := h.deps.DB.QueryContext(ctx, h.store.q(`SELECT id,seq,type,run_id,payload_json,created_at FROM cloud_agent_events WHERE session_id=? AND type IN ('ask_user_request','permission_request','elicitation_request','ask_user_resolved','permission_resolved','elicitation_resolved') ORDER BY seq`), sessionID)
	if err != nil {
		return err
	}
	type sourceEvent struct {
		id, typ, payload string
		run              sql.NullString
		seq              int64
		created          time.Time
	}
	events := []sourceEvent{}
	for rows.Next() {
		var eventID, eventType, payloadRaw string
		var runID sql.NullString
		var seq int64
		var created flexibleTime
		if err := rows.Scan(&eventID, &seq, &eventType, &runID, &payloadRaw, &created); err != nil {
			rows.Close()
			return err
		}
		events = append(events, sourceEvent{id: eventID, typ: eventType, payload: payloadRaw, run: runID, seq: seq, created: created.Time})
	}
	if err := rows.Err(); err != nil {
		rows.Close()
		return err
	}
	rows.Close()
	for _, event := range events {
		payload := map[string]any{}
		if json.Unmarshal([]byte(event.payload), &payload) != nil {
			continue
		}
		requestID := strings.TrimSpace(fmt.Sprint(payload["requestId"]))
		if requestID == "" || requestID == "<nil>" {
			continue
		}
		if event.typ == "ask_user_resolved" || event.typ == "permission_resolved" || event.typ == "elicitation_resolved" {
			status := "answered"
			if cancelled, _ := payload["cancelled"].(bool); cancelled || payload["outcome"] == "cancelled" || payload["status"] == "cancelled" {
				status = "cancelled"
			}
			_, err = h.deps.DB.ExecContext(ctx, h.store.q(`UPDATE zakurabot_interactions SET status=?,event_seq=? WHERE tenant_id=? AND device_id=? AND binding_id=? AND agent_id=? AND source_session_id=? AND request_id=? AND event_seq<?`), status, event.seq, p.TenantID, p.UserID, binding, agent, sessionID, requestID, event.seq)
			if err != nil {
				return err
			}
			continue
		}
		kind := map[string]string{"ask_user_request": "question", "permission_request": "approval", "elicitation_request": "form"}[event.typ]
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
		digest := sha256.Sum256([]byte(p.TenantID + "\x00" + p.UserID + "\x00" + binding + "\x00" + agent + "\x00" + event.id))
		id := "zbi_" + hex.EncodeToString(digest[:])
		_, err = h.deps.DB.ExecContext(ctx, h.store.q(`INSERT INTO zakurabot_interactions(id,tenant_id,device_id,binding_id,agent_id,session_id,run_id,source_session_id,source_run_id,request_id,type,payload_json,reply_to,status,claimed_at,event_seq,created_at) VALUES(?,?,?,?,?,?,?,?,?,?,?,?,NULL,'pending',NULL,?,?) ON CONFLICT(id) DO NOTHING`), id, p.TenantID, p.UserID, binding, agent, sessionID, nullString(event.run.String), sessionID, nullString(event.run.String), requestID, kind, string(projectedRaw), event.seq, event.created)
		if err != nil {
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
	res, err := h.deps.DB.ExecContext(r.Context(), h.store.q(`UPDATE zakurabot_interactions SET status='resolving',claimed_at=? WHERE id=? AND tenant_id=? AND device_id=? AND status='pending'`), h.store.now(), chi.URLParam(r, "messageId"), p.TenantID, p.UserID)
	if err != nil {
		statusErr(w, err)
		return
	}
	n, _ := res.RowsAffected()
	if n == 0 {
		httpx.Error(w, http.StatusConflict, "Interaction is no longer pending")
		return
	}
	if err = h.resolveZakuraInteractionSource(r.Context(), p, snapshot, answer); err != nil {
		_, _ = h.deps.DB.ExecContext(context.WithoutCancel(r.Context()), h.store.q(`UPDATE zakurabot_interactions SET status='pending',claimed_at=NULL WHERE id=? AND tenant_id=? AND device_id=? AND status='resolving'`), chi.URLParam(r, "messageId"), p.TenantID, p.UserID)
		httpx.Error(w, http.StatusConflict, err.Error())
		return
	}
	res, err = h.deps.DB.ExecContext(r.Context(), h.store.q(`UPDATE zakurabot_interactions SET status=?,claimed_at=NULL WHERE id=? AND tenant_id=? AND device_id=? AND status='resolving'`), status, chi.URLParam(r, "messageId"), p.TenantID, p.UserID)
	if err != nil {
		statusErr(w, err)
		return
	}
	n, _ = res.RowsAffected()
	if n == 0 {
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
		result, err := h.deps.DB.ExecContext(ctx, h.store.q(`UPDATE agent_user_questions SET status=?,answer_json=?,resolved_at=? WHERE id=? AND tenant_id=? AND agent_id=? AND session_id=? AND status='pending' AND (expires_at IS NULL OR expires_at>?)`), status, string(encoded), h.store.now(), requestID, p.TenantID, agent, sourceSession, h.store.now())
		if err != nil {
			return err
		}
		if count, _ := result.RowsAffected(); count == 0 {
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
	rows, err := h.deps.DB.QueryContext(r.Context(), h.store.q(`SELECT message_id,emoji,user_id,created_at FROM message_reactions WHERE tenant_id=? AND device_id=? AND binding_id=? AND agent_id=? AND message_id=? ORDER BY created_at`), p.TenantID, p.UserID, binding, agent, chi.URLParam(r, "messageId"))
	if err != nil {
		statusErr(w, err)
		return
	}
	out := []map[string]any{}
	for rows.Next() {
		var message, emoji, user, created string
		if rows.Scan(&message, &emoji, &user, &created) == nil {
			out = append(out, map[string]any{"messageId": message, "emoji": emoji, "userId": user, "createdAt": parseTime(created).UnixMilli()})
		}
	}
	rows.Close()
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
	_, err = h.deps.DB.ExecContext(r.Context(), h.store.q(`INSERT INTO message_reactions(id,tenant_id,device_id,binding_id,agent_id,message_id,user_id,emoji,created_at) VALUES(?,?,?,?,?,?,?,?,?) ON CONFLICT(tenant_id,device_id,binding_id,agent_id,message_id,user_id) DO UPDATE SET emoji=excluded.emoji,created_at=excluded.created_at`), id, p.TenantID, p.UserID, binding, agent, chi.URLParam(r, "messageId"), p.UserID, body.Emoji, now)
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
	res, err := h.deps.DB.ExecContext(r.Context(), h.store.q(`DELETE FROM message_reactions WHERE tenant_id=? AND device_id=? AND binding_id=? AND agent_id=? AND message_id=? AND user_id=? AND emoji=?`), p.TenantID, p.UserID, binding, agent, chi.URLParam(r, "messageId"), p.UserID, body.Emoji)
	if err != nil {
		statusErr(w, err)
		return
	}
	n, _ := res.RowsAffected()
	httpx.JSON(w, http.StatusOK, map[string]any{"removed": n > 0})
}
func (h *handler) zakuraSessionStatus(ctx context.Context, p httpx.Principal, agent, binding string) (map[string]any, error) {
	key := "zakurabot:" + p.TenantID + ":" + p.UserID + ":" + binding + ":" + agent
	var sid string
	err := h.deps.DB.QueryRowContext(ctx, h.store.q(`SELECT session_id FROM agent_channel_threads WHERE tenant_id=? AND binding_id=? AND external_thread_key=?`), p.TenantID, binding, key).Scan(&sid)
	if errors.Is(err, sql.ErrNoRows) {
		return map[string]any{"agentId": agent, "sessionId": nil, "status": "stopped", "activeRunId": nil}, nil
	}
	if err != nil {
		return nil, err
	}
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
		_, _ = h.deps.DB.ExecContext(r.Context(), h.store.q(`DELETE FROM agent_channel_threads WHERE tenant_id=? AND binding_id=? AND external_thread_key=?`), p.TenantID, binding, key)
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
