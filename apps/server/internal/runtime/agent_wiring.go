// SPDX-License-Identifier: AGPL-3.0-or-later
package runtime

import (
	"context"
	"errors"
	"io"
	"os"
	"strings"
)

func (h *handler) wireAgentService() {
	h.service.memoryRecall = h.promptMemories
	h.service.memoryWriter = h.writeAgentMemory
	h.service.skillsProvider = h.promptSkills
	h.service.projectContext = h.loadAgentProjectContext
	h.service.attachmentReader = h.readAgentAttachment
	h.service.postRun = true
}

func (h *handler) promptMemories(ctx context.Context, tenant, agent, query string) []promptMemory {
	items, err := h.store.ListMemories(ctx, tenant, agent, query, "", 100)
	if err != nil {
		return nil
	}
	scored, _ := h.memoryScoredSearch(ctx, tenant, agent, query, 8)
	merged := mergeMemorySearch(8, scored, items)
	out := make([]promptMemory, 0, len(merged))
	for _, hit := range merged {
		out = append(out, promptMemory{ID: hit.Memory.ID, Layer: hit.Memory.Layer, Content: hit.Memory.Content})
	}
	return out
}

func (h *handler) writeAgentMemory(ctx context.Context, tenant, agent string, in Memory) (Memory, error) {
	record, err := h.store.CreateMemory(ctx, tenant, agent, in)
	if err != nil {
		return Memory{}, err
	}
	if cfg, err := h.agentEmbeddingConfig(ctx, tenant, agent); err == nil && cfg != nil {
		if vector, model, err := h.embedMemoryText(ctx, tenant, cfg, record.Content); err == nil {
			_ = h.setMemoryEmbedding(ctx, tenant, agent, record.ID, record.Content, vector, model)
		}
	}
	return record, nil
}

func (h *handler) promptSkills(ctx context.Context, tenant, agent string) []promptSkill {
	return h.enabledSpacePromptSkills(ctx, tenant, agent)
}

func (h *handler) readAgentAttachment(ctx context.Context, tenant, agent, name string, max int64) ([]byte, error) {
	if max < 1 {
		return nil, errors.New("attachment size limit required")
	}
	if strings.HasPrefix(name, "/workspace/") {
		name = strings.TrimPrefix(name, "/workspace")
	}
	// Uploaded attachments live on the Space server, not a selected tool target.
	ctx = context.WithValue(ctx, computerExecKey{}, (*resolvedExecution)(nil))
	remote, selected, err := h.remoteWorkspace(ctx, tenant, agent)
	if err != nil {
		return nil, err
	}
	if selected {
		data, _, err := remote.read(ctx, name, max+1)
		if err != nil {
			return nil, err
		}
		if int64(len(data)) > max {
			return nil, errors.New("attachment exceeds size limit")
		}
		return data, nil
	}
	workspace, err := h.workspaceFor(ctx, tenant, agent)
	if err != nil {
		return nil, err
	}
	resolved, err := workspace.resolve(name, true)
	if err != nil {
		return nil, err
	}
	file, err := os.Open(resolved)
	if err != nil {
		return nil, err
	}
	defer file.Close()
	info, err := file.Stat()
	if err != nil {
		return nil, err
	}
	if !info.Mode().IsRegular() || info.Size() > max {
		return nil, errors.New("attachment must be a regular file within the size limit")
	}
	data, err := io.ReadAll(io.LimitReader(file, max+1))
	if err == nil && int64(len(data)) > max {
		err = errors.New("attachment exceeds size limit")
	}
	return data, err
}
