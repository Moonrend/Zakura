package usage

import (
	"context"
	"database/sql"
	"encoding/json"
	"net/http"
	"strconv"
	"strings"
	"time"
	"unicode/utf8"

	"github.com/Moonrend/Zakura/go/server/internal/platform/appdeps"
	"github.com/Moonrend/Zakura/go/server/internal/platform/db/models"
	"github.com/Moonrend/Zakura/go/server/internal/platform/httpx"
	"github.com/go-chi/chi/v5"
)

var validCategories = map[string]bool{"auth": true, "session": true, "run": true, "tool": true, "admin": true}
var validActions = map[string]bool{"login": true, "session_created": true, "run_started": true, "run_completed": true, "run_failed": true, "run_cancelled": true, "tool_called": true}

type store struct{ d *appdeps.Dependencies }

func RegisterRoutes(r chi.Router, d *appdeps.Dependencies) {
	s := &store{d: d}
	d.RecordUsage = s.record
	r.Group(func(g chi.Router) {
		g.Use(httpx.Auth(d))
		g.Get("/api/usage/me", s.myUsage)
		g.Get("/api/usage/users", s.tenantUsage)
		g.Get("/api/usage/users/{userId}", s.userUsage)
	})
}

func (s *store) myUsage(w http.ResponseWriter, r *http.Request) {
	p, _ := httpx.PrincipalFrom(r.Context())
	if p.APIKey {
		httpx.Error(w, http.StatusForbidden, "User session required")
		return
	}
	days := usageDays(r)
	if !validCategoryQuery(w, r) {
		return
	}
	s.bundle(w, r, p.UserID, &p.TenantID, days)
}

func (s *store) tenantUsage(w http.ResponseWriter, r *http.Request) {
	p, _ := httpx.PrincipalFrom(r.Context())
	if p.APIKey || p.Role != "owner" && p.Role != "admin" && !p.IsPlatformAdmin {
		httpx.Error(w, http.StatusForbidden, "Admin only")
		return
	}
	days := usageDays(r)
	tenantID := p.TenantID
	if requested := strings.TrimSpace(r.URL.Query().Get("tenantId")); requested != "" {
		if !p.IsPlatformAdmin {
			httpx.Error(w, http.StatusForbidden, "Platform admin only")
			return
		}
		var count int64
		if s.d.Gorm.WithContext(r.Context()).Model(&models.Tenant{}).Where("id=?", requested).Count(&count).Error != nil || count == 0 {
			httpx.Error(w, http.StatusNotFound, "Tenant not found")
			return
		}
		tenantID = requested
	}
	limit := boundedQueryInt(r.URL.Query().Get("limit"), 100, 1, 500)
	since := s.d.Clock().UTC().AddDate(0, 0, -(days - 1)).Format("2006-01-02")
	var rows []struct {
		UserID          string  `gorm:"column:user_id"`
		Email           string  `gorm:"column:email"`
		Name            string  `gorm:"column:name"`
		LastSeenAt      *string `gorm:"column:last_seen_at"`
		Logins          int64   `gorm:"column:logins"`
		SessionsStarted int64   `gorm:"column:sessions_started"`
		RunsOk          int64   `gorm:"column:runs_ok"`
		RunsError       int64   `gorm:"column:runs_error"`
		ToolCalls       int64   `gorm:"column:tool_calls"`
	}
	if err := s.d.Gorm.WithContext(r.Context()).Raw(`SELECT u.id AS user_id,u.email AS email,COALESCE(u.name,'') AS name,MAX(d.last_seen_at) AS last_seen_at,COALESCE(SUM(d.logins),0) AS logins,COALESCE(SUM(d.sessions_started),0) AS sessions_started,COALESCE(SUM(d.runs_ok),0) AS runs_ok,COALESCE(SUM(d.runs_error),0) AS runs_error,COALESCE(SUM(d.tool_calls),0) AS tool_calls FROM tenant_memberships m JOIN users u ON u.id=m.user_id LEFT JOIN user_usage_daily d ON d.tenant_id=m.tenant_id AND d.user_id=m.user_id AND d.day>=? WHERE m.tenant_id=? GROUP BY u.id,u.email,u.name ORDER BY MAX(d.last_seen_at) DESC,u.email LIMIT ?`, since, tenantID, limit).Scan(&rows).Error; err != nil {
		httpx.Error(w, 500, "query failed")
		return
	}
	users := []map[string]any{}
	for _, row := range rows {
		users = append(users, map[string]any{"userId": row.UserID, "email": row.Email, "name": nullableText(row.Name), "lastSeenAt": nullStringPtr(row.LastSeenAt), "logins": row.Logins, "sessionsStarted": row.SessionsStarted, "runsOk": row.RunsOk, "runsError": row.RunsError, "toolCalls": row.ToolCalls})
	}
	httpx.JSON(w, 200, map[string]any{"days": days, "users": users})
}

