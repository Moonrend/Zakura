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

	"github.com/Moonrend/Zakura/go/server/internal/platform/appdeps"
)

var (
	ErrNotFound = errors.New("not found")
	ErrConflict = errors.New("conflict")
)

type Store struct{ deps *appdeps.Dependencies }

func NewStore(deps *appdeps.Dependencies) *Store { return &Store{deps: deps} }
func (s *Store) q(q string) string {
	if s.deps.Rebind != nil {
		return s.deps.Rebind(q)
	}
	return q
}
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

func (s *Store) ListSpaces(ctx context.Context, tenant string) ([]Space, error) {
	rows, err := s.deps.DB.QueryContext(ctx, s.q(`SELECT id,tenant_id,name,slug,description,enable_computer,workspace_image,runtime_node_id,workspace_kind,workspace_status,config_json,last_error,created_at,updated_at FROM spaces WHERE tenant_id=? ORDER BY created_at,id`), tenant)
	if err != nil {
		return nil, err
	}
	defer rows.Close()
	out := make([]Space, 0)
	for rows.Next() {
		var x Space
		var config string
		var c, u flexibleTime
		if err := rows.Scan(&x.ID, &x.TenantID, &x.Name, &x.Slug, &x.Description, &x.EnableComputer, &x.WorkspaceImage, &x.RuntimeNodeID, &x.WorkspaceKind, &x.WorkspaceStatus, &config, &x.LastError, &c, &u); err != nil {
			return nil, err
		}
		x.Config = json.RawMessage(config)
		x.CreatedAt = c.Time
		x.UpdatedAt = u.Time
		out = append(out, x)
	}
	return out, rows.Err()
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
	_, err := s.deps.DB.ExecContext(ctx, s.q(`INSERT INTO spaces(id,tenant_id,name,slug,description,enable_computer,workspace_image,runtime_node_id,workspace_kind,workspace_status,config_json,last_error,created_at,updated_at) VALUES(?,?,?,?,?,?,?,?,?,?,?,?,?,?)`), in.ID, tenant, in.Name, in.Slug, in.Description, in.EnableComputer, in.WorkspaceImage, in.RuntimeNodeID, in.WorkspaceKind, in.WorkspaceStatus, validJSON(in.Config, "{}"), in.LastError, now, now)
	if err != nil {
		return Space{}, err
	}
	return in, nil
}

func (s *Store) GetSpace(ctx context.Context, tenant, id string) (Space, error) {
	var x Space
	var config string
	var c, u flexibleTime
	err := s.deps.DB.QueryRowContext(ctx, s.q(`SELECT id,tenant_id,name,slug,description,enable_computer,workspace_image,runtime_node_id,workspace_kind,workspace_status,config_json,last_error,created_at,updated_at FROM spaces WHERE tenant_id=? AND id=?`), tenant, id).Scan(&x.ID, &x.TenantID, &x.Name, &x.Slug, &x.Description, &x.EnableComputer, &x.WorkspaceImage, &x.RuntimeNodeID, &x.WorkspaceKind, &x.WorkspaceStatus, &config, &x.LastError, &c, &u)
	if errors.Is(err, sql.ErrNoRows) {
		return Space{}, ErrNotFound
	}
	if err != nil {
		return Space{}, err
	}
	x.Config = json.RawMessage(config)
	x.CreatedAt = c.Time
	x.UpdatedAt = u.Time
	return x, nil
}

