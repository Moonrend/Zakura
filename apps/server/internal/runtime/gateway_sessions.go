// SPDX-License-Identifier: AGPL-3.0-or-later
package runtime

import (
	"context"
	"encoding/json"
	"errors"
	"net/http"
	"strings"
	"time"

	"github.com/Moonrend/Zakura/apps/server/internal/platform/httpx"
	"github.com/go-chi/chi/v5"
	"gorm.io/gorm"
	"gorm.io/gorm/clause"
)

const gatewayOwnerPrefix = "gateway:"

func gatewayOwner(space string) string         { return gatewayOwnerPrefix + space }
func gatewaySpace(owner string) (string, bool) { return strings.CutPrefix(owner, gatewayOwnerPrefix) }

const gatewaySessionColumns = "id,title,status,model,origin_json,last_seq,created_at,updated_at"

func (s *Store) getGatewaySession(ctx context.Context, tenant, space, id string) (Session, error) {
	var row sessionColumns
	err := s.deps.Gorm.WithContext(ctx).Table("gateway_sessions").Select(gatewaySessionColumns).Where("tenant_id=? AND space_id=? AND id=?", tenant, space, id).Take(&row).Error
	if errors.Is(err, gorm.ErrRecordNotFound) {
		return Session{}, ErrNotFound
	}
	row.AgentID = gatewayOwner(space)
	row.Kind = "chat"
	return row.session(), err
}
func (s *Store) listGatewaySessions(ctx context.Context, tenant, space string, limit, offset int) ([]Session, error) {
	if _, err := s.GetSpace(ctx, tenant, space); err != nil {
		return nil, err
	}
	if limit < 1 || limit > 200 {
		limit = 50
	}
	var rows []sessionColumns
	err := s.deps.Gorm.WithContext(ctx).Table("gateway_sessions").Select(gatewaySessionColumns).Where("tenant_id=? AND space_id=?", tenant, space).Order("updated_at DESC,id DESC").Limit(limit).Offset(offset).Find(&rows).Error
	out := make([]Session, 0, len(rows))
	for _, row := range rows {
		row.AgentID = gatewayOwner(space)
		row.Kind = "chat"
		out = append(out, row.session())
	}
	return out, err
}
func (s *Store) gatewayEvents(ctx context.Context, tenant, space, session string, after int64, limit int) ([]Event, error) {
	if _, err := s.getGatewaySession(ctx, tenant, space, session); err != nil {
		return nil, err
	}
	if limit < 1 || limit > 1000 {
		limit = 500
	}
	var rows []struct {
		ID          string  `gorm:"column:id"`
		SessionID   string  `gorm:"column:session_id"`
		Type        string  `gorm:"column:type"`
		Seq         int64   `gorm:"column:seq"`
		RunID       *string `gorm:"column:run_id"`
		PayloadJSON string  `gorm:"column:payload_json"`
		CreatedAt   string  `gorm:"column:created_at"`
	}
	err := s.deps.Gorm.WithContext(ctx).Table("gateway_events").Where("session_id=? AND seq>?", session, after).Order("seq").Limit(limit).Find(&rows).Error
	out := make([]Event, 0, len(rows))
	for _, row := range rows {
		out = append(out, Event{ID: row.ID, SessionID: row.SessionID, Seq: row.Seq, Type: row.Type, RunID: row.RunID, Payload: json.RawMessage(row.PayloadJSON), CreatedAt: parseTime(row.CreatedAt)})
	}
	return out, err
}
func (s *Store) appendGatewayEvent(tx *gorm.DB, session, run, typ string, payload any) error {
	var seq int64
	if err := tx.Raw("UPDATE gateway_sessions SET last_seq=last_seq+1,updated_at=? WHERE id=? RETURNING last_seq", runtimeTimeString(s.now()), session).Row().Scan(&seq); err != nil {
		return err
	}
	return tx.Table("gateway_events").Create(map[string]any{"id": s.id(), "session_id": session, "seq": seq, "type": typ, "run_id": run, "payload_json": string(rawJSON(payload)), "created_at": runtimeTimeString(s.now())}).Error
}