func (s *store) userUsage(w http.ResponseWriter, r *http.Request) {
	p, _ := httpx.PrincipalFrom(r.Context())
	if p.APIKey {
		httpx.Error(w, http.StatusForbidden, "Forbidden")
		return
	}
	userID := chi.URLParam(r, "userId")
	scopeAll := r.URL.Query().Get("scope") == "all"
	var tenantID *string
	if scopeAll {
		if !p.IsPlatformAdmin {
			httpx.Error(w, http.StatusForbidden, "Forbidden")
			return
		}
	} else {
		tenantID = &p.TenantID
		if p.UserID != userID {
			if p.Role != "owner" && p.Role != "admin" && !p.IsPlatformAdmin {
				httpx.Error(w, http.StatusForbidden, "Forbidden")
				return
			}
			var count int64
			if s.d.Gorm.WithContext(r.Context()).Model(&models.TenantMembership{}).Where("tenant_id=? AND user_id=?", p.TenantID, userID).Count(&count).Error != nil || count == 0 {
				httpx.Error(w, http.StatusNotFound, "Forbidden")
				return
			}
		}
	}
	days := usageDays(r)
	if !validCategoryQuery(w, r) {
		return
	}
	s.bundle(w, r, userID, tenantID, days)
}

func (s *store) bundle(w http.ResponseWriter, r *http.Request, userID string, tenantID *string, days int) {
	summary, err := s.summary(r.Context(), userID, tenantID, days)
	if err != nil {
		httpx.Error(w, 500, "query failed")
		return
	}
	limit := boundedQueryInt(r.URL.Query().Get("limit"), 50, 1, 200)
	offset := boundedQueryInt(r.URL.Query().Get("offset"), 0, 0, 1_000_000)
	events, total, err := s.events(r.Context(), userID, tenantID, r.URL.Query().Get("category"), limit, offset)
	if err != nil {
		httpx.Error(w, 500, "query failed")
		return
	}
	sessions, err := s.sessions(r.Context(), userID, tenantID, 20)
	if err != nil {
		httpx.Error(w, 500, "query failed")
		return
	}
	httpx.JSON(w, 200, map[string]any{"summary": summary, "events": events, "eventTotal": total, "sessions": sessions})
}

func (s *store) summary(ctx context.Context, userID string, tenantID *string, days int) (map[string]any, error) {
	since := s.d.Clock().UTC().AddDate(0, 0, -(days - 1)).Format("2006-01-02")
	query := `SELECT day,SUM(logins),SUM(sessions_started),SUM(runs_ok),SUM(runs_error),SUM(tool_calls),SUM(tool_errors),SUM(duration_ms),MAX(last_seen_at) FROM user_usage_daily WHERE user_id=? AND day>=?`
	args := []any{userID, since}
	if tenantID != nil {
		query += ` AND tenant_id=?`
		args = append(args, *tenantID)
	}
	query += ` GROUP BY day ORDER BY day`
	type usageSeriesRow struct {
		Day             string  `gorm:"column:day"`
		Logins          int64   `gorm:"column:logins"`
		SessionsStarted int64   `gorm:"column:sessions_started"`
		RunsOk          int64   `gorm:"column:runs_ok"`
		RunsError       int64   `gorm:"column:runs_error"`
		ToolCalls       int64   `gorm:"column:tool_calls"`
		ToolErrors      int64   `gorm:"column:tool_errors"`
		DurationMs      int64   `gorm:"column:duration_ms"`
		LastSeenAt      *string `gorm:"column:last_seen_at"`
	}
	var rows []usageSeriesRow
	if err := s.d.Gorm.WithContext(ctx).Raw(query, args...).Scan(&rows).Error; err != nil {
		return nil, err
	}
	series := []map[string]any{}
	totals := map[string]int64{"logins": 0, "sessionsStarted": 0, "runsOk": 0, "runsError": 0, "toolCalls": 0, "toolErrors": 0, "durationMs": 0}
	var latest string
	for _, row := range rows {
		series = append(series, map[string]any{"day": row.Day, "logins": row.Logins, "sessionsStarted": row.SessionsStarted, "runsOk": row.RunsOk, "runsError": row.RunsError, "toolCalls": row.ToolCalls, "toolErrors": row.ToolErrors, "durationMs": row.DurationMs, "lastSeenAt": nullStringPtr(row.LastSeenAt)})
		totals["logins"] += row.Logins
		totals["sessionsStarted"] += row.SessionsStarted
		totals["runsOk"] += row.RunsOk
		totals["runsError"] += row.RunsError
		totals["toolCalls"] += row.ToolCalls
		totals["toolErrors"] += row.ToolErrors
		totals["durationMs"] += row.DurationMs
		if row.LastSeenAt != nil && *row.LastSeenAt > latest {
			latest = *row.LastSeenAt
		}
	}
	var tenant, lastSeen any
	if tenantID != nil {
		tenant = *tenantID
	}
	if latest != "" {
		lastSeen = latest
	}
	return map[string]any{"userId": userID, "tenantId": tenant, "lastSeenAt": lastSeen, "days": days, "totals": totals, "series": series}, nil
}

