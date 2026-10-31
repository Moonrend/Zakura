package runtime

import (
	"context"
	"database/sql"
	"encoding/hex"
	"encoding/json"
	"errors"
	"net/http"
	"strings"

	protocol "github.com/Moonrend/Zakura/apps/agent/workspace"
	"github.com/Moonrend/Zakura/apps/server/internal/platform/httpx"
	"github.com/Moonrend/Zakura/apps/server/internal/workspaces"
	"github.com/go-chi/chi/v5"
)

func (h *handler) workspaceStore() workspaces.Store {
	return workspaces.Store{DB: h.deps.DB, Rebind: h.deps.Rebind}
}

// Disks are tenant storage, not Space settings. A Space only selects a released
// disk when (re)creating its workspace.
func (h *handler) registerWorkspaceDisks(r chi.Router) {
	r.Get("/disks", h.listWorkspaceDisks)
	r.Post("/disks", h.createWorkspaceDisk)
	r.Patch("/disks/{diskId}", h.renameWorkspaceDisk)
	r.Post("/disks/{diskId}/refresh", h.refreshWorkspaceDisk)
	r.Delete("/disks/{diskId}", h.deleteWorkspaceDisk)
	r.Get("/spaces/{id}/workspace-cleanups/{operationId}", h.getWorkspaceCleanup)
}

// Managing tenant storage needs a tenant-wide principal; Space or Agent scoped
// keys must not create or delete disks other Spaces may use.
func (h *handler) manageDiskScope(w http.ResponseWriter, r *http.Request) bool {
	p := principal(r)
	if p.TenantID == "" || p.SpaceID != "" || p.AgentID != "" || (p.Role != "owner" && p.Role != "admin" && !p.IsPlatformAdmin) || (p.APIKey && !APIKeyScopeAllows(p, "computers:manage")) {
		httpx.Error(w, 403, "computer management permission required")
		return false
	}
	return true
}

func workspaceStatusError(w http.ResponseWriter, err error) {
	switch {
	case errors.Is(err, sql.ErrNoRows):
		httpx.Error(w, http.StatusNotFound, "workspace resource not found")
	case errors.Is(err, workspaces.ErrConflict), errors.Is(err, workspaces.ErrTargetRevoked), errors.Is(err, workspaces.ErrUnverified):
		httpx.Error(w, http.StatusConflict, err.Error())
	default:
		statusErr(w, err)
	}
}

func (h *handler) listWorkspaceDisks(w http.ResponseWriter, r *http.Request) {
	p := principal(r)
	if p.TenantID == "" || p.SpaceID != "" || p.AgentID != "" {
		httpx.Error(w, 403, "workspace scope denied")
		return
	}
	disks, err := h.workspaceStore().Disks(r.Context(), p.TenantID)
	if err != nil {
		workspaceStatusError(w, err)
		return
	}
	cleanups, err := h.workspaceStore().DiskCleanups(r.Context(), p.TenantID)
	if err != nil {
		workspaceStatusError(w, err)
		return
	}
	// Name the Space currently using each disk; an instance id alone is opaque.
	var rows []struct {
		Instance string `gorm:"column:instance_id"`
		Space    string `gorm:"column:space_id"`
		Name     string `gorm:"column:name"`
	}
	if err := h.deps.Gorm.WithContext(r.Context()).Table("workspace_instances i").Select("i.id AS instance_id,s.id AS space_id,s.name").Joins("JOIN spaces s ON s.id=i.space_id AND s.tenant_id=i.tenant_id").Where("i.tenant_id=? AND i.state<>'released'", p.TenantID).Scan(&rows).Error; err != nil {
		statusErr(w, err)
		return
	}
	spaces := make(map[string]map[string]string, len(rows))
	for _, row := range rows {
		spaces[row.Instance] = map[string]string{"id": row.Space, "name": row.Name}
	}
	out := make([]map[string]any, 0, len(disks))
	for _, d := range disks {
		item := object(d)
		item["attachedSpace"] = nil
		if d.AttachedInstanceID != nil {
			if space, ok := spaces[*d.AttachedInstanceID]; ok {
				item["attachedSpace"] = space
			}
		}
		out = append(out, item)
	}
	httpx.JSON(w, 200, map[string]any{"disks": out, "cleanups": cleanups})
}

