package runtime

import (
	"context"
	"encoding/json"
	"errors"
	"path"
	"strings"
	"time"

	"github.com/Moonrend/Zakura/apps/server/internal/computers"
)

// temporaryComputerProvider provisions session-scoped, self-hosted Docker
// containers on a server node. Unlike the server provider the container is never
// restarted automatically and every instance is bound to exactly one chat, so its
// files vanish with the session. It shares the container naming, validation and
// node workspace with the server provider, and adds destruction for deadline
// reclamation. Cleanup destroys overdue instances before their storage is removed.
type temporaryComputerProvider struct{ h *handler }

var (
	_ computers.CreationProvider    = temporaryComputerProvider{}
	_ computers.DestructionProvider = temporaryComputerProvider{}
)

// runner re-reads the pinned identity and durable approval before contacting a
// runner. Provider and node membership are resolved from storage, and the runtime
// must stay session-scoped: a temporary computer can never share node storage
// with another chat.
func (p temporaryComputerProvider) runner(ctx context.Context, r computers.Runtime, create bool) (*runnerSession, string, error) {
	if strings.TrimSpace(r.SessionScope) == "" {
		return nil, "", computers.ErrTransitionConflict
	}
	target := computers.Target{TenantID: r.TenantID, SpaceID: r.SpaceID, ComputerID: r.ComputerID, RuntimeID: r.ID, Incarnation: r.Incarnation}
	actual, err := p.h.computerStore().GetRuntime(ctx, target)
	if err != nil {
		return nil, "", err
	}
	if r.CreateOperationID == "" || actual.CreateOperationID != r.CreateOperationID || actual.SessionScope != r.SessionScope || actual.ExternalID != "" ||
		(actual.State != computers.Creating && (create || actual.State != computers.Unknown)) {
		return nil, "", computers.ErrTransitionConflict
	}
	var node, storageRoot string
	err = p.h.deps.DB.QueryRowContext(ctx, p.h.deps.Rebind(`SELECT n.id, n.storage_root FROM computers c
 JOIN runtime_nodes n ON n.id=c.runtime_node_id AND (n.tenant_id=c.tenant_id OR n.is_shared=TRUE)
 JOIN computer_creation_approvals a ON a.runtime_id=? AND a.create_operation_id=?
 JOIN computer_runtimes rt ON rt.id=? AND rt.session_scope=? AND rt.computer_id=c.id AND rt.tenant_id=c.tenant_id AND rt.space_id=c.space_id
 WHERE c.tenant_id=? AND c.space_id=? AND c.id=? AND c.provider='temporary' AND n.kind IN ('server','computer','local')`), r.ID, r.CreateOperationID, r.ID, r.SessionScope, r.TenantID, r.SpaceID, r.ComputerID).Scan(&node, &storageRoot)
	if err != nil {
		return nil, "", err
	}
	if strings.TrimSpace(storageRoot) == "" {
		return nil, "", errors.New("runtime node has no storage root")
	}
	if p.h.hub == nil {
		return nil, "", computers.ErrProviderUnavailable
	}
	session, err := p.h.hub.get(node)
	return session, storageRoot, err
}

// nodeRunner resolves the owning node for a runtime that has already been
// authorized for destruction, without re-checking creation state.
func (p temporaryComputerProvider) nodeRunner(ctx context.Context, r computers.Runtime) (*runnerSession, string, error) {
	if strings.TrimSpace(r.SessionScope) == "" {
		return nil, "", computers.ErrTransitionConflict
	}
	var node, storageRoot string
	err := p.h.deps.DB.QueryRowContext(ctx, p.h.deps.Rebind(`SELECT n.id, n.storage_root FROM computers c
 JOIN runtime_nodes n ON n.id=c.runtime_node_id AND (n.tenant_id=c.tenant_id OR n.is_shared=TRUE)
 JOIN computer_runtimes rt ON rt.id=? AND rt.session_scope=? AND rt.computer_id=c.id AND rt.tenant_id=c.tenant_id AND rt.space_id=c.space_id
 WHERE c.tenant_id=? AND c.space_id=? AND c.id=? AND c.provider='temporary' AND n.kind IN ('server','computer','local')`), r.ID, r.SessionScope, r.TenantID, r.SpaceID, r.ComputerID).Scan(&node, &storageRoot)
	if err != nil {
		return nil, "", err
	}
	if strings.TrimSpace(storageRoot) == "" {
		return nil, "", errors.New("runtime node has no storage root")
	}
	if p.h.hub == nil {
		return nil, "", computers.ErrProviderUnavailable
	}
	session, err := p.h.hub.get(node)
	return session, storageRoot, err
}

