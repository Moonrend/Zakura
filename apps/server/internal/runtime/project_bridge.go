// SPDX-License-Identifier: AGPL-3.0-or-later
package runtime

import (
	"context"
	"crypto/sha256"
	"encoding/hex"
	"encoding/json"
	"errors"
	"fmt"
	"io"
	"path"
	"sort"
	"strings"
	"unicode/utf8"

	"github.com/Moonrend/Zakura/apps/server/internal/computers"
	"github.com/Moonrend/Zakura/packages/projectkit/mission"
	"github.com/Moonrend/Zakura/packages/projectkit/workspace"
	"gorm.io/gorm"
	"gorm.io/gorm/clause"
)

type projectBridge struct{ h *handler }

func projectOperationKey(parts ...string) string {
	h := sha256.New()
	for _, p := range parts {
		h.Write([]byte(p))
		h.Write([]byte{0})
	}
	return "pe_" + hex.EncodeToString(h.Sum(nil))
}

func (b *projectBridge) rpc(ctx context.Context, scope mission.Scope, method string, args map[string]any, out any) error {
	project, err := b.h.projects.GetProject(ctx, scope.TenantID, scope.ProjectID)
	if err != nil {
		return err
	}
	if project.SpaceID != scope.SpaceID {
		return ErrNotFound
	}
	space, err := b.h.store.GetSpace(ctx, scope.TenantID, scope.SpaceID)
	if err != nil {
		return err
	}
	if space.RuntimeNodeID == nil || *space.RuntimeNodeID == "" {
		return errors.New("project execution requires an online runtime node assigned to its space")
	}
	runner, err := b.h.hub.get(*space.RuntimeNodeID)
	if err != nil {
		return err
	}
	params := make(map[string]any, len(args)+2)
	for k, v := range args {
		params[k] = v
	}
	params["spaceId"], params["projectId"] = scope.SpaceID, scope.ProjectID
	return runner.call(ctx, method, params, out)
}

func (b *projectBridge) Base(ctx context.Context, scope mission.Scope) (string, error) {
	var out struct {
		SnapshotID string `json:"snapshotId"`
	}
	err := b.rpc(ctx, scope, "project.base", map[string]any{"operationId": b.h.store.id()}, &out)
	return out.SnapshotID, err
}

func (b *projectBridge) Compose(ctx context.Context, scope mission.Scope, base string, heads []string) (string, error) {
	ordered := make([]string, 0, len(heads))
	seen := map[string]bool{}
	for _, head := range heads {
		if !seen[head] {
			seen[head] = true
			ordered = append(ordered, head)
		}
	}
	sort.Strings(ordered)
	keyParts := append([]string{"compose", scope.ProjectID, base}, ordered...)
	var out struct {
		SnapshotID string `json:"snapshotId"`
	}
	err := b.rpc(ctx, scope, "project.compose", map[string]any{"operationId": projectOperationKey(keyParts...), "baseSnapshot": base, "snapshots": ordered}, &out)
	return out.SnapshotID, err
}

func (b *projectBridge) Fork(ctx context.Context, scope mission.Scope, base, taskID string) (string, error) {
	var out struct {
		BranchID string `json:"branchId"`
	}
	err := b.rpc(ctx, scope, "project.branch.create", map[string]any{"operationId": projectOperationKey("fork", taskID, base), "snapshotId": base, "branchId": "task_" + taskID}, &out)
	return out.BranchID, err
}

func (b *projectBridge) Snapshot(ctx context.Context, scope mission.Scope, branchID string) (string, error) {
	var out struct {
		SnapshotID string `json:"snapshotId"`
	}
	// The worktree can change without changing its persisted head. A fresh
	// capture reads its current bytes; its random operation identity belongs to
	// this request alone, while the resulting immutable snapshot is deduplicated.
	err := b.rpc(ctx, scope, "project.branch.capture", map[string]any{"operationId": b.h.store.id(), "branchId": branchID}, &out)
	return out.SnapshotID, err
}

