// SPDX-License-Identifier: AGPL-3.0-or-later
package runtime

import (
	"database/sql"
	"errors"
	"net/http"
	"strconv"
	"strings"
	"time"

	"github.com/Moonrend/Zakura/go/server/internal/platform/httpx"
	"github.com/go-chi/chi/v5"
)

func scanToolCall(row interface{ Scan(...any) error }) (map[string]any, error) {
	var id, qualified, local, provider, args, result, created string
	var apiKey, agent, instance, agentName, agentSlug, apiKeyName, apiKeyPrefix *string
	var isError bool
	var duration int64
	e := row.Scan(&id, &apiKey, &agent, &qualified, &local, &provider, &instance, &args, &result, &isError, &duration, &created, &agentName, &agentSlug, &apiKeyName, &apiKeyPrefix)
	return map[string]any{"id": id, "apiKeyId": apiKey, "agentId": agent, "qualifiedName": qualified, "localName": local, "providerId": provider, "instanceId": instance, "argsJson": args, "resultJson": result, "isError": isError, "durationMs": duration, "createdAt": created, "agentName": agentName, "agentSlug": agentSlug, "apiKeyName": apiKeyName, "apiKeyPrefix": apiKeyPrefix}, e
}

const toolCallSelect = `SELECT l.id,l.api_key_id,l.agent_id,l.qualified_name,l.local_name,l.provider_id,l.instance_id,l.args_json,l.result_json,l.is_error,l.duration_ms,l.created_at,a.name,a.slug,k.name,k.key_prefix FROM tool_call_logs l LEFT JOIN agents a ON a.id=l.agent_id AND a.tenant_id=l.tenant_id LEFT JOIN api_keys k ON k.id=l.api_key_id AND k.tenant_id=l.tenant_id`

func boundedQueryInt(raw string, fallback, minimum, maximum int) int {
	value, err := strconv.Atoi(raw)
	if err != nil || value < minimum {
		return fallback
	}
	if value > maximum {
		return maximum
	}
	return value
}

func (h *handler) toolCallWhere(r *http.Request, forcedAgent string) (string, []any) {
	p := principal(r)
	where := ` WHERE l.tenant_id=?`
	args := []any{p.TenantID}
	agent := forcedAgent
	if agent == "" {
		agent = strings.TrimSpace(r.URL.Query().Get("agentId"))
	}
	if agent != "" {
		where += ` AND l.agent_id=?`
		args = append(args, agent)
	}
	if key := strings.TrimSpace(r.URL.Query().Get("apiKeyId")); key != "" {
		where += ` AND l.api_key_id=?`
		args = append(args, key)
	}
	if q := strings.TrimSpace(r.URL.Query().Get("q")); q != "" {
		where += ` AND (l.qualified_name LIKE ? OR l.local_name LIKE ? OR l.provider_id LIKE ?)`
		pattern := "%" + q + "%"
		args = append(args, pattern, pattern, pattern)
	}
	if raw := r.URL.Query().Get("isError"); raw == "1" || strings.EqualFold(raw, "true") {
		where += ` AND l.is_error=?`
		args = append(args, true)
	} else if raw == "0" || strings.EqualFold(raw, "false") {
		where += ` AND l.is_error=?`
		args = append(args, false)
	}
	if since := strings.TrimSpace(r.URL.Query().Get("since")); since != "" {
		if parsed, err := time.Parse(time.RFC3339, since); err == nil {
			where += ` AND l.created_at>=?`
			args = append(args, runtimeTimeString(parsed.UTC()))
		}
	}
	if until := strings.TrimSpace(r.URL.Query().Get("until")); until != "" {
		if parsed, err := time.Parse(time.RFC3339, until); err == nil {
			where += ` AND l.created_at<=?`
			args = append(args, runtimeTimeString(parsed.UTC()))
		}
	}
	return where, args
}