func (p temporaryComputerProvider) Create(ctx context.Context, r computers.Runtime) (computers.CreationResult, error) {
	runner, storageRoot, err := p.runner(ctx, r, true)
	if err != nil {
		return computers.CreationResult{}, err
	}
	createCtx, releaseImage, err := ensureComputerImage(ctx, runner, serverComputerImage)
	if err != nil {
		return computers.CreationResult{}, err
	}
	defer releaseImage()
	root, err := computerRoot(createCtx, runner, storageRoot, r.ID)
	if err != nil {
		return computers.CreationResult{}, err
	}
	name, labels := computerContainerIdentity(r)
	var result computerContainer
	// Independent bind-mounted storage, no Docker socket, published ports, or
	// privileged mode. restart=no keeps a temporary instance down until it is
	// reclaimed rather than resurrecting it after an unclean stop.
	err = runner.call(createCtx, "docker.create", map[string]any{
		"name": name, "image": serverComputerImage, "labels": labels,
		"volumes":    []map[string]any{{"hostPath": root, "containerPath": "/workspace"}},
		"workingDir": "/workspace", "restart": "no",
	}, &result)
	if err != nil {
		return computers.CreationResult{}, err
	}
	if err = validateComputerContainer(result, r); err != nil {
		return computers.CreationResult{}, err
	}
	return computers.CreationResult{ExternalID: result.DockerID, RootPath: root}, nil
}

func (p temporaryComputerProvider) Find(ctx context.Context, r computers.Runtime) (computers.CreationResult, error) {
	runner, storageRoot, err := p.runner(ctx, r, false)
	if err != nil {
		return computers.CreationResult{}, err
	}
	root, err := computerRoot(ctx, runner, storageRoot, r.ID)
	if err != nil {
		return computers.CreationResult{}, err
	}
	var results []computerContainer
	if err = runner.call(ctx, "docker.list", map[string]any{"label": "zakura.operation=" + r.CreateOperationID}, &results); err != nil {
		return computers.CreationResult{}, err
	}
	if len(results) == 0 {
		return computers.CreationResult{}, nil
	}
	if len(results) != 1 {
		return computers.CreationResult{}, errors.New("ambiguous computer creation operation")
	}
	if err = validateComputerContainer(results[0], r); err != nil {
		return computers.CreationResult{}, err
	}
	return computers.CreationResult{ExternalID: results[0].DockerID, RootPath: root}, nil
}

// Destroy stops and removes the container, then deletes the node directory that
// backed it, so an expired temporary computer never leaves files behind. The
// runtime must already be stopping/expired/unknown and own a provider instance;
// cleanup parks it in stopping first. Re-reading the identity prevents destroying
// a replacement after a lost race.
func (p temporaryComputerProvider) Destroy(ctx context.Context, r computers.Runtime) error {
	target := computers.Target{TenantID: r.TenantID, SpaceID: r.SpaceID, ComputerID: r.ComputerID, RuntimeID: r.ID, Incarnation: r.Incarnation}
	actual, err := p.h.computerStore().GetRuntime(ctx, target)
	if err != nil {
		return err
	}
	if r.CreateOperationID == "" || actual.CreateOperationID != r.CreateOperationID || actual.SessionScope != r.SessionScope || strings.TrimSpace(actual.SessionScope) == "" {
		return computers.ErrTransitionConflict
	}
	if actual.State != computers.Stopping && actual.State != computers.Expired && actual.State != computers.Unknown {
		return computers.ErrTransitionConflict
	}
	if strings.TrimSpace(actual.ExternalID) == "" {
		return errors.New("computer runtime has no provider instance")
	}
	runner, storageRoot, err := p.nodeRunner(ctx, r)
	if err != nil {
		return err
	}
	if err = runner.call(ctx, "docker.stop", map[string]any{"id": actual.ExternalID, "remove": true}, nil); err != nil {
		return err
	}
	var removed struct {
		OK bool `json:"ok"`
	}
	if err = runner.call(ctx, "host.fs.remove", map[string]any{"root": storageRoot, "path": path.Join("computers", r.ID, "workspace"), "recursive": true}, &removed); err != nil {
		return err
	}
	return nil
}

