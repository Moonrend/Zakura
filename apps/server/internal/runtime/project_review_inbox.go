// SPDX-License-Identifier: AGPL-3.0-or-later
package runtime

import (
	"context"
	"crypto/sha256"
	"database/sql"
	"encoding/base64"
	"encoding/hex"
	"encoding/json"
	"errors"
	"fmt"
	"github.com/Moonrend/Zakura/apps/server/internal/platform/httpx"
	"github.com/go-chi/chi/v5"
	"net/http"
	"net/url"
	"regexp"
	"strconv"
	"strings"
	"time"
	"unicode/utf8"
)

type projectReviewItem struct {
	ID             string   `json:"id"`
	Kind           string   `json:"kind"`
	ProjectID      string   `json:"projectId"`
	ProjectName    string   `json:"projectName"`
	SpaceID        string   `json:"spaceId"`
	RunID          string   `json:"runId,omitempty"`
	TaskID         string   `json:"taskId,omitempty"`
	Status         string   `json:"status"`
	Revision       int64    `json:"revision"`
	Risk           int      `json:"risk"`
	CreatedAt      string   `json:"createdAt"`
	UpdatedAt      string   `json:"updatedAt"`
	WaitingSeconds int64    `json:"waitingSeconds"`
	RequiredRole   string   `json:"requiredRole"`
	CanAct         bool     `json:"canAct"`
	Title          string   `json:"title"`
	Action         string   `json:"action"`
	Summary        string   `json:"summary"`
	HasError       bool     `json:"hasError"`
	ErrorCategory  string   `json:"errorCategory,omitempty"`
	ToolName       string   `json:"toolName,omitempty"`
	Effect         string   `json:"effect,omitempty"`
	ArgumentFields []string `json:"argumentFields,omitempty"`
	SnapshotID     string   `json:"snapshotId,omitempty"`
	Href           string   `json:"href"`
}
type projectReviewGroup struct {
	Kind         string `json:"kind"`
	Status       string `json:"status"`
	RequiredRole string `json:"requiredRole"`
	Count        int64  `json:"count"`
	OldestAt     string `json:"oldestAt"`
}
type projectReviewSummary struct {
	Total        int64                `json:"total"`
	Groups       []projectReviewGroup `json:"groups"`
	SnapshotAt   string               `json:"snapshotAt"`
	VisibleKinds []string             `json:"visibleKinds"`
}
type projectReviewList struct {
	Items        []projectReviewItem `json:"items"`
	NextCursor   string              `json:"nextCursor,omitempty"`
	SnapshotAt   string              `json:"snapshotAt"`
	Total        int64               `json:"total"`
	VisibleKinds []string            `json:"visibleKinds"`
}
type projectReviewFilter struct {
	SpaceID, ProjectID, Kind, Status, Search string
	ReviewID, RunID                          string
	MinAge, MaxAge                           int
	SourceVisible                            bool
}
type projectReviewCursor struct {
	Version    int    `json:"v"`
	Snapshot   string `json:"snapshot"`
	Created    string `json:"created"`
	Kind       string `json:"kind"`
	ID         string `json:"id"`
	ProjectID  string `json:"project"`
	RunID      string `json:"run"`
	FilterHash string `json:"filter"`
}

var projectReviewRisk = map[string]int{"operation": 100, "source": 95, "merge": 85, "baseline": 70, "task_review": 60, "decision": 40, "question": 30}