func projectWritablePath(value string, claims []string) bool {
	if value == "" || strings.ContainsAny(value, "\\\x00") || path.IsAbs(value) || path.Clean(value) != value {
		return false
	}
	for _, part := range strings.Split(value, "/") {
		if part == ".." || part == "." {
			return false
		}
	}
	for _, claim := range claims {
		claim = strings.TrimSuffix(claim, "/**")
		if claim == "" {
			claim = "."
		}
		claim = strings.TrimSuffix(claim, "/")
		if claim == "." || value == claim || strings.HasPrefix(value, claim+"/") {
			return true
		}
	}
	return false
}

func projectBranchPath(value string) (string, error) {
	if value == "/workspace" || value == "" {
		return ".", nil
	}
	value = strings.TrimPrefix(value, "/workspace/")
	if path.IsAbs(value) || strings.ContainsAny(value, "\\\x00") {
		return "", errors.New("path must be relative to the isolated task branch")
	}
	for _, part := range strings.Split(value, "/") {
		if part == ".." {
			return "", errors.New("path escapes task branch")
		}
	}
	return value, nil
}

func (b *projectBridge) ValidateWrites(ctx context.Context, scope mission.Scope, base, branchID string, claims []string) error {
	head, err := b.Snapshot(ctx, scope, branchID)
	if err != nil {
		return err
	}
	var changes []workspace.Change
	if err := b.rpc(ctx, scope, "project.branch.diff", map[string]any{"baseSnapshot": base, "snapshotId": head}, &changes); err != nil {
		return err
	}
	for _, change := range changes {
		if !projectWritablePath(change.Path, claims) || (change.OldPath != "" && !projectWritablePath(change.OldPath, claims)) {
			return fmt.Errorf("task changed unclaimed path %q", change.Path)
		}
	}
	return nil
}

func (b *projectBridge) Verify(ctx context.Context, scope mission.Scope, branchID string, checks []mission.CheckSpec) (mission.Verification, error) {
	head, err := b.Snapshot(ctx, scope, branchID)
	if err != nil {
		return mission.Verification{}, err
	}
	raw, err := json.Marshal(checks)
	if err != nil {
		return mission.Verification{}, err
	}
	var out mission.Verification
	err = b.rpc(ctx, scope, "project.verify", map[string]any{"operationId": projectOperationKey("verify", branchID, head, string(raw)), "branchId": branchID, "checks": checks}, &out)
	return out, err
}

func projectBlockedTool(name string) bool {
	switch name {
	case "codemode", "delegate_agent", "memory_remember", "import_session", "ask_user", "apply_patch",
		"computer_screenshot", "computer_click", "computer_type", "computer_key", "desktop_info", "browser_open", "browser_click", "browser_type":
		return true
	}
	return false
}

func projectCatalog(catalog agentCatalog) agentCatalog {
	filtered := catalog
	filtered.Tools = nil
	for _, tool := range catalog.Tools {
		if !projectBlockedTool(tool.Name) && tool.Name != "fs_list" && tool.Name != "fs_read" && tool.Name != "fs_write" && tool.Name != "shell_exec" {
			filtered.Tools = append(filtered.Tools, tool)
		}
	}
	filtered.Tools = append(filtered.Tools,
		directBuiltin("fs_list", "List files and directories in this task's isolated branch.", map[string]any{"path": map[string]any{"type": "string"}}),
		directBuiltin("fs_read", "Read a file in this task's isolated branch. Returns its full SHA-256 revision.", map[string]any{"path": map[string]any{"type": "string"}, "offset": map[string]any{"type": "integer"}, "limit": map[string]any{"type": "integer"}}, "path"),
		directBuiltin("fs_write", "Write a text file in this task's declared writable paths, never the original workspace.", map[string]any{"path": map[string]any{"type": "string"}, "content": map[string]any{"type": "string"}, "expectedRevision": map[string]any{"type": "string"}}, "path", "content"),
		directBuiltin("branch_patch", "Replace exact text using the full file SHA-256 revision from fs_read. Rejects stale or ambiguous matches.", map[string]any{"path": map[string]any{"type": "string"}, "expectedRevision": map[string]any{"type": "string"}, "oldText": map[string]any{"type": "string"}, "newText": map[string]any{"type": "string"}, "all": map[string]any{"type": "boolean"}}, "path", "expectedRevision", "oldText", "newText"),
		directBuiltin("branch_remove", "Remove a file or directory inside task writable claims.", map[string]any{"path": map[string]any{"type": "string"}, "recursive": map[string]any{"type": "boolean"}}, "path"),
		directBuiltin("branch_rename", "Rename a file inside task writable claims. Both source and destination must be claimed.", map[string]any{"oldPath": map[string]any{"type": "string"}, "newPath": map[string]any{"type": "string"}}, "oldPath", "newPath"),
		directBuiltin("shell_exec", "Run a command in a restricted Docker container with only this task branch writable and networking disabled. Requires an operator-configured image.", map[string]any{"command": map[string]any{"type": "string"}, "timeout_ms": map[string]any{"type": "integer"}}, "command"),
	)
	return filtered
}

