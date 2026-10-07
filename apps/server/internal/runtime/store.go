// SPDX-License-Identifier: AGPL-3.0-or-later
package runtime

import (
	"context"
	"database/sql"
	"encoding/json"
	"errors"
	"fmt"
	mathrand "math/rand"
	"strconv"
	"strings"
	"time"

	"github.com/Moonrend/Zakura/apps/server/internal/computers"
	"github.com/Moonrend/Zakura/apps/server/internal/platform/appdeps"
	"gorm.io/gorm"
)

var (
	ErrNotFound = errors.New("not found")
	ErrConflict = errors.New("conflict")
)

type Store struct{ deps *appdeps.Dependencies }

func NewStore(deps *appdeps.Dependencies) *Store { return &Store{deps: deps} }
func (s *Store) now() time.Time {
	if s.deps.Clock != nil {
		return s.deps.Clock().UTC()
	}
	return time.Now().UTC()
}
func (s *Store) id() string {
	if s.deps.NewID != nil {
		return s.deps.NewID()
	}
	return strconv.FormatInt(time.Now().UnixNano(), 36)
}

type flexibleTime struct{ time.Time }

func (t *flexibleTime) Scan(v any) error {
	switch x := v.(type) {
	case time.Time:
		t.Time = x.UTC()
		return nil
	case string:
		return t.parse(x)
	case []byte:
		return t.parse(string(x))
	case nil:
		t.Time = time.Time{}
		return nil
	default:
		return fmt.Errorf("unsupported time %T", v)
	}
}
func (t *flexibleTime) parse(v string) error {
	for _, layout := range []string{time.RFC3339Nano, "2006-01-02 15:04:05.999999999Z07:00", "2006-01-02 15:04:05"} {
		if parsed, err := time.Parse(layout, v); err == nil {
			t.Time = parsed.UTC()
			return nil
		}
	}
	return fmt.Errorf("invalid timestamp %q", v)
}

func validJSON(raw json.RawMessage, fallback string) string {
	if len(raw) > 0 && json.Valid(raw) {
		return string(raw)
	}
	return fallback
}

func slugify(v string) string {
	v = strings.ToLower(strings.TrimSpace(v))
	var b strings.Builder
	dash := false
	for _, r := range v {
		if (r >= 'a' && r <= 'z') || (r >= '0' && r <= '9') {
			b.WriteRune(r)
			dash = false
		} else if b.Len() > 0 && !dash {
			b.WriteByte('-')
			dash = true
		}
	}
	return strings.Trim(b.String(), "-")
}

type spaceColumns struct {
	ID              string  `gorm:"column:id"`
	TenantID        string  `gorm:"column:tenant_id"`
	Name            string  `gorm:"column:name"`
	Slug            string  `gorm:"column:slug"`
	Description     string  `gorm:"column:description"`
	EnableComputer  bool    `gorm:"column:enable_computer"`
	WorkspaceImage  *string `gorm:"column:workspace_image"`
	RuntimeNodeID   *string `gorm:"column:runtime_node_id"`
	WorkspaceKind   string  `gorm:"column:workspace_kind"`
	WorkspaceStatus string  `gorm:"column:workspace_status"`
	Config          string  `gorm:"column:config_json"`
	LastError       *string `gorm:"column:last_error"`
	CreatedAt       string  `gorm:"column:created_at"`
	UpdatedAt       string  `gorm:"column:updated_at"`
}

func (c spaceColumns) space() Space {
	return Space{ID: c.ID, TenantID: c.TenantID, Name: c.Name, Slug: c.Slug, Description: c.Description, EnableComputer: c.EnableComputer, WorkspaceImage: c.WorkspaceImage, RuntimeNodeID: c.RuntimeNodeID, WorkspaceKind: c.WorkspaceKind, WorkspaceStatus: c.WorkspaceStatus, Config: json.RawMessage(c.Config), LastError: c.LastError, CreatedAt: parseTime(c.CreatedAt), UpdatedAt: parseTime(c.UpdatedAt)}
}

func (s *Store) ListSpaces(ctx context.Context, tenant string) ([]Space, error) {
	var rows []spaceColumns
	if err := s.deps.Gorm.WithContext(ctx).Table("spaces").Select("id,tenant_id,name,slug,description,enable_computer,workspace_image,runtime_node_id,workspace_kind,workspace_status,config_json,last_error,created_at,updated_at").Where("tenant_id = ?", tenant).Order("created_at, id").Scan(&rows).Error; err != nil {
		return nil, err
	}
	out := make([]Space, 0, len(rows))
	for _, c := range rows {
		out = append(out, c.space())
	}
	return out, nil
}

func (s *Store) CreateSpace(ctx context.Context, tenant string, in Space) (Space, error) {
	now := s.now()
	in.ID = s.id()
	in.TenantID = tenant
	in.Name = strings.TrimSpace(in.Name)
	if in.Name == "" {
		return Space{}, errors.New("name required")
	}
	if in.Slug == "" {
		in.Slug = slugify(in.Name)
	}
	if in.Slug == "" {
		return Space{}, errors.New("invalid slug")
	}
	if in.WorkspaceKind == "" {
		in.WorkspaceKind = "container"
	}
	if in.WorkspaceStatus == "" {
		in.WorkspaceStatus = "ready"
	}
	if len(in.Config) == 0 {
		in.Config = json.RawMessage(`{}`)
	}
	in.CreatedAt = now
	in.UpdatedAt = now
	err := s.deps.Gorm.WithContext(ctx).Transaction(func(tx *gorm.DB) error {
		if err := tx.Table("spaces").Create(map[string]any{"id": in.ID, "tenant_id": tenant, "name": in.Name, "slug": in.Slug, "description": in.Description, "enable_computer": in.EnableComputer, "workspace_image": in.WorkspaceImage, "runtime_node_id": in.RuntimeNodeID, "workspace_kind": in.WorkspaceKind, "workspace_status": in.WorkspaceStatus, "config_json": validJSON(in.Config, "{}"), "last_error": in.LastError, "created_at": runtimeTimeString(now), "updated_at": runtimeTimeString(now)}).Error; err != nil {
			return err
		}
		return adoptLegacyComputer(tx, tenant, in.ID)
	})
	if err != nil {
		return Space{}, err
	}
	return in, nil
}

func (s *Store) GetSpace(ctx context.Context, tenant, id string) (Space, error) {
	var c spaceColumns
	err := s.deps.Gorm.WithContext(ctx).Table("spaces").Select("id,tenant_id,name,slug,description,enable_computer,workspace_image,runtime_node_id,workspace_kind,workspace_status,config_json,last_error,created_at,updated_at").Where("tenant_id = ? AND id = ?", tenant, id).Take(&c).Error
	if errors.Is(err, gorm.ErrRecordNotFound) {
		return Space{}, ErrNotFound
	}
	if err != nil {
		return Space{}, err
	}
	return c.space(), nil
}

