package runtime

import (
	"context"
	"errors"
	"net/http"

	"github.com/Moonrend/Zakura/apps/server/internal/platform/db/models"
	"github.com/Moonrend/Zakura/apps/server/internal/platform/httpx"
	"github.com/go-chi/chi/v5"
	"gorm.io/gorm"
)

var errRuntimeNodeBound = errors.New("delete or move the current workspaces before removing this node")

func (h *handler) deleteRuntimeNode(w http.ResponseWriter, r *http.Request) {
	p, id := principal(r), chi.URLParam(r, "id")
	if p.SpaceID != "" || p.AgentID != "" || p.APIKey && !APIKeyScopeAllows(p, "computers:manage") || !p.APIKey && p.Role != "owner" && p.Role != "admin" && !p.IsPlatformAdmin {
		httpx.Error(w, http.StatusForbidden, "node management permission required")
		return
	}
	err := h.removeRuntimeNode(r.Context(), p.TenantID, id)
	if err != nil {
		if errors.Is(err, errRuntimeNodeBound) {
			httpx.Error(w, http.StatusConflict, err.Error())
		} else {
			statusErr(w, err)
		}
		return
	}
	httpx.JSON(w, http.StatusOK, map[string]any{"ok": true, "synchronizationStopped": true})
}

func (h *handler) removeRuntimeNode(ctx context.Context, tenant, id string) error {
	now := h.store.now()
	err := h.deps.Gorm.WithContext(ctx).Transaction(func(tx *gorm.DB) error {
		// Lock owners in the same order as attachment and retirement. A concurrent
		// replacement on a different node remains independent of this deletion.
		if err := tx.Exec(`UPDATE spaces SET workspace_generation=workspace_generation WHERE tenant_id=? AND runtime_node_id=?`, tenant, id).Error; err != nil {
			return err
		}
		result := tx.Table("runtime_nodes").Where("tenant_id=? AND id=? AND is_shared=FALSE AND kind<>'local'", tenant, id).UpdateColumn("status", gorm.Expr("status"))
		if result.Error != nil {
			return result.Error
		}
		if result.RowsAffected != 1 {
			return ErrNotFound
		}
		var bound int64
		if err := tx.Table("spaces").Where("runtime_node_id=?", id).Count(&bound).Error; err != nil {
			return err
		}
		if bound != 0 {
			return errRuntimeNodeBound
		}
		if err := tx.Exec(`UPDATE node_installations SET revoked=TRUE WHERE tenant_id=? AND node_id=?`, tenant, id).Error; err != nil {
			return err
		}
		message := "Node removed; synchronization stopped. Remote files and processes were not confirmed deleted."
		if err := tx.Exec(`UPDATE workspace_cleanup_tombstones SET pending=FALSE,phase='node_removed',token='',last_error=?,updated_at=? WHERE tenant_id=? AND node_id=? AND pending=TRUE`, message, now.UnixMilli(), tenant, id).Error; err != nil {
			return err
		}
		// Preserve attachment and release evidence. Node removal is never a disk
		// release acknowledgment and must not make a retained disk reusable.
		if err := tx.Exec(`UPDATE workspace_disks SET node_removed_at=?,state=CASE WHEN state='delete_pending' THEN 'deleted' ELSE state END,last_error=?,updated_at=? WHERE tenant_id=? AND node_id=? AND state<>'deleted'`, runtimeTimeString(now), message, runtimeTimeString(now), tenant, id).Error; err != nil {
			return err
		}
		return tx.Where("tenant_id=? AND id=?", tenant, id).Delete(&models.RuntimeNode{}).Error
	})
	if err != nil {
		return err
	}
	runnerTokenCache.Delete(id)
	if h.hub != nil {
		h.hub.mu.RLock()
		session := h.hub.sessions[id]
		h.hub.mu.RUnlock()
		if session != nil {
			session.ready.Store(false)
			session.close(errors.New("runtime node removed"))
			h.hub.remove(session)
		}
	}
	return nil
}
