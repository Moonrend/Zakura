// SPDX-License-Identifier: AGPL-3.0-or-later
package runtime

import (
	"archive/tar"
	"bytes"
	"compress/gzip"
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"io"
	"path"
	"strconv"
	"strings"
)

// A configured node is not enough while the Space's files are moving. Callers
// must not launch new shared processes against a half-imported workspace.
func (h *handler) requireSpaceInfrastructureAvailable(ctx context.Context, tenant, space string) error {
	var busy int
	if err := h.deps.DB.QueryRowContext(ctx, h.deps.Rebind(`SELECT COUNT(*) FROM computer_workspace_leases WHERE tenant_id=? AND space_id=? AND operation IN ('migrating','deleting')`), tenant, space).Scan(&busy); err != nil {
		return err
	}
	if busy != 0 {
		return errors.New("Space infrastructure is migrating or being deleted")
	}
	return nil
}

// Shared process creation uses the same durable claim as workspace lifecycle.
// The caller retains the claim on an uncertain remote effect, never on timeout
// alone assumes it is safe for a migration to begin.
func (h *handler) acquireSpaceInfrastructure(ctx context.Context, tenant, space string) (*workspaceLease, error) {
	return h.acquireSpaceWorkspace(ctx, tenant, space, "configuring", false, nil)
}

func (h *handler) migrationPreflight(ctx context.Context, space Space, target string) error {
	return h.migrationCheck(ctx, space, target, false)
}

func (h *handler) migrationQuiescent(ctx context.Context, space Space, target string) error {
	return h.migrationCheck(ctx, space, target, true)
}

