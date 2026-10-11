// SPDX-License-Identifier: AGPL-3.0-or-later
package runtime

import (
	"context"
	"database/sql"
	"encoding/json"
	"errors"
	"fmt"
	"log/slog"
	"net/http"
	"strconv"
	"strings"
	"time"

	"github.com/Moonrend/Zakura/apps/server/internal/platform/httpx"
	"github.com/Moonrend/Zakura/apps/server/internal/projectexec"
	"github.com/Moonrend/Zakura/packages/projectkit/mission"
	"github.com/Moonrend/Zakura/packages/projectkit/plan"
	"github.com/Moonrend/Zakura/packages/projectkit/workspace"
	"github.com/go-chi/chi/v5"
)

func (h *handler) initializeProjectExecutions() {
	h.projects = projectexec.NewStore(h.deps.DB, h.deps.Dialect, h.deps.Rebind)
	h.projectBridge = &projectBridge{h: h}
	cfg := projectexec.DefaultEngineConfig()
	cfg.OnError = func(err error) { slog.Warn("project execution worker", "error", err) }
	h.projectEngine = projectexec.NewEngine(h.projects, h.projectBridge, h.projectBridge, cfg)
	if h.deps.Context == nil {
		h.projectStartErr = errors.New("project execution requires an application lifetime context")
		return
	}
	h.projectStartErr = h.projectEngine.Start(h.deps.RunContext())
	if h.projectStartErr != nil {
		slog.Error("project execution engine could not start", "error", h.projectStartErr)
	}
}

func (h *handler) guardProjectManagedSession(next http.Handler) http.Handler {
	return http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		if r.Method != http.MethodGet && r.Method != http.MethodHead {
			parts := strings.Split(strings.Trim(r.URL.Path, "/"), "/")
			if len(parts) >= 6 && parts[0] == "api" && parts[1] == "agents" && parts[3] == "cloud" && parts[4] == "sessions" {
				sess, err := h.store.GetSession(r.Context(), principal(r).TenantID, parts[2], parts[5])
				if err == nil && sess.Kind == "project" {
					httpx.Error(w, http.StatusConflict, "This session is controlled by its project execution. Use project task controls.")
					return
				}
			}
		}
		next.ServeHTTP(w, r)
	})
}

func (h *handler) registerProjectExecutions(r chi.Router) {
	r.Route("/project-executions", func(p chi.Router) {
		p.Use(h.projectAccess)
		p.Get("/", h.projectList)
		p.Post("/", h.projectCreate)
		p.Route("/{pid}", func(p chi.Router) {
			h.registerProjectKnowledge(p)
			h.registerProjectSemantics(p)
			h.registerProjectInsights(p)
			h.registerProjectDeliveries(p)
			h.registerProjectRequirements(p)
			h.registerProjectRefactors(p)
			h.registerProjectSignoffs(p)
			h.registerProjectContexts(p)
			p.Get("/", h.projectGet)
			p.Patch("/", h.projectUpdate)
			p.Delete("/", h.projectDelete)
			p.Post("/plan/validate", h.projectValidatePlan)
			p.Post("/plan/compare", h.projectComparePlan)
			p.Post("/plan/replan", h.projectReplan)
			p.Get("/events", h.projectEvents)
			p.Get("/branches", h.projectBranches)
			p.Get("/policy", h.projectPolicy)
			p.Get("/source/activities", h.projectSourceActivities)
			p.Post("/source/quiescence", h.projectSourceConfirm)
			p.Get("/source/attestations", h.projectSourceAttestations)
			p.Post("/source/attestations/{aid}/inspect", h.projectSourceInspect)
			p.Get("/branches/{bid}/files", h.projectBranchFiles)
			p.Get("/branches/{bid}/file", h.projectBranchFile)
			p.Get("/snapshots/{snapshot}/file", h.projectSnapshotFile)
			p.Get("/runs", h.projectRuns)
			p.Post("/runs", h.projectStartRun)
			p.Route("/runs/{rid}", func(p chi.Router) {
				p.Get("/", h.projectRunGet)
				p.Post("/pause", h.projectRunControl)
				p.Post("/resume", h.projectRunControl)
				p.Post("/cancel", h.projectRunControl)
				p.Post("/fork", h.projectRunFork)
				p.Get("/schedule", h.projectSchedule)
				p.Get("/compare", h.projectCompareTasks)
				p.Get("/tasks/{tid}", h.projectTaskGet)
				p.Post("/tasks/{tid}/retry", h.projectTaskRetry)
				p.Post("/tasks/{tid}/reviews", h.projectTaskReview)
				p.Post("/operations/{oid}/resolve", h.projectResolveOperation)
				h.registerProjectMerges(p)
			})
		})
	})
}

