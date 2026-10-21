// SPDX-License-Identifier: AGPL-3.0-or-later
package runtime

import (
	"context"
	"encoding/json"
	"errors"
	"strings"

	"gorm.io/gorm"
)

type botOrigin struct {
	Platform  string `json:"platform"`
	BindingID string `json:"bindingId"`
	UserID    string `json:"userId"`
}

func botOriginTx(tx *gorm.DB, session string) (botOrigin, error) {
	var row struct {
		Origin string `gorm:"column:origin_json"`
	}
	err := tx.Table("cloud_agent_sessions").Select("origin_json").Where("id=?", session).Take(&row).Error
	var origin botOrigin
	_ = json.Unmarshal([]byte(row.Origin), &origin)
	return origin, err
}

func (s *Store) persistBotUserTx(ctx context.Context, tx *gorm.DB, tenant, agent, session, messageID, content string, attachments json.RawMessage) error {
	origin, err := botOriginTx(tx, session)
	if err != nil || origin.Platform != "zakurabot" {
		return err
	}
	var count int64
	if err := tx.Table("zakurabot_messages").Where("tenant_id=? AND device_id=? AND binding_id=? AND agent_id=? AND client_message_id=?", tenant, origin.UserID, origin.BindingID, agent, messageID).Count(&count).Error; err != nil || count > 0 {
		return err
	}
	frame := map[string]any{"type": "message", "message": map[string]any{"id": messageID, "clientMessageId": messageID, "agentId": agent, "role": "user", "kind": "text", "text": content, "attachments": botPublicAttachments(s.deps.PublicURL, agent, attachments), "createdAt": s.now().UnixMilli()}}
	return s.insertBotFrame(ctx, tx, s.id(), tenant, origin.UserID, origin.BindingID, agent, messageID, frame)
}

func (s *Store) persistBotFailureTx(ctx context.Context, tx *gorm.DB, tenant, agent, session, runID string) error {
	origin, err := botOriginTx(tx, session)
	if err != nil || origin.Platform != "zakurabot" {
		return err
	}
	var start struct {
		Payload string `gorm:"column:payload_json"`
	}
	if err := tx.Table("cloud_agent_events").Select("payload_json").Where("session_id=? AND run_id=? AND type='run_start'", session, runID).Take(&start).Error; err != nil {
		return err
	}
	var payload struct {
		ReplyTo string `json:"replyToMessageId"`
	}
	if err := json.Unmarshal([]byte(start.Payload), &payload); err != nil {
		return err
	}
	frame := map[string]any{"type": "error", "agentId": agent, "turnEnded": payload.ReplyTo != "", "message": "Could not finish this reply. Try again."}
	if payload.ReplyTo != "" {
		frame["clientMessageId"] = payload.ReplyTo
	}
	return s.insertBotFrame(ctx, tx, s.id(), tenant, origin.UserID, origin.BindingID, agent, "", frame)
}

func (s *Store) publishBotMessage(ctx context.Context, tenant, agent, session, runID, messageID, content, toolCallID, sourceMessageID string) error {
	sess, err := s.GetSession(ctx, tenant, agent, session)
	if err != nil {
		return err
	}
	var origin struct {
		Platform  string `json:"platform"`
		BindingID string `json:"bindingId"`
		UserID    string `json:"userId"`
	}
	_ = json.Unmarshal(sess.Origin, &origin)
	if origin.Platform != "zakurabot" || origin.BindingID == "" || origin.UserID == "" {
		return errors.New("this session has no bot conversation")
	}
	var allowed int64
	if err := s.deps.Gorm.WithContext(ctx).Table("agent_channel_bindings").Where("id=? AND tenant_id=? AND agent_id=? AND platform='zakurabot' AND enabled=true", origin.BindingID, tenant, agent).Count(&allowed).Error; err != nil {
		return err
	}
	if allowed != 1 {
		return errors.New("bot connection is unavailable")
	}
	bot, err := s.GetAgent(ctx, tenant, agent)
	if err != nil {
		return err
	}
	return s.deps.Gorm.WithContext(ctx).Transaction(func(tx *gorm.DB) error {
		// Use the same lock order as run admission: session, then delivery scope.
		if err := tx.Exec("UPDATE cloud_agent_sessions SET updated_at=updated_at WHERE id=?", session).Error; err != nil {
			return err
		}
		id := "zbo:" + session + ":" + messageID
		var count int64
		if err := tx.Table("zakurabot_messages").Where("id=?", id).Count(&count).Error; err != nil || count > 0 {
			return err
		}
		payload := map[string]any{"messageId": messageID, "content": content, "platform": "zakurabot", "botName": bot.Name}
		if toolCallID != "" {
			payload["toolCallId"] = toolCallID
		}
		if sourceMessageID != "" {
			payload["sourceMessageId"] = sourceMessageID
		}
		ev, err := s.appendEventTx(ctx, tx, session, "bot_message", &runID, payload)
		if err != nil {
			return err
		}
		frame := map[string]any{"type": "chat_reply", "agentId": agent, "messageId": messageID, "createdAt": ev.CreatedAt.UnixMilli(), "payload": map[string]any{"text": content, "format": "markdown"}}
		return s.insertBotFrame(ctx, tx, id, tenant, origin.UserID, origin.BindingID, agent, "", frame)
	})
}