func (h *handler) workspaceDiskNode(ctx context.Context, tenant, node string) (*runnerSession, string, error) {
	var incarnation string
	if err := h.deps.DB.QueryRowContext(ctx, h.deps.Rebind(`SELECT incarnation FROM runtime_nodes WHERE id=? AND (tenant_id=? OR is_shared=TRUE) AND kind IN ('server','computer')`), node, tenant).Scan(&incarnation); err != nil {
		return nil, "", err
	}
	if !protocol.ValidIdentity(incarnation) || strings.HasPrefix(incarnation, "legacy:") {
		return nil, "", workspaces.ErrUnverified
	}
	if h.hub == nil {
		return nil, "", errors.New("runtime node agent is offline")
	}
	runner, err := h.hub.get(node)
	if err != nil {
		return nil, "", err
	}
	var info struct {
		Capabilities struct {
			WorkspaceV2 bool `json:"workspaceProtocolV2"`
		} `json:"capabilities"`
	}
	if err := runner.call(ctx, "sys.info", map[string]any{}, &info); err != nil {
		return nil, "", err
	}
	if !info.Capabilities.WorkspaceV2 {
		return nil, "", errors.New("update the runtime node to support managed workspace disks")
	}
	if err := verifyWorkspaceNode(ctx, runner, incarnation); err != nil {
		return nil, "", err
	}
	return runner, incarnation, nil
}

func verifyWorkspaceNode(ctx context.Context, runner *runnerSession, incarnation string) error {
	var identity struct {
		Version     int    `json:"version"`
		Incarnation string `json:"incarnation"`
	}
	if err := runner.call(ctx, "workspace.identity", map[string]any{}, &identity); err != nil {
		return err
	}
	if identity.Version != 1 || identity.Incarnation != incarnation {
		return workspaces.ErrUnverified
	}
	return nil
}

func (h *handler) createWorkspaceDisk(w http.ResponseWriter, r *http.Request) {
	if !h.manageDiskScope(w, r) {
		return
	}
	var in struct {
		Name   string `json:"name"`
		NodeID string `json:"nodeId"`
	}
	if httpx.DecodeJSON(r, &in) != nil || strings.TrimSpace(in.Name) == "" || len(strings.TrimSpace(in.Name)) > 200 || !protocol.ValidIdentity(in.NodeID) {
		httpx.Error(w, 400, "disk name and nodeId required")
		return
	}
	p := principal(r)
	runner, incarnation, err := h.workspaceDiskNode(r.Context(), p.TenantID, in.NodeID)
	if err != nil {
		workspaceStatusError(w, err)
		return
	}
	disk, err := h.workspaceStore().RegisterDisk(r.Context(), p.TenantID, h.store.id(), in.Name, in.NodeID, incarnation, h.store.now())
	if err != nil {
		workspaceStatusError(w, err)
		return
	}
	if err := h.observeWorkspaceDisk(r.Context(), runner, disk); err != nil {
		// Allocation intent survives a lost reply. Refresh retries this exact disk.
		_ = h.workspaceStore().DiskError(r.Context(), disk, err, h.store.now())
	}
	disk, err = h.workspaceStore().Disk(r.Context(), p.TenantID, disk.ID)
	if err != nil {
		workspaceStatusError(w, err)
		return
	}
	httpx.JSON(w, http.StatusCreated, map[string]any{"disk": disk})
}

func (h *handler) observeWorkspaceDisk(ctx context.Context, runner *runnerSession, disk workspaces.Disk) error {
	method := "workspace.disk.usage"
	if disk.State == "pending" {
		method = "workspace.disk.allocate"
	}
	var result struct {
		Disk      protocol.Disk `json:"disk"`
		UsedBytes int64         `json:"usedBytes"`
	}
	if err := runner.call(ctx, method, disk.Wire(), &result); err != nil {
		return err
	}
	if result.Disk != disk.Wire() || result.UsedBytes < 0 {
		return workspaces.ErrUnverified
	}
	if disk.State == "pending" {
		return h.workspaceStore().VerifyDisk(ctx, disk, result.UsedBytes, h.store.now())
	}
	return h.workspaceStore().SampleUsage(ctx, disk, result.UsedBytes, h.store.now())
}

func (h *handler) refreshWorkspaceDisk(w http.ResponseWriter, r *http.Request) {
	if !h.manageDiskScope(w, r) {
		return
	}
	p, id := principal(r), chi.URLParam(r, "diskId")
	disk, err := h.workspaceStore().Disk(r.Context(), p.TenantID, id)
	if err != nil {
		workspaceStatusError(w, err)
		return
	}
	if disk.NodeRemovedAt != nil || disk.State != "pending" && disk.State != "available" && disk.State != "attached" {
		workspaceStatusError(w, workspaces.ErrConflict)
		return
	}
	runner, incarnation, err := h.workspaceDiskNode(r.Context(), p.TenantID, disk.NodeID)
	if err == nil && incarnation != disk.NodeIncarnation {
		err = workspaces.ErrUnverified
	}
	if err == nil {
		err = h.observeWorkspaceDisk(r.Context(), runner, disk)
	}
	if err != nil {
		workspaceStatusError(w, err)
		return
	}
	disk, err = h.workspaceStore().Disk(r.Context(), p.TenantID, id)
	if err != nil {
		workspaceStatusError(w, err)
		return
	}
	httpx.JSON(w, 200, map[string]any{"disk": disk})
}

