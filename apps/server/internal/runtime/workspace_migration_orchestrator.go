// SPDX-License-Identifier: AGPL-3.0-or-later
package runtime

import (
	"context"
	"crypto/sha256"
	"encoding/base64"
	"encoding/hex"
	"encoding/json"
	"errors"
	"fmt"
	"time"

	"github.com/Moonrend/Zakura/apps/server/internal/platform/db/models"
	"gorm.io/gorm"
)

const maxMigrationArchive = 8 << 20

type migrationFSResult struct {
	Phase         string `json:"phase"`
	ArchiveBase64 string `json:"archiveBase64"`
	ArchiveSHA256 string `json:"archiveSha256"`
	Verified      bool   `json:"verified"`
	Size          int64  `json:"size"`
	Entries       int    `json:"entries"`
}

type migrationManifest struct {
	Version           int             `json:"version"`
	Source            string          `json:"sourceNodeId"`
	Target            string          `json:"targetNodeId"`
	PreviousStatus    string          `json:"previousStatus"`
	SourceStopped     bool            `json:"sourceStopped"`
	SourceResumed     bool            `json:"sourceResumed"`
	SourceDockerID    string          `json:"sourceDockerId,omitempty"`
	Switched          bool            `json:"switched"`
	TargetStartIntent bool            `json:"targetStartIntent"`
	TargetStarted     bool            `json:"targetStarted"`
	MCPInstances      []string        `json:"mcpInstances,omitempty"`
	MCPStartIntents   map[string]bool `json:"mcpStartIntents,omitempty"`
}

func requireWorkspaceMigrationFS(ctx context.Context, runner *runnerSession) error {
	var info struct {
		Capabilities struct {
			Migration bool `json:"filesystemWorkspaceMigration"`
		} `json:"capabilities"`
	}
	if err := runner.call(ctx, "sys.info", map[string]any{}, &info); err != nil {
		return err
	}
	if !info.Capabilities.Migration {
		return errors.New("update the runtime node before migrating this workspace safely")
	}
	return nil
}

func migrationFSCall(ctx context.Context, runner *runnerSession, space, id, operation, digest string, archive []byte) (migrationFSResult, error) {
	var result migrationFSResult
	if err := ctx.Err(); err != nil {
		return result, err
	}
	params := map[string]any{"spaceId": space, "migrationId": id, "operation": operation}
	if digest != "" {
		params["archiveSha256"] = digest
	}
	if archive != nil {
		if len(archive) > maxMigrationArchive {
			return result, errors.New("workspace migration archive exceeds 8 MiB transfer limit")
		}
		params["archiveBase64"] = base64.StdEncoding.EncodeToString(archive)
	}
	if err := runner.call(ctx, "host.fs.migration", params, &result); err != nil {
		return result, err
	}
	if digest != "" && result.ArchiveSHA256 != digest {
		return result, errors.New("runtime node reported a different migration archive")
	}
	return result, nil
}

func (h *handler) migrationUpdate(ctx context.Context, id string, lease *workspaceLease, manifest migrationManifest, phase string, progress int, extra map[string]any) error {
	return lease.fenced(ctx, func(tx *gorm.DB) error {
		if extra == nil {
			extra = map[string]any{}
		}
		extra["phase"], extra["progress_pct"], extra["manifest_json"] = phase, progress, string(rawJSON(manifest))
		extra["updated_at"] = runtimeTimeString(h.store.now())
		result := tx.Model(&models.WorkspaceMigration{}).Where("id=? AND tenant_id=? AND space_id=?", id, lease.Space.TenantID, lease.Space.ID).Updates(extra)
		if result.Error != nil {
			return result.Error
		}
		if result.RowsAffected != 1 {
			return ErrNotFound
		}
		return nil
	})
}