func (s *Store) DeleteSpace(ctx context.Context, tenant, id string) error {
	res := s.deps.Gorm.WithContext(ctx).Table("spaces").Where("tenant_id = ? AND id = ?", tenant, id).Delete(nil)
	if res.Error != nil {
		return res.Error
	}
	if res.RowsAffected == 0 {
		return ErrNotFound
	}
	return nil
}
func (s *Store) UpdateSpace(ctx context.Context, tenant, id string, patch map[string]any) (Space, error) {
	allowed := map[string]string{"name": "name", "slug": "slug", "description": "description", "enableComputer": "enable_computer", "workspaceImage": "workspace_image", "runtimeNodeId": "runtime_node_id", "workspaceKind": "workspace_kind", "config": "config_json"}
	sets := []string{}
	args := []any{}
	for k, col := range allowed {
		if v, ok := patch[k]; ok {
			if k == "config" {
				b, e := json.Marshal(v)
				if e != nil {
					return Space{}, e
				}
				v = string(b)
			}
			sets = append(sets, col+"=?")
			args = append(args, v)
		}
	}
	if len(sets) == 0 {
		return s.GetSpace(ctx, tenant, id)
	}
	sets = append(sets, "updated_at=?")
	args = append(args, runtimeTimeString(s.now()), tenant, id)
	err := s.deps.Gorm.WithContext(ctx).Transaction(func(tx *gorm.DB) error {
		res := tx.Exec(`UPDATE spaces SET `+strings.Join(sets, ",")+` WHERE tenant_id=? AND id=?`, args...)
		if res.Error != nil {
			return res.Error
		}
		if res.RowsAffected == 0 {
			return ErrNotFound
		}
		return adoptLegacyComputer(tx, tenant, id)
	})
	if err != nil {
		return Space{}, err
	}
	return s.GetSpace(ctx, tenant, id)
}

type agentColumns struct {
	ID               string  `gorm:"column:id"`
	TenantID         string  `gorm:"column:tenant_id"`
	SpaceID          string  `gorm:"column:space_id"`
	Name             string  `gorm:"column:name"`
	Slug             string  `gorm:"column:slug"`
	Description      string  `gorm:"column:description"`
	EnableMemory     bool    `gorm:"column:enable_memory"`
	MemoryProviderID *string `gorm:"column:memory_provider_id"`
	Config           string  `gorm:"column:config_json"`
	LastError        *string `gorm:"column:last_error"`
	AvatarColor      *string `gorm:"column:avatar_color"`
	AvatarShape      *string `gorm:"column:avatar_shape"`
	AvatarURL        *string `gorm:"column:avatar_url"`
	CreatedAt        string  `gorm:"column:created_at"`
	UpdatedAt        string  `gorm:"column:updated_at"`
}

func (c agentColumns) agent() Agent {
	return Agent{ID: c.ID, TenantID: c.TenantID, SpaceID: c.SpaceID, Name: c.Name, Slug: c.Slug, Description: c.Description, EnableMemory: c.EnableMemory, MemoryProviderID: c.MemoryProviderID, Config: json.RawMessage(c.Config), LastError: c.LastError, AvatarColor: c.AvatarColor, AvatarShape: c.AvatarShape, AvatarURL: c.AvatarURL, CreatedAt: parseTime(c.CreatedAt), UpdatedAt: parseTime(c.UpdatedAt)}
}

const agentColumnsList = "id,tenant_id,space_id,name,slug,description,enable_memory,memory_provider_id,config_json,last_error,avatar_color,avatar_shape,avatar_url,created_at,updated_at"

func (s *Store) ListAgents(ctx context.Context, tenant string) ([]Agent, error) {
	var rows []agentColumns
	if err := s.deps.Gorm.WithContext(ctx).Table("agents").Select(agentColumnsList).Where("tenant_id = ?", tenant).Order("created_at, id").Scan(&rows).Error; err != nil {
		return nil, err
	}
	out := make([]Agent, 0, len(rows))
	for _, c := range rows {
		out = append(out, c.agent())
	}
	return out, nil
}
func (s *Store) CreateAgent(ctx context.Context, tenant string, in Agent) (Agent, error) {
	if _, err := s.GetSpace(ctx, tenant, in.SpaceID); err != nil {
		return Agent{}, err
	}
	now := s.now()
	in.ID = s.id()
	in.TenantID = tenant
	in.Name = strings.TrimSpace(in.Name)
	if in.Name == "" {
		return Agent{}, errors.New("name required")
	}
	if in.Slug == "" {
		in.Slug = slugify(in.Name)
	}
	if in.Slug == "" {
		return Agent{}, errors.New("invalid slug")
	}
	if len(in.Config) == 0 {
		in.Config = json.RawMessage(`{}`)
	}
	in.CreatedAt = now
	in.UpdatedAt = now
	err := s.deps.Gorm.WithContext(ctx).Table("agents").Create(map[string]any{"id": in.ID, "tenant_id": tenant, "space_id": in.SpaceID, "name": in.Name, "slug": in.Slug, "description": in.Description, "enable_memory": in.EnableMemory, "memory_provider_id": in.MemoryProviderID, "config_json": validJSON(in.Config, "{}"), "last_error": in.LastError, "avatar_color": in.AvatarColor, "avatar_shape": in.AvatarShape, "avatar_url": in.AvatarURL, "created_at": runtimeTimeString(now), "updated_at": runtimeTimeString(now)}).Error
	if err != nil {
		return Agent{}, err
	}
	return in, nil
}
func (s *Store) GetAgent(ctx context.Context, tenant, id string) (Agent, error) {
	var c agentColumns
	err := s.deps.Gorm.WithContext(ctx).Table("agents").Select(agentColumnsList).Where("tenant_id = ? AND id = ?", tenant, id).Take(&c).Error
	if errors.Is(err, gorm.ErrRecordNotFound) {
		return Agent{}, ErrNotFound
	}
	if err != nil {
		return Agent{}, err
	}
	return c.agent(), nil
}
func (s *Store) DeleteAgent(ctx context.Context, tenant, id string) error {
	res := s.deps.Gorm.WithContext(ctx).Table("agents").Where("tenant_id = ? AND id = ?", tenant, id).Delete(nil)
	if res.Error != nil {
		return res.Error
	}
	if res.RowsAffected == 0 {
		return ErrNotFound
	}
	return nil
}
func (s *Store) UpdateAgent(ctx context.Context, tenant, id string, patch map[string]any) (Agent, error) {
	allowed := map[string]string{"spaceId": "space_id", "name": "name", "slug": "slug", "description": "description", "enableMemory": "enable_memory", "memoryProviderId": "memory_provider_id", "config": "config_json", "avatarColor": "avatar_color", "avatarShape": "avatar_shape", "avatarUrl": "avatar_url"}
	sets := []string{}
	args := []any{}
	for k, col := range allowed {
		if v, ok := patch[k]; ok {
			if k == "config" {
				b, e := json.Marshal(v)
				if e != nil {
					return Agent{}, e
				}
				v = string(b)
			}
			sets = append(sets, col+"=?")
			args = append(args, v)
		}
	}
	if len(sets) == 0 {
		return s.GetAgent(ctx, tenant, id)
	}
	sets = append(sets, "updated_at=?")
	args = append(args, runtimeTimeString(s.now()), tenant, id)
	res := s.deps.Gorm.WithContext(ctx).Exec(`UPDATE agents SET `+strings.Join(sets, ",")+` WHERE tenant_id=? AND id=?`, args...)
	if res.Error != nil {
		return Agent{}, res.Error
	}
	if res.RowsAffected == 0 {
		return Agent{}, ErrNotFound
	}
	return s.GetAgent(ctx, tenant, id)
}