func (h *handler) projectAccess(next http.Handler) http.Handler {
	return http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		p := principal(r)
		if p.TenantID == "" {
			httpx.Error(w, 401, "Tenant context required")
			return
		}
		if p.AgentID != "" || p.SpaceID != "" {
			httpx.Error(w, 403, "Project execution requires tenant-scoped credentials")
			return
		}
		if r.Method != http.MethodGet && r.Method != http.MethodHead && p.Role != "owner" && p.Role != "admin" && p.Role != "member" && !p.APIKey {
			httpx.Error(w, 403, "Write access required")
			return
		}
		if h.projects == nil || h.projectEngine == nil || h.projectStartErr != nil {
			httpx.Error(w, 503, "Project execution engine is unavailable")
			return
		}
		next.ServeHTTP(w, r)
	})
}

func projectHTTPError(w http.ResponseWriter, err error) {
	var validation *plan.ValidationError
	switch {
	case errors.As(err, &validation):
		httpx.JSON(w, 422, map[string]any{"error": validation.Error(), "issues": validation.Issues})
	case errors.Is(err, projectexec.ErrNotFound), errors.Is(err, ErrNotFound), errors.Is(err, workspace.ErrNotFound):
		httpx.Error(w, 404, "Project execution resource not found")
	case errors.Is(err, projectexec.ErrConflict), errors.Is(err, projectexec.ErrLeaseLost), errors.Is(err, projectexec.ErrInvalidState), errors.Is(err, workspace.ErrConflict):
		httpx.Error(w, 409, err.Error())
	case errors.Is(err, projectexec.ErrBudgetExceeded):
		httpx.Error(w, 409, "Project execution budget exhausted")
	case errors.Is(err, projectexec.ErrTenantDraining):
		httpx.Error(w, 409, "Tenant deletion has fenced new project work; inspect and resolve outstanding effects before retrying deletion")
	case errors.Is(err, context.DeadlineExceeded):
		httpx.Error(w, 504, "Project operation timed out")
	case errors.Is(err, context.Canceled):
		httpx.Error(w, 408, "Project request cancelled")
	default:
		httpx.Error(w, 400, err.Error())
	}
}

func projectQueryInt(r *http.Request, key string, fallback, max int) int {
	v, err := strconv.Atoi(r.URL.Query().Get(key))
	if err != nil || v <= 0 {
		return fallback
	}
	if v > max {
		return max
	}
	return v
}

func (h *handler) requestProject(r *http.Request) (mission.Project, error) {
	return h.projects.GetProject(r.Context(), principal(r).TenantID, chi.URLParam(r, "pid"))
}
func projectScope(p mission.Project) mission.Scope {
	return mission.Scope{TenantID: p.TenantID, SpaceID: p.SpaceID, ProjectID: p.ID}
}

func (h *handler) validateProjectAgents(ctx context.Context, p mission.Project) error {
	if _, err := h.store.GetSpace(ctx, p.TenantID, p.SpaceID); err != nil {
		return err
	}
	if err := plan.ValidatePlan(p.Plan, p.Config); err != nil {
		return err
	}
	for _, spec := range p.Plan.Tasks {
		agent, err := h.store.GetAgent(ctx, p.TenantID, spec.AgentID)
		if err != nil {
			return err
		}
		if agent.SpaceID != p.SpaceID {
			return fmt.Errorf("task %s agent belongs to another space", spec.ID)
		}
		var config struct {
			Runtime string `json:"runtime"`
		}
		_ = json.Unmarshal(agent.Config, &config)
		if config.Runtime == "acp" {
			return fmt.Errorf("task %s requires a gateway agent; ACP providers do not expose durable tool checkpoints", spec.ID)
		}
	}
	return nil
}

type projectDefinitionBody struct {
	SpaceID          string         `json:"spaceId"`
	Name             string         `json:"name"`
	Goal             string         `json:"goal"`
	Plan             mission.Plan   `json:"plan"`
	Config           mission.Config `json:"config"`
	ExpectedRevision int64          `json:"expectedRevision,omitempty"`
}

