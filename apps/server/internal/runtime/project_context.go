package runtime

import (
	"bytes"
	"context"
	"database/sql"
	"encoding/json"
	"errors"
	"net/http"
	"strconv"
	"strings"
	"time"
	"unicode/utf8"

	"github.com/Moonrend/Zakura/apps/server/internal/platform/httpx"
	"github.com/Moonrend/Zakura/packages/projectkit/contextpack"
	"github.com/Moonrend/Zakura/packages/projectkit/mission"
	"github.com/go-chi/chi/v5"
)

func (h *handler) registerProjectContexts(r chi.Router) {
	r.Get("/runs/{rid}/tasks/{tid}/context", h.projectTaskContextHTTP)
}
func contextTaskRequest(task mission.Task, query string, maxBytes int) (contextpack.Request, error) {
	if !semanticSnapshotID(task.BaseSnapshot) {
		return contextpack.Request{}, errors.New("task requires a frozen immutable base snapshot")
	}
	checks := []string{}
	for _, check := range task.Spec.Checks {
		if check.Path != "" {
			checks = append(checks, check.Path)
		}
	}
	// A large frozen prompt remains trusted scope metadata but does not get an
	// unbounded ranking budget. Truncate on a UTF-8 boundary, never expose it as a
	// system instruction or repeat it in the output envelope.
	prompt := task.Spec.Title + "\n" + task.Spec.Prompt
	if len(prompt) > 8192 {
		at := 8192
		for at > 0 && !utf8.RuneStart(prompt[at]) {
			at--
		}
		prompt = prompt[:at]
	}
	req := contextpack.Request{SnapshotID: task.BaseSnapshot, Query: query, Prompt: prompt, Writes: task.Spec.Writes, CheckPaths: checks, MaxBytes: maxBytes}
	return req, contextpack.Validate(req)
}
func (h *handler) contextPackForTask(ctx context.Context, scope mission.Scope, task mission.Task, query string, maxBytes int) (json.RawMessage, error) {
	req, err := contextTaskRequest(task, query, maxBytes)
	if err != nil {
		return nil, err
	}
	if h.projectBridge == nil {
		return nil, errors.New("project execution is unavailable")
	}
	args := map[string]any{"snapshotId": req.SnapshotID, "query": req.Query, "prompt": req.Prompt, "writes": req.Writes, "checkPaths": req.CheckPaths, "maxBytes": req.MaxBytes}
	ctx, cancel := context.WithTimeout(ctx, 12*time.Second)
	defer cancel()
	var raw json.RawMessage
	if err = h.projectBridge.rpc(ctx, scope, "project.context.pack", args, &raw); err != nil {
		return nil, err
	}
	limit := req.MaxBytes
	if limit == 0 {
		limit = 4000
	}
	if len(raw) > limit || len(raw) > contextpack.MaxOutputBytes {
		return nil, errors.New("runner context response exceeds requested budget")
	}
	var result contextpack.Pack
	if err = json.Unmarshal(raw, &result); err != nil || result.SnapshotID != task.BaseSnapshot || result.Version != contextpack.Version || !result.UntrustedReference || result.Mode != "lexical_graph" || result.Bytes != len(raw) {
		return nil, errors.New("invalid immutable context response")
	}
	for _, snippet := range result.Snippets {
		if snippet.SnapshotID != task.BaseSnapshot || !semanticSnapshotID(snippet.Hash) {
			return nil, errors.New("invalid context source reference")
		}
	}
	return raw, nil
}
func (h *handler) projectTaskContextHTTP(w http.ResponseWriter, r *http.Request) {
	p, err := h.requestProject(r)
	if err != nil {
		projectHTTPError(w, err)
		return
	}
	for key := range r.URL.Query() {
		if key != "query" && key != "maxBytes" {
			httpx.Error(w, 400, "Unsupported context parameter")
			return
		}
	}
	maxBytes := 4000
	if value := r.URL.Query().Get("maxBytes"); value != "" {
		parsed, e := strconv.Atoi(value)
		if e != nil || parsed < contextpack.MinOutputBytes || parsed > contextpack.MaxOutputBytes {
			httpx.Error(w, 400, "Context budget must be 512–16000 bytes")
			return
		}
		maxBytes = parsed
	}
	task, err := h.projects.GetTask(r.Context(), p.TenantID, p.ID, chi.URLParam(r, "rid"), chi.URLParam(r, "tid"))
	if err != nil {
		projectHTTPError(w, err)
		return
	}
	if !semanticSnapshotID(task.BaseSnapshot) {
		httpx.Error(w, 409, "Task has no frozen base snapshot yet")
		return
	}
	raw, err := h.contextPackForTask(r.Context(), projectScope(p), task, r.URL.Query().Get("query"), maxBytes)
	if err != nil {
		projectHTTPError(w, err)
		return
	}
	w.Header().Set("Content-Type", "application/json")
	w.WriteHeader(http.StatusOK)
	_, _ = w.Write(raw)
}