type temporaryCleanupSnapshot struct {
	Runtime     computers.Runtime `json:"runtime"`
	NodeID      string            `json:"nodeId"`
	StorageRoot string            `json:"storageRoot"`
}

var _ computers.CleanupSnapshotProvider = temporaryComputerProvider{}

func cleanupRuntimeIdentityMatches(a, b computers.Runtime) bool {
	return a.ID == b.ID && a.TenantID == b.TenantID && a.SpaceID == b.SpaceID && a.ComputerID == b.ComputerID && a.Incarnation == b.Incarnation && a.CreateOperationID == b.CreateOperationID && a.SessionScope == b.SessionScope && a.ExternalID == b.ExternalID && a.RootPath == b.RootPath
}
func temporaryCleanupPath(r computers.Runtime, root string) (string, error) {
	if r.ID == "" || r.ID == "." || r.ID == ".." || strings.ContainsAny(r.ID, "/\\") || strings.TrimSpace(root) == "" {
		return "", errors.New("temporary cleanup storage identity is invalid")
	}
	relative := path.Join("computers", r.ID, "workspace")
	expected := path.Join(strings.ReplaceAll(root, "\\", "/"), relative)
	if r.RootPath != "" && path.Clean(strings.ReplaceAll(r.RootPath, "\\", "/")) != expected {
		return "", errors.New("temporary cleanup workspace root does not match its runtime")
	}
	return relative, nil
}

// Capture pins a sealed original route before deletion. Neither later computer
// configuration nor a reused runtime slot can redirect this cleanup capability.
func (p temporaryComputerProvider) CaptureCleanup(ctx context.Context, r computers.Runtime) (json.RawMessage, error) {
	actual, err := p.h.computerStore().GetRuntime(ctx, computers.Target{TenantID: r.TenantID, SpaceID: r.SpaceID, ComputerID: r.ComputerID, RuntimeID: r.ID, Incarnation: r.Incarnation})
	if err != nil {
		return nil, err
	}
	if !cleanupRuntimeIdentityMatches(actual, r) || r.CreateOperationID == "" || r.Incarnation == "" || strings.TrimSpace(r.SessionScope) == "" {
		return nil, computers.ErrTransitionConflict
	}
	var snapshot temporaryCleanupSnapshot
	snapshot.Runtime = actual
	err = p.h.deps.DB.QueryRowContext(ctx, p.h.deps.Rebind(`SELECT n.id,n.storage_root FROM computers c JOIN runtime_nodes n ON n.id=c.runtime_node_id AND (n.tenant_id=c.tenant_id OR n.is_shared=TRUE) WHERE c.id=? AND c.tenant_id=? AND c.space_id=? AND c.provider='temporary' AND n.kind IN ('server','computer','local')`), r.ComputerID, r.TenantID, r.SpaceID).Scan(&snapshot.NodeID, &snapshot.StorageRoot)
	if err != nil {
		return nil, err
	}
	if _, err = temporaryCleanupPath(r, snapshot.StorageRoot); err != nil {
		return nil, err
	}
	raw, err := json.Marshal(snapshot)
	if err != nil {
		return nil, err
	}
	sealed, err := computers.SealCredentials(p.h.deps.Secret, r.TenantID, r.SpaceID, r.ComputerID, raw)
	if err != nil {
		return nil, errors.New("temporary cleanup snapshot could not be sealed")
	}
	return json.Marshal(map[string]string{"sealed": sealed})
}

