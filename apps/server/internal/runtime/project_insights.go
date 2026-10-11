// SPDX-License-Identifier: AGPL-3.0-or-later
package runtime

import (
	"context"
	"database/sql"
	"encoding/json"
	"errors"
	"fmt"
	"net/http"
	"time"

	"github.com/Moonrend/Zakura/apps/server/internal/platform/httpx"
	"github.com/Moonrend/Zakura/apps/server/internal/projectexec"
	"github.com/Moonrend/Zakura/packages/projectkit/insight"
	"github.com/Moonrend/Zakura/packages/projectkit/mission"
	"github.com/go-chi/chi/v5"
)

func (h *handler) registerProjectInsights(r chi.Router) {
	r.Get("/insights", h.projectInsights)
	r.Get("/runs/compare", h.projectInsightsCompare)
	r.Get("/runs/{rid}/insights", h.projectRunInsights)
	r.Post("/runs/{rid}/simulate", h.projectRunSimulate)
	r.Get("/runs/{rid}/insights/report", h.projectInsightReport)
}

// The existing project access middleware requires a tenant-scoped credential.
// Every record query repeats the tenant/project/run scope. Read-only analysis
// does not borrow runner credentials or dispatch an agent/model request.
func (h *handler) loadProjectInsight(ctx context.Context, tenant, pid, rid string) (insight.Evidence, error) {
	// A repeatable read makes events, state and counters one database snapshot.
	// Checking task revision after a normal read would falsely reject traces
	// whenever a heartbeat renewed a lease during a large event query.
	tx, err := h.deps.DB.BeginTx(ctx, &sql.TxOptions{ReadOnly: true, Isolation: sql.LevelRepeatableRead})
	if err != nil {
		return insight.Evidence{}, err
	}
	defer tx.Rollback()
	query := "SELECT run_json,project_json FROM execution_runs WHERE tenant_id=? AND project_id=? AND id=?"
	if h.deps.Rebind != nil {
		query = h.deps.Rebind(query)
	}
	var runRaw, projectRaw string
	if err := tx.QueryRowContext(ctx, query, tenant, pid, rid).Scan(&runRaw, &projectRaw); err != nil {
		if errors.Is(err, sql.ErrNoRows) {
			return insight.Evidence{}, projectexec.ErrNotFound
		}
		return insight.Evidence{}, err
	}
	var run mission.Run
	var project mission.Project
	if err := json.Unmarshal([]byte(runRaw), &run); err != nil {
		return insight.Evidence{}, err
	}
	if err := json.Unmarshal([]byte(projectRaw), &project); err != nil {
		return insight.Evidence{}, err
	}
	if len(project.Plan.Tasks) > insight.MaxTasks {
		return insight.Evidence{}, fmt.Errorf("insights support at most %d tasks in one frozen run", insight.MaxTasks)
	}
	tasks, err := projectInsightRecords[mission.Task](ctx, tx, h.deps.Rebind, "tasks", tenant, pid, rid, insight.MaxTasks+1)
	if err != nil {
		return insight.Evidence{}, err
	}
	events, err := projectInsightRecords[mission.Event](ctx, tx, h.deps.Rebind, "events", tenant, pid, rid, insight.MaxEvents+1)
	if err != nil {
		return insight.Evidence{}, err
	}
	operations, err := projectInsightRecords[mission.Operation](ctx, tx, h.deps.Rebind, "operations", tenant, pid, rid, insight.MaxOperations+1)
	if err != nil {
		return insight.Evidence{}, err
	}
	verifications, err := projectInsightRecords[mission.Verification](ctx, tx, h.deps.Rebind, "verifications", tenant, pid, rid, insight.MaxOperations+1)
	if err != nil {
		return insight.Evidence{}, err
	}
	reviews, err := projectInsightRecords[mission.Review](ctx, tx, h.deps.Rebind, "reviews", tenant, pid, rid, insight.MaxOperations+1)
	if err != nil {
		return insight.Evidence{}, err
	}
	if len(tasks) > insight.MaxTasks || len(operations) > insight.MaxOperations || len(verifications) > insight.MaxOperations || len(reviews) > insight.MaxOperations {
		return insight.Evidence{}, fmt.Errorf("run evidence exceeds the bounded insight record limit")
	}
	if err := tx.Commit(); err != nil {
		return insight.Evidence{}, err
	}
	truncated := len(events) > insight.MaxEvents
	if truncated {
		events = events[:insight.MaxEvents]
	}
	return insight.Evidence{Project: project, Run: run, Tasks: tasks, Events: events, Operations: operations, Verifications: verifications, Reviews: reviews, EventsTruncated: truncated}, nil
}

