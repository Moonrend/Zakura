package runtime

import (
	"context"
	"errors"
	"net/http"
	"strings"

	"github.com/Moonrend/Zakura/apps/server/internal/platform/httpx"
	"github.com/go-chi/chi/v5"
)

func (h *handler) serverComputerState(ctx context.Context, tenant, spaceID string) (map[string]any, error) {
	space, err := h.store.GetSpace(ctx, tenant, spaceID)
	if err != nil {
		return nil, err
	}
	computer, err := h.resolveServerComputer(ctx, tenant, spaceID)
	if err != nil {
		return nil, err
	}
	var lease struct {
		Token     string `json:"token" gorm:"column:token"`
		Operation string `json:"operation" gorm:"column:operation"`
		ExpiresAt int64  `json:"expiresAt" gorm:"column:expires_at"`
	}
	if err := h.deps.Gorm.WithContext(ctx).Table("computer_workspace_leases").Select("token,operation,expires_at").Where("space_id=? AND tenant_id=?", space.ID, tenant).Find(&lease).Error; err != nil {
		return nil, err
	}
	state := map[string]any{"computer": computer.computer, "space": map[string]any{"id": space.ID, "runtimeNodeId": space.RuntimeNodeID, "workspaceKind": space.WorkspaceKind, "workspaceImage": space.WorkspaceImage, "enableComputer": space.EnableComputer, "workspaceStatus": space.WorkspaceStatus, "lastError": space.LastError}}
	if lease.Token != "" {
		state["workspaceOperation"] = lease
	}
	return state, nil
}
func (h *handler) getServerComputer(w http.ResponseWriter, r *http.Request) {
	p := principal(r)
	spaceID := chi.URLParam(r, "id")
	if !computerScopeAllowed(p, spaceID, "") {
		httpx.Error(w, http.StatusForbidden, "computer scope denied")
		return
	}
	state, err := h.serverComputerState(r.Context(), p.TenantID, spaceID)
	if err != nil {
		computerStatusError(w, err)
		return
	}
	httpx.JSON(w, http.StatusOK, state)
}
func (h *handler) configureServerComputer(w http.ResponseWriter, r *http.Request) {
	if !h.manageComputerScope(w, r) {
		return
	}
	p := principal(r)
	spaceID := chi.URLParam(r, "id")
	var in workspaceConfig
	if httpx.DecodeJSON(r, &in) != nil {
		httpx.Error(w, http.StatusBadRequest, "invalid server computer configuration")
		return
	}
	space, err := h.store.GetSpace(r.Context(), p.TenantID, spaceID)
	if err != nil {
		statusErr(w, err)
		return
	}
	if in.RuntimeNodeID == nil || strings.TrimSpace(*in.RuntimeNodeID) == "" {
		httpx.Error(w, http.StatusBadRequest, "choose a runtime node")
		return
	}
	nodeID := strings.TrimSpace(*in.RuntimeNodeID)
	if err := h.authorizeLocalNode(r.Context(), p, nodeID); err != nil {
		statusErr(w, err)
		return
	}
	if space.RuntimeNodeID != nil && *space.RuntimeNodeID != "" {
		if nodeID != *space.RuntimeNodeID {
			httpx.Error(w, http.StatusConflict, "move the workspace through migration")
			return
		}
		// Initialization is idempotent, even while the existing workspace runs.
		state, err := h.serverComputerState(r.Context(), p.TenantID, spaceID)
		if err != nil {
			computerStatusError(w, err)
			return
		}
		httpx.JSON(w, http.StatusOK, state)
		return
	}
	var count int64
	if err := h.deps.Gorm.WithContext(r.Context()).Table("runtime_nodes").Where("id=? AND (tenant_id=? OR is_shared=TRUE) AND kind IN ('server','computer','local')", nodeID, p.TenantID).Count(&count).Error; err != nil {
		statusErr(w, err)
		return
	}
	if count != 1 {
		httpx.Error(w, http.StatusBadRequest, "runtime node is unavailable")
		return
	}
	image := serverComputerImage
	in = workspaceConfig{RuntimeNodeID: &nodeID, WorkspaceKind: "container", WorkspaceImage: &image, EnableComputer: true}
	lease, err := h.acquireSpaceWorkspace(r.Context(), p.TenantID, spaceID, "configuring", true, &in)
	if err != nil {
		h.serverComputerLifecycleError(w, err)
		return
	}
	defer lease.release()
	obs, err := h.observeSpaceWorkspace(r.Context(), lease.Space)
	if err != nil {
		h.serverComputerLifecycleError(w, workspaceRunnerError{err})
		return
	}
	if err = lease.recordObservation(r.Context(), obs); err != nil {
		h.serverComputerLifecycleError(w, err)
		return
	}
	if obs.Container.Status == "running" {
		_ = lease.finish(r.Context(), "running", nil)
		h.serverComputerLifecycleError(w, errWorkspaceStarting)
		return
	}
	old := lease.Space
	sameString := func(a, b *string) bool {
		if a == nil {
			return b == nil
		}
		return b != nil && *a == *b
	}
	if !sameString(old.RuntimeNodeID, in.RuntimeNodeID) || !sameString(old.WorkspaceImage, in.WorkspaceImage) || old.WorkspaceKind != in.WorkspaceKind || old.EnableComputer != in.EnableComputer {
		if err = lease.removeStoppedWorkspace(r.Context(), obs); err != nil {
			h.serverComputerLifecycleError(w, err)
			return
		}
	}
	if err = lease.applyConfig(r.Context(), in); err != nil {
		h.serverComputerLifecycleError(w, err)
		return
	}
	state, err := h.serverComputerState(r.Context(), p.TenantID, spaceID)
	if err != nil {
		computerStatusError(w, err)
		return
	}
	httpx.JSON(w, http.StatusOK, state)
}
func (h *handler) startServerComputer(w http.ResponseWriter, r *http.Request) {
	if !h.manageComputerScope(w, r) {
		return
	}
	p := principal(r)
	space, err := h.store.GetSpace(r.Context(), p.TenantID, chi.URLParam(r, "id"))
	if err == nil && space.RuntimeNodeID != nil {
		err = h.authorizeLocalNode(r.Context(), p, *space.RuntimeNodeID)
	}
	if err == nil {
		err = h.startSpaceWorkspace(r.Context(), space)
	}
	if err != nil {
		h.serverComputerLifecycleError(w, err)
		return
	}
	state, err := h.serverComputerState(r.Context(), p.TenantID, space.ID)
	if err != nil {
		statusErr(w, err)
		return
	}
	httpx.JSON(w, http.StatusOK, state)
}
func (h *handler) stopServerComputer(w http.ResponseWriter, r *http.Request) {
	if !h.manageComputerScope(w, r) {
		return
	}
	p := principal(r)
	space, err := h.store.GetSpace(r.Context(), p.TenantID, chi.URLParam(r, "id"))
	if err == nil && space.RuntimeNodeID != nil {
		err = h.authorizeLocalNode(r.Context(), p, *space.RuntimeNodeID)
	}
	if err == nil {
		err = h.stopSpaceWorkspace(r.Context(), space)
	}
	if err != nil {
		h.serverComputerLifecycleError(w, err)
		return
	}
	state, err := h.serverComputerState(r.Context(), p.TenantID, space.ID)
	if err != nil {
		statusErr(w, err)
		return
	}
	httpx.JSON(w, http.StatusOK, state)
}