func (h *handler) projectList(w http.ResponseWriter, r *http.Request) {
	items, err := h.projects.ListProjects(r.Context(), principal(r).TenantID, r.URL.Query().Get("spaceId"), projectQueryInt(r, "limit", 100, 1000))
	if err != nil {
		projectHTTPError(w, err)
		return
	}
	httpx.JSON(w, 200, map[string]any{"items": items})
}
func (h *handler) projectCreate(w http.ResponseWriter, r *http.Request) {
	var body projectDefinitionBody
	if httpx.DecodeJSON(r, &body) != nil {
		httpx.Error(w, 400, "Invalid project JSON")
		return
	}
	p := mission.Project{TenantID: principal(r).TenantID, SpaceID: body.SpaceID, Name: body.Name, Goal: body.Goal, Plan: body.Plan, Config: body.Config, CreatedBy: principal(r).UserID}
	if principal(r).APIKey {
		p.CreatedBy = ""
	}
	if err := h.validateProjectAgents(r.Context(), p); err != nil {
		projectHTTPError(w, err)
		return
	}
	p, err := h.projects.CreateProject(r.Context(), p)
	if err != nil {
		projectHTTPError(w, err)
		return
	}
	httpx.JSON(w, 201, p)
}
func (h *handler) projectGet(w http.ResponseWriter, r *http.Request) {
	p, err := h.requestProject(r)
	if err != nil {
		projectHTTPError(w, err)
		return
	}
	analysis, err := plan.Analyze(p.Plan, p.Config)
	if err != nil {
		projectHTTPError(w, err)
		return
	}
	httpx.JSON(w, 200, map[string]any{"project": p, "analysis": analysis})
}
func (h *handler) projectUpdate(w http.ResponseWriter, r *http.Request) {
	if h.rejectCampaignManagedProject(w, r, chi.URLParam(r, "pid")) {
		return
	}
	old, err := h.requestProject(r)
	if err != nil {
		projectHTTPError(w, err)
		return
	}
	var body projectDefinitionBody
	if httpx.DecodeJSON(r, &body) != nil {
		httpx.Error(w, 400, "Invalid project JSON")
		return
	}
	if body.SpaceID != "" && body.SpaceID != old.SpaceID {
		httpx.Error(w, 409, "A project cannot move between spaces")
		return
	}
	p := old
	p.Name = body.Name
	p.Goal = body.Goal
	p.Plan = body.Plan
	p.Config = body.Config
	if err := h.validateProjectAgents(r.Context(), p); err != nil {
		projectHTTPError(w, err)
		return
	}
	p, err = h.projects.UpdateProject(r.Context(), old.TenantID, old.ID, body.ExpectedRevision, p)
	if err != nil {
		projectHTTPError(w, err)
		return
	}
	httpx.JSON(w, 200, p)
}
func (h *handler) projectDelete(w http.ResponseWriter, r *http.Request) {
	if h.rejectCampaignManagedProject(w, r, chi.URLParam(r, "pid")) || h.rejectCampaignSourceDeletion(w, r, chi.URLParam(r, "pid")) {
		return
	}
	var body struct {
		ExpectedRevision int64 `json:"expectedRevision"`
	}
	if httpx.DecodeJSON(r, &body) != nil {
		httpx.Error(w, 400, "Expected revision required")
		return
	}
	if err := h.projects.DeleteProject(r.Context(), principal(r).TenantID, chi.URLParam(r, "pid"), body.ExpectedRevision, func(tx *sql.Tx) error {
		var sourcePending int
		if err := tx.QueryRowContext(r.Context(), h.deps.Rebind(`SELECT COUNT(*) FROM execution_source_attestations WHERE tenant_id=? AND project_id=? AND status IN ('pending','unknown')`), principal(r).TenantID, chi.URLParam(r, "pid")).Scan(&sourcePending); err != nil {
			return err
		}
		if sourcePending > 0 {
			return fmt.Errorf("%w: inspect outstanding source writer attestations before deleting their audit", projectexec.ErrConflict)
		}
		var unresolved int
		if err := tx.QueryRowContext(r.Context(), h.deps.Rebind(`SELECT COUNT(*) FROM execution_merge_previews WHERE tenant_id=? AND project_id=? AND status IN ('applying','unknown')`), principal(r).TenantID, chi.URLParam(r, "pid")).Scan(&unresolved); err != nil {
			return err
		}
		if unresolved > 0 {
			return fmt.Errorf("%w: unresolved publication must be reconciled before deleting its audit history", projectexec.ErrInvalidState)
		}
		return nil
	}); err != nil {
		projectHTTPError(w, err)
		return
	}
	httpx.JSON(w, 200, map[string]any{"ok": true})
}