type projectInsightReader interface {
	QueryContext(context.Context, string, ...any) (*sql.Rows, error)
}

func projectInsightRecords[T any](ctx context.Context, db projectInsightReader, rebind func(string) string, kind, tenant, pid, rid string, limit int) ([]T, error) {
	table, column, order := "", "", ""
	switch kind {
	case "tasks":
		table, column, order = "execution_tasks", "task_json", "id"
	case "events":
		table, column, order = "execution_events", "event_json", "sequence"
	case "operations":
		table, column, order = "execution_operations", "operation_json", "created_at,id"
	case "verifications":
		table, column, order = "execution_verifications", "verification_json", "revision,id"
	case "reviews":
		table, column, order = "execution_reviews", "review_json", "created_at,id"
	default:
		return nil, fmt.Errorf("unsupported insight record kind")
	}
	query := "SELECT " + column + " FROM " + table + " WHERE tenant_id=? AND project_id=? AND run_id=? ORDER BY " + order + " LIMIT ?"
	if rebind != nil {
		query = rebind(query)
	}
	rows, err := db.QueryContext(ctx, query, tenant, pid, rid, limit)
	if err != nil {
		return nil, err
	}
	defer rows.Close()
	values := []T{}
	for rows.Next() {
		var raw string
		if err := rows.Scan(&raw); err != nil {
			return nil, err
		}
		var value T
		if err := json.Unmarshal([]byte(raw), &value); err != nil {
			return nil, fmt.Errorf("persisted insight evidence is invalid: %w", err)
		}
		values = append(values, value)
	}
	return values, rows.Err()
}

func (h *handler) loadProjectInsightHistory(ctx context.Context, tenant, pid string, limit int) ([]insight.Evidence, error) {
	runs, err := h.projects.ListRuns(ctx, tenant, pid, limit)
	if err != nil {
		return nil, err
	}
	values := make([]insight.Evidence, 0, len(runs))
	for _, run := range runs {
		if err := ctx.Err(); err != nil {
			return nil, err
		}
		value, err := h.loadProjectInsight(ctx, tenant, pid, run.ID)
		if err != nil {
			return nil, err
		}
		values = append(values, value)
	}
	return values, nil
}

func (h *handler) projectInsights(w http.ResponseWriter, r *http.Request) {
	ctx, cancel := context.WithTimeout(r.Context(), 30*time.Second)
	defer cancel()
	project, err := h.requestProject(r)
	if err != nil {
		projectHTTPError(w, err)
		return
	}
	history, err := h.loadProjectInsightHistory(ctx, project.TenantID, project.ID, projectQueryInt(r, "limit", 20, insight.MaxRuns))
	if err != nil {
		projectHTTPError(w, err)
		return
	}
	value, err := insight.AnalyzeProject(project, history)
	if err != nil {
		projectHTTPError(w, err)
		return
	}
	httpx.JSON(w, 200, value)
}