func (h *handler) renameWorkspaceDisk(w http.ResponseWriter, r *http.Request) {
	if !h.manageDiskScope(w, r) {
		return
	}
	var in struct {
		Name string `json:"name"`
	}
	if httpx.DecodeJSON(r, &in) != nil || strings.TrimSpace(in.Name) == "" || len(strings.TrimSpace(in.Name)) > 200 {
		httpx.Error(w, 400, "disk name required (maximum 200 bytes)")
		return
	}
	p, id := principal(r), chi.URLParam(r, "diskId")
	if err := h.workspaceStore().RenameDisk(r.Context(), p.TenantID, id, in.Name, h.store.now()); err != nil {
		workspaceStatusError(w, err)
		return
	}
	disk, err := h.workspaceStore().Disk(r.Context(), p.TenantID, id)
	if err != nil {
		workspaceStatusError(w, err)
		return
	}
	httpx.JSON(w, 200, map[string]any{"disk": disk})
}

func (h *handler) deleteWorkspaceDisk(w http.ResponseWriter, r *http.Request) {
	if !h.manageDiskScope(w, r) {
		return
	}
	var in struct {
		RequestID string `json:"requestId"`
	}
	if httpx.DecodeJSON(r, &in) != nil || !protocol.ValidIdentity(in.RequestID) {
		httpx.Error(w, 400, "requestId required")
		return
	}
	p, id := principal(r), chi.URLParam(r, "diskId")
	operation, err := h.workspaceStore().DeleteDisk(r.Context(), p.TenantID, id, in.RequestID, h.store.id(), h.store.now())
	if err != nil {
		workspaceStatusError(w, err)
		return
	}
	httpx.JSON(w, http.StatusAccepted, map[string]any{"operationId": operation.ID, "operation": operation})
}

func (h *handler) getWorkspaceCleanup(w http.ResponseWriter, r *http.Request) {
	p, space := principal(r), chi.URLParam(r, "id")
	if !computerScopeAllowed(p, space, "") {
		httpx.Error(w, 403, "workspace scope denied")
		return
	}
	if _, err := h.store.GetSpace(r.Context(), p.TenantID, space); err != nil {
		statusErr(w, err)
		return
	}
	operation, err := h.workspaceStore().Cleanup(r.Context(), p.TenantID, space, chi.URLParam(r, "operationId"))
	if err != nil {
		workspaceStatusError(w, err)
		return
	}
	httpx.JSON(w, 200, map[string]any{"operation": operation})
}

// Token-registered nodes predate installation bootstrap and have no recorded
// storage identity, which disks require. Record the node's own identity once.
// Only an empty value is filled: an existing one (including an adopted
// "legacy:" placeholder) is never replaced, so a swapped storage pool still
// fails verification instead of silently taking over the old disks.
func (h *handler) enrollWorkspaceIncarnation(ctx context.Context, runner *runnerSession, tokenHash [32]byte) error {
	var identity struct {
		Version     int    `json:"version"`
		Incarnation string `json:"incarnation"`
	}
	if err := runner.call(ctx, "workspace.identity", map[string]any{}, &identity); err != nil {
		return err
	}
	if identity.Version != 1 || !protocol.ValidIdentity(identity.Incarnation) || strings.HasPrefix(identity.Incarnation, "legacy:") {
		return workspaces.ErrUnverified
	}
	_, err := h.deps.DB.ExecContext(ctx, h.deps.Rebind(`UPDATE runtime_nodes SET incarnation=? WHERE id=? AND token_hash=? AND incarnation='' AND kind IN ('server','computer','runner')`), identity.Incarnation, runner.nodeID, hex.EncodeToString(tokenHash[:]))
	return err
}

func supportsWorkspaceProtocol(raw string) bool {
	var capabilities struct {
		WorkspaceV2 bool `json:"workspaceProtocolV2"`
	}
	return json.Unmarshal([]byte(raw), &capabilities) == nil && capabilities.WorkspaceV2
}