func (h *handler) migrationCheck(ctx context.Context, space Space, target string, quiescent bool) error {
	if space.RuntimeNodeID == nil || *space.RuntimeNodeID == "" || target == "" || *space.RuntimeNodeID == target {
		return errors.New("distinct source and target runtime nodes are required")
	}
	if h.hub == nil {
		return errors.New("migration runtime nodes are unavailable")
	}
	var configRaw string
	if err := h.deps.DB.QueryRowContext(ctx, h.deps.Rebind(`SELECT config_json FROM spaces WHERE tenant_id=? AND id=?`), space.TenantID, space.ID).Scan(&configRaw); err != nil {
		return err
	}
	config := map[string]json.RawMessage{}
	if json.Unmarshal([]byte(configRaw), &config) != nil {
		return errors.New("cannot verify pending project operations before migration")
	}
	if raw, ok := config["projectOperations"]; ok && string(raw) != "null" {
		var pending map[string]json.RawMessage
		if json.Unmarshal(raw, &pending) != nil {
			return errors.New("cannot verify pending project operations before migrating")
		}
		for _, value := range pending {
			var intent projectIntent
			if json.Unmarshal(value, &intent) != nil || projectIntentMatches(intent, space.CurrentWorkspaceInstanceID, space.WorkspaceGeneration) {
				return errors.New("finish or reconcile pending project operations before migrating")
			}
		}
	}
	var active int
	if err := h.deps.DB.QueryRowContext(ctx, h.deps.Rebind(`SELECT COUNT(*) FROM cloud_agent_runs r JOIN cloud_agent_sessions s ON s.id=r.session_id JOIN agents a ON a.id=s.agent_id AND a.tenant_id=s.tenant_id WHERE a.tenant_id=? AND a.space_id=? AND r.status IN ('running','pending','queued')`), space.TenantID, space.ID).Scan(&active); err != nil {
		return err
	}
	if quiescent && active != 0 {
		return errors.New("stop active Space runs before migrating")
	}
	if err := h.deps.DB.QueryRowContext(ctx, h.deps.Rebind(`SELECT COUNT(*) FROM acp_device_auth_attempts WHERE tenant_id=? AND space_id=? AND status IN ('starting','pending','polling','persisting','unknown')`), space.TenantID, space.ID).Scan(&active); err != nil {
		return err
	}
	if active != 0 {
		return errors.New("finish or reconcile device authentication before migrating")
	}
	if err := h.deps.DB.QueryRowContext(ctx, h.deps.Rebind(`SELECT COUNT(*) FROM acp_profile_auth_locks WHERE tenant_id=? AND space_id=?`), space.TenantID, space.ID).Scan(&active); err != nil {
		return err
	}
	if active != 0 {
		return errors.New("finish or reconcile profile authentication before migrating")
	}
	if quiescent {
		if err := h.deps.DB.QueryRowContext(ctx, h.deps.Rebind(`SELECT COUNT(*) FROM workspace_connections WHERE tenant_id=? AND space_id=?`), space.TenantID, space.ID).Scan(&active); err != nil {
			return err
		}
		if active != 0 {
			return errors.New("workspace connections have not confirmed cleanup")
		}
	}
	// Stopped MCP/ACP processes have their own lifecycle cleanup. Never rebind
	// them to a different node merely because the Space's files were copied.
	if err := h.deps.DB.QueryRowContext(ctx, h.deps.Rebind(`SELECT COUNT(*) FROM managed_containers WHERE tenant_id=? AND space_id=? AND purpose<>'workspace' AND (status<>'removed' OR docker_id IS NOT NULL)`), space.TenantID, space.ID).Scan(&active); err != nil {
		return err
	}
	if quiescent && active != 0 {
		return errors.New("stop and remove Space ACP/MCP containers before migrating")
	}
	for _, node := range []string{*space.RuntimeNodeID, target} {
		runner, err := h.hub.get(node)
		if err != nil {
			return err
		}
		if err = h.requirePrivateAtomicFS(ctx, runner); err != nil {
			return err
		}
		if err = requireWorkspaceMigrationFS(ctx, runner); err != nil {
			return err
		}
		var containers []acpSidecarContainer
		if err = runner.call(ctx, "docker.list", map[string]any{"label": "zakura.space=" + space.ID}, &containers); err != nil {
			return err
		}
		for _, c := range containers {
			if c.Labels["zakura.purpose"] == "computer" {
				var owned int64
				if err := h.deps.Gorm.WithContext(ctx).Table("computer_runtimes AS r").Joins("JOIN computers AS x ON x.id=r.computer_id AND x.tenant_id=r.tenant_id AND x.space_id=r.space_id").Where("r.tenant_id=? AND r.space_id=? AND r.id=? AND r.external_id=? AND r.incarnation=? AND x.id=? AND x.role<>'server'", space.TenantID, space.ID, c.Labels["zakura.runtime"], c.DockerID, c.Labels["zakura.incarnation"], c.Labels["zakura.computer"]).Count(&owned).Error; err != nil {
					return err
				}
				if owned == 1 {
					continue
				} // Dedicated computers do not move with the workspace.
			}
			if node == target {
				return errors.New("target Space already has workspace processes; reconcile them before migrating")
			}
			if c.DockerID == "" || c.Labels["zakura.space"] != space.ID || c.Labels["zakura.tenant"] != space.TenantID {
				return errors.New("Space process ownership is unverified")
			}
			purpose := c.Labels["zakura.purpose"]
			if purpose != "workspace" && (quiescent || (purpose != "acp-adapter" && purpose != "component" && purpose != "mcp")) {
				return errors.New("unrecognized Space process must be reconciled before migration")
			}
			switch c.Status {
			case "exited", "created", "dead":
			case "running":
				if quiescent {
					return errors.New("Space processes have not finished stopping")
				}
			default:
				return errors.New("Space process state is incomplete")
			}
		}
	}
	if !quiescent {
		sourceRunner, err := h.hub.get(*space.RuntimeNodeID)
		if err != nil {
			return err
		}
		if _, err := migrationFSCall(ctx, sourceRunner, space.ID, "inspect-"+space.ID, "inspect", "", nil); err != nil {
			return fmt.Errorf("workspace cannot be safely migrated: %w", err)
		}
	}
	return nil
}