func observeTemporaryCleanup(ctx context.Context, runner *runnerSession, r computers.Runtime) (computerContainer, error) {
	var listed []computerContainer
	// Unfiltered complete list also finds a known ID whose labels were changed;
	// an operation-only filter would mistake that case for confirmed absence.
	if err := runner.call(ctx, "docker.list", map[string]any{}, &listed); err != nil {
		return computerContainer{}, err
	}
	name, labels := computerContainerIdentity(r)
	var found computerContainer
	for _, c := range listed {
		if c.DockerID != r.ExternalID && strings.TrimPrefix(c.Name, "/") != name && c.Labels["zakura.runtime"] != r.ID && c.Labels["zakura.operation"] != r.CreateOperationID {
			continue
		}
		if c.DockerID == "" || strings.TrimPrefix(c.Name, "/") != name || c.Image != serverComputerImage {
			return computerContainer{}, errors.New("temporary cleanup container identity mismatch")
		}
		if r.ExternalID != "" && c.DockerID != r.ExternalID {
			return computerContainer{}, errors.New("temporary cleanup container was replaced")
		}
		for key, value := range labels {
			if c.Labels[key] != value {
				return computerContainer{}, errors.New("temporary cleanup container ownership mismatch")
			}
		}
		switch c.Status {
		case "running", "exited", "created", "dead":
		default:
			return computerContainer{}, errors.New("temporary cleanup container state is incomplete")
		}
		if found.DockerID != "" {
			return computerContainer{}, errors.New("ambiguous temporary cleanup containers")
		}
		found = c
	}
	if found.DockerID == "" && r.ExternalID == "" {
		return computerContainer{}, errors.New("temporary cleanup creation outcome remains unknown")
	}
	return found, nil
}

// DestroyCleanup only uses the captured route and pinned original identity. It
// deliberately performs no computer/runtime lookup, allowing owner deletion.
func (p temporaryComputerProvider) DestroyCleanup(ctx context.Context, r computers.Runtime, data json.RawMessage) error {
	var envelope struct {
		Sealed string `json:"sealed"`
	}
	if json.Unmarshal(data, &envelope) != nil {
		return errors.New("temporary cleanup snapshot is invalid")
	}
	plain, err := computers.OpenCredentials(p.h.deps.Secret, r.TenantID, r.SpaceID, r.ComputerID, envelope.Sealed)
	if err != nil {
		return errors.New("temporary cleanup snapshot could not be opened")
	}
	var snapshot temporaryCleanupSnapshot
	if json.Unmarshal(plain, &snapshot) != nil || !cleanupRuntimeIdentityMatches(snapshot.Runtime, r) || snapshot.NodeID == "" {
		return computers.ErrTransitionConflict
	}
	relative, err := temporaryCleanupPath(r, snapshot.StorageRoot)
	if err != nil {
		return err
	}
	if p.h.hub == nil {
		return computers.ErrProviderUnavailable
	}
	runner, err := p.h.hub.get(snapshot.NodeID)
	if err != nil {
		return err
	}
	c, err := observeTemporaryCleanup(ctx, runner, r)
	if err != nil {
		return err
	}
	if c.DockerID != "" {
		if err = runner.call(ctx, "docker.stop", map[string]any{"id": c.DockerID, "remove": true}, nil); err != nil {
			return err
		}
		observedRuntime := r
		observedRuntime.ExternalID = c.DockerID
		after, err := observeTemporaryCleanup(ctx, runner, observedRuntime)
		if err != nil {
			return err
		}
		if after.DockerID != "" {
			return errors.New("temporary cleanup removal is not confirmed")
		}
	}
	var removed struct {
		OK bool `json:"ok"`
	}
	if err = runner.call(ctx, "host.fs.remove", map[string]any{"root": snapshot.StorageRoot, "path": relative, "recursive": true}, &removed); err != nil {
		return err
	}
	if !removed.OK {
		return errors.New("temporary cleanup workspace removal is not confirmed")
	}
	return nil
}

func (h *handler) startComputerCleanup(ctx context.Context) {
	go func() {
		ticker := time.NewTicker(time.Minute)
		defer ticker.Stop()
		for {
			select {
			case <-ctx.Done():
				return
			case <-ticker.C:
				h.sweepExpiredComputers(ctx)
			}
		}
	}()
}

// sweepExpiredComputers reclaims overdue temporary computers. It is deliberately
// silent and panic-safe: a cleanup failure must never take down the API server.
func (h *handler) sweepExpiredComputers(ctx context.Context) {
	defer func() { _ = recover() }()
	callCtx, cancel := context.WithTimeout(ctx, 50*time.Second)
	defer cancel()
	_ = h.recoverSpaceWorkspaces(callCtx, 25)
	_ = h.sweepManagedContainerCleanup(callCtx, 50)
	deps := computers.CleanupDeps{Store: h.computerStore(), Destroyers: h.computerDestroyers(), Now: func() time.Time { return h.store.now() }}
	_, _, _ = deps.ExpireOverdue(callCtx, 50)
}