// The API keeps the existing Chat DTO/event protocol, but storage and ownership
// are Space-scoped; no hidden Agent is provisioned to hold Gateway traffic.
func (h *handler) gatewaySessionRoute(next http.HandlerFunc) http.HandlerFunc {
	return func(w http.ResponseWriter, r *http.Request) {
		space := chi.URLParam(r, "id")
		chi.RouteContext(r.Context()).URLParams.Add("id", gatewayOwner(space))
		next(w, r)
	}
}

type gatewayConversation struct {
	session, run, message, reasoning, scope string
	tenant, space                           string
	lastUser, lastRun                       string
}

func gatewayStoredMessages(tx *gorm.DB, session string) ([]gatewayMessage, error) {
	var rows []struct {
		PayloadJSON string `gorm:"column:payload_json"`
	}
	if err := tx.Table("gateway_messages").Select("payload_json").Where("session_id=?", session).Order("position").Find(&rows).Error; err != nil {
		return nil, err
	}
	out := make([]gatewayMessage, 0, len(rows))
	for _, row := range rows {
		var m gatewayMessage
		if err := json.Unmarshal([]byte(row.PayloadJSON), &m); err != nil {
			return nil, err
		}
		out = append(out, m)
	}
	return out, nil
}

func (s *Store) beginGatewayConversation(ctx context.Context, p httpx.Principal, identity gatewayIdentity, input []gatewayMessage, model string) (*gatewayConversation, error) {
	c := &gatewayConversation{tenant: p.TenantID, space: p.SpaceID, scope: p.APIKeyID, run: s.id(), message: s.id(), reasoning: s.id()}
	if c.scope == "" {
		c.scope = "user:" + p.UserID
	}
	err := s.deps.Gorm.WithContext(ctx).Transaction(func(tx *gorm.DB) error {
		// One short database lock serializes matching/admission across server replicas.
		// It never spans upstream I/O or the client response.
		if err := tx.Exec("UPDATE spaces SET id=id WHERE tenant_id=? AND id=?", p.TenantID, p.SpaceID).Error; err != nil {
			return err
		}
		base := func() *gorm.DB {
			return tx.Table("gateway_sessions").Where("tenant_id=? AND space_id=? AND scope_key=? AND harness=?", p.TenantID, p.SpaceID, c.scope, identity.Harness)
		}
		if identity.ClientKey != "" {
			var row struct {
				ID string `gorm:"column:id"`
			}
			err := base().Select("id").Where("client_key=?", identity.ClientKey).Take(&row).Error
			if err != nil && !errors.Is(err, gorm.ErrRecordNotFound) {
				return err
			}
			c.session = row.ID
		}
		compatible := func() *gorm.DB {
			query := base()
			if identity.ClientKey != "" {
				// A newly supplied ID may attach to an anonymous conversation, but
				// never override a different explicit client session.
				query = query.Where("client_key IS NULL OR client_key=?", identity.ClientKey)
			}
			return query
		}
		if c.session == "" && identity.PreviousResponse != "" {
			var ids []string
			if err := compatible().Where("id IN (SELECT session_id FROM gateway_response_links WHERE response_id=?)", identity.PreviousResponse).Pluck("id", &ids).Error; err != nil {
				return err
			}
			if len(ids) == 1 {
				c.session = ids[0]
			}
		}
		if c.session == "" {
			fingerprints := []string{}
			for _, m := range input {
				if m.Kind != "context" && m.Kind != "reasoning" {
					fingerprints = append(fingerprints, m.fingerprint())
					if m.Kind == "result" && m.ID != "" {
						fingerprints = append(fingerprints, (gatewayMessage{Kind: "tool", ID: m.ID}).fingerprint())
					}
				}
			}
			var ids []string
			query := compatible()
			// Fingerprint index finds resumed sessions even after a process restart.
			if len(fingerprints) > 256 {
				fingerprints = fingerprints[len(fingerprints)-256:]
			}
			if len(fingerprints) > 0 {
				query = query.Where("id IN (SELECT session_id FROM gateway_messages WHERE fingerprint IN ?)", fingerprints)
			}
			if err := query.Order("updated_at DESC").Limit(64).Pluck("id", &ids).Error; err != nil {
				return err
			}
			// A rewritten summary can retain text without retaining whole messages.
			// A generic retained turn may hit another chat's index, so still include
			// recent candidates and resolve them by evidence, never by recency.
			for _, m := range input {
				if m.Kind != "compaction" {
					continue
				}
				var recent []string
				if err := compatible().Order("updated_at DESC").Limit(32).Pluck("id", &recent).Error; err != nil {
					return err
				}
				seen := map[string]bool{}
				for _, id := range ids {
					seen[id] = true
				}
				for _, id := range recent {
					if !seen[id] {
						ids = append(ids, id)
					}
				}
				break
			}
			best, tie := 0, false
			for _, id := range ids {
				stored, err := gatewayStoredMessages(tx, id)
				if err != nil {
					return err
				}
				score := gatewayMatchScore(input, stored)
				if score > best {
					best = score
					c.session = id
					tie = false
				} else if score > 0 && score == best {
					tie = true
				}
			}
			if tie {
				c.session = ""
			}
		}
		if c.session == "" {
			c.session = s.id()
			title := "Gateway · " + identity.Harness
			for _, m := range input {
				if m.Kind == "user" {
					title = gwTruncate(strings.TrimSpace(m.Text), 80)
					break
				}
			}
			var clientKey any
			if identity.ClientKey != "" {
				clientKey = identity.ClientKey
			}
			origin := map[string]any{"source": "api", "channel": "openai-gateway", "harness": identity.Harness, "spaceId": p.SpaceID, "clientSessionKey": identity.ClientKey}
			now := runtimeTimeString(s.now())
			if err := tx.Table("gateway_sessions").Create(map[string]any{"id": c.session, "tenant_id": p.TenantID, "space_id": p.SpaceID, "scope_key": c.scope, "harness": identity.Harness, "client_key": clientKey, "title": title, "status": "active", "model": model, "origin_json": string(rawJSON(origin)), "last_seq": 0, "created_at": now, "updated_at": now}).Error; err != nil {
				return err
			}
		}
		if err := tx.Exec("UPDATE gateway_sessions SET id=id WHERE id=?", c.session).Error; err != nil {
			return err
		}
		if identity.ClientKey != "" {
			var row struct {
				ClientKey  *string `gorm:"column:client_key"`
				OriginJSON string  `gorm:"column:origin_json"`
			}
			if err := tx.Table("gateway_sessions").Select("client_key,origin_json").Where("id=?", c.session).Take(&row).Error; err != nil {
				return err
			}
			if row.ClientKey == nil {
				origin := map[string]any{}
				_ = json.Unmarshal([]byte(row.OriginJSON), &origin)
				origin["clientSessionKey"] = identity.ClientKey
				if err := tx.Table("gateway_sessions").Where("id=? AND client_key IS NULL", c.session).Updates(map[string]any{"client_key": identity.ClientKey, "origin_json": string(rawJSON(origin))}).Error; err != nil {
					return err
				}
			}
		}
		stored, err := gatewayStoredMessages(tx, c.session)
		if err != nil {
			return err
		}
		var previous []struct {
			PayloadJSON string `gorm:"column:payload_json"`
		}
		if err := tx.Table("gateway_events").Select("payload_json").Where("session_id=? AND type = ?", c.session, "user_message").Order("seq DESC").Limit(1).Find(&previous).Error; err != nil {
			return err
		}
		for _, ev := range previous {
			var payload map[string]any
			_ = json.Unmarshal([]byte(ev.PayloadJSON), &payload)
			c.lastUser = gwStr(payload["messageId"])
		}
		fresh := gatewayNewMessages(input, stored)
		for _, m := range fresh {
			if err := s.recordGatewayMessage(tx, c, m); err != nil {
				return err
			}
		}
		if c.lastUser == "" {
			c.lastUser = s.id()
			if err := s.appendGatewayEvent(tx, c.session, c.run, "user_message", map[string]any{"messageId": c.lastUser, "content": "客户端继续会话", "continue": true}); err != nil {
				return err
			}
		}
		if err := s.appendGatewayEvent(tx, c.session, c.run, "run_start", map[string]any{"runId": c.run, "replyToMessageId": c.lastUser, "gateway": true}); err != nil {
			return err
		}
		// Context preceding the first user turn must still belong to its visible run.
		return tx.Table("gateway_sessions").Where("id=?", c.session).Update("model", model).Error
	})
	return c, err
}