func (h *handler) orchestrateWorkspaceMigration(ctx context.Context, id string, lease *workspaceLease, target string) {
	ctx, cancel := context.WithTimeout(ctx, 15*time.Minute)
	defer cancel()
	defer lease.release()
	space := lease.Space
	if space.RuntimeNodeID == nil {
		h.failMigration(ctx, id, errWorkspaceNodeRequired)
		return
	}
	manifest := migrationManifest{Version: 1, Source: *space.RuntimeNodeID, Target: target, PreviousStatus: lease.Intent.PreviousStatus}
	if manifest.PreviousStatus != "running" {
		manifest.PreviousStatus = "stopped"
	}
	update := func(phase string, progress int, extra map[string]any) error {
		return h.migrationUpdate(ctx, id, lease, manifest, phase, progress, extra)
	}
	fail := func(err error, uncertain bool) {
		h.migrationFailure(id, lease, manifest, err, uncertain)
	}
	if err := update("preflight", 2, map[string]any{"status": "running", "started_at": runtimeTimeString(h.store.now()), "source_retained": true}); err != nil {
		fail(err, false)
		return
	}
	if err := h.migrationPreflight(ctx, space, target); err != nil {
		fail(err, false)
		return
	}
	sourceRunner, err := h.hub.get(manifest.Source)
	if err != nil {
		fail(err, false)
		return
	}
	targetRunner, err := h.hub.get(target)
	if err != nil {
		fail(err, false)
		return
	}
	// Preparing is job-scoped and cannot merge with or overwrite a prior root.
	if err := update("preparing_target", 5, nil); err != nil {
		fail(err, false)
		return
	}
	prepared, err := migrationFSCall(ctx, targetRunner, space.ID, id, "prepare", "", nil)
	if err != nil || prepared.Phase != "prepared" {
		if err == nil {
			err = errors.New("target did not confirm migration staging")
		}
		fail(err, true)
		return
	}
	if err := h.deps.Gorm.WithContext(ctx).Table("managed_containers AS m").Select("m.instance_id").Joins("JOIN component_instances AS i ON i.id=m.instance_id AND i.tenant_id=m.tenant_id").Where("m.tenant_id=? AND m.space_id=? AND m.purpose='component' AND i.component_type='mcp' AND i.status='running' AND m.status<>'removed'", space.TenantID, space.ID).Distinct().Pluck("m.instance_id", &manifest.MCPInstances).Error; err != nil {
		fail(err, false)
		return
	}
	if err := update("pausing", 10, nil); err != nil {
		fail(err, false)
		return
	}
	if err := h.migrationPauseRuns(ctx, lease); err != nil {
		fail(err, true)
		return
	}
	if err := update("closing_processes", 15, nil); err != nil {
		fail(err, false)
		return
	}
	if err := h.closeSpaceWorkspaceBridges(ctx, space.TenantID, space.ID); err != nil {
		fail(err, true)
		return
	}
	if err := h.recoverWorkspaceConnections(ctx, lease); err != nil {
		fail(err, true)
		return
	}
	if err := h.migrationCloseProcesses(ctx, lease); err != nil {
		fail(err, true)
		return
	}
	if err := update("stopping_source", 20, nil); err != nil {
		fail(err, false)
		return
	}
	observation, err := h.observeSpaceWorkspace(ctx, space)
	if err != nil {
		fail(err, true)
		return
	}
	manifest.SourceDockerID = observation.Container.DockerID
	if err := update("stopping_source", 20, nil); err != nil {
		fail(err, false)
		return
	}
	if err := h.stopSpaceWorkspaceWithLease(ctx, lease); err != nil {
		fail(err, true)
		return
	}
	manifest.SourceStopped = true
	if err := update("exporting", 25, nil); err != nil {
		fail(err, true)
		return
	}
	if err := h.migrationQuiescent(ctx, space, target); err != nil {
		fail(err, true)
		return
	}
	exported, err := migrationFSCall(ctx, sourceRunner, space.ID, id, "export", "", nil)
	if err != nil || exported.Phase != "exported" {
		if err == nil {
			err = errors.New("source did not confirm migration export")
		}
		fail(err, false)
		return
	}
	archive, err := base64.StdEncoding.DecodeString(exported.ArchiveBase64)
	if err != nil || len(archive) > maxMigrationArchive || len(archive) == 0 {
		fail(errors.New("invalid or oversized migration archive"), false)
		return
	}
	digestBytes := sha256.Sum256(archive)
	digest := hex.EncodeToString(digestBytes[:])
	if digest != exported.ArchiveSHA256 || int64(len(archive)) != exported.Size {
		fail(errors.New("source migration archive digest or size does not match"), false)
		return
	}
	if err := update("importing", 45, map[string]any{"archive_sha256": digest, "archive_size": fmt.Sprint(len(archive))}); err != nil {
		fail(err, false)
		return
	}
	imported, err := migrationFSCall(ctx, targetRunner, space.ID, id, "import", digest, archive)
	if err != nil || (imported.Phase != "imported" && imported.Phase != "verified") {
		if err == nil {
			err = errors.New("target did not confirm migration import")
		}
		fail(err, true)
		return
	}
	if err := update("verifying", 65, nil); err != nil {
		fail(err, true)
		return
	}
	verified, err := migrationFSCall(ctx, targetRunner, space.ID, id, "verify", digest, nil)
	if err != nil || verified.Phase != "verified" || !verified.Verified {
		if err == nil {
			err = errors.New("target content, mode, and link verification was not confirmed")
		}
		fail(err, true)
		return
	}
	if err := h.migrationQuiescent(ctx, space, target); err != nil {
		fail(err, true)
		return
	}
	if err := update("committing_files", 75, nil); err != nil {
		fail(err, true)
		return
	}
	committed, err := migrationFSCall(ctx, targetRunner, space.ID, id, "commit", digest, nil)
	if err != nil || committed.Phase != "committed" || !committed.Verified {
		if err == nil {
			err = errors.New("target workspace promotion was not confirmed")
		}
		fail(err, true)
		return
	}
	if err := update("switching", 85, nil); err != nil {
		fail(err, true)
		return
	}
	if err := h.migrationSwitch(ctx, id, lease, &manifest); err != nil {
		fail(err, true)
		return
	}
	if err := h.migrationRestoreTarget(ctx, id, lease, manifest); err != nil {
		fail(err, true)
	}
}