// Import never merges into an old workspace or a previous partial attempt. A
// failed list is not evidence of emptiness. Provision an empty root explicitly.
func migrationTargetEmpty(ctx context.Context, target *remoteWorkspace) error {
	_, entries, err := target.list(ctx, "/")
	if err != nil {
		return fmt.Errorf("verify empty target workspace: %w", err)
	}
	if len(entries) != 0 {
		return errors.New("target workspace is not empty; reconcile existing or partial imports before migrating")
	}
	return nil
}

// Until the runner supports an atomic private executable write, migration must
// reject executable files rather than silently changing their permissions. This
// exporter validates each stat and read together; generic FS export intentionally
// does not carry that migration-specific contract.
func requireMigrationNoFollowFS(ctx context.Context, runner *runnerSession) error {
	var info struct {
		Capabilities struct {
			NoFollowStat bool `json:"filesystemNoFollowStat"`
		} `json:"capabilities"`
	}
	if err := runner.call(ctx, "sys.info", map[string]any{}, &info); err != nil {
		return err
	}
	if !info.Capabilities.NoFollowStat {
		return errors.New("runtime node requires an update for no-follow workspace migration metadata")
	}
	return nil
}

func migrationArchive(ctx context.Context, source *remoteWorkspace) ([]byte, error) {
	if err := requireMigrationNoFollowFS(ctx, source.runner); err != nil {
		return nil, err
	}
	var raw bytes.Buffer
	gz := gzip.NewWriter(&raw)
	tw := tar.NewWriter(gz)
	var total int64
	seen := map[string]bool{}
	var add func(string, int) error
	add = func(target string, depth int) error {
		if depth > 128 || len(seen) >= 10000 {
			return errors.New("workspace migration file tree exceeds safety limits")
		}
		clean := path.Clean(target)
		if !strings.HasPrefix(target, "/") || clean != target || strings.Contains(target, "\\") || strings.ContainsRune(target, 0) || seen[clean] {
			return errors.New("workspace migration returned an invalid or duplicate path")
		}
		seen[clean] = true
		params, err := source.pathParams(clean)
		if err != nil {
			return err
		}
		params["noFollow"] = true
		var stat runnerFSEntry
		if err = source.runner.call(ctx, "host.fs.stat", params, &stat); err != nil {
			return err
		}
		if stat.Path != clean || stat.Size < 0 {
			return errors.New("workspace migration stat is incomplete")
		}
		if err = migrationFileMode(stat); err != nil {
			return fmt.Errorf("cannot safely migrate %q: %w", clean, err)
		}
		name := strings.TrimPrefix(clean, "/")
		if stat.IsDir {
			if name != "" {
				if err = tw.WriteHeader(&tar.Header{Name: name + "/", Typeflag: tar.TypeDir, Mode: 0o750}); err != nil {
					return err
				}
			}
			_, entries, err := source.list(ctx, clean)
			if err != nil {
				return err
			}
			for _, child := range entries {
				if path.Dir(child.Path) != clean || child.Path == clean {
					return errors.New("workspace migration list escaped its directory")
				}
				if err = add(child.Path, depth+1); err != nil {
					return err
				}
			}
			return nil
		}
		if stat.Size > maxWorkspaceUpload-total {
			return errors.New("workspace migration archive exceeds size limit")
		}
		data, _, err := source.read(ctx, clean, stat.Size+1)
		if err != nil {
			return err
		}
		if int64(len(data)) != stat.Size {
			return errors.New("workspace file changed during migration export")
		}
		var after runnerFSEntry
		if err = source.runner.call(ctx, "host.fs.stat", params, &after); err != nil {
			return err
		}
		if after.Path != stat.Path || after.IsDir != stat.IsDir || after.Size != stat.Size || after.Mode != stat.Mode || fmt.Sprint(after.ModTime) != fmt.Sprint(stat.ModTime) {
			return errors.New("workspace file changed during migration export")
		}
		total += int64(len(data))
		if err = tw.WriteHeader(&tar.Header{Name: name, Typeflag: tar.TypeReg, Mode: 0o600, Size: int64(len(data))}); err != nil {
			return err
		}
		_, err = tw.Write(data)
		return err
	}
	if err := add("/", 0); err != nil {
		return nil, err
	}
	if err := tw.Close(); err != nil {
		return nil, err
	}
	if err := gz.Close(); err != nil {
		return nil, err
	}
	return raw.Bytes(), nil
}