type sessionColumns struct {
	ID              string  `gorm:"column:id"`
	AgentID         string  `gorm:"column:agent_id"`
	Title           string  `gorm:"column:title"`
	Status          string  `gorm:"column:status"`
	Kind            string  `gorm:"column:kind"`
	Project         *string `gorm:"column:project"`
	Origin          string  `gorm:"column:origin_json"`
	Model           *string `gorm:"column:model"`
	ModelRouteID    *string `gorm:"column:model_route_id"`
	Reasoning       *string `gorm:"column:reasoning"`
	DraftText       string  `gorm:"column:draft_text"`
	LastSeq         int64   `gorm:"column:last_seq"`
	ActiveRunID     *string `gorm:"column:active_run_id"`
	CreatedByUserID *string `gorm:"column:created_by_user_id"`
	CreatedAt       string  `gorm:"column:created_at"`
	UpdatedAt       string  `gorm:"column:updated_at"`
}

func (c sessionColumns) session() Session {
	return Session{ID: c.ID, AgentID: c.AgentID, Title: c.Title, Status: c.Status, Kind: c.Kind, Project: c.Project, Origin: json.RawMessage(c.Origin), Model: c.Model, ModelRouteID: c.ModelRouteID, Reasoning: c.Reasoning, DraftText: c.DraftText, LastSeq: c.LastSeq, ActiveRunID: c.ActiveRunID, CreatedByUserID: c.CreatedByUserID, CreatedAt: parseTime(c.CreatedAt), UpdatedAt: parseTime(c.UpdatedAt)}
}

const sessionColumnsList = "id,agent_id,title,status,kind,project,origin_json,model,model_route_id,reasoning,draft_text,last_seq,active_run_id,created_by_user_id,created_at,updated_at"

func (s *Store) CreateSession(ctx context.Context, tenant, user, agent string, in Session) (Session, error) {
	if _, e := s.GetAgent(ctx, tenant, agent); e != nil {
		return Session{}, e
	}
	now := s.now()
	in.ID = s.id()
	in.AgentID = agent
	if in.Title == "" {
		in.Title = "New conversation"
	}
	if in.Status == "" {
		in.Status = "active"
	}
	if in.Kind == "" {
		in.Kind = "chat"
	}
	if len(in.Origin) == 0 {
		in.Origin = json.RawMessage(`{}`)
	}
	if user != "" {
		in.CreatedByUserID = &user
	}
	in.CreatedAt = now
	in.UpdatedAt = now
	e := s.deps.Gorm.WithContext(ctx).Transaction(func(tx *gorm.DB) error {
		if e := tx.Table("cloud_agent_sessions").Create(map[string]any{"id": in.ID, "tenant_id": tenant, "agent_id": agent, "title": in.Title, "status": in.Status, "kind": in.Kind, "project": in.Project, "origin_json": validJSON(in.Origin, "{}"), "model": in.Model, "model_route_id": in.ModelRouteID, "reasoning": in.Reasoning, "draft_text": in.DraftText, "created_by_user_id": in.CreatedByUserID, "last_seq": 0, "active_run_id": nil, "created_at": runtimeTimeString(now), "updated_at": runtimeTimeString(now)}).Error; e != nil {
			return e
		}
		return tx.Exec(computers.InitializeSessionDefaultSQL, in.ID, tenant).Error
	})
	if e != nil {
		return Session{}, e
	}
	if user != "" && s.deps.RecordUsage != nil {
		_ = s.deps.RecordUsage(context.WithoutCancel(ctx), appdeps.UsageRecord{TenantID: tenant, UserID: user, ActorKind: "user", Category: "session", Action: "session_created", Status: "ok", AgentID: agent, SessionID: in.ID, ResourceKind: "session", ResourceID: in.ID, Summary: in.Title})
	}
	return in, nil
}
func (s *Store) GetSession(ctx context.Context, tenant, agent, id string) (Session, error) {
	var c sessionColumns
	e := s.deps.Gorm.WithContext(ctx).Table("cloud_agent_sessions").Select(sessionColumnsList).Where("tenant_id = ? AND agent_id = ? AND id = ?", tenant, agent, id).Take(&c).Error
	if errors.Is(e, gorm.ErrRecordNotFound) {
		return Session{}, ErrNotFound
	}
	if e != nil {
		return Session{}, e
	}
	return c.session(), nil
}
func (s *Store) ListSessions(ctx context.Context, tenant, agent string, kinds []string, limit, offset int) ([]Session, error) {
	if limit < 1 || limit > 200 {
		limit = 50
	}
	query := s.deps.Gorm.WithContext(ctx).Table("cloud_agent_sessions").Select(sessionColumnsList).Where("tenant_id = ? AND agent_id = ?", tenant, agent)
	if len(kinds) > 0 {
		query = query.Where("kind IN ?", kinds)
	}
	var rows []sessionColumns
	if err := query.Order("updated_at DESC, id DESC").Limit(limit).Offset(offset).Scan(&rows).Error; err != nil {
		return nil, err
	}
	out := make([]Session, 0, len(rows))
	for _, c := range rows {
		out = append(out, c.session())
	}
	return out, nil
}
func (s *Store) SearchSessions(ctx context.Context, tenant, q string, limit int) ([]Session, error) {
	if limit < 1 || limit > 100 {
		limit = 30
	}
	var rows []sessionColumns
	if e := s.deps.Gorm.WithContext(ctx).Raw(`SELECT DISTINCT s.id,s.agent_id,s.title,s.status,s.kind,s.project,s.origin_json,s.model,s.model_route_id,s.reasoning,s.draft_text,s.last_seq,s.active_run_id,s.created_by_user_id,s.created_at,s.updated_at FROM cloud_agent_sessions s LEFT JOIN cloud_agent_events e ON e.session_id=s.id WHERE s.tenant_id=? AND (LOWER(s.title) LIKE LOWER(?) OR LOWER(e.payload_json) LIKE LOWER(?)) ORDER BY s.updated_at DESC LIMIT ?`, tenant, "%"+q+"%", "%"+q+"%", limit).Scan(&rows).Error; e != nil {
		return nil, e
	}
	out := make([]Session, 0, len(rows))
	for _, c := range rows {
		out = append(out, c.session())
	}
	return out, nil
}
func (s *Store) UpdateSession(ctx context.Context, tenant, agent, id string, patch map[string]any) (Session, error) {
	allowed := map[string]string{"title": "title", "status": "status", "project": "project", "model": "model", "modelRouteId": "model_route_id", "reasoning": "reasoning", "draftText": "draft_text"}
	sets := []string{}
	args := []any{}
	for key, col := range allowed {
		if v, ok := patch[key]; ok {
			sets = append(sets, col+"=?")
			args = append(args, v)
		}
	}
	if len(sets) == 0 {
		return s.GetSession(ctx, tenant, agent, id)
	}
	sets = append(sets, "updated_at=?")
	args = append(args, runtimeTimeString(s.now()), tenant, agent, id)
	res := s.deps.Gorm.WithContext(ctx).Exec(`UPDATE cloud_agent_sessions SET `+strings.Join(sets, ",")+` WHERE tenant_id=? AND agent_id=? AND id=?`, args...)
	if res.Error != nil {
		return Session{}, res.Error
	}
	if res.RowsAffected == 0 {
		return Session{}, ErrNotFound
	}
	return s.GetSession(ctx, tenant, agent, id)
}
func (s *Store) DeleteSession(ctx context.Context, tenant, agent, id string) error {
	res := s.deps.Gorm.WithContext(ctx).Table("cloud_agent_sessions").Where("tenant_id = ? AND agent_id = ? AND id = ?", tenant, agent, id).Delete(nil)
	if res.Error != nil {
		return res.Error
	}
	if res.RowsAffected == 0 {
		return ErrNotFound
	}
	return nil
}

