// SPDX-License-Identifier: AGPL-3.0-or-later
package runtime

import (
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"net/http"
	"strings"
	"time"

	"github.com/Moonrend/Zakura/apps/server/internal/platform/httpx"
	"github.com/Moonrend/Zakura/apps/server/internal/projectcampaign"
	"github.com/Moonrend/Zakura/apps/server/internal/projectexec"
	"github.com/Moonrend/Zakura/packages/projectkit/blueprint"
	"github.com/Moonrend/Zakura/packages/projectkit/campaign"
	"github.com/Moonrend/Zakura/packages/projectkit/mission"
	"github.com/go-chi/chi/v5"
)

func (h *handler) registerProjectCampaigns(r chi.Router) {
	r.Route("/project-campaigns", func(c chi.Router) {
		c.Use(h.projectAccess)
		c.Get("/", h.campaignList)
		c.Post("/", h.campaignCreate)
		c.Route("/{cid}", func(c chi.Router) {
			c.Get("/", h.campaignGet)
			c.Get("/audit", h.campaignAudit)
			c.Post("/provision", h.campaignProvision)
			c.Post("/freeze", h.campaignFreeze)
			c.Post("/inspect", h.campaignInspect)
			c.Post("/control", h.campaignControl)
			c.Post("/variants/{vid}/copy", h.campaignCopy)
			c.Post("/variants/{vid}/start", h.campaignStart)
			c.Post("/variants/{vid}/retry-start", h.campaignRetryStart)
		})
	})
}
func (h *handler) campaignStore() *projectcampaign.Store {
	return projectcampaign.NewStore(h.deps.DB, h.deps.Dialect, h.deps.Rebind)
}

func campaignHTTPError(w http.ResponseWriter, err error) {
	switch {
	case errors.Is(err, projectcampaign.ErrNotFound):
		httpx.Error(w, 404, "Project campaign not found")
	case errors.Is(err, projectcampaign.ErrConflict):
		httpx.Error(w, 409, "Campaign revision or state changed; reload before applying this action")
	case errors.Is(err, projectcampaign.ErrActiveLimit):
		httpx.Error(w, 409, err.Error())
	default:
		templateHTTPError(w, err)
	}
}

func (h *handler) rejectCampaignManagedProject(w http.ResponseWriter, r *http.Request, pid string) bool {
	managed, err := h.campaignStore().Managed(r.Context(), principal(r).TenantID, pid)
	if err != nil {
		campaignHTTPError(w, err)
		return true
	}
	if managed {
		httpx.Error(w, 409, "This project is frozen by an experiment campaign; use campaign controls to preserve its reserved budget and comparable definition")
		return true
	}
	return false
}
func (h *handler) rejectCampaignSourceDeletion(w http.ResponseWriter, r *http.Request, pid string) bool {
	referenced, err := h.campaignStore().SourceReferenced(r.Context(), principal(r).TenantID, pid)
	if err != nil {
		campaignHTTPError(w, err)
		return true
	}
	if referenced {
		httpx.Error(w, 409, "This project is referenced by experiment campaigns; preserve their source and audit records")
		return true
	}
	return false
}

func (h *handler) campaignList(w http.ResponseWriter, r *http.Request) {
	items, err := h.campaignStore().List(r.Context(), principal(r).TenantID, r.URL.Query().Get("sourceProjectId"), projectQueryInt(r, "limit", 100, 1000))
	if err != nil {
		campaignHTTPError(w, err)
		return
	}
	httpx.JSON(w, 200, map[string]any{"items": items})
}

type campaignCreateBody struct {
	Name                     string                     `json:"name"`
	SourceProjectID          string                     `json:"sourceProjectId"`
	TemplateID               string                     `json:"templateId"`
	TemplateVersion          int                        `json:"templateVersion,omitempty"`
	ExpectedTemplateRevision int64                      `json:"expectedTemplateRevision"`
	BaselineID               string                     `json:"baselineId"`
	Budget                   mission.Budget             `json:"budget"`
	Parameters               map[string]json.RawMessage `json:"parameters"`
	Variants                 []campaign.VariantSpec     `json:"variants"`
}