func (s *Store) storeGatewayMessage(tx *gorm.DB, c *gatewayConversation, m gatewayMessage) error {
	// The session is locked by admission/persistence; another request may have
	// appended since this capture started, so never reuse a cached position.
	var position int
	if err := tx.Table("gateway_messages").Select("COALESCE(MAX(position), -1) + 1").Where("session_id=?", c.session).Scan(&position).Error; err != nil {
		return err
	}
	return tx.Table("gateway_messages").Create(map[string]any{"id": s.id(), "session_id": c.session, "position": position, "fingerprint": m.fingerprint(), "kind": m.Kind, "payload_json": string(rawJSON(m))}).Error
}
func (s *Store) recordGatewayMessage(tx *gorm.DB, c *gatewayConversation, m gatewayMessage) error {
	if err := s.storeGatewayMessage(tx, c, m); err != nil {
		return err
	}
	emit := func(typ string, payload any) error { return s.appendGatewayEvent(tx, c.session, c.run, typ, payload) }
	switch m.Kind {
	case "user":
		c.lastUser = s.id()
		payload := map[string]any{"messageId": c.lastUser, "content": m.Text, "context": m.Context}
		if c.lastRun != "" {
			payload["parentRunId"] = c.lastRun
		}
		return emit("user_message", payload)
	case "assistant":
		// Historical turns imported with a request get their own run, preserving the
		// complete conversation rather than treating each old answer as a variant.
		oldRun := c.run
		c.run = s.id()
		if err := s.appendGatewayEvent(tx, c.session, c.run, "run_start", map[string]any{"runId": c.run, "replyToMessageId": c.lastUser}); err != nil {
			return err
		}
		if err := s.appendGatewayEvent(tx, c.session, c.run, "assistant_message", map[string]any{"messageId": s.id(), "content": m.Text}); err != nil {
			return err
		}
		if err := s.appendGatewayEvent(tx, c.session, c.run, "run_end", map[string]any{"status": "completed"}); err != nil {
			return err
		}
		c.lastRun = c.run
		c.run = oldRun
		return nil
	case "reasoning":
		return emit("reasoning_delta", map[string]any{"messageId": s.id(), "delta": m.Text})
	case "tool":
		return emit("tool_call_start", map[string]any{"toolCallId": m.ID, "name": m.Name, "arguments": m.Arguments})
	case "result":
		return emit("tool_call_result", map[string]any{"toolCallId": m.ID, "resultText": m.Text, "isError": m.Error})
	case "compaction":
		return emit("context_compacted", map[string]any{"summary": m.Text, "source": "auto", "keptMessages": 0, "droppedMessages": 0})
	case "context":
		return emit("context_sources", map[string]any{"items": []any{map[string]any{"kind": "other", "title": gwOr(m.Name, "客户端上下文"), "content": m.Text}}})
	}
	return nil
}

