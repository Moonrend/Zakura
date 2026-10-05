// SPDX-License-Identifier: AGPL-3.0-or-later
package runtime

import (
	"context"
	"crypto/rand"
	"crypto/subtle"
	"encoding/base64"
	"encoding/json"
	"errors"
	"net/http"
	"strconv"
	"strings"
	"time"

	"github.com/Moonrend/Zakura/go/server/internal/platform/db/models"
	"github.com/Moonrend/Zakura/go/server/internal/platform/httpx"
	"github.com/go-chi/chi/v5"
	"gorm.io/gorm"
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

func scheduleFromModel(m models.AgentSchedule) (Schedule, string) {
	x := Schedule{AgentID: m.AgentID, Name: m.Name, TriggerKind: m.TriggerKind, Listener: json.RawMessage(m.ListenerJSON), Prompt: m.Prompt, Project: m.Project, Enabled: m.Enabled, RunCount: int(m.RunCount), Timezone: m.Timezone, LastStatus: m.LastStatus, LastError: m.LastError}
	if m.ID != nil {
		x.ID = *m.ID
	}
	if m.Description != nil {
		x.Description = *m.Description
	}
	if m.Pattern != nil {
		x.Pattern = *m.Pattern
	}
	if m.MaxRuns != nil {
		v := int(*m.MaxRuns)
		x.MaxRuns = &v
	}
	if m.NextRunAt != nil {
		t := parseTime(*m.NextRunAt)
		x.NextRunAt = &t
	}
	if m.LastRunAt != nil {
		t := parseTime(*m.LastRunAt)
		x.LastRunAt = &t
	}
	var c, u flexibleTime
	_ = c.Scan(m.CreatedAt)
	_ = u.Scan(m.UpdatedAt)
	x.CreatedAt, x.UpdatedAt = c.Time, u.Time
	secret := ""
	if m.WebhookSecret != nil {
		secret = *m.WebhookSecret
	}
	return x, secret
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
	var m models.AgentSchedule
	e := h.deps.Gorm.WithContext(ctx).Where("tenant_id = ? AND agent_id = ? AND id = ?", tenant, agent, id).Take(&m).Error
	if errors.Is(e, gorm.ErrRecordNotFound) {
		return Schedule{}, "", ErrNotFound
	}
	if e != nil {
		return Schedule{}, "", e
	}
	x, sec := scheduleFromModel(m)
	return x, sec, nil
}
func (h *handler) listScheduleRows(ctx context.Context, tenant, agent string) ([]Schedule, error) {
	var ms []models.AgentSchedule
	if e := h.deps.Gorm.WithContext(ctx).Where("tenant_id = ? AND agent_id = ?", tenant, agent).Order("created_at, id").Find(&ms).Error; e != nil {
		return nil, e
	}
	out := make([]Schedule, 0, len(ms))
	for _, m := range ms {
		x, _ := scheduleFromModel(m)
		out = append(out, x)
	}
	return out, nil
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
	now := runtimeTimeString(h.store.now())
	id := h.store.id()
	var maxRuns *int32
	if b.MaxRuns != nil {
		v := int32(*b.MaxRuns)
		maxRuns = &v
	}
	var nextStr *string
	if next != nil {
		s := runtimeTimeString(*next)
		nextStr = &s
	}
	secret := randomSecret()
	m := models.AgentSchedule{ID: &id, TenantID: p.TenantID, AgentID: agent, Name: b.Name, Description: &b.Description, Pattern: &b.Pattern, TriggerKind: b.TriggerKind, ListenerJSON: validJSON(b.Listener, "{}"), WebhookSecret: &secret, Prompt: b.Prompt, Project: b.Project, Enabled: enabled, MaxRuns: maxRuns, Timezone: b.Timezone, NextRunAt: nextStr, CreatedAt: now, UpdatedAt: now}
	if e = h.deps.Gorm.WithContext(r.Context()).Create(&m).Error; e != nil {
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
	var nextVal any
	if next != nil {
		nextVal = runtimeTimeString(*next)
	}
	e = h.deps.Gorm.WithContext(r.Context()).Model(&models.AgentSchedule{}).Where("tenant_id = ? AND agent_id = ? AND id = ?", p.TenantID, agent, id).Updates(map[string]any{"name": cur.Name, "description": cur.Description, "pattern": cur.Pattern, "prompt": cur.Prompt, "timezone": cur.Timezone, "enabled": cur.Enabled, "next_run_at": nextVal, "updated_at": runtimeTimeString(h.store.now())}).Error
	if e != nil {
		statusErr(w, e)
		return
	}
	x, _, _ := h.getSchedule(r.Context(), p.TenantID, agent, id)
	httpx.JSON(w, 200, map[string]any{"schedule": x})
}
func (h *handler) deleteSchedule(w http.ResponseWriter, r *http.Request) {
	p := principal(r)
	res := h.deps.Gorm.WithContext(r.Context()).Where("tenant_id = ? AND agent_id = ? AND id = ?", p.TenantID, chi.URLParam(r, "id"), chi.URLParam(r, "sid")).Delete(&models.AgentSchedule{})
	if res.Error != nil {
		statusErr(w, res.Error)
		return
	}
	if res.RowsAffected == 0 {
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
	nowStr := runtimeTimeString(now)
	m := models.AgentAutomationRun{ID: &ar.ID, TenantID: tenant, AgentID: agent, Kind: kind, ScheduleID: scheduleID, SessionID: &sess.ID, CloudRunID: &run.ID, Status: "running", Prompt: &prompt, StartedAt: &nowStr, CreatedAt: nowStr}
	e = h.deps.Gorm.WithContext(ctx).Create(&m).Error
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
	nowStr := runtimeTimeString(h.store.now())
	h.deps.Gorm.WithContext(r.Context()).Model(&models.AgentSchedule{}).Where("id = ?", id).Updates(map[string]any{"run_count": gorm.Expr("run_count + 1"), "last_run_at": nowStr, "last_status": "running", "updated_at": nowStr})
	httpx.JSON(w, 202, map[string]any{"run": run})
}
func automationRunFromModel(m models.AgentAutomationRun) AutomationRun {
	x := AutomationRun{AgentID: m.AgentID, Kind: m.Kind, ScheduleID: m.ScheduleID, SessionID: m.SessionID, CloudRunID: m.CloudRunID, Status: m.Status, ResultText: m.ResultText, Error: m.Error}
	if m.ID != nil {
		x.ID = *m.ID
	}
	if m.Prompt != nil {
		x.Prompt = *m.Prompt
	}
	if m.StartedAt != nil {
		t := parseTime(*m.StartedAt)
		x.StartedAt = &t
	}
	if m.CompletedAt != nil {
		t := parseTime(*m.CompletedAt)
		x.CompletedAt = &t
	}
	var c flexibleTime
	_ = c.Scan(m.CreatedAt)
	x.CreatedAt = c.Time
	return x
}
func (h *handler) listAutomationRuns(w http.ResponseWriter, r *http.Request) {
	p := principal(r)
	q := h.deps.Gorm.WithContext(r.Context()).Model(&models.AgentAutomationRun{}).Where("tenant_id = ? AND agent_id = ?", p.TenantID, chi.URLParam(r, "id"))
	if sid := chi.URLParam(r, "sid"); sid != "" {
		q = q.Where("schedule_id = ?", sid)
	}
	var ms []models.AgentAutomationRun
	if e := q.Order("created_at DESC").Limit(100).Find(&ms).Error; e != nil {
		statusErr(w, e)
		return
	}
	out := make([]AutomationRun, 0, len(ms))
	for _, m := range ms {
		out = append(out, automationRunFromModel(m))
	}
	httpx.JSON(w, 200, map[string]any{"runs": out})
}
func (h *handler) getAutomationRun(w http.ResponseWriter, r *http.Request) {
	p := principal(r)
	var m models.AgentAutomationRun
	e := h.deps.Gorm.WithContext(r.Context()).Where("tenant_id = ? AND agent_id = ? AND id = ?", p.TenantID, chi.URLParam(r, "id"), chi.URLParam(r, "rid")).Take(&m).Error
	if errors.Is(e, gorm.ErrRecordNotFound) {
		e = ErrNotFound
	}
	if e != nil {
		statusErr(w, e)
		return
	}
	httpx.JSON(w, 200, map[string]any{"run": automationRunFromModel(m)})
}
func (h *handler) cancelAutomationRun(w http.ResponseWriter, r *http.Request) {
	p := principal(r)
	agent, id := chi.URLParam(r, "id"), chi.URLParam(r, "rid")
	var m models.AgentAutomationRun
	e := h.deps.Gorm.WithContext(r.Context()).Where("tenant_id = ? AND agent_id = ? AND id = ?", p.TenantID, agent, id).Take(&m).Error
	if e != nil {
		statusErr(w, ErrNotFound)
		return
	}
	x := automationRunFromModel(m)
	if x.SessionID != nil {
		_, _ = h.service.Cancel(r.Context(), p.TenantID, agent, *x.SessionID)
	}
	now := h.store.now()
	if e = h.deps.Gorm.WithContext(r.Context()).Model(&models.AgentAutomationRun{}).Where("id = ? AND tenant_id = ?", id, p.TenantID).Updates(map[string]any{"status": "cancelled", "completed_at": runtimeTimeString(now)}).Error; e != nil {
		statusErr(w, e)
		return
	}
	x.Status = "cancelled"
	x.CompletedAt = &now
	httpx.JSON(w, 200, map[string]any{"run": x})
}

func (h *handler) getHeartbeat(w http.ResponseWriter, r *http.Request) {
	p := principal(r)
	var m models.AgentHeartbeat
	e := h.deps.Gorm.WithContext(r.Context()).Where("tenant_id = ? AND agent_id = ?", p.TenantID, chi.URLParam(r, "id")).Take(&m).Error
	if errors.Is(e, gorm.ErrRecordNotFound) {
		httpx.JSON(w, 200, map[string]any{"heartbeat": map[string]any{"enabled": false, "intervalMinutes": 60, "prompt": ""}})
		return
	}
	if e != nil {
		statusErr(w, e)
		return
	}
	prompt := ""
	if m.Prompt != nil {
		prompt = *m.Prompt
	}
	nextStr, lastStr := "", ""
	if m.NextRunAt != nil {
		nextStr = *m.NextRunAt
	}
	if m.LastRunAt != nil {
		lastStr = *m.LastRunAt
	}
	httpx.JSON(w, 200, map[string]any{"heartbeat": map[string]any{"enabled": m.Enabled, "intervalMinutes": int(m.IntervalMinutes), "prompt": prompt, "nextRunAt": nextStr, "lastRunAt": lastStr, "lastStatus": m.LastStatus, "lastError": m.LastError}})
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
	nowStr, nextStr := runtimeTimeString(now), runtimeTimeString(next)
	e := h.deps.Gorm.WithContext(r.Context()).Exec(`INSERT INTO agent_heartbeats(agent_id,tenant_id,enabled,interval_minutes,prompt,next_run_at,last_run_at,last_status,last_error,created_at,updated_at) VALUES(?,?,?,?,?,?,NULL,NULL,NULL,?,?) ON CONFLICT(agent_id) DO UPDATE SET enabled=?,interval_minutes=?,prompt=?,next_run_at=?,updated_at=?`, agent, p.TenantID, b.Enabled, b.IntervalMinutes, b.Prompt, nextStr, nowStr, nowStr, b.Enabled, b.IntervalMinutes, b.Prompt, nextStr, nowStr).Error
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
	var hb models.AgentHeartbeat
	e := h.deps.Gorm.WithContext(r.Context()).Where("tenant_id = ? AND agent_id = ?", p.TenantID, agent).Take(&hb).Error
	if errors.Is(e, gorm.ErrRecordNotFound) {
		prompt = "Review current priorities and report anything requiring attention."
	} else if e != nil {
		statusErr(w, e)
		return
	} else if hb.Prompt != nil {
		prompt = *hb.Prompt
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
	var m models.AgentSchedule
	e := h.deps.Gorm.WithContext(r.Context()).Where("id = ? AND enabled = true AND trigger_kind = 'listener'", id).Take(&m).Error
	if errors.Is(e, gorm.ErrRecordNotFound) {
		httpx.Error(w, 404, "Not found")
		return
	}
	if e != nil {
		statusErr(w, e)
		return
	}
	tenant, agent, prompt := m.TenantID, m.AgentID, m.Prompt
	secret := ""
	if m.WebhookSecret != nil {
		secret = *m.WebhookSecret
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
	var ms []models.AgentSchedule
	if e := h.deps.Gorm.WithContext(ctx).Where("enabled = true AND trigger_kind = 'cron' AND next_run_at IS NOT NULL AND next_run_at <= ?", runtimeTimeString(h.store.now())).Order("next_run_at").Limit(25).Find(&ms).Error; e != nil {
		return
	}
	type due struct {
		id, tenant, agent, prompt, pattern, tz string
		next                                   string
		count                                  int
		max                                    *int
	}
	all := make([]due, 0, len(ms))
	for _, m := range ms {
		x := due{tenant: m.TenantID, agent: m.AgentID, prompt: m.Prompt, tz: m.Timezone, count: int(m.RunCount)}
		if m.ID != nil {
			x.id = *m.ID
		}
		if m.Pattern != nil {
			x.pattern = *m.Pattern
		}
		if m.NextRunAt != nil {
			x.next = *m.NextRunAt
		}
		if m.MaxRuns != nil {
			v := int(*m.MaxRuns)
			x.max = &v
		}
		all = append(all, x)
	}
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
		nowStr := runtimeTimeString(h.store.now())
		res := h.deps.Gorm.WithContext(ctx).Model(&models.AgentSchedule{}).Where("id = ? AND next_run_at = ?", x.id, x.next).Updates(map[string]any{"next_run_at": runtimeTimeString(next.UTC()), "run_count": gorm.Expr("run_count + 1"), "last_run_at": nowStr, "last_status": "running", "enabled": enabled, "updated_at": nowStr})
		if res.Error != nil {
			continue
		}
		if res.RowsAffected == 1 {
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