func (s *Store) appendEventTx(ctx context.Context, tx *gorm.DB, sessionID, typ string, runID *string, payload any) (Event, error) {
	raw, e := json.Marshal(payload)
	if e != nil {
		return Event{}, e
	}
	var seq int64
	e = tx.Raw(`UPDATE cloud_agent_sessions SET last_seq=last_seq+1, updated_at=? WHERE id=? RETURNING last_seq`, runtimeTimeString(s.now()), sessionID).Row().Scan(&seq)
	if errors.Is(e, sql.ErrNoRows) {
		return Event{}, ErrNotFound
	}
	if e != nil {
		return Event{}, e
	}
	ev := Event{ID: s.id(), SessionID: sessionID, Seq: seq, Type: typ, RunID: runID, Payload: raw, CreatedAt: s.now()}
	e = tx.Table("cloud_agent_events").Create(map[string]any{"id": ev.ID, "session_id": sessionID, "seq": seq, "type": typ, "run_id": runID, "payload_json": string(raw), "created_at": runtimeTimeString(ev.CreatedAt)}).Error
	return ev, e
}
func (s *Store) AppendEvent(ctx context.Context, tenant, agent, session, typ string, runID *string, payload any) (Event, error) {
	if _, e := s.GetSession(ctx, tenant, agent, session); e != nil {
		return Event{}, e
	}
	var out Event
	e := s.deps.Gorm.WithContext(ctx).Transaction(func(tx *gorm.DB) error {
		var x error
		out, x = s.appendEventTx(ctx, tx, session, typ, runID, payload)
		return x
	})
	return out, e
}
func (s *Store) ListEvents(ctx context.Context, tenant, agent, session string, after int64, limit int) ([]Event, error) {
	if _, e := s.GetSession(ctx, tenant, agent, session); e != nil {
		return nil, e
	}
	if limit < 1 || limit > 1000 {
		limit = 200
	}
	var rows []struct {
		ID        string  `gorm:"column:id"`
		SessionID string  `gorm:"column:session_id"`
		Seq       int64   `gorm:"column:seq"`
		Type      string  `gorm:"column:type"`
		RunID     *string `gorm:"column:run_id"`
		Raw       string  `gorm:"column:payload_json"`
		CreatedAt string  `gorm:"column:created_at"`
	}
	if e := s.deps.Gorm.WithContext(ctx).Table("cloud_agent_events").Select("id,session_id,seq,type,run_id,payload_json,created_at").Where("session_id = ? AND seq > ?", session, after).Order("seq").Limit(limit).Scan(&rows).Error; e != nil {
		return nil, e
	}
	out := make([]Event, 0, len(rows))
	for _, c := range rows {
		out = append(out, Event{ID: c.ID, SessionID: c.SessionID, Seq: c.Seq, Type: c.Type, RunID: c.RunID, Payload: json.RawMessage(c.Raw), CreatedAt: parseTime(c.CreatedAt)})
	}
	return out, nil
}
func (s *Store) StartRun(ctx context.Context, tenant, agent, session, content string, attachments, options json.RawMessage) (Run, error) {
	if strings.TrimSpace(content) == "" && len(attachments) == 0 {
		return Run{}, errors.New("content or attachments required")
	}
	if _, e := s.GetSession(ctx, tenant, agent, session); e != nil {
		return Run{}, e
	}
	now := s.now()
	run := Run{ID: s.id(), SessionID: session, Status: "running", StartedAt: &now, CreatedAt: now}
	e := s.deps.Gorm.WithContext(ctx).Transaction(func(tx *gorm.DB) error {
		res := tx.Table("cloud_agent_sessions").Where("tenant_id = ? AND agent_id = ? AND id = ? AND active_run_id IS NULL", tenant, agent, session).Updates(map[string]any{"active_run_id": run.ID, "updated_at": runtimeTimeString(now)})
		if res.Error != nil {
			return res.Error
		}
		if res.RowsAffected == 0 {
			return ErrConflict
		}
		if e := tx.Table("cloud_agent_runs").Create(map[string]any{"id": run.ID, "session_id": session, "status": run.Status, "cancel_requested": false, "error": nil, "started_at": runtimeTimeString(now), "completed_at": nil, "created_at": runtimeTimeString(now)}).Error; e != nil {
			return e
		}
		if e := tx.Exec(computers.SnapshotRunTargetSQL, run.ID, tenant).Error; e != nil {
			return e
		}
		if _, e := s.appendEventTx(ctx, tx, session, "user_message", &run.ID, map[string]any{"content": content, "attachments": json.RawMessage(validJSON(attachments, "[]")), "options": json.RawMessage(validJSON(options, "{}"))}); e != nil {
			return e
		}
		_, e := s.appendEventTx(ctx, tx, session, "run_start", &run.ID, map[string]any{"runId": run.ID, "status": "running"})
		return e
	})
	if e == nil {
		if sess, lookupErr := s.GetSession(context.WithoutCancel(ctx), tenant, agent, session); lookupErr == nil && sess.CreatedByUserID != nil && s.deps.RecordUsage != nil {
			_ = s.deps.RecordUsage(context.WithoutCancel(ctx), appdeps.UsageRecord{TenantID: tenant, UserID: *sess.CreatedByUserID, ActorKind: "user", Category: "run", Action: "run_started", Status: "ok", AgentID: agent, SessionID: session, ResourceKind: "run", ResourceID: run.ID, Summary: "Run started"})
		}
	}
	return run, e
}
func (s *Store) GetRun(ctx context.Context, tenant, agent, session, runID string) (Run, error) {
	if _, e := s.GetSession(ctx, tenant, agent, session); e != nil {
		return Run{}, e
	}
	var c struct {
		ID              string  `gorm:"column:id"`
		SessionID       string  `gorm:"column:session_id"`
		Status          string  `gorm:"column:status"`
		CancelRequested bool    `gorm:"column:cancel_requested"`
		Error           *string `gorm:"column:error"`
		StartedAt       *string `gorm:"column:started_at"`
		CompletedAt     *string `gorm:"column:completed_at"`
		CreatedAt       string  `gorm:"column:created_at"`
	}
	e := s.deps.Gorm.WithContext(ctx).Table("cloud_agent_runs").Select("id,session_id,status,cancel_requested,error,started_at,completed_at,created_at").Where("session_id = ? AND id = ?", session, runID).Take(&c).Error
	if errors.Is(e, gorm.ErrRecordNotFound) {
		return Run{}, ErrNotFound
	}
	if e != nil {
		return Run{}, e
	}
	x := Run{ID: c.ID, SessionID: c.SessionID, Status: c.Status, CancelRequested: c.CancelRequested, Error: c.Error, CreatedAt: parseTime(c.CreatedAt)}
	if c.StartedAt != nil {
		t := parseTime(*c.StartedAt)
		x.StartedAt = &t
	}
	if c.CompletedAt != nil {
		t := parseTime(*c.CompletedAt)
		x.CompletedAt = &t
	}
	return x, nil
}
func (s *Store) FinishRun(ctx context.Context, tenant, agent, session, runID, status string, errText *string, payload any) error {
	if status != "completed" && status != "failed" && status != "cancelled" {
		return errors.New("invalid terminal status")
	}
	if _, e := s.GetSession(ctx, tenant, agent, session); e != nil {
		return e
	}
	e := s.deps.Gorm.WithContext(ctx).Transaction(func(tx *gorm.DB) error {
		now := s.now()
		res := tx.Table("cloud_agent_runs").Where("id = ? AND session_id = ? AND status IN ('running','queued')", runID, session).Updates(map[string]any{"status": status, "error": errText, "completed_at": runtimeTimeString(now)})
		if res.Error != nil {
			return res.Error
		}
		if res.RowsAffected == 0 {
			return ErrConflict
		}
		if e := tx.Table("cloud_agent_sessions").Where("id = ? AND active_run_id = ?", session, runID).Updates(map[string]any{"active_run_id": nil, "updated_at": runtimeTimeString(now)}).Error; e != nil {
			return e
		}
		typ := "run_end"
		if status == "failed" {
			typ = "run_error"
		}
		terminalPayload := map[string]any{"runId": runID, "status": status}
		if errText != nil {
			terminalPayload["error"] = *errText
		}
		terminalPayload["result"] = payload
		_, e := s.appendEventTx(ctx, tx, session, typ, &runID, terminalPayload)
		return e
	})
	if e == nil {
		s.recordRunTerminal(context.WithoutCancel(ctx), tenant, agent, session, runID, status)
	}
	return e
}