func migrationFileMode(entry runnerFSEntry) error {
	mode := entry.Mode
	if numeric, err := strconv.ParseUint(mode, 8, 32); err == nil && mode != "" {
		// Accept permission bits only. Special file/type and set-id bits require
		// an explicit runner migration protocol, not generic host.fs.read.
		if numeric & ^uint64(0o777) != 0 || (!entry.IsDir && numeric&0o111 != 0) {
			return errors.New("executable or special file migration is not supported")
		}
		return nil
	}
	if len(mode) != 10 || (entry.IsDir && mode[0] != 'd') || (!entry.IsDir && mode[0] != '-') {
		return errors.New("runtime node must report a safe regular-file mode for migration")
	}
	for i, ch := range mode[1:] {
		allowed := byte('-')
		switch i % 3 {
		case 0:
			allowed = 'r'
		case 1:
			allowed = 'w'
		case 2:
			allowed = 'x'
		}
		if ch != '-' && ch != rune(allowed) {
			return errors.New("special file mode migration is not supported")
		}
		if !entry.IsDir && ch == 'x' {
			return errors.New("executable migration requires secure mode-preserving runner support")
		}
	}
	return nil
}

// Remove only an observed stopped workspace under the migration claim. Its data
// root remains on the source. Clear cache identities before switching nodes, so
// legacy resolution cannot route the new Space back to its stopped old Docker ID.
func (h *handler) migrationCleanupSourceWorkspace(ctx context.Context, lease *workspaceLease) error {
	obs, err := h.observeSpaceWorkspace(ctx, lease.Space)
	if err != nil {
		return err
	}
	if obs.Container.DockerID != "" {
		if obs.Container.Status != "exited" && obs.Container.Status != "created" && obs.Container.Status != "dead" {
			return errors.New("source workspace must be stopped before migration")
		}
		if err = lease.check(ctx); err != nil {
			return err
		}
		runner, err := h.hub.get(*lease.Space.RuntimeNodeID)
		if err != nil {
			return err
		}
		if err = runner.call(ctx, "docker.stop", map[string]any{"id": obs.Container.DockerID, "remove": true}, nil); err != nil {
			return lease.uncertain(fmt.Errorf("remove stopped source workspace: %w", err))
		}
		after, err := h.observeSpaceWorkspace(ctx, lease.Space)
		if err != nil {
			return lease.uncertain(err)
		}
		if after.Container.DockerID != "" {
			return lease.uncertain(errors.New("source workspace removal was not confirmed"))
		}
	}
	return lease.recordObservation(ctx, workspaceObservation{})
}

func migrationVerifyImport(ctx context.Context, target *remoteWorkspace, archive []byte) error {
	gz, err := gzip.NewReader(bytes.NewReader(archive))
	if err != nil {
		return err
	}
	defer gz.Close()
	tr := tar.NewReader(gz)
	for {
		hdr, err := tr.Next()
		if errors.Is(err, io.EOF) {
			return nil
		}
		if err != nil {
			return err
		}
		if hdr.Typeflag != tar.TypeReg {
			continue
		}
		expected, err := io.ReadAll(io.LimitReader(tr, hdr.Size+1))
		if err != nil {
			return err
		}
		actual, _, err := target.read(ctx, "/"+hdr.Name, hdr.Size+1)
		if err != nil {
			return err
		}
		if !bytes.Equal(expected, actual) {
			return fmt.Errorf("migration import verification failed for %q", hdr.Name)
		}
	}
}

func (h *handler) runLeasedWorkspaceMigration(ctx context.Context, id string, lease *workspaceLease, target string) {
	h.orchestrateWorkspaceMigration(ctx, id, lease, target)
}