var errWorkspaceNodeRequired = errors.New("bind a runtime node before starting the workspace")
var errWorkspaceStarting = errors.New("workspace operation in progress; retry shortly")

type workspaceRunnerError struct{ error }

func (h *handler) serverComputerLifecycleError(w http.ResponseWriter, err error) {
	var runnerErr workspaceRunnerError
	switch {
	case errors.Is(err, errWorkspaceNodeRequired), errors.Is(err, errWorkspaceStarting), errors.Is(err, errWorkspaceLeaseLost):
		httpx.Error(w, http.StatusConflict, err.Error())
	case errors.As(err, &runnerErr):
		httpx.Error(w, http.StatusBadGateway, err.Error())
	default:
		statusErr(w, err)
	}
}
func (h *handler) startSpaceWorkspace(ctx context.Context, space Space) error {
	lease, err := h.acquireSpaceWorkspace(ctx, space.TenantID, space.ID, "starting", false, nil)
	if err != nil {
		return err
	}
	defer lease.release()
	if err = h.startSpaceWorkspaceWithLease(ctx, lease); err != nil {
		return err
	}
	return lease.finish(ctx, "running", map[string]any{"last_error": nil})
}

// Migration keeps its original claim across stop, transfer and restart.
func (h *handler) startSpaceWorkspaceWithLease(ctx context.Context, lease *workspaceLease) error {
	space := lease.Space
	if err := lease.check(ctx); err != nil {
		return err
	}
	if space.RuntimeNodeID == nil || *space.RuntimeNodeID == "" {
		return errWorkspaceNodeRequired
	}
	runner, err := h.hub.get(*space.RuntimeNodeID)
	if err != nil {
		return err
	}
	obs, err := h.observeSpaceWorkspace(ctx, space)
	if err != nil {
		// Observation cannot create or stop a workspace. Retain the durable
		// claim only after an ambiguous lifecycle effect, not a failed preflight.
		return workspaceRunnerError{err}
	}
	op, err := h.workspaceCreateOperation(ctx, space)
	if err != nil {
		return err
	}
	if op != nil {
		if err := h.reconcileWorkspaceCreate(ctx, lease, runner, op, obs); err != nil {
			return lease.uncertain(err)
		}
	} else if obs.Container.DockerID == "" {
		for _, row := range obs.Rows {
			if row.DockerID != nil && *row.DockerID != "" {
				return lease.uncertain(errors.New("the previously recorded workspace could not be confirmed"))
			}
		}
	}
	if err = lease.recordObservation(ctx, obs); err != nil {
		return err
	}
	var mkdir struct {
		Abs string `json:"abs"`
	}
	if err = runner.call(ctx, "host.fs.mkdir", map[string]any{"spaceId": space.ID, "path": "/"}, &mkdir); err != nil {
		return workspaceRunnerError{err}
	}
	if space.WorkspaceKind != "host" {
		if strings.TrimSpace(mkdir.Abs) == "" {
			return workspaceRunnerError{errors.New("runtime node returned no workspace path")}
		}
		if obs.Container.DockerID != "" && obs.Container.Status != "running" {
			if err = lease.check(ctx); err != nil {
				return err
			}
			lease.retained = true
			if err = runner.call(ctx, "docker.start", map[string]any{"id": obs.Container.DockerID}, nil); err != nil {
				return lease.uncertain(err)
			}
		} else if obs.Container.DockerID == "" {
			image := serverComputerImage
			if space.WorkspaceImage != nil && strings.TrimSpace(*space.WorkspaceImage) != "" {
				image = strings.TrimSpace(*space.WorkspaceImage)
			}
			if err = runner.call(ctx, "docker.pull", map[string]any{"image": image}, nil); err != nil {
				// A pull is safe to repeat and has not created the workspace.
				return workspaceRunnerError{err}
			}
			if err = lease.check(ctx); err != nil {
				return err
			}
			display := "0"
			if space.EnableComputer {
				display = "1"
			}
			op, err = h.beginWorkspaceCreate(ctx, lease, runner)
			if err != nil {
				return err
			}
			lease.retained = true
			if err = runner.call(ctx, "docker.create", map[string]any{
				"name": op.Name, "image": image, "operation": op.wire(),
				"env":     map[string]string{"ZAKURA_SPACE_ID": space.ID, "ZAKURA_ENABLE_COMPUTER": display, "ZAKURA_ENABLE_BROWSER": display},
				"labels":  map[string]string{"zakura.tenant": space.TenantID, "zakura.space": space.ID, "zakura.computer": op.ComputerID, "zakura.purpose": "workspace"},
				"volumes": []map[string]any{{"hostPath": mkdir.Abs, "containerPath": "/workspace"}}, "ports": []any{}, "workingDir": "/workspace", "restart": "unless-stopped",
			}, nil); err != nil {
				return lease.uncertain(err)
			}
		}
		obs, err = h.observeSpaceWorkspace(ctx, space)
		if err != nil {
			return lease.uncertain(err)
		}
		if obs.Container.DockerID == "" || obs.Container.Status != "running" {
			return lease.uncertain(errors.New("workspace container did not start"))
		}
		if op != nil {
			if err := h.reconcileWorkspaceCreate(ctx, lease, runner, op, obs); err != nil {
				return lease.uncertain(err)
			}
		}
		if err = lease.recordObservation(ctx, obs); err != nil {
			return lease.uncertain(err)
		}
	}
	return nil
}