func (h *handler) campaignCreate(w http.ResponseWriter, r *http.Request) {
	var body campaignCreateBody
	if err := templateDecode(r, &body); err != nil {
		campaignHTTPError(w, err)
		return
	}
	source, err := h.projects.GetProject(r.Context(), principal(r).TenantID, body.SourceProjectID)
	if err != nil {
		campaignHTTPError(w, err)
		return
	}
	version, err := h.templateStore().Select(r.Context(), source.TenantID, body.TemplateID, body.ExpectedTemplateRevision, body.TemplateVersion)
	if err != nil {
		campaignHTTPError(w, err)
		return
	}
	d, err := campaign.Freeze(campaign.FrozenRequest{Name: body.Name, SourceProjectID: source.ID, TemplateID: body.TemplateID, TemplateVersion: version.Version, BaselineID: body.BaselineID, Budget: body.Budget, Blueprint: version.Definition, Inputs: blueprint.Inputs{SpaceID: source.SpaceID, Parameters: body.Parameters}, Variants: body.Variants})
	if err != nil {
		campaignHTTPError(w, err)
		return
	}
	for i := range d.Variants {
		p := &d.Variants[i].Project
		p.TenantID = source.TenantID
		p.CreatedBy = templateAuthor(r)
		if err = h.validateProjectAgents(r.Context(), *p); err != nil {
			campaignHTTPError(w, err)
			return
		}
	}
	c, err := h.campaignStore().Create(r.Context(), source.TenantID, source.SpaceID, templateAuthor(r), d)
	if err != nil {
		campaignHTTPError(w, err)
		return
	}
	c, details, err := h.provisionCampaign(r.Context(), c, templateAuthor(r), c.Revision)
	if err != nil {
		httpx.JSON(w, 201, map[string]any{"campaign": c, "provision": details, "error": err.Error()})
		return
	}
	httpx.JSON(w, 201, c)
}

func (h *handler) provisionCampaign(ctx context.Context, c campaign.Campaign, author string, expected int64) (campaign.Campaign, []campaignControlResult, error) {
	store := h.campaignStore()
	current, err := store.BeginProvision(ctx, c.TenantID, c.ID, author, expected)
	if err != nil {
		return c, nil, err
	}
	results := []campaignControlResult{}
	for _, v := range current.Definition.Variants {
		if v.State != "prepared" {
			continue
		}
		p, err := h.projects.GetProject(ctx, current.TenantID, v.Project.ID)
		if errors.Is(err, projectexec.ErrNotFound) {
			p, err = h.projects.CreateProject(ctx, v.Project)
			if err != nil {
				existing, e := h.projects.GetProject(ctx, current.TenantID, v.Project.ID)
				if e == nil {
					p = existing
					err = nil
				}
			}
		}
		row := campaignControlResult{VariantID: v.ID, Status: "provisioned"}
		if err == nil && campaign.ProjectHash(p) != v.DefinitionHash {
			err = fmt.Errorf("existing project differs from frozen variant")
		}
		if err == nil {
			current, err = store.Provisioned(ctx, c.TenantID, c.ID, v.ID, p)
		}
		if err != nil {
			row.Status = "failed"
			row.Error = err.Error()
		}
		results = append(results, row)
	}
	finished, e := store.FinishProvision(ctx, c.TenantID, c.ID, author, results)
	if e != nil {
		return current, results, e
	}
	return finished, results, nil
}

type campaignActionBody struct {
	ExpectedRevision int64  `json:"expectedRevision"`
	Confirmation     string `json:"confirmation,omitempty"`
	Comment          string `json:"comment,omitempty"`
	Action           string `json:"action,omitempty"`
}

func campaignAction(w http.ResponseWriter, r *http.Request, human bool) (campaignActionBody, bool) {
	var body campaignActionBody
	if human && !projectHumanReviewer(w, r) {
		return body, false
	}
	if err := templateDecode(r, &body); err != nil {
		campaignHTTPError(w, err)
		return body, false
	}
	if body.ExpectedRevision < 1 {
		httpx.Error(w, 400, "expectedRevision must be positive")
		return body, false
	}
	if human && (strings.TrimSpace(body.Comment) == "" || len(body.Comment) > 4096) {
		httpx.Error(w, 400, "A human comment of 1 to 4096 bytes is required")
		return body, false
	}
	return body, true
}

func (h *handler) campaignProvision(w http.ResponseWriter, r *http.Request) {
	body, ok := campaignAction(w, r, false)
	if !ok {
		return
	}
	c, err := h.campaignStore().Get(r.Context(), principal(r).TenantID, chi.URLParam(r, "cid"))
	if err != nil {
		campaignHTTPError(w, err)
		return
	}
	c, results, err := h.provisionCampaign(r.Context(), c, templateAuthor(r), body.ExpectedRevision)
	if err != nil {
		campaignHTTPError(w, err)
		return
	}
	httpx.JSON(w, 200, map[string]any{"campaign": c, "results": results})
}

