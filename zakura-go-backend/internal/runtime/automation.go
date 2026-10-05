// SPDX-License-Identifier: AGPL-3.0-or-later
package runtime

import (
	"context"
	"crypto/rand"
	"crypto/subtle"
	"database/sql"
	"encoding/base64"
	"encoding/json"
	"errors"
	"fmt"
	"net/http"
	"strconv"
	"strings"
	"time"

	"github.com/go-chi/chi/v5"
	"github.com/momo-mnsjtxy/Zakura/zakura-go-backend/internal/platform/httpx"
)

type Schedule struct {
	ID          string          `json:"id"`
	AgentID     string          `json:"agentId"`
	Name        string          `json:"name"`
	Description string          `json:"description"`
	Pattern     string          `json:"pattern"`
	TriggerKind string          `json:"triggerKind"`
	Listener    json.RawMessage `json:"listener"`
	Prompt      string          `json:"prompt"`
	Project     *string         `json:"project"`
	Enabled     bool            `json:"enabled"`
	MaxRuns     *int            `json:"maxRuns"`
	RunCount    int             `json:"runCount"`
	Timezone    string          `json:"timezone"`
	NextRunAt   *time.Time      `json:"nextRunAt"`
	LastRunAt   *time.Time      `json:"lastRunAt"`
	LastStatus  *string         `json:"lastStatus"`
	LastError   *string         `json:"lastError"`
	CreatedAt   time.Time       `json:"createdAt"`
	UpdatedAt   time.Time       `json:"updatedAt"`
}
type AutomationRun struct {
	ID          string     `json:"id"`
	AgentID     string     `json:"agentId"`
	Kind        string     `json:"kind"`
	ScheduleID  *string    `json:"scheduleId"`
	SessionID   *string    `json:"sessionId"`
	CloudRunID  *string    `json:"cloudRunId"`
	Status      string     `json:"status"`
	Prompt      string     `json:"prompt"`
	ResultText  *string    `json:"resultText"`
	Error       *string    `json:"error"`
	StartedAt   *time.Time `json:"startedAt"`
	CompletedAt *time.Time `json:"completedAt"`
	CreatedAt   time.Time  `json:"createdAt"`
}

func (h *handler) registerAutomation(r chi.Router) {
	r.Get("/agents/{id}/routines", h.listSchedules)
	r.Post("/agents/{id}/routines", h.createSchedule)
	r.Get("/agents/{id}/routines/{sid}", h.getScheduleHTTP)
	r.Patch("/agents/{id}/routines/{sid}", h.patchSchedule)
	r.Delete("/agents/{id}/routines/{sid}", h.deleteSchedule)
	r.Post("/agents/{id}/routines/{sid}/run", h.runSchedule)
	r.Get("/agents/{id}/routines/{sid}/runs", h.listAutomationRuns)
	r.Get("/agents/{id}/automation/runs", h.listAutomationRuns)
	r.Get("/agents/{id}/automation/runs/{rid}", h.getAutomationRun)
	r.Post("/agents/{id}/automation/runs/{rid}/cancel", h.cancelAutomationRun)
	r.Get("/agents/{id}/heartbeat", h.getHeartbeat)
	r.Patch("/agents/{id}/heartbeat", h.patchHeartbeat)
	r.Post("/agents/{id}/heartbeat/run", h.runHeartbeat)
	r.Get("/agents/{id}/routines/{sid}/webhook-secret", h.getWebhookSecret)
}