// Configuration removes only a verified stopped container, never bind-mounted files.
func (l *workspaceLease) removeStoppedWorkspace(ctx context.Context, obs workspaceObservation) error {
	if obs.Container.DockerID == "" {
		return nil
	}
	if obs.Container.Status == "running" {
		return errWorkspaceStarting
	}
	if err := l.check(ctx); err != nil {
		return err
	}
	runner, err := l.h.hub.get(*l.Space.RuntimeNodeID)
	if err != nil {
		return err
	}
	l.retained = true
	if err = runner.call(ctx, "docker.stop", map[string]any{"id": obs.Container.DockerID, "remove": true}, nil); err != nil {
		return l.uncertain(err)
	}
	after, err := l.h.observeSpaceWorkspace(ctx, l.Space)
	if err != nil {
		return l.uncertain(err)
	}
	if after.Container.DockerID != "" {
		return l.uncertain(errors.New("workspace container removal is not confirmed"))
	}
	return l.recordObservation(ctx, after)
}
func (h *handler) stopSpaceWorkspace(ctx context.Context, space Space) error {
	lease, err := h.acquireSpaceWorkspace(ctx, space.TenantID, space.ID, "stopping", false, nil)
	if err != nil {
		return err
	}
	defer lease.release()
	if err = h.stopSpaceWorkspaceWithLease(ctx, lease); err != nil {
		return err
	}
	return lease.finish(ctx, "stopped", map[string]any{"last_error": nil})
}