func (h *handler) campaignObservations(ctx context.Context, c campaign.Campaign) []campaign.Observation {
	items := []campaign.Observation{}
	for _, v := range c.Definition.Variants {
		o := campaign.Observation{VariantID: v.ID}
		if v.RunID != "" {
			run, err := h.projects.GetRun(ctx, c.TenantID, v.Project.ID, v.RunID)
			if err == nil {
				o.Run = &run
				if run.BaseSnapshot != c.BaseSnapshot {
					o.Error = "run uses a different common campaign base"
				}
				p, e := h.projects.GetRunProject(ctx, c.TenantID, v.Project.ID, v.RunID)
				if e == nil {
					o.Project = &p
				} else {
					o.Error = e.Error()
				}
				o.Tasks, e = h.projects.ListTasks(ctx, c.TenantID, v.Project.ID, v.RunID)
				if e != nil {
					o.Error = e.Error()
				}
				o.Verifications, e = h.projects.ListVerifications(ctx, c.TenantID, v.Project.ID, v.RunID)
				if e != nil {
					o.Error = e.Error()
				}
			} else {
				o.Error = err.Error()
			}
		}
		items = append(items, o)
	}
	return items
}

func (h *handler) campaignGet(w http.ResponseWriter, r *http.Request) {
	c, err := h.campaignStore().Get(r.Context(), principal(r).TenantID, chi.URLParam(r, "cid"))
	if err != nil {
		campaignHTTPError(w, err)
		return
	}
	httpx.JSON(w, 200, map[string]any{"campaign": c, "comparison": campaign.Compare(c.Definition, h.campaignObservations(r.Context(), c), time.Now().UTC())})
}
func (h *handler) campaignAudit(w http.ResponseWriter, r *http.Request) {
	items, err := h.campaignStore().Audit(r.Context(), principal(r).TenantID, chi.URLParam(r, "cid"), projectQueryInt(r, "limit", 100, 1000))
	if err != nil {
		campaignHTTPError(w, err)
		return
	}
	httpx.JSON(w, 200, map[string]any{"items": items})
}

type campaignReceipt struct {
	Known  bool            `json:"known"`
	Status string          `json:"status"`
	Result json.RawMessage `json:"result"`
	Error  string          `json:"error"`
}
type campaignSnapshotResult struct {
	SnapshotID string `json:"snapshotId"`
}

func (h *handler) campaignFreeze(w http.ResponseWriter, r *http.Request) {
	body, ok := campaignAction(w, r, true)
	if !ok {
		return
	}
	if body.Confirmation != "freeze" {
		httpx.Error(w, 400, "Explicit freeze confirmation is required")
		return
	}
	store := h.campaignStore()
	c, err := store.Capture(r.Context(), principal(r).TenantID, chi.URLParam(r, "cid"), templateAuthor(r), body.Comment, body.ExpectedRevision)
	if err != nil {
		campaignHTTPError(w, err)
		return
	}
	ctx, cancel := context.WithTimeout(r.Context(), 90*time.Second)
	defer cancel()
	var out campaignSnapshotResult
	err = h.projectBridge.rpc(ctx, mission.Scope{TenantID: c.TenantID, SpaceID: c.SpaceID, ProjectID: c.Definition.SourceProjectID}, "project.base", map[string]any{"operationId": c.CaptureOperationID}, &out)
	state, message := "ready", ""
	if err != nil || out.SnapshotID == "" {
		state = "unknown"
		if err != nil {
			message = err.Error()
		} else {
			message = "runner returned no snapshot identity"
		}
	}
	finishCtx, finishCancel := context.WithTimeout(context.WithoutCancel(r.Context()), 10*time.Second)
	defer finishCancel()
	c, finishErr := store.CaptureResult(finishCtx, c.TenantID, c.ID, c.CaptureOperationID, out.SnapshotID, state, message, templateAuthor(r), body.Comment)
	if finishErr != nil {
		campaignHTTPError(w, finishErr)
		return
	}
	if state == "ready" {
		for _, v := range c.Definition.Variants {
			c, err = h.copyCampaign(ctx, c, v.ID, templateAuthor(r), c.Revision)
			if err != nil {
				break
			}
		}
	}
	httpx.JSON(w, 200, map[string]any{"campaign": c, "error": errorString(err)})
}