func (s *store) events(ctx context.Context, userID string, tenantID *string, category string, limit, offset int) ([]map[string]any, int, error) {
	clauses := []string{`user_id=?`}
	args := []any{userID}
	if tenantID != nil {
		clauses = append(clauses, `tenant_id=?`)
		args = append(args, *tenantID)
	}
	if category != "" {
		clauses = append(clauses, `category=?`)
		args = append(args, category)
	}
	where := strings.Join(clauses, " AND ")
	var total int64
	if err := s.d.Gorm.WithContext(ctx).Model(&models.UserUsageEvent{}).Where(where, args...).Count(&total).Error; err != nil {
		return nil, 0, err
	}
	var rows []models.UserUsageEvent
	if err := s.d.Gorm.WithContext(ctx).Model(&models.UserUsageEvent{}).Where(where, args...).Select("id,tenant_id,user_id,actor_kind,category,action,status,duration_ms,agent_id,session_id,resource_kind,resource_id,summary,CAST(created_at AS TEXT) AS created_at").Order("created_at DESC").Limit(limit).Offset(offset).Find(&rows).Error; err != nil {
		return nil, 0, err
	}
	items := []map[string]any{}
	for _, row := range rows {
		created := ""
		if row.CreatedAt != nil {
			created = *row.CreatedAt
		}
		items = append(items, map[string]any{"id": deref(row.ID), "tenantId": row.TenantID, "userId": row.UserID, "actorKind": row.ActorKind, "category": row.Category, "action": row.Action, "status": row.Status, "durationMs": row.DurationMs, "agentId": nullStringPtr(row.AgentID), "sessionId": nullStringPtr(row.SessionID), "resourceKind": nullStringPtr(row.ResourceKind), "resourceId": nullStringPtr(row.ResourceID), "summary": row.Summary, "createdAt": created})
	}
	return items, int(total), nil
}

func (s *store) sessions(ctx context.Context, userID string, tenantID *string, limit int) ([]map[string]any, error) {
	query := s.d.Gorm.WithContext(ctx).Model(&models.CloudAgentSession{}).Where("created_by_user_id=?", userID)
	if tenantID != nil {
		query = query.Where("tenant_id=?", *tenantID)
	}
	var rows []models.CloudAgentSession
	if err := query.Select("id,tenant_id,agent_id,title,kind,status,CAST(updated_at AS TEXT) AS updated_at").Order("updated_at DESC").Limit(limit).Find(&rows).Error; err != nil {
		return nil, err
	}
	items := []map[string]any{}
	for _, row := range rows {
		items = append(items, map[string]any{"id": deref(row.ID), "tenantId": row.TenantID, "agentId": row.AgentID, "title": row.Title, "kind": row.Kind, "status": row.Status, "updatedAt": row.UpdatedAt})
	}
	return items, nil
}