func (h *handler) listToolCalls(w http.ResponseWriter, r *http.Request) {
	p := principal(r)
	forcedAgent := chi.URLParam(r, "id")
	if forcedAgent != "" {
		var exists int64
		if err := h.deps.Gorm.WithContext(r.Context()).Table("agents").Where("tenant_id = ? AND id = ?", p.TenantID, forcedAgent).Count(&exists).Error; err != nil {
			statusErr(w, err)
			return
		}
		if exists == 0 {
			statusErr(w, ErrNotFound)
			return
		}
	}
	where, args := h.toolCallWhere(r, forcedAgent)
	var total int64
	if err := h.deps.Gorm.WithContext(r.Context()).Raw(`SELECT COUNT(*) FROM tool_call_logs l`+where, args...).Row().Scan(&total); err != nil {
		statusErr(w, err)
		return
	}
	limit := boundedQueryInt(r.URL.Query().Get("limit"), 50, 1, 200)
	offset := boundedQueryInt(r.URL.Query().Get("offset"), 0, 0, 1_000_000)
	q := toolCallSelect + where + ` ORDER BY l.created_at DESC,l.id DESC LIMIT ? OFFSET ?`
	args = append(args, limit, offset)
	rows, e := h.deps.Gorm.WithContext(r.Context()).Raw(q, args...).Rows()
	if e != nil {
		statusErr(w, e)
		return
	}
	defer rows.Close()
	out := make([]map[string]any, 0)
	for rows.Next() {
		x, e := scanToolCall(rows)
		if e != nil {
			statusErr(w, e)
			return
		}
		out = append(out, x)
	}
	httpx.JSON(w, 200, map[string]any{"items": out, "total": total})
}
func (h *handler) getToolCall(w http.ResponseWriter, r *http.Request) {
	x, e := scanToolCall(h.deps.Gorm.WithContext(r.Context()).Raw(toolCallSelect+` WHERE l.tenant_id=? AND l.id=?`, principal(r).TenantID, chi.URLParam(r, "id")).Row())
	if errors.Is(e, sql.ErrNoRows) {
		e = ErrNotFound
	}
	if e != nil {
		statusErr(w, e)
		return
	}
	httpx.JSON(w, 200, x)
}
func (h *handler) toolCallStats(w http.ResponseWriter, r *http.Request) {
	p := principal(r)
	agent := chi.URLParam(r, "id")
	if agent == "" {
		agent = strings.TrimSpace(r.URL.Query().Get("agentId"))
	}
	if agent != "" {
		var exists int64
		if err := h.deps.Gorm.WithContext(r.Context()).Table("agents").Where("tenant_id = ? AND id = ?", p.TenantID, agent).Count(&exists).Error; err != nil {
			statusErr(w, err)
			return
		}
		if exists == 0 {
			statusErr(w, ErrNotFound)
			return
		}
	}
	q := `SELECT COUNT(*),COALESCE(SUM(CASE WHEN is_error THEN 1 ELSE 0 END),0),COALESCE(AVG(duration_ms),0) FROM tool_call_logs WHERE tenant_id=?`
	args := []any{p.TenantID}
	if agent != "" {
		q += ` AND agent_id=?`
		args = append(args, agent)
	}
	var total, failed, last24 int64
	var avg float64
	e := h.deps.Gorm.WithContext(r.Context()).Raw(q, args...).Row().Scan(&total, &failed, &avg)
	if e != nil {
		statusErr(w, e)
		return
	}
	lastQ := `SELECT COUNT(*) FROM tool_call_logs WHERE tenant_id=? AND created_at>=?`
	lastArgs := []any{p.TenantID, runtimeTimeString(h.store.now().Add(-24 * time.Hour))}
	if agent != "" {
		lastQ += ` AND agent_id=?`
		lastArgs = append(lastArgs, agent)
	}
	if e = h.deps.Gorm.WithContext(r.Context()).Raw(lastQ, lastArgs...).Row().Scan(&last24); e != nil {
		statusErr(w, e)
		return
	}
	groupWhere := ` WHERE l.tenant_id=?`
	groupArgs := []any{p.TenantID}
	if agent != "" {
		groupWhere += ` AND l.agent_id=?`
		groupArgs = append(groupArgs, agent)
	}
	byAgent := []map[string]any{}
	rows, e := h.deps.Gorm.WithContext(r.Context()).Raw(`SELECT l.agent_id,a.name,COUNT(*) FROM tool_call_logs l LEFT JOIN agents a ON a.id=l.agent_id AND a.tenant_id=l.tenant_id`+groupWhere+` GROUP BY l.agent_id,a.name ORDER BY COUNT(*) DESC,l.agent_id LIMIT 20`, groupArgs...).Rows()
	if e != nil {
		statusErr(w, e)
		return
	}
	for rows.Next() {
		var id, name *string
		var count int64
		if rows.Scan(&id, &name, &count) == nil {
			byAgent = append(byAgent, map[string]any{"agentId": id, "agentName": name, "count": count})
		}
	}
	rows.Close()
	byKey := []map[string]any{}
	rows, e = h.deps.Gorm.WithContext(r.Context()).Raw(`SELECT l.api_key_id,k.name,k.key_prefix,COUNT(*) FROM tool_call_logs l LEFT JOIN api_keys k ON k.id=l.api_key_id AND k.tenant_id=l.tenant_id`+groupWhere+` GROUP BY l.api_key_id,k.name,k.key_prefix ORDER BY COUNT(*) DESC,l.api_key_id LIMIT 20`, groupArgs...).Rows()
	if e != nil {
		statusErr(w, e)
		return
	}
	for rows.Next() {
		var id, name, prefix *string
		var count int64
		if rows.Scan(&id, &name, &prefix, &count) == nil {
			byKey = append(byKey, map[string]any{"apiKeyId": id, "apiKeyName": name, "keyPrefix": prefix, "count": count})
		}
	}
	rows.Close()
	byTool := []map[string]any{}
	rows, e = h.deps.Gorm.WithContext(r.Context()).Raw(`SELECT l.qualified_name,COUNT(*),COALESCE(SUM(CASE WHEN l.is_error THEN 1 ELSE 0 END),0) FROM tool_call_logs l`+groupWhere+` GROUP BY l.qualified_name ORDER BY COUNT(*) DESC,l.qualified_name LIMIT 20`, groupArgs...).Rows()
	if e != nil {
		statusErr(w, e)
		return
	}
	for rows.Next() {
		var name string
		var count, errors int64
		if rows.Scan(&name, &count, &errors) == nil {
			byTool = append(byTool, map[string]any{"qualifiedName": name, "count": count, "errors": errors})
		}
	}
	rows.Close()
	httpx.JSON(w, 200, map[string]any{"total": total, "errors": failed, "avgDurationMs": int64(avg + 0.5), "last24h": last24, "byAgent": byAgent, "byApiKey": byKey, "byTool": byTool})
}