// projectTaskContext is the project_context read builtin. Only query and
// maxBytes are model-controlled. Re-read SQL ownership and frozen task data on
// every invocation; stale assignment objects cannot choose a different base.
func (h *handler) projectTaskContext(ctx context.Context, a mission.Assignment, op mission.Operation) (mission.ToolResult, error) {
	if op.Call.Name != "project_context" || op.Call.Effect != "read" {
		return mission.ToolResult{}, errors.New("invalid project context tool")
	}
	if op.Scope != a.Scope || op.RunID != a.Run.ID || op.TaskID != a.Task.ID || op.ID == "" || op.ArgumentsHash == "" || len(op.Call.Arguments) > 8192 {
		return mission.ToolResult{}, ErrNotFound
	}
	task, stored, err := h.contextAdmittedTask(ctx, a, op)
	if err != nil {
		return mission.ToolResult{}, err
	}
	var body struct {
		Query    string `json:"query"`
		MaxBytes int    `json:"maxBytes"`
	}
	if err := knowledgeToolJSON(stored.Call.Arguments, &body); err != nil {
		return mission.ToolResult{}, err
	}
	if strings.TrimSpace(string(stored.Call.Arguments)) == "null" {
		return mission.ToolResult{}, errors.New("context arguments require an object")
	}
	raw, err := h.contextPackForTask(ctx, a.Scope, task, body.Query, body.MaxBytes)
	if err == nil {
		// A cancellation, pause or lease expiry during the bounded CPU request
		// discards the result before it enters the next model checkpoint.
		_, _, err = h.contextAdmittedTask(ctx, a, op)
	}
	return mission.ToolResult{Content: raw}, err
}

func (h *handler) contextAdmittedTask(ctx context.Context, a mission.Assignment, op mission.Operation) (mission.Task, mission.Operation, error) {
	var task mission.Task
	var stored mission.Operation
	if err := h.projects.RequireTenantActive(ctx, nil, a.Scope.TenantID); err != nil {
		return task, stored, err
	}
	var operationRaw, taskRaw, frozenRaw, space, runStatus, taskStatus, operationStatus string
	err := h.deps.DB.QueryRowContext(ctx, h.deps.Rebind(`SELECT o.operation_json,t.task_json,r.project_json,p.space_id,r.status,t.status,o.status FROM execution_operations o JOIN execution_tasks t ON t.tenant_id=o.tenant_id AND t.project_id=o.project_id AND t.run_id=o.run_id AND t.id=o.task_id JOIN execution_runs r ON r.tenant_id=o.tenant_id AND r.project_id=o.project_id AND r.id=o.run_id JOIN execution_projects p ON p.tenant_id=o.tenant_id AND p.id=o.project_id WHERE o.tenant_id=? AND o.project_id=? AND o.run_id=? AND o.task_id=? AND o.id=?`), a.Scope.TenantID, a.Scope.ProjectID, op.RunID, op.TaskID, op.ID).Scan(&operationRaw, &taskRaw, &frozenRaw, &space, &runStatus, &taskStatus, &operationStatus)
	if errors.Is(err, sql.ErrNoRows) {
		return task, stored, ErrNotFound
	}
	if err != nil {
		return task, stored, err
	}
	var frozen mission.Project
	if err = json.Unmarshal([]byte(operationRaw), &stored); err != nil {
		return task, stored, err
	}
	if err = json.Unmarshal([]byte(taskRaw), &task); err != nil {
		return task, stored, err
	}
	if err = json.Unmarshal([]byte(frozenRaw), &frozen); err != nil {
		return task, stored, err
	}
	if space != a.Scope.SpaceID || projectScope(frozen) != a.Scope || stored.Scope != a.Scope || stored.RunID != op.RunID || stored.TaskID != op.TaskID || stored.ID != op.ID || stored.ArgumentsHash != op.ArgumentsHash || stored.Call.Name != "project_context" || stored.Call.Effect != "read" || stored.Call.ID != op.Call.ID || !bytes.Equal(bytes.TrimSpace(stored.Call.Arguments), bytes.TrimSpace(op.Call.Arguments)) {
		return task, stored, ErrConflict
	}
	if operationStatus != "running" || stored.Status != "running" || runStatus != "running" || taskStatus != "running" || task.Status != "running" || a.Task.Fence <= 0 || task.Fence != a.Task.Fence || task.LeaseOwner == "" || task.LeaseOwner != a.Task.LeaseOwner || task.LeaseUntil == nil || !task.LeaseUntil.After(h.deps.Clock()) {
		return task, stored, ErrConflict
	}
	if task.BaseSnapshot != a.Task.BaseSnapshot || !semanticSnapshotID(task.BaseSnapshot) {
		return task, stored, ErrConflict
	}
	return task, stored, nil
}