func projectToolEffect(tool agentTool) string {
	if tool.Kind != "builtin" {
		return "external_write"
	}
	switch tool.Name {
	case "fs_write", "shell_exec", "branch_patch", "branch_remove", "branch_rename":
		return "workspace_write"
	case "fs_list", "fs_read", "tool_search", "memory_search", "list_sessions", "search_sessions", "get_messages",
		"list_routines", "list_automation_runs", "list_computers", "web_search", "web_fetch", "list_mcp_resources", "list_mcp_resource_templates", "read_mcp_resource":
		return "read"
	default:
		return "external_write"
	}
}

func (b *projectBridge) ensureSession(ctx context.Context, a mission.Assignment) error {
	agent, err := b.h.store.GetAgent(ctx, a.Scope.TenantID, a.Task.Spec.AgentID)
	if err != nil {
		return err
	}
	if agent.SpaceID != a.Scope.SpaceID {
		return ErrNotFound
	}
	if a.Task.SessionID == "" {
		return errors.New("task session identity is missing")
	}
	origin, _ := json.Marshal(map[string]any{"kind": "project_execution", "projectId": a.Scope.ProjectID, "runId": a.Run.ID, "taskId": a.Task.ID})
	now := runtimeTimeString(b.h.store.now())
	var creator any
	if a.Project.CreatedBy != "" {
		var exists int64
		if err := b.h.deps.Gorm.WithContext(ctx).Table("users").Where("id=?", a.Project.CreatedBy).Count(&exists).Error; err != nil {
			return err
		}
		if exists > 0 {
			creator = a.Project.CreatedBy
		}
	}
	err = b.h.deps.Gorm.WithContext(ctx).Transaction(func(tx *gorm.DB) error {
		result := tx.Table("cloud_agent_sessions").Clauses(clause.OnConflict{DoNothing: true}).Create(map[string]any{
			"id": a.Task.SessionID, "tenant_id": a.Scope.TenantID, "agent_id": agent.ID, "title": a.Task.Spec.Title, "status": "active", "kind": "project", "project": nil,
			"origin_json": string(origin), "model": nullString(a.Task.Spec.Model), "model_route_id": nil, "reasoning": nil, "draft_text": "", "created_by_user_id": creator,
			"last_seq": 0, "active_run_id": nil, "created_at": now, "updated_at": now,
		})
		if result.Error != nil {
			return result.Error
		}
		if result.RowsAffected > 0 {
			return tx.Exec(computers.InitializeSessionDefaultSQL, a.Task.SessionID, a.Scope.TenantID).Error
		}
		return nil
	})
	if err != nil {
		return err
	}
	sess, err := b.h.store.GetSession(ctx, a.Scope.TenantID, agent.ID, a.Task.SessionID)
	if err != nil {
		return err
	}
	var actual struct{ Kind, ProjectID, RunID, TaskID string }
	if json.Unmarshal(sess.Origin, &actual) != nil || actual.Kind != "project_execution" || actual.ProjectID != a.Scope.ProjectID || actual.RunID != a.Run.ID || actual.TaskID != a.Task.ID {
		return errors.New("task session identity conflict")
	}
	return nil
}