type projectPlanBody struct {
	Plan   mission.Plan    `json:"plan"`
	Config *mission.Config `json:"config,omitempty"`
	RunID  string          `json:"runId,omitempty"`
}

func (h *handler) projectValidatePlan(w http.ResponseWriter, r *http.Request) {
	p, err := h.requestProject(r)
	if err != nil {
		projectHTTPError(w, err)
		return
	}
	var body projectPlanBody
	if httpx.DecodeJSON(r, &body) != nil {
		httpx.Error(w, 400, "Invalid plan JSON")
		return
	}
	p.Plan = body.Plan
	if body.Config != nil {
		p.Config = *body.Config
	}
	if err := h.validateProjectAgents(r.Context(), p); err != nil {
		projectHTTPError(w, err)
		return
	}
	analysis, err := plan.Analyze(p.Plan, p.Config)
	if err != nil {
		projectHTTPError(w, err)
		return
	}
	httpx.JSON(w, 200, analysis)
}
func (h *handler) projectComparePlan(w http.ResponseWriter, r *http.Request) {
	p, err := h.requestProject(r)
	if err != nil {
		projectHTTPError(w, err)
		return
	}
	var body projectPlanBody
	if httpx.DecodeJSON(r, &body) != nil {
		httpx.Error(w, 400, "Invalid plan JSON")
		return
	}
	config := p.Config
	if body.Config != nil {
		config = *body.Config
	}
	out, err := plan.Compare(p.Plan, body.Plan, config, plan.CompareOptions{})
	if err != nil {
		projectHTTPError(w, err)
		return
	}
	httpx.JSON(w, 200, out)
}
func (h *handler) projectReplan(w http.ResponseWriter, r *http.Request) {
	p, err := h.requestProject(r)
	if err != nil {
		projectHTTPError(w, err)
		return
	}
	var body projectPlanBody
	if httpx.DecodeJSON(r, &body) != nil {
		httpx.Error(w, 400, "Invalid plan JSON")
		return
	}
	config := p.Config
	if body.Config != nil {
		config = *body.Config
	}
	var tasks []mission.Task
	base := p.Plan
	if body.RunID != "" {
		frozen, e := h.projects.GetRunProject(r.Context(), p.TenantID, p.ID, body.RunID)
		if e != nil {
			projectHTTPError(w, e)
			return
		}
		base = frozen.Plan
		tasks, e = h.projects.ListTasks(r.Context(), p.TenantID, p.ID, body.RunID)
		if e != nil {
			projectHTTPError(w, e)
			return
		}
	}
	out, err := plan.Replan(base, body.Plan, tasks, config)
	if err != nil {
		projectHTTPError(w, err)
		return
	}
	httpx.JSON(w, 200, out)
}

func (h *handler) projectRuns(w http.ResponseWriter, r *http.Request) {
	items, err := h.projects.ListRuns(r.Context(), principal(r).TenantID, chi.URLParam(r, "pid"), projectQueryInt(r, "limit", 100, 1000))
	if err != nil {
		projectHTTPError(w, err)
		return
	}
	httpx.JSON(w, 200, map[string]any{"items": items})
}
func (h *handler) projectStartRun(w http.ResponseWriter, r *http.Request) {
	if h.rejectCampaignManagedProject(w, r, chi.URLParam(r, "pid")) {
		return
	}
	p, err := h.requestProject(r)
	if err != nil {
		projectHTTPError(w, err)
		return
	}
	var body struct {
		ExpectedRevision int64 `json:"expectedRevision"`
	}
	if httpx.DecodeJSON(r, &body) != nil {
		httpx.Error(w, 400, "Expected project revision required")
		return
	}
	if body.ExpectedRevision != p.Revision {
		projectHTTPError(w, projectexec.ErrConflict)
		return
	}
	if err := h.validateProjectAgents(r.Context(), p); err != nil {
		projectHTTPError(w, err)
		return
	}
	ctx, cancel := context.WithTimeout(r.Context(), 90*time.Second)
	defer cancel()
	base, err := h.projectBridge.Base(ctx, projectScope(p))
	if err != nil {
		projectHTTPError(w, err)
		return
	}
	run, err := h.projects.CreateRun(ctx, p.TenantID, p.ID, base, body.ExpectedRevision)
	if err != nil {
		projectHTTPError(w, err)
		return
	}
	httpx.JSON(w, 201, run)
}
func (h *handler) projectRunGet(w http.ResponseWriter, r *http.Request) {
	p, err := h.requestProject(r)
	if err != nil {
		projectHTTPError(w, err)
		return
	}
	rid := chi.URLParam(r, "rid")
	run, err := h.projects.GetRun(r.Context(), p.TenantID, p.ID, rid)
	if err != nil {
		projectHTTPError(w, err)
		return
	}
	tasks, err := h.projects.ListTasks(r.Context(), p.TenantID, p.ID, rid)
	if err != nil {
		projectHTTPError(w, err)
		return
	}
	frozen, err := h.projects.GetRunProject(r.Context(), p.TenantID, p.ID, rid)
	if err != nil {
		projectHTTPError(w, err)
		return
	}
	analysis, err := plan.Analyze(frozen.Plan, frozen.Config)
	if err != nil {
		projectHTTPError(w, err)
		return
	}
	httpx.JSON(w, 200, map[string]any{"run": run, "tasks": tasks, "project": frozen, "analysis": analysis})
}