func scanSchedule(row interface{ Scan(...any) error }) (Schedule, string, error) {
	var x Schedule
	var listener, secret string
	var next, last sql.NullString
	var c, u flexibleTime
	e := row.Scan(&x.ID, &x.AgentID, &x.Name, &x.Description, &x.Pattern, &x.TriggerKind, &listener, &secret, &x.Prompt, &x.Project, &x.Enabled, &x.MaxRuns, &x.RunCount, &x.Timezone, &next, &last, &x.LastStatus, &x.LastError, &c, &u)
	if e != nil {
		return Schedule{}, "", e
	}
	x.Listener = json.RawMessage(listener)
	x.CreatedAt = c.Time
	x.UpdatedAt = u.Time
	if next.Valid {
		t := parseTime(next.String)
		x.NextRunAt = &t
	}
	if last.Valid {
		t := parseTime(last.String)
		x.LastRunAt = &t
	}
	return x, secret, nil
}
func parseTime(v string) time.Time {
	for _, l := range []string{time.RFC3339Nano, time.RFC3339, "2006-01-02 15:04:05"} {
		if t, e := time.Parse(l, v); e == nil {
			return t.UTC()
		}
	}
	return time.Time{}
}
func (h *handler) getSchedule(ctx context.Context, tenant, agent, id string) (Schedule, string, error) {
	x, sec, e := scanSchedule(h.deps.DB.QueryRowContext(ctx, h.store.q(`SELECT id,agent_id,name,COALESCE(description,''),COALESCE(pattern,''),trigger_kind,listener_json,COALESCE(webhook_secret,''),prompt,project,enabled,max_runs,run_count,timezone,next_run_at,last_run_at,last_status,last_error,created_at,updated_at FROM agent_schedules WHERE tenant_id=? AND agent_id=? AND id=?`), tenant, agent, id))
	if errors.Is(e, sql.ErrNoRows) {
		return Schedule{}, "", ErrNotFound
	}
	return x, sec, e
}
func (h *handler) listScheduleRows(ctx context.Context, tenant, agent string) ([]Schedule, error) {
	rows, e := h.deps.DB.QueryContext(ctx, h.store.q(`SELECT id,agent_id,name,COALESCE(description,''),COALESCE(pattern,''),trigger_kind,listener_json,COALESCE(webhook_secret,''),prompt,project,enabled,max_runs,run_count,timezone,next_run_at,last_run_at,last_status,last_error,created_at,updated_at FROM agent_schedules WHERE tenant_id=? AND agent_id=? ORDER BY created_at,id`), tenant, agent)
	if e != nil {
		return nil, e
	}
	defer rows.Close()
	out := make([]Schedule, 0)
	for rows.Next() {
		x, _, e := scanSchedule(rows)
		if e != nil {
			return nil, e
		}
		out = append(out, x)
	}
	return out, rows.Err()
}
func randomSecret() string {
	b := make([]byte, 32)
	_, _ = rand.Read(b)
	return base64.RawURLEncoding.EncodeToString(b)
}
func (h *handler) createSchedule(w http.ResponseWriter, r *http.Request) {
	p := principal(r)
	agent := chi.URLParam(r, "id")
	if _, e := h.store.GetAgent(r.Context(), p.TenantID, agent); e != nil {
		statusErr(w, e)
		return
	}
	var b struct {
		Name        string          `json:"name"`
		Description string          `json:"description"`
		TriggerKind string          `json:"triggerKind"`
		Pattern     string          `json:"pattern"`
		Listener    json.RawMessage `json:"listener"`
		Prompt      string          `json:"prompt"`
		Project     *string         `json:"project"`
		Enabled     *bool           `json:"enabled"`
		MaxRuns     *int            `json:"maxRuns"`
		Timezone    string          `json:"timezone"`
	}
	if httpx.DecodeJSON(r, &b) != nil {
		httpx.Error(w, 400, "invalid JSON")
		return
	}
	if strings.TrimSpace(b.Name) == "" || strings.TrimSpace(b.Prompt) == "" {
		httpx.Error(w, 400, "name and prompt required")
		return
	}
	if b.TriggerKind == "" {
		b.TriggerKind = "cron"
	}
	if b.TriggerKind != "cron" && b.TriggerKind != "listener" {
		httpx.Error(w, 400, "invalid triggerKind")
		return
	}
	if b.Timezone == "" {
		b.Timezone = "UTC"
	}
	loc, e := time.LoadLocation(b.Timezone)
	if e != nil {
		httpx.Error(w, 400, "invalid timezone")
		return
	}
	var next *time.Time
	if b.TriggerKind == "cron" {
		n, e := nextCron(b.Pattern, h.store.now().In(loc))
		if e != nil {
			httpx.Error(w, 400, e.Error())
			return
		}
		nn := n.UTC()
		next = &nn
	}
	enabled := true
	if b.Enabled != nil {
		enabled = *b.Enabled
	}
	now := h.store.now()
	id := h.store.id()
	_, e = h.deps.DB.ExecContext(r.Context(), h.store.q(`INSERT INTO agent_schedules(id,tenant_id,agent_id,name,description,pattern,trigger_kind,listener_json,webhook_secret,prompt,project,enabled,max_runs,run_count,timezone,next_run_at,last_run_at,last_status,last_error,created_at,updated_at) VALUES(?,?,?,?,?,?,?,?,?,?,?,?,?,0,?,?,NULL,NULL,NULL,?,?)`), id, p.TenantID, agent, b.Name, b.Description, b.Pattern, b.TriggerKind, validJSON(b.Listener, "{}"), randomSecret(), b.Prompt, b.Project, enabled, b.MaxRuns, b.Timezone, next, now, now)
	if e != nil {
		statusErr(w, e)
		return
	}
	x, _, _ := h.getSchedule(r.Context(), p.TenantID, agent, id)
	httpx.JSON(w, 201, map[string]any{"schedule": x})
}
func (h *handler) listSchedules(w http.ResponseWriter, r *http.Request) {
	p := principal(r)
	x, e := h.listScheduleRows(r.Context(), p.TenantID, chi.URLParam(r, "id"))
	if e != nil {
		statusErr(w, e)
		return
	}
	httpx.JSON(w, 200, map[string]any{"schedules": x})
}
func (h *handler) getScheduleHTTP(w http.ResponseWriter, r *http.Request) {
	p := principal(r)
	x, _, e := h.getSchedule(r.Context(), p.TenantID, chi.URLParam(r, "id"), chi.URLParam(r, "sid"))
	if e != nil {
		statusErr(w, e)
		return
	}
	httpx.JSON(w, 200, map[string]any{"schedule": x})
}
func (h *handler) patchSchedule(w http.ResponseWriter, r *http.Request) {
	p := principal(r)
	agent, id := chi.URLParam(r, "id"), chi.URLParam(r, "sid")
	cur, _, e := h.getSchedule(r.Context(), p.TenantID, agent, id)
	if e != nil {
		statusErr(w, e)
		return
	}
	m, e := decodeMap(r)
	if e != nil {
		httpx.Error(w, 400, "invalid JSON")
		return
	}
	if v, ok := m["name"].(string); ok {
		cur.Name = v
	}
	if v, ok := m["description"].(string); ok {
		cur.Description = v
	}
	if v, ok := m["pattern"].(string); ok {
		cur.Pattern = v
	}
	if v, ok := m["prompt"].(string); ok {
		cur.Prompt = v
	}
	if v, ok := m["timezone"].(string); ok {
		cur.Timezone = v
	}
	if v, ok := m["enabled"].(bool); ok {
		cur.Enabled = v
	}
	loc, e := time.LoadLocation(cur.Timezone)
	if e != nil {
		httpx.Error(w, 400, "invalid timezone")
		return
	}
	var next *time.Time
	if cur.TriggerKind == "cron" {
		n, e := nextCron(cur.Pattern, h.store.now().In(loc))
		if e != nil {
			httpx.Error(w, 400, e.Error())
			return
		}
		n = n.UTC()
		next = &n
	}
	_, e = h.deps.DB.ExecContext(r.Context(), h.store.q(`UPDATE agent_schedules SET name=?,description=?,pattern=?,prompt=?,timezone=?,enabled=?,next_run_at=?,updated_at=? WHERE tenant_id=? AND agent_id=? AND id=?`), cur.Name, cur.Description, cur.Pattern, cur.Prompt, cur.Timezone, cur.Enabled, next, h.store.now(), p.TenantID, agent, id)
	if e != nil {
		statusErr(w, e)
		return
	}
	x, _, _ := h.getSchedule(r.Context(), p.TenantID, agent, id)
	httpx.JSON(w, 200, map[string]any{"schedule": x})
}
func (h *handler) deleteSchedule(w http.ResponseWriter, r *http.Request) {
	p := principal(r)
	res, e := h.deps.DB.ExecContext(r.Context(), h.store.q(`DELETE FROM agent_schedules WHERE tenant_id=? AND agent_id=? AND id=?`), p.TenantID, chi.URLParam(r, "id"), chi.URLParam(r, "sid"))
	if e != nil {
		statusErr(w, e)
		return
	}
	n, _ := res.RowsAffected()
	if n == 0 {
		statusErr(w, ErrNotFound)
		return
	}
	httpx.JSON(w, 200, map[string]any{"ok": true})
}