func reviewStamp(t time.Time) string { return t.UTC().Format("2006-01-02T15:04:05.000000000Z") }
func (h *handler) registerProjectReviewInbox(r chi.Router) {
	r.Route("/project-reviews", func(p chi.Router) {
		p.Use(h.projectAccess)
		p.Get("/", h.projectReviewList)
		p.Get("/summary", h.projectReviewSummary)
	})
}
func projectReviewSourceVisible(r *http.Request) bool {
	p := principal(r)
	return p.UserID != "" && p.SessionID != "" && !p.APIKey && !p.OAuth && (p.Role == "owner" || p.Role == "admin")
}
func reviewKinds(source bool) []string {
	out := []string{"operation", "merge", "task_review", "decision", "question", "baseline"}
	if source {
		out = append(out, "source")
	}
	return out
}
func reviewFilter(r *http.Request) (projectReviewFilter, error) {
	q := r.URL.Query()
	f := projectReviewFilter{SpaceID: q.Get("spaceId"), ProjectID: q.Get("projectId"), Kind: q.Get("kind"), Status: q.Get("status"), Search: strings.TrimSpace(q.Get("q")), ReviewID: q.Get("reviewId"), RunID: q.Get("runId"), SourceVisible: projectReviewSourceVisible(r)}
	if len(f.SpaceID) > 128 || len(f.ProjectID) > 128 || len(f.ReviewID) > 128 || len(f.RunID) > 128 || len(f.Status) > 64 || len(f.Search) > 256 {
		return f, fmt.Errorf("review filter exceeds its limit")
	}
	if f.Kind != "" {
		if _, ok := projectReviewRisk[f.Kind]; !ok {
			return f, fmt.Errorf("unknown review kind")
		}
	}
	for key, target := range map[string]*int{"minAgeSeconds": &f.MinAge, "maxAgeSeconds": &f.MaxAge} {
		if q.Get(key) == "" {
			continue
		}
		n, err := strconv.Atoi(q.Get(key))
		if err != nil || n < 0 || n > 315360000 {
			return f, fmt.Errorf("invalid age filter")
		}
		*target = n
	}
	if f.MaxAge > 0 && f.MinAge > f.MaxAge {
		return f, fmt.Errorf("minimum age exceeds maximum age")
	}
	return f, nil
}
func reviewFilterHash(tenant string, f projectReviewFilter) string {
	raw, _ := json.Marshal(struct {
		Tenant string
		Filter projectReviewFilter
	}{tenant, f})
	sum := sha256.Sum256(raw)
	return hex.EncodeToString(sum[:])
}
func reviewDecodeCursor(raw, hash string, now time.Time) (projectReviewCursor, error) {
	var c projectReviewCursor
	if len(raw) > 2048 {
		return c, errors.New("review cursor exceeds its limit")
	}
	body, err := base64.RawURLEncoding.DecodeString(raw)
	if err != nil {
		return c, errors.New("invalid review cursor")
	}
	if err = json.Unmarshal(body, &c); err != nil {
		return c, errors.New("invalid review cursor")
	}
	snapshot, e1 := time.Parse(time.RFC3339Nano, c.Snapshot)
	created, e2 := time.Parse(time.RFC3339Nano, c.Created)
	_, kindValid := projectReviewRisk[c.Kind]
	if c.Version != 1 || c.FilterHash != hash || !kindValid || c.ID == "" || c.ProjectID == "" || len(c.ID) > 128 || len(c.ProjectID) > 128 || len(c.RunID) > 128 || e1 != nil || e2 != nil || snapshot.After(now) || created.After(snapshot) || reviewStamp(snapshot) != c.Snapshot || reviewStamp(created) != c.Created {
		return c, errors.New("review cursor does not match this snapshot and filter")
	}
	return c, nil
}
func reviewEncodeCursor(c projectReviewCursor) string {
	raw, _ := json.Marshal(c)
	return base64.RawURLEncoding.EncodeToString(raw)
}