func (s *Store) insertBotFrame(ctx context.Context, tx *gorm.DB, id, tenant, user, binding, agent, clientID string, frame any) error {
	raw, err := json.Marshal(frame)
	if err != nil {
		return err
	}
	if err := tx.Exec("UPDATE agent_channel_bindings SET updated_at=updated_at WHERE id=? AND tenant_id=?", binding, tenant).Error; err != nil {
		return err
	}
	var seq int64
	if err := tx.Table("zakurabot_messages").Select("COALESCE(MAX(seq),0)+1").Where("tenant_id=? AND device_id=? AND binding_id=? AND agent_id=?", tenant, user, binding, agent).Scan(&seq).Error; err != nil {
		return err
	}
	return tx.Table("zakurabot_messages").Create(map[string]any{"id": id, "seq": seq, "tenant_id": tenant, "device_id": user, "binding_id": binding, "agent_id": agent, "client_message_id": nullString(clientID), "frame_json": string(raw), "created_at": runtimeTimeString(s.now())}).Error
}

func (h *handler) runChatReply(ctx context.Context, tenant, agent, session, callID string, args json.RawMessage) (json.RawMessage, error) {
	var input struct {
		Text string `json:"text"`
	}
	if json.Unmarshal(args, &input) != nil || strings.TrimSpace(input.Text) == "" || len(input.Text) > 256<<10 {
		return nil, errors.New("text must contain 1–262144 bytes")
	}
	runID, _ := ctx.Value(computerRunKey{}).(string)
	if callID == "" || runID == "" {
		return nil, errors.New("chat_reply requires an active run")
	}
	if _, err := h.store.GetRun(ctx, tenant, agent, session, runID); err != nil {
		return nil, err
	}
	messageID := "bot:" + runID + ":" + callID
	if err := h.store.publishBotMessage(ctx, tenant, agent, session, runID, messageID, input.Text, callID, ""); err != nil {
		return nil, err
	}
	return builtinJSON(map[string]any{"messageId": messageID, "sent": true})
}

func (s *Service) publishBotFallback(ctx context.Context, req TurnRequest, sess Session, runID, content string) error {
	var origin struct {
		Platform string `json:"platform"`
	}
	_ = json.Unmarshal(sess.Origin, &origin)
	if origin.Platform != "zakurabot" {
		return nil
	}
	var count int64
	if err := s.store.deps.Gorm.WithContext(ctx).Table("cloud_agent_events").Where("session_id=? AND run_id=? AND type='bot_message'", req.Session, runID).Count(&count).Error; err != nil || count > 0 {
		return err
	}
	var source struct {
		Payload string `gorm:"column:payload_json"`
	}
	if err := s.store.deps.Gorm.WithContext(ctx).Table("cloud_agent_events").Select("payload_json").Where("session_id=? AND run_id=? AND type='assistant_message'", req.Session, runID).Order("seq DESC").Take(&source).Error; err != nil {
		if errors.Is(err, gorm.ErrRecordNotFound) {
			return nil
		}
		return err
	}
	var p struct {
		MessageID string `json:"messageId"`
		Content   string `json:"content"`
	}
	_ = json.Unmarshal([]byte(source.Payload), &p)
	if content == "" {
		content = p.Content
	}
	if strings.TrimSpace(content) == "" {
		return nil
	}
	return s.store.publishBotMessage(ctx, req.Tenant, req.Agent, req.Session, runID, "bot:"+runID, content, "", p.MessageID)
}