func errorString(err error) string {
	if err == nil {
		return ""
	}
	return err.Error()
}

func (h *handler) copyCampaign(ctx context.Context, c campaign.Campaign, vid, author string, expected int64) (campaign.Campaign, error) {
	store := h.campaignStore()
	current, err := store.Copy(ctx, c.TenantID, c.ID, vid, author, expected)
	if err != nil {
		return c, err
	}
	var target campaign.Variant
	for _, v := range current.Definition.Variants {
		if v.ID == vid {
			target = v
		}
	}
	// The source and target are frozen tenant-scoped project identities. The
	// runner copy never accepts another space or arbitrary filesystem root.
	source, err := h.projects.GetProject(ctx, current.TenantID, current.Definition.SourceProjectID)
	if err != nil || source.SpaceID != current.SpaceID {
		return current, fmt.Errorf("campaign source project is unavailable")
	}
	var out campaignSnapshotResult
	rpcErr := h.projectBridge.rpc(ctx, projectScope(target.Project), "project.snapshot.copy", map[string]any{"operationId": target.CopyOperationID, "sourceProjectId": source.ID, "snapshotId": current.BaseSnapshot}, &out)
	state, message := "ready", ""
	if rpcErr != nil || out.SnapshotID != current.BaseSnapshot {
		state = "copy_unknown"
		message = errorString(rpcErr)
		if message == "" {
			message = "runner copy returned a different snapshot"
		}
	}
	finishCtx, cancel := context.WithTimeout(context.WithoutCancel(ctx), 10*time.Second)
	defer cancel()
	return store.CopyResult(finishCtx, current.TenantID, current.ID, vid, target.CopyOperationID, out.SnapshotID, state, message, author, "")
}

func (h *handler) campaignCopy(w http.ResponseWriter, r *http.Request) {
	body, ok := campaignAction(w, r, true)
	if !ok {
		return
	}
	c, err := h.campaignStore().Get(r.Context(), principal(r).TenantID, chi.URLParam(r, "cid"))
	if err != nil {
		campaignHTTPError(w, err)
		return
	}
	ctx, cancel := context.WithTimeout(r.Context(), 90*time.Second)
	defer cancel()
	c, err = h.copyCampaign(ctx, c, chi.URLParam(r, "vid"), templateAuthor(r), body.ExpectedRevision)
	if err != nil {
		campaignHTTPError(w, err)
		return
	}
	httpx.JSON(w, 200, c)
}

func (h *handler) campaignStart(w http.ResponseWriter, r *http.Request) {
	h.startCampaignVariant(w, r, false)
}
func (h *handler) campaignRetryStart(w http.ResponseWriter, r *http.Request) {
	h.startCampaignVariant(w, r, true)
}

func (h *handler) startCampaignVariant(w http.ResponseWriter, r *http.Request, retry bool) {
	body, ok := campaignAction(w, r, true)
	if !ok {
		return
	}
	if body.Confirmation != "start" {
		httpx.Error(w, 400, "Explicit start confirmation is required")
		return
	}
	store := h.campaignStore()
	var c campaign.Campaign
	var err error
	tenant, cid, vid := principal(r).TenantID, chi.URLParam(r, "cid"), chi.URLParam(r, "vid")
	if retry {
		c, err = store.RetryStart(r.Context(), tenant, cid, vid, templateAuthor(r), body.Comment, body.ExpectedRevision)
	} else {
		c, err = store.Start(r.Context(), tenant, cid, vid, templateAuthor(r), body.Comment, body.ExpectedRevision)
	}
	if err != nil {
		campaignHTTPError(w, err)
		return
	}
	var target campaign.Variant
	for _, v := range c.Definition.Variants {
		if v.ID == vid {
			target = v
		}
	}
	run, createErr := h.projects.CreateRunOnce(r.Context(), tenant, target.Project.ID, c.BaseSnapshot, target.Project.Revision, target.RunID)
	state, message := "started", ""
	if createErr != nil {
		state = "start_unknown"
		message = createErr.Error()
	}
	finishCtx, cancel := context.WithTimeout(context.WithoutCancel(r.Context()), 10*time.Second)
	defer cancel()
	c, err = store.StartResult(finishCtx, tenant, cid, vid, target.RunID, state, message, templateAuthor(r), body.Comment)
	if err != nil {
		campaignHTTPError(w, err)
		return
	}
	httpx.JSON(w, 200, map[string]any{"campaign": c, "run": run, "error": message})
}