func (h *handler) projectRunInsights(w http.ResponseWriter, r *http.Request) {
	ctx, cancel := context.WithTimeout(r.Context(), 15*time.Second)
	defer cancel()
	evidence, err := h.loadProjectInsight(ctx, principal(r).TenantID, chi.URLParam(r, "pid"), chi.URLParam(r, "rid"))
	if err != nil {
		projectHTTPError(w, err)
		return
	}
	value, err := insight.Analyze(evidence)
	if err != nil {
		projectHTTPError(w, err)
		return
	}
	httpx.JSON(w, 200, value)
}

func (h *handler) projectInsightsCompare(w http.ResponseWriter, r *http.Request) {
	left, right := r.URL.Query().Get("left"), r.URL.Query().Get("right")
	if left == "" || right == "" || len(left) > 128 || len(right) > 128 {
		httpx.Error(w, 400, "Two bounded run IDs are required")
		return
	}
	ctx, cancel := context.WithTimeout(r.Context(), 30*time.Second)
	defer cancel()
	a, err := h.loadProjectInsight(ctx, principal(r).TenantID, chi.URLParam(r, "pid"), left)
	if err != nil {
		projectHTTPError(w, err)
		return
	}
	b, err := h.loadProjectInsight(ctx, principal(r).TenantID, chi.URLParam(r, "pid"), right)
	if err != nil {
		projectHTTPError(w, err)
		return
	}
	value, err := insight.Compare(a, b)
	if err != nil {
		projectHTTPError(w, err)
		return
	}
	httpx.JSON(w, 200, value)
}

func (h *handler) projectRunSimulate(w http.ResponseWriter, r *http.Request) {
	var body insight.SimulationRequest
	r.Body = http.MaxBytesReader(w, r.Body, 2<<20)
	if httpx.DecodeJSON(r, &body) != nil {
		httpx.Error(w, 400, "Invalid or oversized simulation JSON")
		return
	}
	if len(body.Scenarios) < 1 || len(body.Scenarios) > insight.MaxScenarios {
		httpx.Error(w, 400, "Supply 1 to 8 simulation scenarios")
		return
	}
	ctx, cancel := context.WithTimeout(r.Context(), 30*time.Second)
	defer cancel()
	target, err := h.loadProjectInsight(ctx, principal(r).TenantID, chi.URLParam(r, "pid"), chi.URLParam(r, "rid"))
	if err != nil {
		projectHTTPError(w, err)
		return
	}
	history, err := h.loadProjectInsightHistory(ctx, target.Project.TenantID, target.Project.ID, 20)
	if err != nil {
		projectHTTPError(w, err)
		return
	}
	value, err := insight.Simulate(target, history, body)
	if err != nil {
		projectHTTPError(w, err)
		return
	}
	httpx.JSON(w, 200, value)
}

func (h *handler) projectInsightReport(w http.ResponseWriter, r *http.Request) {
	format := r.URL.Query().Get("format")
	if format == "" {
		format = "json"
	}
	if format != "json" && format != "markdown" {
		httpx.Error(w, 400, "Report format must be json or markdown")
		return
	}
	ctx, cancel := context.WithTimeout(r.Context(), 15*time.Second)
	defer cancel()
	evidence, err := h.loadProjectInsight(ctx, principal(r).TenantID, chi.URLParam(r, "pid"), chi.URLParam(r, "rid"))
	if err != nil {
		projectHTTPError(w, err)
		return
	}
	value, err := insight.Analyze(evidence)
	if err != nil {
		projectHTTPError(w, err)
		return
	}
	w.Header().Set("Cache-Control", "private, no-store")
	w.Header().Set("X-Content-Type-Options", "nosniff")
	// The filename is constant so even malformed persisted IDs cannot inject a header.
	if format == "json" {
		w.Header().Set("Content-Disposition", `attachment; filename="project-execution-insights.json"`)
		httpx.JSON(w, 200, value)
		return
	}
	w.Header().Set("Content-Disposition", `attachment; filename="project-execution-insights.md"`)
	w.Header().Set("Content-Type", "text/markdown; charset=utf-8")
	_, _ = w.Write([]byte(insight.Markdown(value)))
}