func (h *handler) projectRunFork(w http.ResponseWriter, r *http.Request) {
	if h.rejectCampaignManagedProject(w, r, chi.URLParam(r, "pid")) {
		return
	}
	var body struct {
		ExpectedProjectRevision int64 `json:"expectedProjectRevision"`
	}
	if httpx.DecodeJSON(r, &body) != nil {
		httpx.Error(w, 400, "Expected current project revision required")
		return
	}
	run, err := h.projects.ForkRun(r.Context(), principal(r).TenantID, chi.URLParam(r, "pid"), chi.URLParam(r, "rid"), body.ExpectedProjectRevision)
	if err != nil {
		projectHTTPError(w, err)
		return
	}
	httpx.JSON(w, 201, run)
}
func (h *handler) projectRunControl(w http.ResponseWriter, r *http.Request) {
	if strings.HasSuffix(r.URL.Path, "/resume") && h.rejectCampaignManagedProject(w, r, chi.URLParam(r, "pid")) {
		return
	}
	var body struct {
		ExpectedRevision int64 `json:"expectedRevision"`
	}
	if httpx.DecodeJSON(r, &body) != nil {
		httpx.Error(w, 400, "Expected run revision required")
		return
	}
	tenant, pid, rid := principal(r).TenantID, chi.URLParam(r, "pid"), chi.URLParam(r, "rid")
	var run mission.Run
	var err error
	switch pathAction := r.URL.Path[strings.LastIndex(r.URL.Path, "/")+1:]; pathAction {
	case "pause":
		run, err = h.projectEngine.Pause(r.Context(), tenant, pid, rid, body.ExpectedRevision)
	case "resume":
		run, err = h.projectEngine.Resume(r.Context(), tenant, pid, rid, body.ExpectedRevision)
	case "cancel":
		run, err = h.projectEngine.Cancel(r.Context(), tenant, pid, rid, body.ExpectedRevision)
	default:
		err = projectexec.ErrInvalidState
	}
	if err != nil {
		projectHTTPError(w, err)
		return
	}
	httpx.JSON(w, 200, run)
}
func (h *handler) projectSchedule(w http.ResponseWriter, r *http.Request) {
	tenant, pid, rid := principal(r).TenantID, chi.URLParam(r, "pid"), chi.URLParam(r, "rid")
	p, err := h.projects.GetRunProject(r.Context(), tenant, pid, rid)
	if err != nil {
		projectHTTPError(w, err)
		return
	}
	run, err := h.projects.GetRun(r.Context(), tenant, pid, rid)
	if err != nil {
		projectHTTPError(w, err)
		return
	}
	tasks, err := h.projects.ListTasks(r.Context(), tenant, pid, rid)
	if err != nil {
		projectHTTPError(w, err)
		return
	}
	out, err := plan.ScheduleCandidates(p.Plan, tasks, p.Config, plan.ScheduleOptions{Now: time.Now().UTC(), Used: plan.Usage{Tokens: run.Tokens, ModelCalls: run.ModelCalls, ToolCalls: run.ToolCalls, WallSeconds: int(time.Since(run.CreatedAt).Seconds())}})
	if err != nil {
		projectHTTPError(w, err)
		return
	}
	httpx.JSON(w, 200, out)
}
func (h *handler) projectTaskGet(w http.ResponseWriter, r *http.Request) {
	p, err := h.requestProject(r)
	if err != nil {
		projectHTTPError(w, err)
		return
	}
	rid, tid := chi.URLParam(r, "rid"), chi.URLParam(r, "tid")
	task, err := h.projects.GetTask(r.Context(), p.TenantID, p.ID, rid, tid)
	if err != nil {
		projectHTTPError(w, err)
		return
	}
	cp, err := h.projects.GetCheckpoint(r.Context(), projectScope(p), rid, tid)
	if err != nil && !errors.Is(err, projectexec.ErrNotFound) {
		projectHTTPError(w, err)
		return
	}
	ops, err := h.projects.ListOperations(r.Context(), p.TenantID, p.ID, rid, tid)
	if err != nil {
		projectHTTPError(w, err)
		return
	}
	verifications, err := h.projects.ListVerifications(r.Context(), p.TenantID, p.ID, rid, tid)
	if err != nil {
		projectHTTPError(w, err)
		return
	}
	reviews, err := h.projects.ListReviews(r.Context(), p.TenantID, p.ID, rid, tid)
	if err != nil {
		projectHTTPError(w, err)
		return
	}
	httpx.JSON(w, 200, map[string]any{"task": task, "checkpoint": cp, "operations": ops, "verifications": verifications, "reviews": reviews})
}
func (h *handler) projectTaskRetry(w http.ResponseWriter, r *http.Request) {
	if h.rejectCampaignManagedProject(w, r, chi.URLParam(r, "pid")) {
		return
	}
	var body struct {
		ExpectedRevision int64 `json:"expectedRevision"`
	}
	if httpx.DecodeJSON(r, &body) != nil {
		httpx.Error(w, 400, "Expected task revision required")
		return
	}
	task, err := h.projectEngine.RetryTask(r.Context(), principal(r).TenantID, chi.URLParam(r, "pid"), chi.URLParam(r, "rid"), chi.URLParam(r, "tid"), body.ExpectedRevision)
	if err != nil {
		projectHTTPError(w, err)
		return
	}
	httpx.JSON(w, 200, task)
}
func (h *handler) projectTaskReview(w http.ResponseWriter, r *http.Request) {
	var body struct {
		SnapshotID string `json:"snapshotId"`
		Decision   string `json:"decision"`
		Comment    string `json:"comment"`
	}
	if httpx.DecodeJSON(r, &body) != nil {
		httpx.Error(w, 400, "Invalid review JSON")
		return
	}
	p := principal(r)
	if p.UserID == "" || p.APIKey || p.OAuth || p.SessionID == "" {
		httpx.Error(w, 403, "Human reviews require an authenticated member session")
		return
	}
	review, err := h.projects.RecordReview(r.Context(), p.TenantID, chi.URLParam(r, "pid"), chi.URLParam(r, "rid"), mission.Review{TaskID: chi.URLParam(r, "tid"), SnapshotID: body.SnapshotID, Decision: body.Decision, AuthorID: p.UserID, Comment: body.Comment})
	if err != nil {
		projectHTTPError(w, err)
		return
	}
	httpx.JSON(w, 201, review)
}
func (h *handler) projectResolveOperation(w http.ResponseWriter, r *http.Request) {
	var body struct {
		ExpectedRevision int64           `json:"expectedRevision"`
		Decision         string          `json:"decision"`
		Result           json.RawMessage `json:"result,omitempty"`
		Error            string          `json:"error,omitempty"`
		Comment          string          `json:"comment"`
	}
	if httpx.DecodeJSON(r, &body) != nil {
		httpx.Error(w, 400, "Invalid operation resolution JSON")
		return
	}
	p := principal(r)
	if p.UserID == "" || p.APIKey || p.OAuth || p.SessionID == "" {
		httpx.Error(w, 403, "Operation attestations require an authenticated member session")
		return
	}
	op, err := h.projects.ResolveOperation(r.Context(), p.TenantID, chi.URLParam(r, "pid"), chi.URLParam(r, "rid"), chi.URLParam(r, "oid"), body.ExpectedRevision, projectexec.Resolution{Decision: body.Decision, Result: body.Result, Error: body.Error, Comment: body.Comment, AuthorID: p.UserID})
	if err != nil {
		projectHTTPError(w, err)
		return
	}
	httpx.JSON(w, 200, op)
}
func (h *handler) projectEvents(w http.ResponseWriter, r *http.Request) {
	after, err := strconv.ParseInt(r.URL.Query().Get("after"), 10, 64)
	if err != nil && r.URL.Query().Get("after") != "" || after < 0 {
		httpx.Error(w, 400, "Invalid event cursor")
		return
	}
	items, err := h.projects.ListEvents(r.Context(), principal(r).TenantID, chi.URLParam(r, "pid"), r.URL.Query().Get("runId"), after, projectQueryInt(r, "limit", 200, 1000))
	if err != nil {
		projectHTTPError(w, err)
		return
	}
	cursor := after
	for _, event := range items {
		if event.Sequence > cursor {
			cursor = event.Sequence
		}
	}
	httpx.JSON(w, 200, map[string]any{"items": items, "cursor": cursor})
}