func (h *handler) migrationSwitch(ctx context.Context, id string, lease *workspaceLease, manifest *migrationManifest) error {
	return lease.fenced(ctx, func(tx *gorm.DB) error {
		now := runtimeTimeString(h.store.now())
		result := tx.Table("spaces").Where("tenant_id=? AND id=? AND runtime_node_id=?", lease.Space.TenantID, lease.Space.ID, manifest.Source).Updates(map[string]any{"runtime_node_id": manifest.Target, "workspace_status": "migrating", "last_error": nil, "updated_at": now})
		if result.Error != nil {
			return result.Error
		}
		if result.RowsAffected != 1 {
			return ErrConflict
		}
		// Source containers remain stopped alongside the retained source files;
		// their identities must never be reused on the target node.
		if err := tx.Table("managed_containers").Where("tenant_id=? AND space_id=? AND purpose='workspace' AND runtime_node_id=?", lease.Space.TenantID, lease.Space.ID, manifest.Source).Updates(map[string]any{"docker_id": nil, "status": "removed", "updated_at": now}).Error; err != nil {
			return err
		}
		if err := adoptLegacyComputer(tx, lease.Space.TenantID, lease.Space.ID); err != nil {
			return err
		}
		copy := *manifest
		copy.Switched = true
		if err := tx.Model(&models.WorkspaceMigration{}).Where("id=? AND tenant_id=? AND space_id=?", id, lease.Space.TenantID, lease.Space.ID).Updates(map[string]any{"manifest_json": string(rawJSON(copy)), "phase": "restoring", "progress_pct": 90, "updated_at": now}).Error; err != nil {
			return err
		}
		return nil
	})
}

