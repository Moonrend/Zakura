// SPDX-License-Identifier: AGPL-3.0-or-later
package runtime

import (
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"strings"
	"time"
)

const (
	agentFSReadDefaultBytes = 65536
	agentFSReadMaxBytes     = 262144
	agentShellDefaultMS     = 60000
	agentShellMaxMS         = 300000
	agentShellMinMS         = 1000
)

func builtinStringArg(args map[string]any, key string) string {
	value, _ := args[key].(string)
	return value
}

func builtinIntArg(args map[string]any, key string, fallback int) int {
	switch value := args[key].(type) {
	case float64:
		return int(value)
	case json.Number:
		if n, err := value.Int64(); err == nil {
			return int(n)
		}
	}
	return fallback
}

func builtinJSON(out any) (json.RawMessage, error) {
	raw, err := json.Marshal(out)
	if err != nil {
		return nil, err
	}
	return raw, nil
}

func (h *handler) runBuiltinTool(ctx context.Context, tenant, agent, name string, args json.RawMessage) (json.RawMessage, error) {
	parsed := map[string]any{}
	if len(args) > 0 {
		if err := json.Unmarshal(args, &parsed); err != nil {
			return nil, fmt.Errorf("invalid tool arguments: %w", err)
		}
	}
	if parsed == nil {
		parsed = map[string]any{}
	}
	switch name {
	case "memory_search":
		return h.runMemorySearch(ctx, tenant, agent, parsed)
	case "memory_remember":
		return h.runMemoryRemember(ctx, tenant, agent, parsed)
	case "fs_list":
		return h.runFSList(ctx, tenant, agent, parsed)
	case "fs_read":
		return h.runFSRead(ctx, tenant, agent, parsed)
	case "fs_write":
		return h.runFSWrite(ctx, tenant, agent, parsed)
	case "shell_exec":
		return h.runShellExec(ctx, tenant, agent, parsed)
	default:
		return nil, fmt.Errorf("unknown builtin tool %q", name)
	}
}

func (h *handler) runMemorySearch(ctx context.Context, tenant, agent string, args map[string]any) (json.RawMessage, error) {
	record, err := h.store.GetAgent(ctx, tenant, agent)
	if err != nil {
		return nil, err
	}
	if !record.EnableMemory {
		return nil, errors.New("memory is not enabled for this agent")
	}
	limit := builtinIntArg(args, "limit", 8)
	if limit < 1 || limit > 50 {
		limit = 8
	}
	items, err := h.store.ListMemories(ctx, tenant, agent, builtinStringArg(args, "query"), "", limit)
	if err != nil {
		return nil, err
	}
	results := make([]map[string]any, 0, len(items))
	for _, item := range items {
		entry := map[string]any{
			"id":         item.ID,
			"content":    item.Content,
			"layer":      item.Layer,
			"pinned":     item.Pinned,
			"importance": item.Importance,
			"createdAt":  item.CreatedAt,
		}
		if len(item.Tags) > 0 && string(item.Tags) != "null" {
			entry["tags"] = json.RawMessage(item.Tags)
		}
		results = append(results, entry)
	}
	return builtinJSON(map[string]any{"results": results})
}

func (h *handler) runMemoryRemember(ctx context.Context, tenant, agent string, args map[string]any) (json.RawMessage, error) {
	content := builtinStringArg(args, "content")
	if strings.TrimSpace(content) == "" {
		return nil, errors.New("content is required")
	}
	title := strings.TrimSpace(builtinStringArg(args, "title"))
	tags := []string{"note"}
	if title != "" {
		tags = []string{"note", title}
	}
	encodedTags, err := json.Marshal(tags)
	if err != nil {
		return nil, err
	}
	record, err := h.store.CreateMemory(ctx, tenant, agent, Memory{Content: content, Source: "agent", Layer: "note", Tags: json.RawMessage(encodedTags)})
	if err != nil {
		return nil, err
	}
	if cfg, cfgErr := h.agentEmbeddingConfig(ctx, tenant, agent); cfgErr == nil && cfg != nil {
		if vector, model, embedErr := h.embedMemoryText(ctx, tenant, cfg, record.Content); embedErr == nil {
			_ = h.setMemoryEmbedding(ctx, tenant, agent, record.ID, record.Content, vector, model)
		}
	}
	return builtinJSON(map[string]any{"id": record.ID, "stored": true})
}