func (s *Store) DeleteSpace(ctx context.Context, tenant, id string) error {
	r, e := s.deps.DB.ExecContext(ctx, s.q(`DELETE FROM spaces WHERE tenant_id=? AND id=?`), tenant, id)
	if e != nil {
		return e
	}
	n, _ := r.RowsAffected()
	if n == 0 {
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
	args = append(args, s.now(), tenant, id)
	r, e := s.deps.DB.ExecContext(ctx, s.q(`UPDATE spaces SET `+strings.Join(sets, ",")+` WHERE tenant_id=? AND id=?`), args...)
	if e != nil {
		return Space{}, e
	}
	n, _ := r.RowsAffected()
	if n == 0 {
		return Space{}, ErrNotFound
	}
	return s.GetSpace(ctx, tenant, id)
}

func (s *Store) ListAgents(ctx context.Context, tenant string) ([]Agent, error) {
	rows, err := s.deps.DB.QueryContext(ctx, s.q(`SELECT id,tenant_id,space_id,name,slug,description,enable_memory,memory_provider_id,config_json,last_error,avatar_color,avatar_shape,avatar_url,created_at,updated_at FROM agents WHERE tenant_id=? ORDER BY created_at,id`), tenant)
	if err != nil {
		return nil, err
	}
	defer rows.Close()
	out := make([]Agent, 0)
	for rows.Next() {
		var x Agent
		var config string
		var c, u flexibleTime
		if err := rows.Scan(&x.ID, &x.TenantID, &x.SpaceID, &x.Name, &x.Slug, &x.Description, &x.EnableMemory, &x.MemoryProviderID, &config, &x.LastError, &x.AvatarColor, &x.AvatarShape, &x.AvatarURL, &c, &u); err != nil {
			return nil, err
		}
		x.Config = json.RawMessage(config)
		x.CreatedAt = c.Time
		x.UpdatedAt = u.Time
		out = append(out, x)
	}
	return out, rows.Err()
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
	_, err := s.deps.DB.ExecContext(ctx, s.q(`INSERT INTO agents(id,tenant_id,space_id,name,slug,description,enable_memory,memory_provider_id,config_json,last_error,avatar_color,avatar_shape,avatar_url,created_at,updated_at) VALUES(?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)`), in.ID, tenant, in.SpaceID, in.Name, in.Slug, in.Description, in.EnableMemory, in.MemoryProviderID, validJSON(in.Config, "{}"), in.LastError, in.AvatarColor, in.AvatarShape, in.AvatarURL, now, now)
	if err != nil {
		return Agent{}, err
	}
	return in, nil
}
func (s *Store) GetAgent(ctx context.Context, tenant, id string) (Agent, error) {
	var x Agent
	var config string
	var c, u flexibleTime
	err := s.deps.DB.QueryRowContext(ctx, s.q(`SELECT id,tenant_id,space_id,name,slug,description,enable_memory,memory_provider_id,config_json,last_error,avatar_color,avatar_shape,avatar_url,created_at,updated_at FROM agents WHERE tenant_id=? AND id=?`), tenant, id).Scan(&x.ID, &x.TenantID, &x.SpaceID, &x.Name, &x.Slug, &x.Description, &x.EnableMemory, &x.MemoryProviderID, &config, &x.LastError, &x.AvatarColor, &x.AvatarShape, &x.AvatarURL, &c, &u)
	if errors.Is(err, sql.ErrNoRows) {
		return Agent{}, ErrNotFound
	}
	if err != nil {
		return Agent{}, err
	}
	x.Config = json.RawMessage(config)
	x.CreatedAt = c.Time
	x.UpdatedAt = u.Time
	return x, nil
}
func (s *Store) DeleteAgent(ctx context.Context, tenant, id string) error {
	r, e := s.deps.DB.ExecContext(ctx, s.q(`DELETE FROM agents WHERE tenant_id=? AND id=?`), tenant, id)
	if e != nil {
		return e
	}
	n, _ := r.RowsAffected()
	if n == 0 {
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
	args = append(args, s.now(), tenant, id)
	r, e := s.deps.DB.ExecContext(ctx, s.q(`UPDATE agents SET `+strings.Join(sets, ",")+` WHERE tenant_id=? AND id=?`), args...)
	if e != nil {
		return Agent{}, e
	}
	n, _ := r.RowsAffected()
	if n == 0 {
		return Agent{}, ErrNotFound
	}
	return s.GetAgent(ctx, tenant, id)
}

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
	_, e := s.deps.DB.ExecContext(ctx, s.q(`INSERT INTO cloud_agent_sessions(id,tenant_id,agent_id,title,status,kind,project,origin_json,model,model_route_id,reasoning,draft_text,created_by_user_id,last_seq,active_run_id,created_at,updated_at) VALUES(?,?,?,?,?,?,?,?,?,?,?,?,?,0,NULL,?,?)`), in.ID, tenant, agent, in.Title, in.Status, in.Kind, in.Project, validJSON(in.Origin, "{}"), in.Model, in.ModelRouteID, in.Reasoning, in.DraftText, in.CreatedByUserID, now, now)
	if e != nil {
		return Session{}, e
	}
	if user != "" && s.deps.RecordUsage != nil {
		_ = s.deps.RecordUsage(context.WithoutCancel(ctx), appdeps.UsageRecord{TenantID: tenant, UserID: user, ActorKind: "user", Category: "session", Action: "session_created", Status: "ok", AgentID: agent, SessionID: in.ID, ResourceKind: "session", ResourceID: in.ID, Summary: in.Title})
	}
	return in, nil
}
func (s *Store) GetSession(ctx context.Context, tenant, agent, id string) (Session, error) {
	var x Session
	var origin string
	var c, u flexibleTime
	e := s.deps.DB.QueryRowContext(ctx, s.q(`SELECT id,agent_id,title,status,kind,project,origin_json,model,model_route_id,reasoning,draft_text,last_seq,active_run_id,created_by_user_id,created_at,updated_at FROM cloud_agent_sessions WHERE tenant_id=? AND agent_id=? AND id=?`), tenant, agent, id).Scan(&x.ID, &x.AgentID, &x.Title, &x.Status, &x.Kind, &x.Project, &origin, &x.Model, &x.ModelRouteID, &x.Reasoning, &x.DraftText, &x.LastSeq, &x.ActiveRunID, &x.CreatedByUserID, &c, &u)
	if errors.Is(e, sql.ErrNoRows) {
		return Session{}, ErrNotFound
	}
	if e != nil {
		return Session{}, e
	}
	x.Origin = json.RawMessage(origin)
	x.CreatedAt = c.Time
	x.UpdatedAt = u.Time
	return x, nil
}
func (s *Store) ListSessions(ctx context.Context, tenant, agent string, kinds []string, limit, offset int) ([]Session, error) {
	if limit < 1 || limit > 200 {
		limit = 50
	}
	q := `SELECT id,agent_id,title,status,kind,project,origin_json,model,model_route_id,reasoning,draft_text,last_seq,active_run_id,created_by_user_id,created_at,updated_at FROM cloud_agent_sessions WHERE tenant_id=? AND agent_id=?`
	args := []any{tenant, agent}
	if len(kinds) > 0 {
		q += ` AND kind IN (` + strings.TrimSuffix(strings.Repeat("?,", len(kinds)), ",") + ")"
		for _, k := range kinds {
			args = append(args, k)
		}
	}
	q += ` ORDER BY updated_at DESC,id DESC LIMIT ? OFFSET ?`
	args = append(args, limit, offset)
	rows, e := s.deps.DB.QueryContext(ctx, s.q(q), args...)
	if e != nil {
		return nil, e
	}
	defer rows.Close()
	out := make([]Session, 0)
	for rows.Next() {
		var x Session
		var o string
		var c, u flexibleTime
		if e := rows.Scan(&x.ID, &x.AgentID, &x.Title, &x.Status, &x.Kind, &x.Project, &o, &x.Model, &x.ModelRouteID, &x.Reasoning, &x.DraftText, &x.LastSeq, &x.ActiveRunID, &x.CreatedByUserID, &c, &u); e != nil {
			return nil, e
		}
		x.Origin = json.RawMessage(o)
		x.CreatedAt = c.Time
		x.UpdatedAt = u.Time
		out = append(out, x)
	}
	return out, rows.Err()
}
func (s *Store) SearchSessions(ctx context.Context, tenant, q string, limit int) ([]Session, error) {
	if limit < 1 || limit > 100 {
		limit = 30
	}
	rows, e := s.deps.DB.QueryContext(ctx, s.q(`SELECT DISTINCT s.id,s.agent_id,s.title,s.status,s.kind,s.project,s.origin_json,s.model,s.model_route_id,s.reasoning,s.draft_text,s.last_seq,s.active_run_id,s.created_by_user_id,s.created_at,s.updated_at FROM cloud_agent_sessions s LEFT JOIN cloud_agent_events e ON e.session_id=s.id WHERE s.tenant_id=? AND (LOWER(s.title) LIKE LOWER(?) OR LOWER(e.payload_json) LIKE LOWER(?)) ORDER BY s.updated_at DESC LIMIT ?`), tenant, "%"+q+"%", "%"+q+"%", limit)
	if e != nil {
		return nil, e
	}
	defer rows.Close()
	out := make([]Session, 0)
	for rows.Next() {
		var x Session
		var o string
		var c, u flexibleTime
		if e := rows.Scan(&x.ID, &x.AgentID, &x.Title, &x.Status, &x.Kind, &x.Project, &o, &x.Model, &x.ModelRouteID, &x.Reasoning, &x.DraftText, &x.LastSeq, &x.ActiveRunID, &x.CreatedByUserID, &c, &u); e != nil {
			return nil, e
		}
		x.Origin = json.RawMessage(o)
		x.CreatedAt = c.Time
		x.UpdatedAt = u.Time
		out = append(out, x)
	}
	return out, rows.Err()
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
	args = append(args, s.now(), tenant, agent, id)
	r, e := s.deps.DB.ExecContext(ctx, s.q(`UPDATE cloud_agent_sessions SET `+strings.Join(sets, ",")+` WHERE tenant_id=? AND agent_id=? AND id=?`), args...)
	if e != nil {
		return Session{}, e
	}
	n, _ := r.RowsAffected()
	if n == 0 {
		return Session{}, ErrNotFound
	}
	return s.GetSession(ctx, tenant, agent, id)
}
func (s *Store) DeleteSession(ctx context.Context, tenant, agent, id string) error {
	r, e := s.deps.DB.ExecContext(ctx, s.q(`DELETE FROM cloud_agent_sessions WHERE tenant_id=? AND agent_id=? AND id=?`), tenant, agent, id)
	if e != nil {
		return e
	}
	n, _ := r.RowsAffected()
	if n == 0 {
		return ErrNotFound
	}
	return nil
}

func (s *Store) appendEventTx(ctx context.Context, tx *sql.Tx, sessionID, typ string, runID *string, payload any) (Event, error) {
	raw, e := json.Marshal(payload)
	if e != nil {
		return Event{}, e
	}
	var seq int64
	e = tx.QueryRowContext(ctx, s.q(`UPDATE cloud_agent_sessions SET last_seq=last_seq+1,updated_at=? WHERE id=? RETURNING last_seq`), s.now(), sessionID).Scan(&seq)
	if errors.Is(e, sql.ErrNoRows) {
		return Event{}, ErrNotFound
	}
	if e != nil {
		return Event{}, e
	}
	ev := Event{ID: s.id(), SessionID: sessionID, Seq: seq, Type: typ, RunID: runID, Payload: raw, CreatedAt: s.now()}
	_, e = tx.ExecContext(ctx, s.q(`INSERT INTO cloud_agent_events(id,session_id,seq,type,run_id,payload_json,created_at) VALUES(?,?,?,?,?,?,?)`), ev.ID, sessionID, seq, typ, runID, string(raw), ev.CreatedAt)
	return ev, e
}
func (s *Store) AppendEvent(ctx context.Context, tenant, agent, session, typ string, runID *string, payload any) (Event, error) {
	if _, e := s.GetSession(ctx, tenant, agent, session); e != nil {
		return Event{}, e
	}
	var out Event
	e := appdeps.InTx(ctx, s.deps.DB, func(tx *sql.Tx) error {
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
	rows, e := s.deps.DB.QueryContext(ctx, s.q(`SELECT id,session_id,seq,type,run_id,payload_json,created_at FROM cloud_agent_events WHERE session_id=? AND seq>? ORDER BY seq LIMIT ?`), session, after, limit)
	if e != nil {
		return nil, e
	}
	defer rows.Close()
	out := make([]Event, 0)
	for rows.Next() {
		var x Event
		var raw string
		var c flexibleTime
		if e := rows.Scan(&x.ID, &x.SessionID, &x.Seq, &x.Type, &x.RunID, &raw, &c); e != nil {
			return nil, e
		}
		x.Payload = json.RawMessage(raw)
		x.CreatedAt = c.Time
		out = append(out, x)
	}
	return out, rows.Err()
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
	e := appdeps.InTx(ctx, s.deps.DB, func(tx *sql.Tx) error {
		r, e := tx.ExecContext(ctx, s.q(`UPDATE cloud_agent_sessions SET active_run_id=?,updated_at=? WHERE tenant_id=? AND agent_id=? AND id=? AND active_run_id IS NULL`), run.ID, now, tenant, agent, session)
		if e != nil {
			return e
		}
		n, _ := r.RowsAffected()
		if n == 0 {
			return ErrConflict
		}
		if _, e = tx.ExecContext(ctx, s.q(`INSERT INTO cloud_agent_runs(id,session_id,status,cancel_requested,error,started_at,completed_at,created_at) VALUES(?,?,?,false,NULL,?,NULL,?)`), run.ID, session, run.Status, now, now); e != nil {
			return e
		}
		_, e = s.appendEventTx(ctx, tx, session, "user_message", &run.ID, map[string]any{"content": content, "attachments": json.RawMessage(validJSON(attachments, "[]")), "options": json.RawMessage(validJSON(options, "{}"))})
		if e != nil {
			return e
		}
		_, e = s.appendEventTx(ctx, tx, session, "run_start", &run.ID, map[string]any{"runId": run.ID, "status": "running"})
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
	var x Run
	var st, ct sql.NullString
	var c flexibleTime
	e := s.deps.DB.QueryRowContext(ctx, s.q(`SELECT id,session_id,status,cancel_requested,error,started_at,completed_at,created_at FROM cloud_agent_runs WHERE session_id=? AND id=?`), session, runID).Scan(&x.ID, &x.SessionID, &x.Status, &x.CancelRequested, &x.Error, &st, &ct, &c)
	if errors.Is(e, sql.ErrNoRows) {
		return Run{}, ErrNotFound
	}
	if e != nil {
		return Run{}, e
	}
	if st.Valid {
		t := parseTime(st.String)
		x.StartedAt = &t
	}
	if ct.Valid {
		t := parseTime(ct.String)
		x.CompletedAt = &t
	}
	x.CreatedAt = c.Time
	return x, nil
}
func (s *Store) FinishRun(ctx context.Context, tenant, agent, session, runID, status string, errText *string, payload any) error {
	if status != "completed" && status != "failed" && status != "cancelled" {
		return errors.New("invalid terminal status")
	}
	if _, e := s.GetSession(ctx, tenant, agent, session); e != nil {
		return e
	}
	e := appdeps.InTx(ctx, s.deps.DB, func(tx *sql.Tx) error {
		now := s.now()
		r, e := tx.ExecContext(ctx, s.q(`UPDATE cloud_agent_runs SET status=?,error=?,completed_at=? WHERE id=? AND session_id=? AND status IN ('running','queued')`), status, errText, now, runID, session)
		if e != nil {
			return e
		}
		n, _ := r.RowsAffected()
		if n == 0 {
			return ErrConflict
		}
		_, e = tx.ExecContext(ctx, s.q(`UPDATE cloud_agent_sessions SET active_run_id=NULL,updated_at=? WHERE id=? AND active_run_id=?`), now, session, runID)
		if e != nil {
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
		_, e = s.appendEventTx(ctx, tx, session, typ, &runID, terminalPayload)
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
	e = appdeps.InTx(ctx, s.deps.DB, func(tx *sql.Tx) error {
		r, e := tx.ExecContext(ctx, s.q(`UPDATE cloud_agent_runs SET cancel_requested=true,status='cancelled',completed_at=? WHERE id=? AND session_id=? AND status IN ('queued','running')`), now, rid, session)
		if e != nil {
			return e
		}
		n, _ := r.RowsAffected()
		if n == 0 {
			return ErrConflict
		}
		r, e = tx.ExecContext(ctx, s.q(`UPDATE cloud_agent_sessions SET active_run_id=NULL,updated_at=? WHERE id=? AND active_run_id=?`), now, session, rid)
		if e != nil {
			return e
		}
		n, _ = r.RowsAffected()
		if n == 0 {
			return ErrConflict
		}
		_, e = s.appendEventTx(ctx, tx, session, "run_end", &rid, map[string]any{"runId": rid, "status": "cancelled"})
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
	type recovered struct{ tenant, agent, session, run string }
	items := []recovered{}
	rows, queryErr := s.deps.DB.QueryContext(ctx, `SELECT cs.tenant_id,cs.agent_id,cs.id,r.id FROM cloud_agent_runs r JOIN cloud_agent_sessions cs ON cs.id=r.session_id WHERE r.status='running'`)
	if queryErr == nil {
		for rows.Next() {
			var item recovered
			if rows.Scan(&item.tenant, &item.agent, &item.session, &item.run) == nil {
				items = append(items, item)
			}
		}
		rows.Close()
	}
	now := s.now()
	r, e := s.deps.DB.ExecContext(ctx, s.q(`UPDATE cloud_agent_runs SET status='failed',error='server restarted',completed_at=? WHERE status='running'`), now)
	if e != nil {
		return 0, e
	}
	_, _ = s.deps.DB.ExecContext(ctx, s.q(`UPDATE cloud_agent_sessions SET active_run_id=NULL,updated_at=? WHERE active_run_id IS NOT NULL AND NOT EXISTS (SELECT 1 FROM cloud_agent_runs r WHERE r.id=cloud_agent_sessions.active_run_id AND r.status='running')`), now)
	for _, item := range items {
		s.recordRunTerminal(context.WithoutCancel(ctx), item.tenant, item.agent, item.session, item.run, "failed")
	}
	return r.RowsAffected()
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
	query := `SELECT id,agent_id,provider_id,layer,content,tags_json,pinned,importance,source,metadata_json,created_at,updated_at FROM memories WHERE tenant_id=? AND agent_id=?`
	args := []any{tenant, agent}
	if q != "" {
		query += ` AND LOWER(content) LIKE LOWER(?)`
		args = append(args, "%"+q+"%")
	}
	if layer != "" {
		query += ` AND layer=?`
		args = append(args, layer)
	}
	query += ` ORDER BY pinned DESC,updated_at DESC LIMIT ?`
	args = append(args, limit)
	rows, e := s.deps.DB.QueryContext(ctx, s.q(query), args...)
	if e != nil {
		return nil, e
	}
	defer rows.Close()
	out := make([]Memory, 0)
	for rows.Next() {
		var x Memory
		var tags, meta string
		var pinned int
		var c, u flexibleTime
		if e := rows.Scan(&x.ID, &x.AgentID, &x.ProviderID, &x.Layer, &x.Content, &tags, &pinned, &x.Importance, &x.Source, &meta, &c, &u); e != nil {
			return nil, e
		}
		x.Pinned = pinned != 0
		x.Tags = json.RawMessage(tags)
		x.Metadata = json.RawMessage(meta)
		x.CreatedAt = c.Time
		x.UpdatedAt = u.Time
		out = append(out, x)
	}
	return out, rows.Err()
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
	_, e := s.deps.DB.ExecContext(ctx, s.q(`INSERT INTO memories(id,tenant_id,agent_id,provider_id,layer,content,tags_json,pinned,importance,source,metadata_json,created_at,updated_at) VALUES(?,?,?,?,?,?,?,?,?,?,?,?,?)`), in.ID, tenant, agent, in.ProviderID, in.Layer, in.Content, validJSON(in.Tags, "[]"), pinned, in.Importance, in.Source, validJSON(in.Metadata, "{}"), now, now)
	return in, e
}
func (s *Store) DeleteMemory(ctx context.Context, tenant, agent, id string) error {
	r, e := s.deps.DB.ExecContext(ctx, s.q(`DELETE FROM memories WHERE tenant_id=? AND agent_id=? AND id=?`), tenant, agent, id)
	if e != nil {
		return e
	}
	n, _ := r.RowsAffected()
	if n == 0 {
		return ErrNotFound
	}
	return nil
}
func (s *Store) ClearMemories(ctx context.Context, tenant, agent string) (int64, error) {
	r, e := s.deps.DB.ExecContext(ctx, s.q(`DELETE FROM memories WHERE tenant_id=? AND agent_id=?`), tenant, agent)
	if e != nil {
		return 0, e
	}
	return r.RowsAffected()
}

func (s *Store) ListUpstreams(ctx context.Context, tenant string) ([]Upstream, error) {
	rows, e := s.deps.DB.QueryContext(ctx, s.q(`SELECT id,name,slug,protocol,config_json,status,last_error,created_at,updated_at FROM model_upstreams WHERE tenant_id=? ORDER BY created_at,id`), tenant)
	if e != nil {
		return nil, e
	}
	defer rows.Close()
	out := make([]Upstream, 0)
	for rows.Next() {
		var x Upstream
		var config string
		var c, u flexibleTime
		if e := rows.Scan(&x.ID, &x.Name, &x.Slug, &x.Protocol, &config, &x.Status, &x.LastError, &c, &u); e != nil {
			return nil, e
		}
		x.Config = json.RawMessage(config)
		x.CreatedAt = c.Time
		x.UpdatedAt = u.Time
		out = append(out, x)
	}
	return out, rows.Err()
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
	_, e := s.deps.DB.ExecContext(ctx, s.q(`INSERT INTO model_upstreams(id,tenant_id,name,slug,protocol,config_json,status,last_error,created_at,updated_at) VALUES(?,?,?,?,?,?,?,?,?,?)`), in.ID, tenant, in.Name, in.Slug, in.Protocol, validJSON(in.Config, "{}"), in.Status, in.LastError, now, now)
	return in, e
}
func (s *Store) GetUpstream(ctx context.Context, tenant, id string) (Upstream, error) {
	var x Upstream
	var config string
	var c, u flexibleTime
	e := s.deps.DB.QueryRowContext(ctx, s.q(`SELECT id,name,slug,protocol,config_json,status,last_error,created_at,updated_at FROM model_upstreams WHERE tenant_id=? AND id=?`), tenant, id).Scan(&x.ID, &x.Name, &x.Slug, &x.Protocol, &config, &x.Status, &x.LastError, &c, &u)
	if errors.Is(e, sql.ErrNoRows) {
		return Upstream{}, ErrNotFound
	}
	if e != nil {
		return Upstream{}, e
	}
	x.Config = json.RawMessage(config)
	x.CreatedAt = c.Time
	x.UpdatedAt = u.Time
	return x, nil
}
func (s *Store) DeleteUpstream(ctx context.Context, tenant, id string) error {
	r, e := s.deps.DB.ExecContext(ctx, s.q(`DELETE FROM model_upstreams WHERE tenant_id=? AND id=?`), tenant, id)
	if e != nil {
		return e
	}
	n, _ := r.RowsAffected()
	if n == 0 {
		return ErrNotFound
	}
	return nil
}
func (s *Store) ListRoutes(ctx context.Context, tenant, capability string) ([]ModelRoute, error) {
	q := `SELECT id,name,slug,capability,alias,upstream_id,model,options_json,priority,weight,is_default,status,last_error,created_at,updated_at FROM model_routes WHERE tenant_id=?`
	args := []any{tenant}
	if capability != "" {
		q += ` AND capability=?`
		args = append(args, capability)
	}
	q += ` ORDER BY is_default DESC,CAST(priority AS INTEGER),id`
	rows, e := s.deps.DB.QueryContext(ctx, s.q(q), args...)
	if e != nil {
		return nil, e
	}
	defer rows.Close()
	out := make([]ModelRoute, 0)
	for rows.Next() {
		var x ModelRoute
		var opts, pri, wei string
		var c, u flexibleTime
		if e := rows.Scan(&x.ID, &x.Name, &x.Slug, &x.Capability, &x.Alias, &x.UpstreamID, &x.Model, &opts, &pri, &wei, &x.IsDefault, &x.Status, &x.LastError, &c, &u); e != nil {
			return nil, e
		}
		x.Options = json.RawMessage(opts)
		x.Priority, _ = strconv.Atoi(pri)
		x.Weight, _ = strconv.Atoi(wei)
		x.CreatedAt = c.Time
		x.UpdatedAt = u.Time
		out = append(out, x)
	}
	return out, rows.Err()
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
	_, e := s.deps.DB.ExecContext(ctx, s.q(`INSERT INTO model_routes(id,tenant_id,name,slug,capability,alias,upstream_id,model,options_json,priority,weight,is_default,status,last_error,created_at,updated_at) VALUES(?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)`), in.ID, tenant, in.Name, in.Slug, in.Capability, in.Alias, in.UpstreamID, in.Model, validJSON(in.Options, "{}"), strconv.Itoa(in.Priority), strconv.Itoa(in.Weight), in.IsDefault, in.Status, in.LastError, now, now)
	return in, e
}
func (s *Store) DeleteRoute(ctx context.Context, tenant, id string) error {
	r, e := s.deps.DB.ExecContext(ctx, s.q(`DELETE FROM model_routes WHERE tenant_id=? AND id=?`), tenant, id)
	if e != nil {
		return e
	}
	n, _ := r.RowsAffected()
	if n == 0 {
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