func (s *Store) recordRunTerminal(ctx context.Context, tenant, agent, session, runID, status string) {
	if s.deps.RecordUsage == nil {
		return
	}
	sess, err := s.GetSession(ctx, tenant, agent, session)
	if err != nil || sess.CreatedByUserID == nil || *sess.CreatedByUserID == "" {
		return
	}
	run, err := s.GetRun(ctx, tenant, agent, session, runID)
	if err != nil {
		return
	}
	duration := int64(0)
	if run.StartedAt != nil && run.CompletedAt != nil {
		duration = run.CompletedAt.Sub(*run.StartedAt).Milliseconds()
		if duration < 0 {
			duration = 0
		}
	}
	action, usageStatus := "run_"+status, "ok"
	if status == "failed" || status == "cancelled" {
		usageStatus = "error"
	}
	_ = s.deps.RecordUsage(ctx, appdeps.UsageRecord{TenantID: tenant, UserID: *sess.CreatedByUserID, ActorKind: "user", Category: "run", Action: action, Status: usageStatus, DurationMS: duration, AgentID: agent, SessionID: session, ResourceKind: "run", ResourceID: runID, Summary: "Run " + status})
}
func (s *Store) CancelRun(ctx context.Context, tenant, agent, session string) (Run, error) {
	sess, e := s.GetSession(ctx, tenant, agent, session)
	if e != nil {
		return Run{}, e
	}
	if sess.ActiveRunID == nil {
		return Run{}, ErrConflict
	}
	rid := *sess.ActiveRunID
	now := s.now()
	e = s.deps.Gorm.WithContext(ctx).Transaction(func(tx *gorm.DB) error {
		res := tx.Table("cloud_agent_runs").Where("id = ? AND session_id = ? AND status IN ('queued','running')", rid, session).Updates(map[string]any{"cancel_requested": true, "status": "cancelled", "completed_at": runtimeTimeString(now)})
		if res.Error != nil {
			return res.Error
		}
		if res.RowsAffected == 0 {
			return ErrConflict
		}
		res = tx.Table("cloud_agent_sessions").Where("id = ? AND active_run_id = ?", session, rid).Updates(map[string]any{"active_run_id": nil, "updated_at": runtimeTimeString(now)})
		if res.Error != nil {
			return res.Error
		}
		if res.RowsAffected == 0 {
			return ErrConflict
		}
		_, e := s.appendEventTx(ctx, tx, session, "run_end", &rid, map[string]any{"runId": rid, "status": "cancelled"})
		return e
	})
	if e != nil {
		return Run{}, e
	}
	run, e := s.GetRun(ctx, tenant, agent, session, rid)
	if e == nil {
		s.recordRunTerminal(context.WithoutCancel(ctx), tenant, agent, session, rid, "cancelled")
	}
	return run, e
}
func (s *Store) RecoverRuns(ctx context.Context) (int64, error) {
	type recovered struct {
		Tenant  string `gorm:"column:tenant_id"`
		Agent   string `gorm:"column:agent_id"`
		Session string `gorm:"column:session_id"`
		Run     string `gorm:"column:run_id"`
	}
	items := []recovered{}
	_ = s.deps.Gorm.WithContext(ctx).Raw(`SELECT cs.tenant_id,cs.agent_id,cs.id,r.id AS run_id FROM cloud_agent_runs r JOIN cloud_agent_sessions cs ON cs.id=r.session_id WHERE r.status='running'`).Scan(&items).Error
	now := s.now()
	res := s.deps.Gorm.WithContext(ctx).Table("cloud_agent_runs").Where("status = 'running'").Updates(map[string]any{"status": "failed", "error": "server restarted", "completed_at": runtimeTimeString(now)})
	// phase5: NOT EXISTS subquery — keep Exec (gorm has no chain equivalent)
	if res.Error != nil {
		return 0, res.Error
	}
	_ = s.deps.Gorm.WithContext(ctx).Exec(`UPDATE cloud_agent_sessions SET active_run_id=NULL,updated_at=? WHERE active_run_id IS NOT NULL AND NOT EXISTS (SELECT 1 FROM cloud_agent_runs r WHERE r.id=cloud_agent_sessions.active_run_id AND r.status='running')`, runtimeTimeString(now))
	for _, item := range items {
		s.recordRunTerminal(context.WithoutCancel(ctx), item.Tenant, item.Agent, item.Session, item.Run, "failed")
	}
	return res.RowsAffected, nil
}