func (h *handler) admitAutomation(ctx context.Context, tenant, agent, kind string, scheduleID *string, prompt string) (AutomationRun, error) {
	now := h.store.now()
	ar := AutomationRun{ID: h.store.id(), AgentID: agent, Kind: kind, ScheduleID: scheduleID, Status: "running", Prompt: prompt, StartedAt: &now, CreatedAt: now}
	sess, e := h.store.CreateSession(ctx, tenant, "", agent, Session{Title: "Automation: " + kind, Kind: "system", Status: "active"})
	if e != nil {
		return AutomationRun{}, e
	}
	ar.SessionID = &sess.ID
	run, _, e := h.service.StartTurn(ctx, tenant, agent, sess.ID, prompt, nil, nil, false)
	if e != nil {
		return AutomationRun{}, e
	}
	ar.CloudRunID = &run.ID
	_, e = h.deps.DB.ExecContext(ctx, h.store.q(`INSERT INTO agent_automation_runs(id,tenant_id,agent_id,kind,schedule_id,session_id,cloud_run_id,status,prompt,result_text,error,started_at,completed_at,created_at) VALUES(?,?,?,?,?,?,?,'running',?,NULL,NULL,?,NULL,?)`), ar.ID, tenant, agent, kind, scheduleID, sess.ID, run.ID, prompt, now, now)
	return ar, e
}
func (h *handler) runSchedule(w http.ResponseWriter, r *http.Request) {
	p := principal(r)
	agent, id := chi.URLParam(r, "id"), chi.URLParam(r, "sid")
	sch, _, e := h.getSchedule(r.Context(), p.TenantID, agent, id)
	if e != nil {
		statusErr(w, e)
		return
	}
	run, e := h.admitAutomation(r.Context(), p.TenantID, agent, "schedule", &id, sch.Prompt)
	if e != nil {
		statusErr(w, e)
		return
	}
	_, _ = h.deps.DB.ExecContext(r.Context(), h.store.q(`UPDATE agent_schedules SET run_count=run_count+1,last_run_at=?,last_status='running',updated_at=? WHERE id=?`), h.store.now(), h.store.now(), id)
	httpx.JSON(w, 202, map[string]any{"run": run})
}
func scanAutoRun(row interface{ Scan(...any) error }) (AutomationRun, error) {
	var x AutomationRun
	var st, ct sql.NullString
	var c flexibleTime
	e := row.Scan(&x.ID, &x.AgentID, &x.Kind, &x.ScheduleID, &x.SessionID, &x.CloudRunID, &x.Status, &x.Prompt, &x.ResultText, &x.Error, &st, &ct, &c)
	if e != nil {
		return x, e
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
func (h *handler) listAutomationRuns(w http.ResponseWriter, r *http.Request) {
	p := principal(r)
	q := `SELECT id,agent_id,kind,schedule_id,session_id,cloud_run_id,status,COALESCE(prompt,''),result_text,error,started_at,completed_at,created_at FROM agent_automation_runs WHERE tenant_id=? AND agent_id=?`
	args := []any{p.TenantID, chi.URLParam(r, "id")}
	if sid := chi.URLParam(r, "sid"); sid != "" {
		q += ` AND schedule_id=?`
		args = append(args, sid)
	}
	q += ` ORDER BY created_at DESC LIMIT 100`
	rows, e := h.deps.DB.QueryContext(r.Context(), h.store.q(q), args...)
	if e != nil {
		statusErr(w, e)
		return
	}
	defer rows.Close()
	out := make([]AutomationRun, 0)
	for rows.Next() {
		x, e := scanAutoRun(rows)
		if e != nil {
			statusErr(w, e)
			return
		}
		out = append(out, x)
	}
	httpx.JSON(w, 200, map[string]any{"runs": out})
}
func (h *handler) getAutomationRun(w http.ResponseWriter, r *http.Request) {
	p := principal(r)
	x, e := scanAutoRun(h.deps.DB.QueryRowContext(r.Context(), h.store.q(`SELECT id,agent_id,kind,schedule_id,session_id,cloud_run_id,status,COALESCE(prompt,''),result_text,error,started_at,completed_at,created_at FROM agent_automation_runs WHERE tenant_id=? AND agent_id=? AND id=?`), p.TenantID, chi.URLParam(r, "id"), chi.URLParam(r, "rid")))
	if errors.Is(e, sql.ErrNoRows) {
		e = ErrNotFound
	}
	if e != nil {
		statusErr(w, e)
		return
	}
	httpx.JSON(w, 200, map[string]any{"run": x})
}
func (h *handler) cancelAutomationRun(w http.ResponseWriter, r *http.Request) {
	p := principal(r)
	agent, id := chi.URLParam(r, "id"), chi.URLParam(r, "rid")
	x, e := scanAutoRun(h.deps.DB.QueryRowContext(r.Context(), h.store.q(`SELECT id,agent_id,kind,schedule_id,session_id,cloud_run_id,status,COALESCE(prompt,''),result_text,error,started_at,completed_at,created_at FROM agent_automation_runs WHERE tenant_id=? AND agent_id=? AND id=?`), p.TenantID, agent, id))
	if e != nil {
		statusErr(w, ErrNotFound)
		return
	}
	if x.SessionID != nil {
		_, _ = h.service.Cancel(r.Context(), p.TenantID, agent, *x.SessionID)
	}
	now := h.store.now()
	_, e = h.deps.DB.ExecContext(r.Context(), h.store.q(`UPDATE agent_automation_runs SET status='cancelled',completed_at=? WHERE id=? AND tenant_id=?`), now, id, p.TenantID)
	if e != nil {
		statusErr(w, e)
		return
	}
	x.Status = "cancelled"
	x.CompletedAt = &now
	httpx.JSON(w, 200, map[string]any{"run": x})
}

func (h *handler) getHeartbeat(w http.ResponseWriter, r *http.Request) {
	p := principal(r)
	var enabled bool
	var interval int
	var prompt string
	var next, last sql.NullString
	var status, errText *string
	e := h.deps.DB.QueryRowContext(r.Context(), h.store.q(`SELECT enabled,interval_minutes,COALESCE(prompt,''),next_run_at,last_run_at,last_status,last_error FROM agent_heartbeats WHERE tenant_id=? AND agent_id=?`), p.TenantID, chi.URLParam(r, "id")).Scan(&enabled, &interval, &prompt, &next, &last, &status, &errText)
	if errors.Is(e, sql.ErrNoRows) {
		httpx.JSON(w, 200, map[string]any{"heartbeat": map[string]any{"enabled": false, "intervalMinutes": 60, "prompt": ""}})
		return
	}
	if e != nil {
		statusErr(w, e)
		return
	}
	httpx.JSON(w, 200, map[string]any{"heartbeat": map[string]any{"enabled": enabled, "intervalMinutes": interval, "prompt": prompt, "nextRunAt": next.String, "lastRunAt": last.String, "lastStatus": status, "lastError": errText}})
}
func (h *handler) patchHeartbeat(w http.ResponseWriter, r *http.Request) {
	p := principal(r)
	agent := chi.URLParam(r, "id")
	var b struct {
		Enabled         bool   `json:"enabled"`
		IntervalMinutes int    `json:"intervalMinutes"`
		Prompt          string `json:"prompt"`
	}
	if httpx.DecodeJSON(r, &b) != nil {
		httpx.Error(w, 400, "invalid JSON")
		return
	}
	if b.IntervalMinutes == 0 {
		b.IntervalMinutes = 60
	}
	if b.IntervalMinutes < 5 {
		httpx.Error(w, 400, "intervalMinutes must be at least 5")
		return
	}
	now := h.store.now()
	next := now.Add(time.Duration(b.IntervalMinutes) * time.Minute)
	_, e := h.deps.DB.ExecContext(r.Context(), h.store.q(`INSERT INTO agent_heartbeats(agent_id,tenant_id,enabled,interval_minutes,prompt,next_run_at,last_run_at,last_status,last_error,created_at,updated_at) VALUES(?,?,?,?,?,?,NULL,NULL,NULL,?,?) ON CONFLICT(agent_id) DO UPDATE SET enabled=?,interval_minutes=?,prompt=?,next_run_at=?,updated_at=?`), agent, p.TenantID, b.Enabled, b.IntervalMinutes, b.Prompt, next, now, now, b.Enabled, b.IntervalMinutes, b.Prompt, next, now)
	if e != nil {
		statusErr(w, e)
		return
	}
	h.getHeartbeat(w, r)
}
func (h *handler) runHeartbeat(w http.ResponseWriter, r *http.Request) {
	p := principal(r)
	agent := chi.URLParam(r, "id")
	var prompt string
	e := h.deps.DB.QueryRowContext(r.Context(), h.store.q(`SELECT COALESCE(prompt,'') FROM agent_heartbeats WHERE tenant_id=? AND agent_id=?`), p.TenantID, agent).Scan(&prompt)
	if errors.Is(e, sql.ErrNoRows) {
		prompt = "Review current priorities and report anything requiring attention."
	} else if e != nil {
		statusErr(w, e)
		return
	}
	if prompt == "" {
		prompt = "Review current priorities and report anything requiring attention."
	}
	run, e := h.admitAutomation(r.Context(), p.TenantID, agent, "heartbeat", nil, prompt)
	if e != nil {
		statusErr(w, e)
		return
	}
	httpx.JSON(w, 202, map[string]any{"run": run})
}
func (h *handler) getWebhookSecret(w http.ResponseWriter, r *http.Request) {
	p := principal(r)
	_, sec, e := h.getSchedule(r.Context(), p.TenantID, chi.URLParam(r, "id"), chi.URLParam(r, "sid"))
	if e != nil {
		statusErr(w, e)
		return
	}
	httpx.JSON(w, 200, map[string]any{"secret": sec})
}

func (h *handler) routineHook(w http.ResponseWriter, r *http.Request) {
	id := chi.URLParam(r, "id")
	var tenant, agent, prompt, secret string
	e := h.deps.DB.QueryRowContext(r.Context(), h.store.q(`SELECT tenant_id,agent_id,prompt,COALESCE(webhook_secret,'') FROM agent_schedules WHERE id=? AND enabled=true AND trigger_kind='listener'`), id).Scan(&tenant, &agent, &prompt, &secret)
	if errors.Is(e, sql.ErrNoRows) {
		httpx.Error(w, 404, "Not found")
		return
	}
	if e != nil {
		statusErr(w, e)
		return
	}
	provided := strings.TrimPrefix(r.Header.Get("Authorization"), "Bearer ")
	if provided == "" {
		provided = r.Header.Get("X-Zakura-Secret")
	}
	if len(provided) != len(secret) || subtle.ConstantTimeCompare([]byte(provided), []byte(secret)) != 1 {
		httpx.Error(w, 401, "unauthorized")
		return
	}
	var payload any
	if json.NewDecoder(http.MaxBytesReader(w, r.Body, 1<<20)).Decode(&payload) != nil {
		payload = map[string]any{}
	}
	b, _ := json.Marshal(payload)
	run, e := h.admitAutomation(r.Context(), tenant, agent, "listener", &id, prompt+"\n\nInbound event:\n"+string(b))
	if e != nil {
		statusErr(w, e)
		return
	}
	httpx.JSON(w, 202, map[string]any{"run": run})
}

func (h *handler) startScheduler(ctx context.Context) {
	go func() {
		ticker := time.NewTicker(30 * time.Second)
		defer ticker.Stop()
		for {
			select {
			case <-ctx.Done():
				return
			case <-ticker.C:
				h.claimDue(ctx)
			}
		}
	}()
}
func (h *handler) claimDue(ctx context.Context) {
	rows, e := h.deps.DB.QueryContext(ctx, h.store.q(`SELECT id,tenant_id,agent_id,prompt,pattern,timezone,next_run_at,run_count,max_runs FROM agent_schedules WHERE enabled=true AND trigger_kind='cron' AND next_run_at IS NOT NULL AND next_run_at<=? ORDER BY next_run_at LIMIT 25`), h.store.now())
	if e != nil {
		return
	}
	type due struct {
		id, tenant, agent, prompt, pattern, tz string
		next                                   string
		count                                  int
		max                                    *int
	}
	var all []due
	for rows.Next() {
		var x due
		if rows.Scan(&x.id, &x.tenant, &x.agent, &x.prompt, &x.pattern, &x.tz, &x.next, &x.count, &x.max) == nil {
			all = append(all, x)
		}
	}
	rows.Close()
	for _, x := range all {
		loc, e := time.LoadLocation(x.tz)
		if e != nil {
			continue
		}
		next, e := nextCron(x.pattern, h.store.now().In(loc))
		if e != nil {
			continue
		}
		enabled := x.max == nil || x.count+1 < *x.max
		res, e := h.deps.DB.ExecContext(ctx, h.store.q(`UPDATE agent_schedules SET next_run_at=?,run_count=run_count+1,last_run_at=?,last_status='running',enabled=?,updated_at=? WHERE id=? AND next_run_at=?`), next.UTC(), h.store.now(), enabled, h.store.now(), x.id, x.next)
		if e != nil {
			continue
		}
		n, _ := res.RowsAffected()
		if n == 1 {
			_, _ = h.admitAutomation(ctx, x.tenant, x.agent, "schedule", &x.id, x.prompt)
		}
	}
}

func nextCron(pattern string, after time.Time) (time.Time, error) {
	p := strings.TrimSpace(pattern)
	aliases := map[string]string{"@hourly": "0 * * * *", "@daily": "0 0 * * *", "@weekly": "0 0 * * 0", "@monthly": "0 0 1 * *"}
	if a, ok := aliases[p]; ok {
		p = a
	}
	if strings.HasPrefix(p, "@every ") {
		d, e := time.ParseDuration(strings.TrimSpace(strings.TrimPrefix(p, "@every ")))
		if e != nil || d < 5*time.Minute {
			return time.Time{}, errors.New("@every duration must be at least 5m")
		}
		return after.Add(d), nil
	}
	f := strings.Fields(p)
	if len(f) != 5 {
		return time.Time{}, errors.New("cron must contain five fields")
	}
	for i := 1; i <= 366*24*60; i++ {
		t := after.Truncate(time.Minute).Add(time.Duration(i) * time.Minute)
		if cronMatch(f[0], t.Minute(), 0, 59) && cronMatch(f[1], t.Hour(), 0, 23) && cronMatch(f[2], t.Day(), 1, 31) && cronMatch(f[3], int(t.Month()), 1, 12) && cronMatch(f[4], int(t.Weekday()), 0, 6) {
			return t, nil
		}
	}
	return time.Time{}, errors.New("cron has no occurrence within one year")
}
func cronMatch(expr string, v, min, max int) bool {
	for _, part := range strings.Split(expr, ",") {
		step := 1
		base := part
		if a := strings.Split(part, "/"); len(a) == 2 {
			base = a[0]
			step, _ = strconv.Atoi(a[1])
			if step < 1 {
				return false
			}
		}
		lo, hi := min, max
		if base != "*" {
			if a := strings.Split(base, "-"); len(a) == 2 {
				lo, _ = strconv.Atoi(a[0])
				hi, _ = strconv.Atoi(a[1])
			} else {
				lo, _ = strconv.Atoi(base)
				hi = lo
			}
		}
		if lo < min || hi > max || lo > hi {
			continue
		}
		if v >= lo && v <= hi && (v-lo)%step == 0 {
			return true
		}
	}
	return false
}

var _ = fmt.Sprintf