func (h *handler) campaignInspect(w http.ResponseWriter, r *http.Request) {
	body, ok := campaignAction(w, r, true)
	if !ok {
		return
	}
	store := h.campaignStore()
	c, err := store.Get(r.Context(), principal(r).TenantID, chi.URLParam(r, "cid"))
	if err != nil {
		campaignHTTPError(w, err)
		return
	}
	if c.Revision != body.ExpectedRevision {
		campaignHTTPError(w, projectcampaign.ErrConflict)
		return
	}
	ctx, cancel := context.WithTimeout(r.Context(), 90*time.Second)
	defer cancel()
	results := []campaignControlResult{}
	if c.CaptureState == "capturing" || c.CaptureState == "unknown" {
		var receipt campaignReceipt
		err = h.projectBridge.rpc(ctx, mission.Scope{TenantID: c.TenantID, SpaceID: c.SpaceID, ProjectID: c.Definition.SourceProjectID}, "project.operation.inspect", map[string]any{"operationId": c.CaptureOperationID}, &receipt)
		if err == nil && receipt.Known {
			var snapshot campaignSnapshotResult
			state := "unknown"
			if receipt.Status == "completed" && json.Unmarshal(receipt.Result, &snapshot) == nil && snapshot.SnapshotID != "" {
				state = "ready"
			} else if receipt.Status == "failed" {
				state = "failed"
			}
			c, err = store.CaptureResult(ctx, c.TenantID, c.ID, c.CaptureOperationID, snapshot.SnapshotID, state, receipt.Error, templateAuthor(r), body.Comment)
		}
		results = append(results, campaignControlResult{Status: c.CaptureState, Error: errorString(err)})
	}
	for _, v := range c.Definition.Variants {
		switch v.State {
		case "copying", "copy_unknown":
			var receipt campaignReceipt
			err = h.projectBridge.rpc(ctx, projectScope(v.Project), "project.operation.inspect", map[string]any{"operationId": v.CopyOperationID}, &receipt)
			if err == nil && receipt.Known {
				var snapshot campaignSnapshotResult
				state := "copy_unknown"
				if receipt.Status == "completed" && json.Unmarshal(receipt.Result, &snapshot) == nil && snapshot.SnapshotID == c.BaseSnapshot {
					state = "ready"
				} else if receipt.Status == "failed" {
					state = "copy_failed"
				}
				c, err = store.CopyResult(ctx, c.TenantID, c.ID, v.ID, v.CopyOperationID, snapshot.SnapshotID, state, receipt.Error, templateAuthor(r), body.Comment)
			}
		case "starting", "start_unknown":
			run, e := h.projects.GetRun(ctx, c.TenantID, v.Project.ID, v.RunID)
			err = e
			if errors.Is(e, projectexec.ErrNotFound) && v.State == "starting" {
				c, err = store.StartResult(ctx, c.TenantID, c.ID, v.ID, v.RunID, "start_unknown", "No committed run receipt was observed; inspect or explicitly retry the same reserved run identity", templateAuthor(r), body.Comment)
			}
			if e == nil {
				frozen, e := h.projects.GetRunProject(ctx, c.TenantID, v.Project.ID, v.RunID)
				if e != nil || run.BaseSnapshot != c.BaseSnapshot || campaign.ProjectHash(frozen) != v.DefinitionHash {
					err = fmt.Errorf("reserved run does not match frozen campaign grant")
				} else {
					c, err = store.StartResult(ctx, c.TenantID, c.ID, v.ID, v.RunID, "started", "", templateAuthor(r), body.Comment)
				}
			}
		default:
			continue
		}
		results = append(results, campaignControlResult{VariantID: v.ID, RunID: v.RunID, Status: "inspected", Error: errorString(err)})
	}
	if c.Status == "controlling" {
		observed := []campaignControlResult{}
		for _, v := range c.Definition.Variants {
			if v.RunID == "" {
				continue
			}
			run, e := h.projects.GetRun(ctx, c.TenantID, v.Project.ID, v.RunID)
			row := campaignControlResult{VariantID: v.ID, RunID: v.RunID, Status: run.Status, Error: errorString(e)}
			if errors.Is(e, projectexec.ErrNotFound) && c.ControlAction == "cancel" && campaignPendingStart(v.State) {
				c, e = store.CancelUnstarted(ctx, c.TenantID, c.ID, v.ID, v.RunID, templateAuthor(r), body.Comment)
				row.Status, row.Error = "cancelled_without_run", errorString(e)
			} else if errors.Is(e, projectexec.ErrNotFound) && (v.State == "starting" || v.State == "start_unknown") {
				c, e = store.StartResult(ctx, c.TenantID, c.ID, v.ID, v.RunID, "start_unknown", "No run was created before the control fence; starting requires an explicit retry of the same reserved identity", templateAuthor(r), body.Comment)
				row.Status, row.Error = "not_started", errorString(e)
			}
			if e == nil && row.Status != "cancelled_without_run" && row.Status != "not_started" && !campaign.Terminal(run.Status) {
				if c.ControlAction == "cancel" || c.ControlAction == "pause" && run.Status != "paused" || c.ControlAction == "resume" && run.Status == "paused" {
					row.Error = "requested control outcome has not been observed; retry the explicit control"
				}
			}
			observed = append(observed, row)
		}
		c, err = store.FinishControl(ctx, c.TenantID, c.ID, templateAuthor(r), body.Comment, observed)
		if err != nil {
			results = append(results, campaignControlResult{Status: "control_unknown", Error: err.Error()})
		}
	}
	httpx.JSON(w, 200, map[string]any{"campaign": c, "results": results})
}