func (h *handler) projectReadRPC(w http.ResponseWriter, r *http.Request, method string, args map[string]any) {
	p, err := h.requestProject(r)
	if err != nil {
		projectHTTPError(w, err)
		return
	}
	ctx, cancel := context.WithTimeout(r.Context(), 30*time.Second)
	defer cancel()
	var out json.RawMessage
	if err := h.projectBridge.rpc(ctx, projectScope(p), method, args, &out); err != nil {
		projectHTTPError(w, err)
		return
	}
	httpx.JSON(w, 200, out)
}
func (h *handler) projectBranches(w http.ResponseWriter, r *http.Request) {
	h.projectReadRPC(w, r, "project.branches", nil)
}
func (h *handler) projectPolicy(w http.ResponseWriter, r *http.Request) {
	h.projectReadRPC(w, r, "project.policy", nil)
}
func (h *handler) projectBranchFiles(w http.ResponseWriter, r *http.Request) {
	h.projectReadRPC(w, r, "project.branch.list", map[string]any{"branchId": chi.URLParam(r, "bid"), "path": r.URL.Query().Get("path")})
}
func (h *handler) projectBranchFile(w http.ResponseWriter, r *http.Request) {
	h.projectReadRPC(w, r, "project.branch.read", map[string]any{"branchId": chi.URLParam(r, "bid"), "path": r.URL.Query().Get("path"), "maxBytes": 262144})
}
func (h *handler) projectSnapshotFile(w http.ResponseWriter, r *http.Request) {
	h.projectReadRPC(w, r, "project.snapshot.read", map[string]any{"snapshotId": chi.URLParam(r, "snapshot"), "path": r.URL.Query().Get("path"), "maxBytes": 262144})
}
func (h *handler) projectCompareTasks(w http.ResponseWriter, r *http.Request) {
	p, err := h.requestProject(r)
	if err != nil {
		projectHTTPError(w, err)
		return
	}
	rid := chi.URLParam(r, "rid")
	left, err := h.projects.GetTask(r.Context(), p.TenantID, p.ID, rid, r.URL.Query().Get("leftTask"))
	if err != nil {
		projectHTTPError(w, err)
		return
	}
	right, err := h.projects.GetTask(r.Context(), p.TenantID, p.ID, rid, r.URL.Query().Get("rightTask"))
	if err != nil {
		projectHTTPError(w, err)
		return
	}
	if left.SnapshotID == "" || right.SnapshotID == "" {
		httpx.Error(w, 409, "Both tasks need captured artifacts before comparison")
		return
	}
	var diff []workspace.Change
	if err := h.projectBridge.rpc(r.Context(), projectScope(p), "project.branch.diff", map[string]any{"baseSnapshot": left.SnapshotID, "snapshotId": right.SnapshotID}, &diff); err != nil {
		projectHTTPError(w, err)
		return
	}
	lv, err := h.projects.ListVerifications(r.Context(), p.TenantID, p.ID, rid, left.ID)
	if err != nil {
		projectHTTPError(w, err)
		return
	}
	rv, err := h.projects.ListVerifications(r.Context(), p.TenantID, p.ID, rid, right.ID)
	if err != nil {
		projectHTTPError(w, err)
		return
	}
	httpx.JSON(w, 200, map[string]any{"left": left, "right": right, "diff": diff, "leftVerifications": lv, "rightVerifications": rv})
}