func (s *Store) gatewayResponseLink(tx *gorm.DB, session, id string) error {
	if id == "" {
		return nil
	}
	return tx.Table("gateway_response_links").Clauses(clause.OnConflict{DoNothing: true}).Create(map[string]any{"session_id": session, "response_id": id}).Error
}

func (h *handler) notifyGatewaySession(c *gatewayConversation) {
	broadcastTenant(c.tenant, "platform", map[string]any{"type": "cloud_session_changed", "ts": time.Now().UnixMilli(), "agentId": gatewayOwner(c.space), "sessionId": c.session, "reason": "updated"}, "")
}

func (s *Store) updateGatewaySession(ctx context.Context, tenant, space, id string, patch map[string]any) (Session, error) {
	updates := map[string]any{"updated_at": runtimeTimeString(s.now())}
	for _, key := range []string{"title", "status"} {
		if v, ok := patch[key]; ok {
			updates[key] = v
		}
	}
	result := s.deps.Gorm.WithContext(ctx).Table("gateway_sessions").Where("tenant_id=? AND space_id=? AND id=?", tenant, space, id).Updates(updates)
	if result.Error != nil {
		return Session{}, result.Error
	}
	if result.RowsAffected == 0 {
		return Session{}, ErrNotFound
	}
	return s.getGatewaySession(ctx, tenant, space, id)
}