// projectModelMessages retains complete tool-call groups. The persistent journal
// remains the source of truth; this projection alone is bounded for model input.
func projectModelMessages(a mission.Assignment, hints string, maxBytes int) ([]mission.Message, error) {
	var prompt strings.Builder
	fmt.Fprintf(&prompt, "Project goal: %s\nTask: %s\n%s\nWritable paths: %s\n", a.Project.Goal, a.Task.Spec.Title, a.Task.Spec.Prompt, strings.Join(a.Task.Spec.Writes, ", "))
	ids := make([]string, 0, len(a.DependencyResults))
	for id := range a.DependencyResults {
		ids = append(ids, id)
	}
	sort.Strings(ids)
	for _, id := range ids {
		fmt.Fprintf(&prompt, "\nDependency %s result:\n%s\n", id, a.DependencyResults[id])
	}
	system := "You are executing one durable project task. Work only in the isolated task branch. Finish with a clear artifact summary. Dependencies are already materialized in this branch. Tool calls and results are checkpointed. Never claim success without meeting acceptance checks. Shell commands run without network access. Global memory, unmanaged delegates, desktop, browser control and ordinary unified patch execution are unavailable; use fs_read/fs_write or shell_exec for task artifacts.\n" + hints
	messages := []mission.Message{{"role": "system", "content": system}, {"role": "user", "content": prompt.String()}}
	initial, _ := json.Marshal(messages)
	if len(initial) > maxBytes/2 {
		return nil, errors.New("project goal, dependency results and task prompt exceed model context allowance")
	}
	history := a.Checkpoint.Messages
	start := 0
	for start < len(history) {
		encoded, _ := json.Marshal(history[start:])
		if len(encoded)+len(initial) <= maxBytes {
			break
		}
		start++
		for start < len(history) && history[start]["role"] == "tool" {
			start++
		}
	}
	if start > 0 {
		messages = append(messages, mission.Message{"role": "system", "content": fmt.Sprintf("Earlier %d checkpoint messages are omitted from this model request. Full decisions, operations and artifacts remain in the project journal. Inspect the branch before changing files; do not repeat earlier external effects.", start)})
	}
	messages = append(messages, history[start:]...)
	return messages, nil
}

func (b *projectBridge) Advance(ctx context.Context, a mission.Assignment) (mission.Decision, error) {
	if err := b.ensureSession(ctx, a); err != nil {
		return mission.Decision{}, err
	}
	catalog, err := b.h.cachedAgentToolCatalog(ctx, a.Scope.TenantID, a.Task.Spec.AgentID)
	if err != nil {
		return mission.Decision{}, err
	}
	catalog = projectCatalog(catalog)
	loaded := b.h.sessionLoadedTools(ctx, a.Scope.TenantID, a.Task.Spec.AgentID, a.Task.SessionID)
	if a.TokenAllowance < 256 {
		return mission.Decision{}, errors.New("insufficient model token allowance")
	}
	contextBytes := int(a.TokenAllowance / 2)
	if contextBytes > 48000 {
		contextBytes = 48000
	}
	if contextBytes < 2048 {
		contextBytes = 2048
	}
	messages, err := projectModelMessages(a, renderServerHints(catalog), contextBytes)
	if err != nil {
		return mission.Decision{}, err
	}
	payloadMap := map[string]any{"model": a.Task.Spec.Model, "stream": false, "messages": messages}
	tools := declaredTools(catalog, loaded, nil)
	if len(tools) > 0 {
		payloadMap["tools"] = tools
	}
	before, _ := json.Marshal(payloadMap)
	// One byte per token is conservative for mixed-language text and JSON schemas.
	inputReserve := int64(len(before))
	remaining := a.TokenAllowance - inputReserve
	if remaining < 128 {
		return mission.Decision{}, errors.New("model input exceeds reserved token budget; shorten task prompts or reduce tool schemas")
	}
	if remaining > 4096 {
		remaining = 4096
	}
	payloadMap["max_tokens"] = remaining
	payload, err := json.Marshal(payloadMap)
	if err != nil {
		return mission.Decision{}, err
	}
	resp, err := b.h.service.gateway.Do(ctx, a.Scope.TenantID, "chat", "chat", a.Task.Spec.Model, payload)
	if err != nil {
		return mission.Decision{}, err
	}
	defer resp.Body.Close()
	raw, err := io.ReadAll(io.LimitReader(resp.Body, 4<<20+1))
	if err != nil {
		return mission.Decision{}, err
	}
	if len(raw) > 4<<20 {
		return mission.Decision{}, errors.New("project model response exceeds limit")
	}
	if resp.Status < 200 || resp.Status >= 300 {
		return mission.Decision{}, fmt.Errorf("project model provider returned HTTP %d", resp.Status)
	}
	decision, err := parseProjectDecision(raw, catalog)
	if err != nil {
		return mission.Decision{}, err
	}
	if decision.Tokens == 0 {
		decision.Tokens = a.TokenAllowance
	}
	return decision, nil
}