func (h *handler) runFSList(ctx context.Context, tenant, agent string, args map[string]any) (json.RawMessage, error) {
	remote, selected, err := h.remoteWorkspace(ctx, tenant, agent)
	if err != nil {
		return nil, err
	}
	if !selected {
		return nil, errors.New("no runtime node bound to this space")
	}
	target := builtinStringArg(args, "path")
	if target == "" {
		target = "."
	}
	resolved, entries, err := remote.list(ctx, target)
	if err != nil {
		return nil, err
	}
	return builtinJSON(map[string]any{"path": resolved, "entries": entries})
}

func (h *handler) runFSRead(ctx context.Context, tenant, agent string, args map[string]any) (json.RawMessage, error) {
	target := builtinStringArg(args, "path")
	if strings.TrimSpace(target) == "" {
		return nil, errors.New("path is required")
	}
	offset := builtinIntArg(args, "offset", 0)
	if offset < 0 {
		offset = 0
	}
	limit := builtinIntArg(args, "limit", agentFSReadDefaultBytes)
	if limit < 1 {
		limit = agentFSReadDefaultBytes
	}
	if limit > agentFSReadMaxBytes {
		limit = agentFSReadMaxBytes
	}
	remote, selected, err := h.remoteWorkspace(ctx, tenant, agent)
	if err != nil {
		return nil, err
	}
	if !selected {
		return nil, errors.New("no runtime node bound to this space")
	}
	raw, meta, err := remote.read(ctx, target, agentFSReadMaxBytes)
	if err != nil {
		return nil, err
	}
	lines := strings.Split(string(raw), "\n")
	if offset > 0 {
		if offset >= len(lines) {
			lines = nil
		} else {
			lines = lines[offset:]
		}
	}
	content := strings.Join(lines, "\n")
	if len(content) > limit {
		content = content[:limit]
		if idx := strings.LastIndexByte(content, '\n'); idx >= 0 {
			content = content[:idx]
		}
	}
	resolved := target
	if value, ok := meta["path"].(string); ok && value != "" {
		resolved = value
	}
	return builtinJSON(map[string]any{"path": resolved, "content": content, "size": len(content)})
}

func (h *handler) runFSWrite(ctx context.Context, tenant, agent string, args map[string]any) (json.RawMessage, error) {
	target := builtinStringArg(args, "path")
	if strings.TrimSpace(target) == "" {
		return nil, errors.New("path is required")
	}
	remote, selected, err := h.remoteWorkspace(ctx, tenant, agent)
	if err != nil {
		return nil, err
	}
	if !selected {
		return nil, errors.New("no runtime node bound to this space")
	}
	result, err := remote.write(ctx, target, []byte(builtinStringArg(args, "content")))
	if err != nil {
		return nil, err
	}
	resolved := target
	if value, ok := result["path"].(string); ok && value != "" {
		resolved = value
	}
	return builtinJSON(map[string]any{"path": resolved, "written": true})
}

func (h *handler) runShellExec(ctx context.Context, tenant, agent string, args map[string]any) (json.RawMessage, error) {
	command := builtinStringArg(args, "command")
	if strings.TrimSpace(command) == "" {
		return nil, errors.New("command is required")
	}
	timeoutMS := builtinIntArg(args, "timeout_ms", agentShellDefaultMS)
	if timeoutMS < agentShellMinMS {
		timeoutMS = agentShellMinMS
	}
	if timeoutMS > agentShellMaxMS {
		timeoutMS = agentShellMaxMS
	}
	callCtx, cancel := context.WithTimeout(ctx, time.Duration(timeoutMS)*time.Millisecond)
	defer cancel()
	result, err := h.runtimeExec(callCtx, tenant, agent, "bash", "-lc", command)
	if result == nil {
		if err != nil {
			return nil, err
		}
		result = map[string]any{}
	} else if err != nil && result["exitCode"] == nil {
		return nil, err
	}
	return builtinJSON(map[string]any{
		"stdout":   result["stdout"],
		"stderr":   result["stderr"],
		"exitCode": result["exitCode"],
	})
}