// Store timestamps are UTC but older records can use trimmed fractions. This
// portable expression normalizes them without losing sub-millisecond ordering.
func reviewTimeSQL(column string) string {
	return `CASE WHEN SUBSTR(` + column + `,20,1)='.' THEN SUBSTR(` + column + `,1,19)||'.'||SUBSTR(RTRIM(SUBSTR(` + column + `,21,9),'Z')||'000000000',1,9)||'Z' ELSE SUBSTR(` + column + `,1,19)||'.000000000Z' END`
}
func (h *handler) reviewJSONText(column string, path ...string) string {
	if h.deps.Dialect == "postgres" {
		return `COALESCE((` + column + `::jsonb #>> '{` + strings.Join(path, ",") + `}'),'')`
	}
	return `COALESCE(json_extract(` + column + `,'$.` + strings.Join(path, ".") + `'),'')`
}
func (h *handler) reviewUnion(source bool) string {
	branch := func(kind, table, alias, status, run, task, revision, role string) string {
		return `SELECT '` + kind + `' AS kind,` + alias + `.id AS id,` + alias + `.tenant_id AS tenant_id,` + alias + `.project_id AS project_id,` + run + ` AS run_id,` + task + ` AS task_id,` + alias + `.status AS status,` + revision + ` AS revision,` + strconv.Itoa(projectReviewRisk[kind]) + ` AS risk,'` + role + `' AS required_role,` + reviewTimeSQL(alias+".created_at") + ` AS created_key,` + reviewTimeSQL(alias+".updated_at") + ` AS updated_key FROM ` + table + ` ` + alias + ` WHERE ` + alias + `.tenant_id=? AND ` + status
	}
	parts := []string{
		branch("operation", "execution_operations", "o", "o.status IN ('pending_approval','unknown')", "o.run_id", "o.task_id", "o.revision", "member"),
		branch("merge", "execution_merge_previews", "m", "m.status IN ('ready','approved','conflicted','verification_failed','applying','unknown')", "m.run_id", "''", "m.revision", "member"),
		branch("task_review", "execution_tasks", "t", "t.status='waiting_review'", "t.run_id", "t.id", "t.revision", "member"),
		branch("decision", "execution_knowledge", "k", "k.kind='decision' AND k.status='proposed'", "k.run_id", "k.task_id", "k.revision", "member"),
		branch("question", "execution_knowledge", "k", "k.kind='question' AND k.status='open'", "k.run_id", "k.task_id", "k.revision", "member"),
		branch("baseline", "execution_requirement_baselines", "b", "b.status='draft'", "''", "''", "b.revision", "member"),
	}
	if source {
		parts = append(parts, branch("source", "execution_source_attestations", "a", "a.status IN ('pending','unknown')", "''", "''", "0", "owner_admin"))
	}
	return strings.Join(parts, " UNION ALL ")
}
func reviewLike(text string) string {
	return "%" + strings.NewReplacer("\\", "\\\\", "%", "\\%", "_", "\\_").Replace(strings.ToLower(text)) + "%"
}
func (h *handler) reviewWhere(tenant string, f projectReviewFilter, snapshot string) (string, []any) {
	args := make([]any, 0, 20)
	for range reviewKinds(f.SourceVisible) {
		args = append(args, tenant)
	}
	where := ` WHERE q.tenant_id=? AND q.created_key<=? AND q.updated_key<=?`
	args = append(args, tenant, snapshot, snapshot)
	for _, term := range []struct{ column, value string }{{"p.space_id", f.SpaceID}, {"q.project_id", f.ProjectID}, {"q.kind", f.Kind}, {"q.status", f.Status}, {"q.id", f.ReviewID}, {"q.run_id", f.RunID}} {
		if term.value != "" {
			where += ` AND ` + term.column + `=?`
			args = append(args, term.value)
		}
	}
	at, _ := time.Parse(time.RFC3339Nano, snapshot)
	if f.MinAge > 0 {
		where += ` AND q.created_key<=?`
		args = append(args, reviewStamp(at.Add(-time.Duration(f.MinAge)*time.Second)))
	}
	if f.MaxAge > 0 {
		where += ` AND q.created_key>=?`
		args = append(args, reviewStamp(at.Add(-time.Duration(f.MaxAge)*time.Second)))
	}
	if f.Search != "" {
		name := h.reviewJSONText("p.project_json", "name")
		where += ` AND (LOWER(` + name + `) LIKE ? ESCAPE '\' OR LOWER(q.id) LIKE ? ESCAPE '\' OR LOWER(q.kind) LIKE ? ESCAPE '\' OR LOWER(q.project_id) LIKE ? ESCAPE '\')`
		for i := 0; i < 4; i++ {
			args = append(args, reviewLike(f.Search))
		}
	}
	return where, args
}
func (h *handler) projectReviewSummary(w http.ResponseWriter, r *http.Request) {
	f, err := reviewFilter(r)
	if err != nil {
		httpx.Error(w, 400, err.Error())
		return
	}
	snapshot := reviewStamp(h.store.now())
	tx, err := h.deps.DB.BeginTx(r.Context(), &sql.TxOptions{ReadOnly: true, Isolation: sql.LevelRepeatableRead})
	if err != nil {
		projectHTTPError(w, err)
		return
	}
	defer tx.Rollback()
	out, err := h.reviewSummary(r.Context(), tx, principal(r).TenantID, f, snapshot)
	if err != nil {
		projectHTTPError(w, err)
		return
	}
	if err = tx.Commit(); err != nil {
		projectHTTPError(w, err)
		return
	}
	httpx.JSON(w, 200, out)
}
func (h *handler) reviewSummary(ctx context.Context, tx *sql.Tx, tenant string, f projectReviewFilter, snapshot string) (projectReviewSummary, error) {
	out := projectReviewSummary{Groups: []projectReviewGroup{}, SnapshotAt: snapshot, VisibleKinds: reviewKinds(f.SourceVisible)}
	where, args := h.reviewWhere(tenant, f, snapshot)
	rows, err := tx.QueryContext(ctx, h.deps.Rebind(`WITH queue AS (`+h.reviewUnion(f.SourceVisible)+`) SELECT q.kind,q.status,q.required_role,COUNT(*),MIN(q.created_key) FROM queue q JOIN execution_projects p ON p.id=q.project_id AND p.tenant_id=q.tenant_id`+where+` GROUP BY q.kind,q.status,q.required_role ORDER BY q.kind,q.status`), args...)
	if err != nil {
		return out, err
	}
	defer rows.Close()
	for rows.Next() {
		var group projectReviewGroup
		if err = rows.Scan(&group.Kind, &group.Status, &group.RequiredRole, &group.Count, &group.OldestAt); err != nil {
			return out, err
		}
		out.Groups = append(out.Groups, group)
		out.Total += group.Count
	}
	return out, rows.Err()
}
func (h *handler) projectReviewList(w http.ResponseWriter, r *http.Request) {
	f, err := reviewFilter(r)
	if err != nil {
		httpx.Error(w, 400, err.Error())
		return
	}
	now := h.store.now()
	snapshot := reviewStamp(now)
	hash := reviewFilterHash(principal(r).TenantID, f)
	var cursor projectReviewCursor
	if raw := r.URL.Query().Get("cursor"); raw != "" {
		cursor, err = reviewDecodeCursor(raw, hash, now)
		if err != nil {
			httpx.Error(w, 400, err.Error())
			return
		}
		snapshot = cursor.Snapshot
	}
	limit := projectQueryInt(r, "limit", 50, 200)
	tx, err := h.deps.DB.BeginTx(r.Context(), &sql.TxOptions{ReadOnly: true, Isolation: sql.LevelRepeatableRead})
	if err != nil {
		projectHTTPError(w, err)
		return
	}
	defer tx.Rollback()
	summary, err := h.reviewSummary(r.Context(), tx, principal(r).TenantID, f, snapshot)
	if err != nil {
		projectHTTPError(w, err)
		return
	}
	out := projectReviewList{Items: []projectReviewItem{}, SnapshotAt: snapshot, Total: summary.Total, VisibleKinds: summary.VisibleKinds}
	where, args := h.reviewWhere(principal(r).TenantID, f, snapshot)
	if cursor.ID != "" {
		where += ` AND (q.risk<? OR (q.risk=? AND (q.created_key>? OR (q.created_key=? AND (q.kind>? OR (q.kind=? AND (q.id>? OR (q.id=? AND (q.project_id>? OR (q.project_id=? AND q.run_id>?))))))))))`
		risk := projectReviewRisk[cursor.Kind]
		args = append(args, risk, risk, cursor.Created, cursor.Created, cursor.Kind, cursor.Kind, cursor.ID, cursor.ID, cursor.ProjectID, cursor.ProjectID, cursor.RunID)
	}
	args = append(args, limit+1)
	sqlQuery := `WITH queue AS (` + h.reviewUnion(f.SourceVisible) + `), page AS (SELECT q.* FROM queue q JOIN execution_projects p ON p.id=q.project_id AND p.tenant_id=q.tenant_id` + where + ` ORDER BY q.risk DESC,q.created_key,q.kind,q.id,q.project_id,q.run_id LIMIT ?) SELECT page.kind,page.id,page.project_id,SUBSTR(` + h.reviewJSONText("p.project_json", "name") + `,1,160),p.space_id,page.run_id,page.task_id,page.status,page.revision,page.risk,page.required_role,page.created_key,page.updated_key FROM page JOIN execution_projects p ON p.id=page.project_id AND p.tenant_id=page.tenant_id ORDER BY page.risk DESC,page.created_key,page.kind,page.id,page.project_id,page.run_id`
	rows, err := tx.QueryContext(r.Context(), h.deps.Rebind(sqlQuery), args...)
	if err != nil {
		projectHTTPError(w, err)
		return
	}
	for rows.Next() {
		var item projectReviewItem
		if err = rows.Scan(&item.Kind, &item.ID, &item.ProjectID, &item.ProjectName, &item.SpaceID, &item.RunID, &item.TaskID, &item.Status, &item.Revision, &item.Risk, &item.RequiredRole, &item.CreatedAt, &item.UpdatedAt); err != nil {
			rows.Close()
			projectHTTPError(w, err)
			return
		}
		out.Items = append(out.Items, item)
	}
	err = rows.Err()
	rows.Close()
	if err != nil {
		projectHTTPError(w, err)
		return
	}
	if len(out.Items) > limit {
		out.Items = out.Items[:limit]
		last := out.Items[len(out.Items)-1]
		out.NextCursor = reviewEncodeCursor(projectReviewCursor{Version: 1, Snapshot: snapshot, Created: last.CreatedAt, Kind: last.Kind, ID: last.ID, ProjectID: last.ProjectID, RunID: last.RunID, FilterHash: hash})
	}
	for i := range out.Items {
		if err = h.hydrateReview(r.Context(), tx, r, &out.Items[i], now); err != nil {
			projectHTTPError(w, err)
			return
		}
	}
	if err = tx.Commit(); err != nil {
		projectHTTPError(w, err)
		return
	}
	httpx.JSON(w, 200, out)
}