type campaignControlResult struct {
	VariantID string `json:"variantId,omitempty"`
	RunID     string `json:"runId,omitempty"`
	Status    string `json:"status"`
	Error     string `json:"error,omitempty"`
}

func campaignPendingStart(state string) bool {
	return state == "starting" || state == "start_unknown" || state == "start_failed"
}

func (h *handler) campaignControl(w http.ResponseWriter, r *http.Request) {
	body, ok := campaignAction(w, r, true)
	if !ok {
		return
	}
	store := h.campaignStore()
	c, err := store.BeginControl(r.Context(), principal(r).TenantID, chi.URLParam(r, "cid"), templateAuthor(r), body.Comment, body.Action, body.ExpectedRevision)
	if err != nil {
		campaignHTTPError(w, err)
		return
	}
	results := []campaignControlResult{}
	for _, v := range c.Definition.Variants {
		if v.RunID == "" {
			continue
		}
		row := campaignControlResult{VariantID: v.ID, RunID: v.RunID}
		run, e := h.projects.GetRun(r.Context(), c.TenantID, v.Project.ID, v.RunID)
		if errors.Is(e, projectexec.ErrNotFound) && body.Action == "cancel" && campaignPendingStart(v.State) {
			c, e = store.CancelUnstarted(r.Context(), c.TenantID, c.ID, v.ID, v.RunID, templateAuthor(r), body.Comment)
			row.Status, row.Error = "cancelled_without_run", errorString(e)
			results = append(results, row)
			continue
		}
		if errors.Is(e, projectexec.ErrNotFound) && (v.State == "starting" || v.State == "start_unknown") {
			c, e = store.StartResult(r.Context(), c.TenantID, c.ID, v.ID, v.RunID, "start_unknown", "No run was created before the control fence; starting requires an explicit retry of the same reserved identity", templateAuthor(r), body.Comment)
			row.Status, row.Error = "not_started", errorString(e)
			results = append(results, row)
			continue
		}
		if e == nil {
			switch {
			case campaign.Terminal(run.Status):
			case body.Action == "pause" && run.Status != "paused":
				run, e = h.projectEngine.Pause(r.Context(), c.TenantID, v.Project.ID, run.ID, run.Revision)
			case body.Action == "resume" && run.Status == "paused":
				run, e = h.projectEngine.Resume(r.Context(), c.TenantID, v.Project.ID, run.ID, run.Revision)
			case body.Action == "cancel":
				run, e = h.projectEngine.Cancel(r.Context(), c.TenantID, v.Project.ID, run.ID, run.Revision)
			}
		}
		row.Status = run.Status
		if e != nil {
			row.Status = "unknown"
			row.Error = e.Error()
		}
		results = append(results, row)
	}
	finishCtx, cancel := context.WithTimeout(context.WithoutCancel(r.Context()), 10*time.Second)
	defer cancel()
	c, err = store.FinishControl(finishCtx, c.TenantID, c.ID, templateAuthor(r), body.Comment, results)
	if err != nil {
		campaignHTTPError(w, err)
		return
	}
	httpx.JSON(w, 200, map[string]any{"campaign": c, "results": results})
}