func (h *handler) migrationRestoreTarget(ctx context.Context, id string, lease *workspaceLease, manifest migrationManifest) error {
	manifest.Switched = true
	space, err := h.store.GetSpace(ctx, lease.Space.TenantID, lease.Space.ID)
	if err != nil {
		return err
	}
	if space.RuntimeNodeID == nil || *space.RuntimeNodeID != manifest.Target {
		return ErrConflict
	}
	lease.Space = space
	if manifest.PreviousStatus == "running" {
		if manifest.TargetStartIntent && !manifest.TargetStarted {
			observed, err := h.observeSpaceWorkspace(ctx, space)
			if err != nil || observed.Container.DockerID == "" || observed.Container.Status != "running" {
				return errors.New("target start outcome is unconfirmed; refusing to create another workspace")
			}
			if op, err := h.workspaceCreateOperation(ctx, space); err != nil {
				return err
			} else if op != nil {
				runner, err := h.hub.get(*space.RuntimeNodeID)
				if err != nil {
					return err
				}
				if err = h.reconcileWorkspaceCreate(ctx, lease, runner, op, observed); err != nil {
					return err
				}
			}
			if err := lease.recordObservation(ctx, observed); err != nil {
				return err
			}
		} else if !manifest.TargetStarted {
			manifest.TargetStartIntent = true
			if err := h.migrationUpdate(ctx, id, lease, manifest, "restoring", 90, nil); err != nil {
				return err
			}
			if err := h.startSpaceWorkspaceWithLease(ctx, lease); err != nil {
				return err
			}
		}
		manifest.TargetStarted = true
		if err := h.migrationUpdate(ctx, id, lease, manifest, "restoring", 95, nil); err != nil {
			return err
		}
	}
	if err := h.migrationRestoreMCP(ctx, id, lease, &manifest); err != nil {
		return err
	}
	// ACP stays closed: only an explicit next invocation may reconnect its
	// migrated HOME/session. Never replay the interrupted turn or queued input.
	return lease.fenced(ctx, func(tx *gorm.DB) error {
		now := runtimeTimeString(h.store.now())
		if err := tx.Model(&models.WorkspaceMigration{}).Where("id=? AND tenant_id=? AND space_id=?", id, space.TenantID, space.ID).Updates(map[string]any{"status": "completed", "phase": "completed", "progress_pct": 100, "manifest_json": string(rawJSON(manifest)), "source_retained": true, "error": nil, "completed_at": now, "updated_at": now}).Error; err != nil {
			return err
		}
		if err := tx.Table("spaces").Where("tenant_id=? AND id=? AND runtime_node_id=?", space.TenantID, space.ID, manifest.Target).Updates(map[string]any{"workspace_status": manifest.PreviousStatus, "last_error": nil, "updated_at": now}).Error; err != nil {
			return err
		}
		return tx.Table("computer_workspace_leases").Where("tenant_id=? AND space_id=? AND token=?", space.TenantID, space.ID, lease.Token).Delete(map[string]any{}).Error
	})
}

func (h *handler) migrationRestoreMCP(ctx context.Context, jobID string, lease *workspaceLease, manifest *migrationManifest) error {
	for _, id := range manifest.MCPInstances {
		instance, err := h.getMCPInstance(ctx, lease.Space.TenantID, id)
		if err != nil {
			return err
		}
		body, stdio, err := h.stdioBodyForInstance(instance)
		if err != nil {
			return err
		}
		if !stdio {
			continue
		}
		owner, err := h.mcpOwnerSpace(ctx, instance)
		if err != nil || owner != lease.Space.ID {
			return errors.New("MCP ownership changed during migration")
		}
		var active int64
		if err := h.deps.Gorm.WithContext(ctx).Table("managed_containers").Where("tenant_id=? AND space_id=? AND instance_id=? AND runtime_node_id=? AND status='running' AND docker_id IS NOT NULL", lease.Space.TenantID, lease.Space.ID, id, manifest.Target).Count(&active).Error; err != nil {
			return err
		}
		if active == 1 {
			continue
		}
		if active > 1 {
			return errors.New("MCP target has conflicting active containers")
		}
		if manifest.MCPStartIntents[id] {
			return errors.New("MCP restart outcome is unconfirmed; refusing to create a duplicate process")
		}
		if manifest.MCPStartIntents == nil {
			manifest.MCPStartIntents = map[string]bool{}
		}
		manifest.MCPStartIntents[id] = true
		if err := h.migrationUpdate(ctx, jobID, lease, *manifest, "restoring", 95, nil); err != nil {
			return err
		}
		body.RuntimeNodeID = nil
		body.SpaceIDs = []string{owner}
		if err := h.provisionStdioMCPWithLease(ctx, lease.Space.TenantID, id, body, owner, lease); err != nil {
			return err
		}
	}
	return nil
}

