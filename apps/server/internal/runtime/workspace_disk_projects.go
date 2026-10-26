package runtime

import (
	"context"

	"github.com/Moonrend/Zakura/apps/server/internal/platform/db/models"
	"github.com/Moonrend/Zakura/apps/server/internal/workspaces"
	"gorm.io/gorm"
)

// Project metadata belongs to the Space; directory presence belongs to a disk.
// Read the accepted instance once, then record only a successful node inventory.
// Offline and failed inventories must not turn unknown files into absent files.
func (h *handler) projectDiskPresence(ctx context.Context, tenant, space string, projects []models.SpaceProject) (map[string]bool, error) {
	accepted, ok := ctx.Value(workspaceRequestTargetKey{}).(Space)
	if !ok || accepted.TenantID != tenant || accepted.ID != space {
		var err error
		accepted, err = h.store.GetSpace(ctx, tenant, space)
		if err != nil {
			return nil, err
		}
	}
	present := make(map[string]bool, len(projects))
	if accepted.CurrentWorkspaceInstanceID == nil {
		for _, project := range projects {
			present[project.Slug] = accepted.WorkspaceGeneration == 0 && project.HasWorkspace
		}
		return present, nil
	}
	ctx = context.WithValue(ctx, workspaceRequestTargetKey{}, accepted)
	exec, err := h.resolveServerComputer(ctx, tenant, space)
	if err != nil {
		return nil, err
	}
	remote, err := h.remotePinnedWorkspace(ctx, exec)
	if err != nil {
		return nil, err
	}
	_, entries, err := remote.list(ctx, "/projects")
	if err != nil {
		if !workspaceMissing(err) {
			return nil, err
		}
		// A missing disk or mount is not evidence that /projects is empty.
		if _, _, err := remote.list(ctx, "/"); err != nil {
			return nil, err
		}
	}
	for _, entry := range entries {
		if entry.IsDir {
			present[entry.Name] = true
		}
	}
	err = h.deps.Gorm.WithContext(ctx).Transaction(func(tx *gorm.DB) error {
		if err := lockWorkspaceInstance(tx, tenant, space, accepted.CurrentWorkspaceInstanceID, accepted.WorkspaceGeneration); err != nil {
			return err
		}
		for _, project := range projects {
			if project.ID == nil {
				continue
			}
			if err := h.saveProjectDiskPresence(tx, tenant, space, exec.workspace.Target.DiskID, *project.ID, project.Slug, present[project.Slug]); err != nil {
				return err
			}
		}
		return nil
	})
	return present, err
}

func lockWorkspaceInstance(tx *gorm.DB, tenant, space string, instance *string, generation int64) error {
	q := tx.Table("spaces").Where("tenant_id=? AND id=? AND deletion_pending=FALSE AND workspace_generation=?", tenant, space, generation)
	if instance == nil {
		q = q.Where("current_workspace_instance_id IS NULL")
	} else {
		q = q.Where("current_workspace_instance_id=?", *instance)
	}
	result := q.UpdateColumn("workspace_generation", generation)
	if result.Error != nil {
		return result.Error
	}
	if result.RowsAffected != 1 {
		return workspaces.ErrTargetRevoked
	}
	return nil
}

func (h *handler) saveProjectDiskPresence(tx *gorm.DB, tenant, space, disk, project, slug string, present bool) error {
	if err := tx.Exec("DELETE FROM workspace_disk_projects WHERE tenant_id=? AND space_id=? AND disk_id=? AND project_id=?", tenant, space, disk, project).Error; err != nil {
		return err
	}
	if !present {
		return nil
	}
	return tx.Exec("INSERT INTO workspace_disk_projects(tenant_id,space_id,disk_id,project_id,path,verified_at) VALUES(?,?,?,?,?,?)", tenant, space, disk, project, projectRemotePath(slug), runtimeTimeString(h.store.now())).Error
}

func projectIntentMatches(in projectIntent, instance *string, generation int64) bool {
	return in.Generation == generation && (in.InstanceID == nil && instance == nil || in.InstanceID != nil && instance != nil && *in.InstanceID == *instance)
}

func projectIntentSlot(in projectIntent) string {
	if in.InstanceID == nil {
		return in.Slug
	}
	return *in.InstanceID + ":" + in.Slug
}

func projectIntentAt(ops map[string]any, in projectIntent) (string, projectIntent, error) {
	for key, value := range ops {
		other, err := decodeProjectIntent(value)
		if err != nil {
			return "", projectIntent{}, err
		}
		if other.Slug == in.Slug && projectIntentMatches(other, in.InstanceID, in.Generation) {
			return key, other, nil
		}
	}
	return "", projectIntent{}, nil
}