func (s *store) record(ctx context.Context, input appdeps.UsageRecord) error {
	if input.UserID == "" || input.UserID == "api-key" || input.TenantID == "" || !validCategories[input.Category] || !validActions[input.Action] {
		return nil
	}
	if input.ActorKind == "" {
		input.ActorKind = "user"
	}
	if input.ActorKind != "user" && input.ActorKind != "api_key" && input.ActorKind != "system" {
		input.ActorKind = "user"
	}
	if input.Status != "error" {
		input.Status = "ok"
	}
	if input.DurationMS < 0 {
		input.DurationMS = 0
	}
	input.Summary = truncateSummary(input.Summary)
	now := s.d.Clock().UTC()
	created := now.Format(time.RFC3339Nano)
	day := now.Format("2006-01-02")
	logins, sessions, runsOK, runsError, toolCalls, toolErrors := 0, 0, 0, 0, 0, 0
	switch input.Action {
	case "login":
		logins = 1
	case "session_created":
		sessions = 1
	case "run_completed":
		runsOK = 1
	case "run_failed", "run_cancelled":
		runsError = 1
	case "tool_called":
		toolCalls = 1
		if input.Status == "error" {
			toolErrors = 1
		}
	}
	detail, _ := json.Marshal(map[string]any{"actorKind": input.ActorKind, "action": input.Action, "status": input.Status, "durationMs": input.DurationMS, "agentId": emptyNull(input.AgentID), "sessionId": emptyNull(input.SessionID), "resourceKind": emptyNull(input.ResourceKind), "resourceId": emptyNull(input.ResourceID), "summary": input.Summary})
	return appdeps.InTx(ctx, s.d.DB, func(tx *sql.Tx) error {
		if _, err := tx.ExecContext(ctx, s.d.Rebind(`INSERT INTO user_usage_events(id,tenant_id,user_id,actor_kind,category,action,status,duration_ms,agent_id,session_id,resource_kind,resource_id,summary,created_at,units,detail_json,occurred_at) VALUES(?,?,?,?,?,?,?,?,?,?,?,?,?,?,1,?,?)`), s.d.NewID(), input.TenantID, input.UserID, input.ActorKind, input.Category, input.Action, input.Status, input.DurationMS, emptyNull(input.AgentID), emptyNull(input.SessionID), emptyNull(input.ResourceKind), emptyNull(input.ResourceID), input.Summary, created, string(detail), created); err != nil {
			return err
		}
		_, err := tx.ExecContext(ctx, s.d.Rebind(`INSERT INTO user_usage_daily(id,tenant_id,user_id,day,logins,sessions_started,runs_ok,runs_error,tool_calls,tool_errors,duration_ms,last_seen_at) VALUES(?,?,?,?,?,?,?,?,?,?,?,?) ON CONFLICT(tenant_id,user_id,day) DO UPDATE SET logins=user_usage_daily.logins+excluded.logins,sessions_started=user_usage_daily.sessions_started+excluded.sessions_started,runs_ok=user_usage_daily.runs_ok+excluded.runs_ok,runs_error=user_usage_daily.runs_error+excluded.runs_error,tool_calls=user_usage_daily.tool_calls+excluded.tool_calls,tool_errors=user_usage_daily.tool_errors+excluded.tool_errors,duration_ms=user_usage_daily.duration_ms+excluded.duration_ms,last_seen_at=excluded.last_seen_at`), s.d.NewID(), input.TenantID, input.UserID, day, logins, sessions, runsOK, runsError, toolCalls, toolErrors, input.DurationMS, created)
		return err
	})
}

func usageDays(r *http.Request) int { return boundedQueryInt(r.URL.Query().Get("days"), 30, 1, 400) }
func validCategoryQuery(w http.ResponseWriter, r *http.Request) bool {
	if category := r.URL.Query().Get("category"); category != "" && !validCategories[category] {
		httpx.Error(w, http.StatusBadRequest, "Invalid usage category")
		return false
	}
	return true
}
func boundedQueryInt(raw string, fallback, min, max int) int {
	value, err := strconv.Atoi(raw)
	if err != nil {
		return fallback
	}
	if value < min {
		return min
	}
	if value > max {
		return max
	}
	return value
}
func truncateSummary(value string) string {
	value = strings.Join(strings.Fields(value), " ")
	for utf8.RuneCountInString(value) > 120 {
		_, size := utf8.DecodeLastRuneInString(value)
		value = value[:len(value)-size]
	}
	return value
}
func emptyNull(value string) any {
	if strings.TrimSpace(value) == "" {
		return nil
	}
	return value
}
func nullString(value sql.NullString) any {
	if value.Valid {
		return value.String
	}
	return nil
}
func nullStringPtr(value *string) any {
	if value != nil {
		return *value
	}
	return nil
}
func deref(value *string) string {
	if value != nil {
		return *value
	}
	return ""
}
func nullableText(value string) any {
	if value == "" {
		return nil
	}
	return value
}
