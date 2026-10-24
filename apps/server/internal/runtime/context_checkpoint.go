// SPDX-License-Identifier: AGPL-3.0-or-later
package runtime

import (
	"context"
	"encoding/json"
	"errors"
	"sort"

	"gorm.io/gorm"
)

// Model-visible messages are written once after each completed round. Replay
// uses this projection instead of reassembling stream chunks and tool events.
func (s *Service) recordContextMessages(ctx context.Context, req TurnRequest, run string, messages []chatMessage) error {
	if len(messages) == 0 {
		return nil
	}
	_, err := s.store.AppendEvent(ctx, req.Tenant, req.Agent, req.Session, "context.messages", &run, map[string]any{"messages": messages})
	return err
}

func decodeContextMessages(value any) []chatMessage {
	raw, err := json.Marshal(value)
	if err != nil {
		return nil
	}
	var messages []chatMessage
	if json.Unmarshal(raw, &messages) != nil {
		return nil
	}
	return messages
}

// A checkpoint depends on everything the summarizer read, including the retained
// tail. anchorRunId prevents it leaking into regenerated or edited branches.
type contextCheckpoint struct {
	Version     int           `json:"version"`
	AnchorRunID string        `json:"anchorRunId"`
	ThroughSeq  int64         `json:"throughSeq"`
	Summary     string        `json:"summary"`
	Messages    []chatMessage `json:"messages"`
}

func readContextCheckpoint(ev histEvent) (contextCheckpoint, bool) {
	var cp contextCheckpoint
	raw, _ := json.Marshal(ev.Payload)
	err := json.Unmarshal(raw, &cp)
	return cp, err == nil && cp.Version == 2 && cp.AnchorRunID != "" && cp.ThroughSeq > 0 && cp.Summary != "" && len(cp.Messages) > 0
}

func (s *Service) saveContextCheckpoint(ctx context.Context, req TurnRequest, activeRun string, cp contextCheckpoint, result compactionResult, expectedSeq int64) error {
	return s.store.deps.Gorm.WithContext(ctx).Transaction(func(tx *gorm.DB) error {
		query := tx.Table("cloud_agent_sessions").Where("id=? AND tenant_id=? AND agent_id=? AND last_seq=?", req.Session, req.Tenant, req.Agent, expectedSeq)
		if activeRun == "" {
			query = query.Where("active_run_id IS NULL")
		} else {
			query = query.Where("active_run_id=?", activeRun)
		}
		locked := query.Update("updated_at", runtimeTimeString(s.store.now()))
		if locked.Error != nil {
			return locked.Error
		}
		if locked.RowsAffected != 1 {
			return ErrConflict
		}
		var runID *string
		if activeRun != "" {
			runID = &activeRun
		}
		if _, err := s.store.appendEventTx(ctx, tx, req.Session, "context.checkpoint", runID, cp); err != nil {
			return err
		}
		_, err := s.store.appendEventTx(ctx, tx, req.Session, "context_compacted", runID, result)
		return err
	})
}

// Request templates exclude messages and image payloads. They let manual
// compaction use the same system, tools and model settings as the last run.
type contextRequestTemplate struct {
	System  string         `json:"system"`
	Payload map[string]any `json:"payload"`
}

func (s *Service) recordContextTemplate(ctx context.Context, req TurnRequest, run, system string, payload map[string]any) error {
	template := clonePayload(payload)
	delete(template, "messages")
	_, err := s.store.AppendEvent(ctx, req.Tenant, req.Agent, req.Session, "context.template", &run, contextRequestTemplate{System: system, Payload: template})
	return err
}

func clonePayload(payload map[string]any) map[string]any {
	out := make(map[string]any, len(payload))
	for k, v := range payload {
		out[k] = v
	}
	return out
}