func parseProjectDecision(raw []byte, catalog agentCatalog) (mission.Decision, error) {
	var envelope struct {
		Choices []struct {
			Message struct {
				ToolCalls []struct {
					ID       string `json:"id"`
					Function struct {
						Name      string `json:"name"`
						Arguments string `json:"arguments"`
					} `json:"function"`
				} `json:"tool_calls"`
			} `json:"message"`
			FinishReason string `json:"finish_reason"`
		} `json:"choices"`
		Content []struct {
			Type, ID, Name string
			Input          json.RawMessage
		} `json:"content"`
		StopReason string `json:"stop_reason"`
		Usage      struct {
			TotalTokens  int64 `json:"total_tokens"`
			InputTokens  int64 `json:"input_tokens"`
			OutputTokens int64 `json:"output_tokens"`
		} `json:"usage"`
	}
	if err := json.Unmarshal(raw, &envelope); err != nil {
		return mission.Decision{}, errors.New("invalid project model response JSON")
	}
	expected := 0
	for _, choice := range envelope.Choices {
		if choice.FinishReason == "length" || choice.FinishReason == "content_filter" {
			return mission.Decision{}, errors.New("model response did not finish successfully")
		}
		for _, call := range choice.Message.ToolCalls {
			var args map[string]any
			if call.ID == "" || call.Function.Name == "" || json.Unmarshal([]byte(call.Function.Arguments), &args) != nil || args == nil {
				return mission.Decision{}, errors.New("invalid model tool call")
			}
			expected++
		}
	}
	for _, block := range envelope.Content {
		if block.Type == "tool_use" {
			var args map[string]any
			if block.ID == "" || block.Name == "" || json.Unmarshal(block.Input, &args) != nil || args == nil {
				return mission.Decision{}, errors.New("invalid model tool use")
			}
			expected++
		}
	}
	if len(envelope.Choices) == 0 && len(envelope.Content) == 0 {
		return mission.Decision{}, errors.New("model response contains no assistant message")
	}
	if envelope.StopReason == "max_tokens" {
		return mission.Decision{}, errors.New("model response exhausted its output limit")
	}
	assistant, calls := canonicalAssistant(raw)
	if len(calls) != expected {
		return mission.Decision{}, errors.New("model tool response shape mismatch")
	}
	byName := map[string]agentTool{}
	for _, tool := range catalog.Tools {
		byName[tool.Name] = tool
	}
	d := mission.Decision{Message: mission.Message(assistant), Done: len(calls) == 0, Result: extractAssistantText(raw), Tokens: envelope.Usage.TotalTokens}
	if d.Tokens == 0 {
		d.Tokens = envelope.Usage.InputTokens + envelope.Usage.OutputTokens
	}
	if d.Tokens < 0 {
		return mission.Decision{}, errors.New("invalid model usage")
	}
	seen := map[string]bool{}
	for _, call := range calls {
		tool, ok := byName[call.Name]
		if !ok || seen[call.ID] {
			return mission.Decision{}, errors.New("model requested an unavailable or duplicate tool")
		}
		seen[call.ID] = true
		args, _ := json.Marshal(call.Args)
		d.Tools = append(d.Tools, mission.ToolCall{ID: call.ID, Name: call.Name, Arguments: args, Effect: projectToolEffect(tool)})
	}
	if d.Done && strings.TrimSpace(d.Result) == "" {
		return mission.Decision{}, errors.New("model finished without a task result")
	}
	return d, nil
}