func (s *Store) Enqueue(ctx context.Context, tenant, agent, session string, msg QueueMessage) (QueueMessage, error) {
	if _, e := s.GetSession(ctx, tenant, agent, session); e != nil {
		return QueueMessage{}, e
	}
	msg.Content = strings.TrimSpace(msg.Content)
	if msg.Content == "" && len(msg.Attachments) == 0 {
		return QueueMessage{}, errors.New("content or attachments required")
	}
	if msg.ID == "" {
		msg.ID = s.id()
	}
	if len(msg.Attachments) == 0 {
		msg.Attachments = json.RawMessage(`[]`)
	}
	if len(msg.Options) == 0 {
		msg.Options = json.RawMessage(`{}`)
	}
	_, e := s.AppendEvent(ctx, tenant, agent, session, "queue.added", nil, msg)
	return msg, e
}
func (s *Store) UpdateQueued(ctx context.Context, tenant, agent, session, id string, patch QueueMessage) (QueueMessage, error) {
	items, e := s.PendingQueue(ctx, tenant, agent, session)
	if e != nil {
		return QueueMessage{}, e
	}
	var cur *QueueMessage
	for i := range items {
		if items[i].ID == id {
			cur = &items[i]
			break
		}
	}
	if cur == nil {
		return QueueMessage{}, ErrNotFound
	}
	if patch.Content != "" {
		cur.Content = patch.Content
	}
	if len(patch.Attachments) > 0 {
		cur.Attachments = patch.Attachments
	}
	if len(patch.Options) > 0 {
		cur.Options = patch.Options
	}
	_, e = s.AppendEvent(ctx, tenant, agent, session, "queue.updated", nil, *cur)
	return *cur, e
}
func (s *Store) DeleteQueued(ctx context.Context, tenant, agent, session, id string) error {
	items, e := s.PendingQueue(ctx, tenant, agent, session)
	if e != nil {
		return e
	}
	found := false
	for _, x := range items {
		if x.ID == id {
			found = true
			break
		}
	}
	if !found {
		return ErrNotFound
	}
	_, e = s.AppendEvent(ctx, tenant, agent, session, "queue.deleted", nil, map[string]any{"id": id})
	return e
}
func (s *Store) PendingQueue(ctx context.Context, tenant, agent, session string) ([]QueueMessage, error) {
	events, e := s.ListEvents(ctx, tenant, agent, session, 0, 1000)
	if e != nil {
		return nil, e
	}
	order := []string{}
	state := map[string]QueueMessage{}
	for _, ev := range events {
		switch ev.Type {
		case "queue.added", "queue.updated":
			var m QueueMessage
			if json.Unmarshal(ev.Payload, &m) != nil || m.ID == "" {
				continue
			}
			if _, ok := state[m.ID]; !ok {
				order = append(order, m.ID)
			}
			state[m.ID] = m
		case "queue.deleted", "queue.started":
			var x struct {
				ID string `json:"id"`
			}
			if json.Unmarshal(ev.Payload, &x) == nil {
				delete(state, x.ID)
			}
		}
	}
	out := make([]QueueMessage, 0, len(state))
	for _, id := range order {
		if m, ok := state[id]; ok {
			out = append(out, m)
		}
	}
	return out, nil
}
func (s *Store) TakeQueued(ctx context.Context, tenant, agent, session string) (QueueMessage, error) {
	items, e := s.PendingQueue(ctx, tenant, agent, session)
	if e != nil {
		return QueueMessage{}, e
	}
	if len(items) == 0 {
		return QueueMessage{}, ErrNotFound
	}
	m := items[0]
	_, e = s.AppendEvent(ctx, tenant, agent, session, "queue.started", nil, map[string]any{"id": m.ID})
	return m, e
}