func (h *handler) stopSpaceWorkspaceWithLease(ctx context.Context, lease *workspaceLease) error {
	space := lease.Space
	if err := lease.check(ctx); err != nil {
		return err
	}
	if err := h.closeSpaceWorkspaceBridges(ctx, space.TenantID, space.ID); err != nil {
		return lease.uncertain(err)
	}
	if err := h.recoverWorkspaceConnections(ctx, lease); err != nil {
		return lease.uncertain(err)
	}
	obs, err := h.observeSpaceWorkspace(ctx, space)
	if err != nil {
		// Observation cannot create or stop a workspace. Retain the durable
		// claim only after an ambiguous lifecycle effect, not a failed preflight.
		return workspaceRunnerError{err}
	}
	if err = lease.recordObservation(ctx, obs); err != nil {
		return err
	}
	if obs.Container.DockerID != "" {
		if err = lease.check(ctx); err != nil {
			return err
		}
		runner, err := h.hub.get(*space.RuntimeNodeID)
		if err != nil {
			return err
		}
		lease.retained = true
		if err = runner.call(ctx, "docker.stop", map[string]any{"id": obs.Container.DockerID, "remove": false}, nil); err != nil {
			return lease.uncertain(err)
		}
		obs, err = h.observeSpaceWorkspace(ctx, space)
		if err != nil {
			return lease.uncertain(err)
		}
		if obs.Container.Status == "running" {
			return lease.uncertain(errors.New("workspace container stop is not confirmed"))
		}
		if err = lease.recordObservation(ctx, obs); err != nil {
			return lease.uncertain(err)
		}
	}
	return nil
}