func (s *Service) CompactSession(ctx context.Context, tenant, agent, session string, selectedRun ...string) (compactionResult, error) {
	ctx = withContextCache(ctx, tenant, session)
	mu := s.sessionLock(session)
	mu.Lock()
	defer mu.Unlock()
	sess, err := s.store.GetSession(ctx, tenant, agent, session)
	if err != nil {
		return compactionResult{}, err
	}
	if sess.ActiveRunID != nil {
		return compactionResult{}, ErrConflict
	}
	if sess.Kind == "acp" {
		return compactionResult{}, errors.New("ACP sessions manage their own context")
	}
	run := ""
	if len(selectedRun) > 0 {
		run = selectedRun[0]
	}
	if run == "" {
		latest, err := readHistoryRows(s.store.deps.Gorm.WithContext(ctx).Table("cloud_agent_events").Where("session_id=? AND type='run_start' AND seq<=?", session, sess.LastSeq).Order("seq DESC").Limit(1))
		if err != nil {
			return compactionResult{}, err
		}
		if len(latest) == 0 {
			return compactionResult{Source: "manual"}, nil
		}
		run = latest[0].RunID
	}
	var template contextRequestTemplate
	lastRun, err := s.store.GetRun(ctx, tenant, agent, session, run)
	if err != nil {
		return compactionResult{}, err
	}
	if lastRun.Status == "failed" {
		return compactionResult{}, errors.New("retry the failed run before compacting its context")
	}

	templates, err := readHistoryRows(s.store.deps.Gorm.WithContext(ctx).Table("cloud_agent_events").Where("session_id=? AND run_id=? AND type='context.template' AND seq<=?", session, run, sess.LastSeq).Order("seq DESC").Limit(1))
	if err != nil {
		return compactionResult{}, err
	}
	if len(templates) > 0 {
		encoded, _ := json.Marshal(templates[0].Payload)
		if err = json.Unmarshal(encoded, &template); err != nil {
			return compactionResult{}, err
		}
	}
	record, err := s.store.GetAgent(ctx, tenant, agent)
	if err != nil {
		return compactionResult{}, err
	}
	space, err := s.store.GetSpace(ctx, tenant, record.SpaceID)
	if err != nil {
		return compactionResult{}, err
	}
	model, err := s.turnModel(ctx, tenant, record, space, sess)
	if err != nil {
		return compactionResult{}, err
	}
	// Reuse the prior prefix, but honor an explicit model change before compacting.
	// Older sessions have no template: construct the current stable base once.
	if template.Payload == nil {
		catalog := agentCatalog{}
		if parseCloudConfig(record.Config).EnableTools && s.catalogProvider != nil {
			catalog, err = s.catalogProvider(ctx, tenant, agent)
			if err != nil {
				return compactionResult{}, err
			}
		}
		catalog.Tools = append([]agentTool(nil), catalog.Tools...)
		sort.SliceStable(catalog.Tools, func(i, j int) bool { return catalog.Tools[i].Name < catalog.Tools[j].Name })
		input := promptInput{Agent: record, Space: space, Cloud: parseCloudConfig(record.Config), Tools: reachableToolNames(catalog, nil), ServerHints: renderServerHints(catalog)}
		if sess.Project != nil {
			input.Project = *sess.Project
		}
		if s.skillsProvider != nil {
			input.Skills = append([]promptSkill(nil), s.skillsProvider(ctx, tenant, agent)...)
			sort.SliceStable(input.Skills, func(i, j int) bool { return input.Skills[i].Name < input.Skills[j].Name })
		}
		template.System = buildSystemPrompt(input)
		if s.projectContext != nil {
			project, err := s.projectContext(ctx, tenant, record.SpaceID, agent, input.Project, nil, input.Skills)
			if err != nil {
				return compactionResult{}, err
			}
			if project != nil {
				template.System += project.text
			}
		}
		template.Payload = map[string]any{"model": model}
		if tools := declaredTools(catalog, nil, nil); len(tools) > 0 {
			template.Payload["tools"] = tools
		}
		if sess.Reasoning != nil && *sess.Reasoning != "" {
			template.Payload["reasoning_effort"] = *sess.Reasoning
		}

	}
	// A synthetic child selects the completed run, without modifying the event log.
	synthetic := "compact:" + s.store.id()
	events, err := s.loadContextHistory(ctx, session, synthetic, run, sess.LastSeq)
	if err != nil {
		return compactionResult{}, err
	}
	messages := buildChainMessages(events, synthetic, int(^uint(0)>>1))
	if len(messages) > 0 && messages[len(messages)-1].UserMessageID == synthetic {
		messages = messages[:len(messages)-1]
	}
	template.Payload["model"] = model
	policy, err := s.contextPolicy(ctx, tenant, model)
	if err != nil {
		return compactionResult{}, err
	}
	images := s.contextImages(ctx, tenant, agent, messages)
	payload := clonePayload(template.Payload)
	payload["messages"] = renderMessages(template.System, messages, images, "openai")
	_, result, err := s.compactWorkingContext(ctx, TurnRequest{Tenant: tenant, Agent: agent, Session: session}, "", run, messages, payload, policy, "manual", true, sess.LastSeq)
	return result, err
}