func (s *Store) ListMemories(ctx context.Context, tenant, agent, q, layer string, limit int) ([]Memory, error) {
	if _, e := s.GetAgent(ctx, tenant, agent); e != nil {
		return nil, e
	}
	if limit < 1 || limit > 500 {
		limit = 100
	}
	query := s.deps.Gorm.WithContext(ctx).Table("memories").Select("id,agent_id,provider_id,layer,content,tags_json,pinned,importance,source,metadata_json,created_at,updated_at").Where("tenant_id = ? AND agent_id = ?", tenant, agent)
	if q != "" {
		query = query.Where("LOWER(content) LIKE LOWER(?)", "%"+q+"%")
	}
	if layer != "" {
		query = query.Where("layer = ?", layer)
	}
	var rows []struct {
		ID         string  `gorm:"column:id"`
		AgentID    string  `gorm:"column:agent_id"`
		ProviderID *string `gorm:"column:provider_id"`
		Layer      string  `gorm:"column:layer"`
		Content    string  `gorm:"column:content"`
		Tags       string  `gorm:"column:tags_json"`
		Pinned     bool    `gorm:"column:pinned"`
		Importance string  `gorm:"column:importance"`
		Source     string  `gorm:"column:source"`
		Metadata   string  `gorm:"column:metadata_json"`
		CreatedAt  string  `gorm:"column:created_at"`
		UpdatedAt  string  `gorm:"column:updated_at"`
	}
	if e := query.Order("pinned DESC, updated_at DESC").Limit(limit).Scan(&rows).Error; e != nil {
		return nil, e
	}
	out := make([]Memory, 0, len(rows))
	for _, c := range rows {
		out = append(out, Memory{ID: c.ID, AgentID: c.AgentID, ProviderID: c.ProviderID, Layer: c.Layer, Content: c.Content, Tags: json.RawMessage(c.Tags), Pinned: c.Pinned, Importance: c.Importance, Source: c.Source, Metadata: json.RawMessage(c.Metadata), CreatedAt: parseTime(c.CreatedAt), UpdatedAt: parseTime(c.UpdatedAt)})
	}
	return out, nil
}
func (s *Store) CreateMemory(ctx context.Context, tenant, agent string, in Memory) (Memory, error) {
	if _, e := s.GetAgent(ctx, tenant, agent); e != nil {
		return Memory{}, e
	}
	in.Content = strings.TrimSpace(in.Content)
	if in.Content == "" {
		return Memory{}, errors.New("content required")
	}
	if in.Layer == "" {
		in.Layer = "fact"
	}
	if in.Importance == "" {
		in.Importance = "3"
	}
	if in.Source == "" {
		in.Source = "manual"
	}
	if len(in.Tags) == 0 {
		in.Tags = json.RawMessage(`[]`)
	}
	if len(in.Metadata) == 0 {
		in.Metadata = json.RawMessage(`{}`)
	}
	now := s.now()
	in.ID = s.id()
	in.AgentID = agent
	in.CreatedAt = now
	in.UpdatedAt = now
	pinned := 0
	if in.Pinned {
		pinned = 1
	}
	e := s.deps.Gorm.WithContext(ctx).Table("memories").Create(map[string]any{"id": in.ID, "tenant_id": tenant, "agent_id": agent, "provider_id": in.ProviderID, "layer": in.Layer, "content": in.Content, "tags_json": validJSON(in.Tags, "[]"), "pinned": pinned, "importance": in.Importance, "source": in.Source, "metadata_json": validJSON(in.Metadata, "{}"), "created_at": runtimeTimeString(now), "updated_at": runtimeTimeString(now)}).Error
	return in, e
}
func (s *Store) DeleteMemory(ctx context.Context, tenant, agent, id string) error {
	res := s.deps.Gorm.WithContext(ctx).Table("memories").Where("tenant_id = ? AND agent_id = ? AND id = ?", tenant, agent, id).Delete(nil)
	if res.Error != nil {
		return res.Error
	}
	if res.RowsAffected == 0 {
		return ErrNotFound
	}
	return nil
}
func (s *Store) ClearMemories(ctx context.Context, tenant, agent string) (int64, error) {
	res := s.deps.Gorm.WithContext(ctx).Table("memories").Where("tenant_id = ? AND agent_id = ?", tenant, agent).Delete(nil)
	if res.Error != nil {
		return 0, res.Error
	}
	return res.RowsAffected, nil
}

type upstreamColumns struct {
	ID        string  `gorm:"column:id"`
	Name      string  `gorm:"column:name"`
	Slug      string  `gorm:"column:slug"`
	Protocol  string  `gorm:"column:protocol"`
	Config    string  `gorm:"column:config_json"`
	Status    string  `gorm:"column:status"`
	LastError *string `gorm:"column:last_error"`
	CreatedAt string  `gorm:"column:created_at"`
	UpdatedAt string  `gorm:"column:updated_at"`
}

func (c upstreamColumns) upstream() Upstream {
	return Upstream{ID: c.ID, Name: c.Name, Slug: c.Slug, Protocol: c.Protocol, Config: json.RawMessage(c.Config), Status: c.Status, LastError: c.LastError, CreatedAt: parseTime(c.CreatedAt), UpdatedAt: parseTime(c.UpdatedAt)}
}