var reviewArgumentName = regexp.MustCompile(`^[A-Za-z][A-Za-z0-9_-]{0,40}$`)
var reviewHTTPStatus = regexp.MustCompile(`(?i)(?:http(?: status)?|status(?: code)?)[ :=]+([1-5][0-9]{2})\b`)

func reviewErrorCategory(raw string) string {
	lower := strings.ToLower(raw)
	switch {
	case raw == "":
		return ""
	case strings.Contains(lower, "deadline") || strings.Contains(lower, "timed out") || strings.Contains(lower, "timeout"):
		return "timeout"
	case strings.Contains(lower, "conflict") || strings.Contains(lower, "baseline") || strings.Contains(lower, "revision"):
		return "conflict"
	case strings.Contains(lower, "denied") || strings.Contains(lower, "permission") || strings.Contains(lower, "unauthorized") || strings.Contains(lower, "forbidden"):
		return "permission"
	case reviewHTTPStatus.MatchString(raw):
		return "http_" + reviewHTTPStatus.FindStringSubmatch(raw)[1]
	case strings.Contains(lower, "unknown"):
		return "unknown_outcome"
	default:
		return "recorded_error"
	}
}
func reviewBounded(text string, limit int) string {
	if utf8.RuneCountInString(text) <= limit {
		return text
	}
	runes := []rune(text)
	return string(runes[:limit]) + "…"
}
func (h *handler) reviewArgumentKeysSQL(column string) string {
	expr := h.reviewJSONText(column, "call", "arguments")
	if h.deps.Dialect == "postgres" {
		obj := `CASE WHEN jsonb_typeof(` + column + `::jsonb #> '{call,arguments}')='object' THEN ` + column + `::jsonb #> '{call,arguments}' ELSE '{}'::jsonb END`
		return `COALESCE((SELECT json_agg(argument_key)::text FROM (SELECT jsonb_object_keys(` + obj + `) AS argument_key LIMIT 12) argument_keys),'[]')`
	}
	return `COALESCE((SELECT json_group_array(argument_key) FROM (SELECT key AS argument_key FROM json_each(CASE WHEN json_type(` + column + `,'$.call.arguments')='object' THEN ` + expr + ` ELSE '{}' END) LIMIT 12)),'[]')`
}
func (h *handler) hydrateReview(ctx context.Context, tx *sql.Tx, r *http.Request, item *projectReviewItem, now time.Time) error {
	var rawError string
	tenant := principal(r).TenantID
	switch item.Kind {
	case "task_review":
		query := `SELECT SUBSTR(` + h.reviewJSONText("task_json", "spec", "title") + `,1,160),SUBSTR(` + h.reviewJSONText("task_json", "error") + `,1,2048),SUBSTR(` + h.reviewJSONText("task_json", "snapshotId") + `,1,128) FROM execution_tasks WHERE tenant_id=? AND project_id=? AND run_id=? AND id=?`
		if err := tx.QueryRowContext(ctx, h.deps.Rebind(query), tenant, item.ProjectID, item.RunID, item.ID).Scan(&item.Title, &rawError, &item.SnapshotID); err != nil {
			return err
		}
		item.Action = "验收任务产物"
		item.Summary = "检查冻结的验收证据，针对当前不可变产物决定接受或拒绝。"
	case "operation":
		item.ArgumentFields = nil
		query := `SELECT SUBSTR(` + h.reviewJSONText("operation_json", "call", "name") + `,1,160),SUBSTR(` + h.reviewJSONText("operation_json", "call", "effect") + `,1,32),SUBSTR(` + h.reviewJSONText("operation_json", "error") + `,1,2048),` + h.reviewArgumentKeysSQL("operation_json") + ` FROM execution_operations WHERE tenant_id=? AND project_id=? AND run_id=? AND id=?`
		var keys string
		if err := tx.QueryRowContext(ctx, h.deps.Rebind(query), tenant, item.ProjectID, item.RunID, item.ID).Scan(&item.ToolName, &item.Effect, &rawError, &keys); err != nil {
			return err
		}
		var fields []any
		if json.Unmarshal([]byte(keys), &fields) == nil {
			for _, field := range fields {
				if key, ok := field.(string); ok && reviewArgumentName.MatchString(key) {
					item.ArgumentFields = append(item.ArgumentFields, key)
				} else {
					item.ArgumentFields = append(item.ArgumentFields, "[自定义参数名]")
				}
			}
		}
		item.Title = "工具调用：" + reviewBounded(item.ToolName, 80)
		item.Action = "审批外部调用"
		item.Summary = "调用尚未获准；检查工具与参数，在任务详情中逐项审批。"
		if item.Status == "unknown" {
			item.Action = "核实未知调用结果"
			item.Summary = "调用可能已生效；先检查目标系统与持久回执，不能直接重放。"
		}
	case "merge":
		query := `SELECT SUBSTR(` + h.reviewJSONText("preview_json", "error") + `,1,2048),SUBSTR(` + h.reviewJSONText("preview_json", "plan", "result", "id") + `,1,128) FROM execution_merge_previews WHERE tenant_id=? AND project_id=? AND run_id=? AND id=?`
		if err := tx.QueryRowContext(ctx, h.deps.Rebind(query), tenant, item.ProjectID, item.RunID, item.ID).Scan(&rawError, &item.SnapshotID); err != nil {
			return err
		}
		item.Title = "工作区合并"
		item.Action = "检查合并候选"
		item.Summary = "审查最终合并产物及验收证据；审批与写入原工作区是独立操作。"
		switch item.Status {
		case "unknown", "applying":
			item.Action = "检查合并发布回执"
			item.Summary = "发布可能正在进行或已生效；检查原工作区与回执后再处理。"
		case "approved":
			item.Action = "确认发布已审批产物"
		case "conflicted":
			item.Action = "解决合并冲突"
		case "verification_failed":
			item.Action = "修复合并产物验收"
		}
	case "source":
		if err := tx.QueryRowContext(ctx, h.deps.Rebind(`SELECT SUBSTR(error,1,2048) FROM execution_source_attestations WHERE tenant_id=? AND project_id=? AND id=?`), tenant, item.ProjectID, item.ID).Scan(&rawError); err != nil {
			return err
		}
		item.Title = "原工作区写入进程确认"
		item.Action = "检查管理员确认回执"
		item.Summary = "需在运行节点确认旧写入进程确已停止，并核对持久确认结果；页面不会自动作出该确认。"
	case "baseline":
		query := `SELECT SUBSTR(` + h.reviewJSONText("baseline_json", "title") + `,1,160) FROM execution_requirement_baselines WHERE tenant_id=? AND project_id=? AND id=?`
		if err := tx.QueryRowContext(ctx, h.deps.Rebind(query), tenant, item.ProjectID, item.ID).Scan(&item.Title); err != nil {
			return err
		}
		item.Action = "审核需求基线"
		item.Summary = "检查必需需求与任务、验收绑定，批准当前版本后才能作为交付依据。"
	case "decision", "question":
		query := `SELECT SUBSTR(` + h.reviewJSONText("entry_json", "title") + `,1,160) FROM execution_knowledge WHERE tenant_id=? AND project_id=? AND id=?`
		if err := tx.QueryRowContext(ctx, h.deps.Rebind(query), tenant, item.ProjectID, item.ID).Scan(&item.Title); err != nil {
			return err
		}
		if item.Kind == "decision" {
			item.Action = "审核项目决策"
			item.Summary = "检查提案、来源与当前版本，决定批准或拒绝该决策。"
		} else {
			item.Action = "回答开放问题"
			item.Summary = "记录问题结论与依据，然后在知识条目中明确标记解决。"
		}
	}
	item.HasError = rawError != ""
	item.ErrorCategory = reviewErrorCategory(rawError)
	p := principal(r)
	item.CanAct = p.UserID != "" && p.SessionID != "" && !p.APIKey && !p.OAuth && (p.Role == "owner" || p.Role == "admin" || p.Role == "member")
	if item.RequiredRole == "owner_admin" {
		item.CanAct = item.CanAct && (p.Role == "owner" || p.Role == "admin")
	}
	created, err := time.Parse(time.RFC3339Nano, item.CreatedAt)
	if err != nil {
		return err
	}
	item.WaitingSeconds = int64(now.Sub(created) / time.Second)
	if item.WaitingSeconds < 0 {
		item.WaitingSeconds = 0
	}
	query := url.Values{"reviewId": {item.ID}, "reviewKind": {item.Kind}}
	tab := "execution"
	if item.Kind == "merge" {
		tab = "merge"
	}
	if item.Kind == "decision" || item.Kind == "question" {
		tab = "knowledge"
	}
	if item.Kind == "baseline" {
		tab = "requirements"
	}
	query.Set("tab", tab)
	if item.RunID != "" {
		query.Set("runId", item.RunID)
	}
	if item.TaskID != "" {
		query.Set("taskId", item.TaskID)
	}
	item.Href = "/dashboard/project-executions/" + url.PathEscape(item.ProjectID) + "?" + query.Encode()
	return nil
}