func (b *projectBridge) Perform(ctx context.Context, a mission.Assignment, op mission.Operation) (mission.ToolResult, error) {
	if err := b.ensureSession(ctx, a); err != nil {
		return mission.ToolResult{}, err
	}
	var args map[string]any
	if json.Unmarshal(op.Call.Arguments, &args) != nil || args == nil {
		return mission.ToolResult{}, errors.New("invalid persisted tool arguments")
	}
	name := op.Call.Name
	if projectBlockedTool(name) {
		return mission.ToolResult{Error: "tool unavailable in project tasks; use isolated branch tools or the project review queue"}, nil
	}
	params := map[string]any{"branchId": a.Task.BranchID}
	method := ""
	if name == "fs_list" || name == "fs_read" || name == "fs_write" || name == "branch_patch" || name == "branch_remove" {
		file, err := projectBranchPath(builtinStringArg(args, "path"))
		if err != nil {
			return mission.ToolResult{Error: err.Error()}, nil
		}
		args["path"] = file
	}
	switch name {
	case "fs_list":
		method = "project.branch.list"
		params["path"] = strings.TrimPrefix(builtinStringArg(args, "path"), "/")
	case "fs_read":
		method = "project.branch.read"
		params["path"] = strings.TrimPrefix(builtinStringArg(args, "path"), "/")
		params["maxBytes"] = agentFSReadMaxBytes
	case "fs_write":
		if _, ok := args["content"].(string); !ok {
			return mission.ToolResult{Error: "content must be a text string"}, nil
		}
		file := strings.TrimPrefix(builtinStringArg(args, "path"), "/")
		if !projectWritablePath(file, a.Task.Spec.Writes) {
			return mission.ToolResult{Error: "path is outside task writable claims"}, nil
		}
		method = "project.branch.write"
		params["path"] = file
		params["content"] = builtinStringArg(args, "content")
		params["operationId"] = op.ID
		if revision := builtinStringArg(args, "expectedRevision"); revision != "" {
			params["expectedRevision"] = revision
		}
	case "branch_patch", "branch_remove":
		file := strings.TrimPrefix(builtinStringArg(args, "path"), "/")
		if !projectWritablePath(file, a.Task.Spec.Writes) {
			return mission.ToolResult{Error: "path is outside task writable claims"}, nil
		}
		params["path"] = file
		params["operationId"] = op.ID
		if name == "branch_patch" {
			if _, ok := args["oldText"].(string); !ok {
				return mission.ToolResult{Error: "oldText must be a text string"}, nil
			}
			if _, ok := args["newText"].(string); !ok {
				return mission.ToolResult{Error: "newText must be a text string"}, nil
			}
			method = "project.branch.patch"
			params["expectedRevision"] = builtinStringArg(args, "expectedRevision")
			params["oldText"] = builtinStringArg(args, "oldText")
			params["newText"] = builtinStringArg(args, "newText")
			params["all"], _ = args["all"].(bool)
		} else {
			method = "project.branch.remove"
			params["recursive"], _ = args["recursive"].(bool)
		}
	case "branch_rename":
		oldPath, err := projectBranchPath(builtinStringArg(args, "oldPath"))
		if err != nil {
			return mission.ToolResult{Error: err.Error()}, nil
		}
		newPath, err := projectBranchPath(builtinStringArg(args, "newPath"))
		if err != nil {
			return mission.ToolResult{Error: err.Error()}, nil
		}
		if !projectWritablePath(oldPath, a.Task.Spec.Writes) || !projectWritablePath(newPath, a.Task.Spec.Writes) {
			return mission.ToolResult{Error: "rename is outside task writable claims"}, nil
		}
		method = "project.branch.rename"
		params["oldPath"] = oldPath
		params["newPath"] = newPath
		params["operationId"] = op.ID
	case "shell_exec":
		if mode := builtinStringArg(args, "execution_mode"); mode != "" && mode != "sandbox" {
			return mission.ToolResult{Error: "project shell commands require isolated execution"}, nil
		}
		command := builtinStringArg(args, "command")
		if strings.TrimSpace(command) == "" {
			return mission.ToolResult{Error: "command is required"}, nil
		}
		method = "project.exec"
		params["operationId"] = op.ID
		params["command"] = []string{"bash", "-lc", command}
		params["timeoutMs"] = builtinIntArg(args, "timeout_ms", agentShellDefaultMS)
	case "tool_search":
		catalog, err := b.h.cachedAgentToolCatalog(ctx, a.Scope.TenantID, a.Task.Spec.AgentID)
		if err != nil {
			return mission.ToolResult{}, err
		}
		loaded := b.h.sessionLoadedTools(ctx, a.Scope.TenantID, a.Task.Spec.AgentID, a.Task.SessionID)
		matches := runToolSearch(projectCatalog(catalog), loaded, builtinStringArg(args, "query"), builtinIntArg(args, "limit", 8))
		names := make([]string, 0, len(matches))
		for _, tool := range matches {
			names = append(names, tool.Name)
		}
		if err := b.h.persistSessionLoadedTools(ctx, a.Scope.TenantID, a.Task.Spec.AgentID, a.Task.SessionID, names); err != nil {
			return mission.ToolResult{}, err
		}
		raw, err := json.Marshal(matches)
		return mission.ToolResult{Content: raw}, err
	}
	if method != "" {
		var result json.RawMessage
		if err := b.rpc(ctx, a.Scope, method, params, &result); err != nil {
			return mission.ToolResult{}, err
		}
		if name == "fs_read" {
			var file struct {
				Content  string `json:"content"`
				Base64   string `json:"base64"`
				Size     int64  `json:"size"`
				Revision string `json:"revision"`
			}
			if json.Unmarshal(result, &file) == nil && file.Base64 == "" {
				offset := builtinIntArg(args, "offset", 0)
				limit := builtinIntArg(args, "limit", agentFSReadDefaultBytes)
				if offset < 0 {
					offset = 0
				}
				if limit < 1 || limit > agentFSReadMaxBytes {
					limit = agentFSReadDefaultBytes
				}
				lines := strings.Split(file.Content, "\n")
				if offset > len(lines) {
					offset = len(lines)
				}
				content := strings.Join(lines[offset:], "\n")
				truncated := len(content) > limit
				if truncated {
					content = content[:limit]
					for !utf8.ValidString(content) && len(content) > 0 {
						content = content[:len(content)-1]
					}
				}
				result, _ = json.Marshal(map[string]any{"content": content, "size": file.Size, "truncated": truncated, "offset": offset, "revision": file.Revision})
			}
		}
		return mission.ToolResult{Content: result}, nil
	}
	catalog, err := b.h.cachedAgentToolCatalog(ctx, a.Scope.TenantID, a.Task.Spec.AgentID)
	if err != nil {
		return mission.ToolResult{}, err
	}
	allowed := false
	for _, tool := range projectCatalog(catalog).Tools {
		if tool.Name == name && projectToolEffect(tool) == op.Call.Effect {
			allowed = true
			break
		}
	}
	if !allowed {
		return mission.ToolResult{Error: "tool is no longer available under the persisted effect policy"}, nil
	}
	result, err := b.h.dispatchAgentTool(ctx, a.Scope.TenantID, a.Task.Spec.AgentID, a.Task.SessionID, op.ID, name, op.Call.Arguments)
	if err != nil {
		return mission.ToolResult{}, err
	}
	if !json.Valid(result) {
		result, _ = json.Marshal(string(result))
	}
	return mission.ToolResult{Content: result}, nil
}

func (b *projectBridge) Inspect(ctx context.Context, a mission.Assignment, op mission.Operation) (mission.Inspection, error) {
	if op.Call.Effect != "workspace_write" {
		return mission.Inspection{Known: false}, nil
	}
	var out struct {
		Known  bool            `json:"known"`
		Status string          `json:"status"`
		Result json.RawMessage `json:"result"`
		Error  string          `json:"error"`
	}
	if err := b.rpc(ctx, a.Scope, "project.operation.inspect", map[string]any{"operationId": op.ID}, &out); err != nil {
		return mission.Inspection{}, err
	}
	if !out.Known || out.Status == "unknown" || out.Status == "running" || out.Status == "prepared" {
		return mission.Inspection{Known: false}, nil
	}
	return mission.Inspection{Known: true, Result: mission.ToolResult{Content: out.Result, Error: out.Error}}, nil
}