func (s *Store) ListUpstreams(ctx context.Context, tenant string) ([]Upstream, error) {
	var rows []upstreamColumns
	if e := s.deps.Gorm.WithContext(ctx).Table("model_upstreams").Select("id,name,slug,protocol,config_json,status,last_error,created_at,updated_at").Where("tenant_id = ?", tenant).Order("created_at, id").Scan(&rows).Error; e != nil {
		return nil, e
	}
	out := make([]Upstream, 0, len(rows))
	for _, c := range rows {
		out = append(out, c.upstream())
	}
	return out, nil
}
func (s *Store) CreateUpstream(ctx context.Context, tenant string, in Upstream) (Upstream, error) {
	in.Name = strings.TrimSpace(in.Name)
	if in.Name == "" {
		return Upstream{}, errors.New("name required")
	}
	if in.Slug == "" {
		in.Slug = slugify(in.Name)
	}
	if in.Protocol == "" {
		in.Protocol = "openai"
	}
	if in.Status == "" {
		in.Status = "ready"
	}
	if len(in.Config) == 0 {
		in.Config = json.RawMessage(`{}`)
	}
	now := s.now()
	in.ID = s.id()
	var protected map[string]any
	if json.Unmarshal(in.Config, &protected) == nil {
		if e := protectModelConfig(s.deps.Secret, tenant, in.ID, protected); e != nil {
			return Upstream{}, e
		}
		in.Config, _ = json.Marshal(protected)
	}
	in.CreatedAt = now
	in.UpdatedAt = now
	e := s.deps.Gorm.WithContext(ctx).Table("model_upstreams").Create(map[string]any{"id": in.ID, "tenant_id": tenant, "name": in.Name, "slug": in.Slug, "protocol": in.Protocol, "config_json": validJSON(in.Config, "{}"), "status": in.Status, "last_error": in.LastError, "created_at": runtimeTimeString(now), "updated_at": runtimeTimeString(now)}).Error
	return in, e
}
func (s *Store) GetUpstream(ctx context.Context, tenant, id string) (Upstream, error) {
	var c upstreamColumns
	e := s.deps.Gorm.WithContext(ctx).Table("model_upstreams").Select("id,name,slug,protocol,config_json,status,last_error,created_at,updated_at").Where("tenant_id = ? AND id = ?", tenant, id).Take(&c).Error
	if errors.Is(e, gorm.ErrRecordNotFound) {
		return Upstream{}, ErrNotFound
	}
	if e != nil {
		return Upstream{}, e
	}
	return c.upstream(), nil
}
func (s *Store) DeleteUpstream(ctx context.Context, tenant, id string) error {
	res := s.deps.Gorm.WithContext(ctx).Table("model_upstreams").Where("tenant_id = ? AND id = ?", tenant, id).Delete(nil)
	if res.Error != nil {
		return res.Error
	}
	if res.RowsAffected == 0 {
		return ErrNotFound
	}
	return nil
}
func (s *Store) ListRoutes(ctx context.Context, tenant, capability string) ([]ModelRoute, error) {
	query := s.deps.Gorm.WithContext(ctx).Table("model_routes").Select("id,name,slug,capability,alias,upstream_id,model,options_json,priority,weight,is_default,status,last_error,created_at,updated_at").Where("tenant_id = ?", tenant)
	if capability != "" {
		query = query.Where("capability = ?", capability)
	}
	var rows []struct {
		ID         string  `gorm:"column:id"`
		Name       string  `gorm:"column:name"`
		Slug       string  `gorm:"column:slug"`
		Capability string  `gorm:"column:capability"`
		Alias      *string `gorm:"column:alias"`
		UpstreamID string  `gorm:"column:upstream_id"`
		Model      string  `gorm:"column:model"`
		Options    string  `gorm:"column:options_json"`
		Priority   string  `gorm:"column:priority"`
		Weight     string  `gorm:"column:weight"`
		IsDefault  bool    `gorm:"column:is_default"`
		Status     string  `gorm:"column:status"`
		LastError  *string `gorm:"column:last_error"`
		CreatedAt  string  `gorm:"column:created_at"`
		UpdatedAt  string  `gorm:"column:updated_at"`
	}
	if e := query.Order("is_default DESC, CAST(priority AS INTEGER), id").Scan(&rows).Error; e != nil {
		return nil, e
	}
	out := make([]ModelRoute, 0, len(rows))
	for _, c := range rows {
		priority, _ := strconv.Atoi(c.Priority)
		weight, _ := strconv.Atoi(c.Weight)
		out = append(out, ModelRoute{ID: c.ID, Name: c.Name, Slug: c.Slug, Capability: c.Capability, Alias: c.Alias, UpstreamID: c.UpstreamID, Model: c.Model, Options: json.RawMessage(c.Options), Priority: priority, Weight: weight, IsDefault: c.IsDefault, Status: c.Status, LastError: c.LastError, CreatedAt: parseTime(c.CreatedAt), UpdatedAt: parseTime(c.UpdatedAt)})
	}
	return out, nil
}
func (s *Store) CreateRoute(ctx context.Context, tenant string, in ModelRoute) (ModelRoute, error) {
	if _, e := s.GetUpstream(ctx, tenant, in.UpstreamID); e != nil {
		return ModelRoute{}, e
	}
	if in.Name == "" {
		return ModelRoute{}, errors.New("name required")
	}
	if in.Slug == "" {
		in.Slug = slugify(in.Name)
	}
	if in.Capability == "" {
		in.Capability = "chat"
	}
	if in.Model == "" {
		return ModelRoute{}, errors.New("model required")
	}
	if in.Priority == 0 {
		in.Priority = 100
	}
	if in.Weight == 0 {
		in.Weight = 100
	}
	if in.Status == "" {
		in.Status = "ready"
	}
	if len(in.Options) == 0 {
		in.Options = json.RawMessage(`{}`)
	}
	now := s.now()
	in.ID = s.id()
	in.CreatedAt = now
	in.UpdatedAt = now
	e := s.deps.Gorm.WithContext(ctx).Table("model_routes").Create(map[string]any{"id": in.ID, "tenant_id": tenant, "name": in.Name, "slug": in.Slug, "capability": in.Capability, "alias": in.Alias, "upstream_id": in.UpstreamID, "model": in.Model, "options_json": validJSON(in.Options, "{}"), "priority": strconv.Itoa(in.Priority), "weight": strconv.Itoa(in.Weight), "is_default": in.IsDefault, "status": in.Status, "last_error": in.LastError, "created_at": runtimeTimeString(now), "updated_at": runtimeTimeString(now)}).Error
	return in, e
}
func (s *Store) DeleteRoute(ctx context.Context, tenant, id string) error {
	res := s.deps.Gorm.WithContext(ctx).Table("model_routes").Where("tenant_id = ? AND id = ?", tenant, id).Delete(nil)
	if res.Error != nil {
		return res.Error
	}
	if res.RowsAffected == 0 {
		return ErrNotFound
	}
	return nil
}

func (s *Store) ResolveModel(ctx context.Context, tenant, capability, model string) (ModelRoute, Upstream, error) {
	candidates, e := s.ResolveCandidates(ctx, tenant, capability, model)
	if e != nil {
		return ModelRoute{}, Upstream{}, e
	}
	return candidates[0].Route, candidates[0].Upstream, nil
}

type ModelCandidate struct {
	Route    ModelRoute
	Upstream Upstream
}

func (s *Store) ResolveCandidates(ctx context.Context, tenant, capability, model string) ([]ModelCandidate, error) {
	routes, e := s.ListRoutes(ctx, tenant, capability)
	if e != nil {
		return nil, e
	}
	var candidates []ModelRoute
	for _, r := range routes {
		if r.Status != "ready" {
			continue
		}
		if model == "" && r.IsDefault {
			candidates = append(candidates, r)
		} else if r.Model == model || (r.Alias != nil && *r.Alias == model) || r.Slug == model {
			candidates = append(candidates, r)
		}
	}
	if model == "" {
		for _, r := range routes {
			if r.Status != "ready" || r.IsDefault {
				continue
			}
			candidates = append(candidates, r)
		}
	}
	if len(candidates) == 0 && model != "" {
		for _, r := range routes {
			if r.Status == "ready" {
				candidates = append(candidates, r)
			}
		}
	}
	if len(candidates) == 0 {
		return nil, ErrNotFound
	}
	// Weighted choice determines the first attempt while every remaining route is
	// retained as an ordered failover candidate. Restrict the draw to the best
	// priority tier so a low-priority fallback cannot steal normal traffic.
	best := candidates[0].Priority
	total := 0
	for _, r := range candidates {
		if r.Priority != best {
			break
		}
		if r.Weight > 0 {
			total += r.Weight
		}
	}
	chosen := 0
	if total > 0 {
		draw := mathrand.Intn(total)
		for i, r := range candidates {
			if r.Priority != best {
				break
			}
			draw -= max(r.Weight, 0)
			if draw < 0 {
				chosen = i
				break
			}
		}
	}
	if chosen > 0 {
		picked := candidates[chosen]
		copy(candidates[1:chosen+1], candidates[0:chosen])
		candidates[0] = picked
	}
	out := make([]ModelCandidate, 0, len(candidates))
	for _, route := range candidates {
		up, e := s.GetUpstream(ctx, tenant, route.UpstreamID)
		if e != nil || up.Status != "ready" {
			continue
		}
		out = append(out, ModelCandidate{Route: route, Upstream: up})
	}
	if len(out) == 0 {
		return nil, ErrNotFound
	}
	return out, nil
}