func (h *handler) migrationFailure(id string, lease *workspaceLease, manifest migrationManifest, cause error, uncertain bool) {
	ctx, cancel := context.WithTimeout(context.Background(), 30*time.Second)
	defer cancel()
	space, err := h.store.GetSpace(ctx, lease.Space.TenantID, lease.Space.ID)
	if err == nil && space.RuntimeNodeID != nil && *space.RuntimeNodeID == manifest.Target {
		manifest.Switched = true
		lease.Space = space
	}
	phase, status := "failed", "failed"
	if manifest.Switched {
		// Preserve the most recent target-start/MCP restore intent rather than
		// overwriting it with the caller's pre-restore manifest copy.
		var current models.WorkspaceMigration
		if err := h.deps.Gorm.WithContext(ctx).Where("id=? AND tenant_id=? AND space_id=?", id, lease.Space.TenantID, lease.Space.ID).Take(&current).Error; err == nil && current.ManifestJSON != nil {
			var saved migrationManifest
			if json.Unmarshal([]byte(*current.ManifestJSON), &saved) == nil && saved.Source == manifest.Source && saved.Target == manifest.Target {
				manifest = saved
			}
		}
		manifest.Switched = true
		phase = "restore_failed"
		uncertain = true
	}
	if !manifest.Switched && manifest.SourceStopped && manifest.PreviousStatus == "running" {
		if err := h.startSpaceWorkspaceWithLease(ctx, lease); err != nil {
			cause = errors.Join(cause, fmt.Errorf("source workspace could not be restarted: %w", err))
			uncertain = true
		} else {
			manifest.SourceResumed = true
		}
	}
	if uncertain {
		status = "waiting"
		if !manifest.Switched {
			phase = "recovery_required"
		}
	}
	_ = h.migrationUpdate(ctx, id, lease, manifest, phase, 0, map[string]any{"status": status, "source_retained": true, "error": cause.Error()})
	if uncertain {
		_ = lease.uncertain(cause)
		return
	}
	lease.retained = false
	_ = lease.finish(ctx, manifest.PreviousStatus, map[string]any{"last_error": cause.Error()})
}

// Recovery never assumes that timeout/list absence means a remote effect did
// not happen. Only the runner's durable job+digest receipt permits continuation.
func (h *handler) recoverWorkspaceMigration(ctx context.Context, lease *workspaceLease) error {
	var job models.WorkspaceMigration
	if err := h.deps.Gorm.WithContext(ctx).Where("tenant_id=? AND space_id=? AND status IN ('pending','running','waiting')", lease.Space.TenantID, lease.Space.ID).Order("created_at DESC").Take(&job).Error; err != nil {
		return lease.uncertain(errors.New("migration journal is unavailable; retained files and operation require reconciliation"))
	}
	var manifest migrationManifest
	if job.ID == nil || job.ManifestJSON == nil || json.Unmarshal([]byte(*job.ManifestJSON), &manifest) != nil || manifest.Version != 1 || manifest.Source != job.SourceNodeID || manifest.Target != job.TargetNodeID {
		return lease.uncertain(errors.New("migration journal is incomplete; refusing to repeat remote operations"))
	}
	if err := h.closeSpaceWorkspaceBridges(ctx, lease.Space.TenantID, lease.Space.ID); err != nil {
		return lease.uncertain(err)
	}
	if err := h.recoverWorkspaceConnections(ctx, lease); err != nil {
		return lease.uncertain(err)
	}
	if manifest.Switched || (lease.Space.RuntimeNodeID != nil && *lease.Space.RuntimeNodeID == manifest.Target) {
		return h.migrationRestoreTarget(ctx, *job.ID, lease, manifest)
	}
	if manifest.SourceResumed {
		return lease.uncertain(errors.New("source workspace resumed after interruption; staged snapshot cannot be activated without a fresh migration"))
	}
	if job.ArchiveSha256 == nil || *job.ArchiveSha256 == "" {
		return lease.uncertain(errors.New("migration was interrupted before a verified archive; source remains unchanged and execution will not be replayed"))
	}
	runner, err := h.hub.get(manifest.Target)
	if err != nil {
		return lease.uncertain(err)
	}
	status, err := migrationFSCall(ctx, runner, lease.Space.ID, *job.ID, "status", *job.ArchiveSha256, nil)
	if err != nil {
		return lease.uncertain(err)
	}
	if status.Phase != "committed" || !status.Verified {
		return lease.uncertain(errors.New("migration staging is retained; target promotion has not been confirmed"))
	}
	if err := h.migrationQuiescent(ctx, lease.Space, manifest.Target); err != nil {
		return lease.uncertain(err)
	}
	if err := h.migrationSwitch(ctx, *job.ID, lease, &manifest); err != nil {
		return lease.uncertain(err)
	}
	return h.migrationRestoreTarget(ctx, *job.ID, lease, manifest)
}
